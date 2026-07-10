/* Web shell for the LectureEditor engine (web/editor.js is a verbatim copy of
   src/editor.js). Everything runs client-side: open = FileReader, save = blob
   download. No uploads, no backend. */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const iframe = $('#canvas');
  const zoomWrap = $('#zoom-wrap');
  const stage = $('#stage');
  const emptyState = $('#empty-state');
  const statusEl = $('#status');
  const btnUndo = $('#btn-undo');
  const btnRedo = $('#btn-redo');
  const btnZoomLabel = $('#btn-zoom-label');
  const fileInput = $('#file-input');
  const imgInput = $('#img-input');

  let editor = null;
  let zoom = 1;
  let saveName = 'lecture-edited.html';
  let imgMode = 'insert';   // what the hidden image input is being used for

  function status(msg) { statusEl.textContent = msg; }

  // ---------- open ----------
  async function openFile(file) {
    if (!file) return;
    saveName = file.name.replace(/\.html?$/i, '') + '-edited.html';
    const html = await file.text();
    loadIntoIframe(html);
    status('Opened: ' + file.name);
  }

  function loadIntoIframe(html) {
    iframe.onload = () => {
      editor = new window.LectureEditor();
      editor.onChange = ({ canUndo, canRedo }) => {
        btnUndo.disabled = !canUndo;
        btnRedo.disabled = !canRedo;
      };
      editor.onReplaceRequest = () => { imgMode = 'replace'; imgInput.click(); };
      editor.onPlaced = (type) => {
        status(type ? 'Inserted. Click it to style or move it.' : 'Insert cancelled.');
      };
      editor.onSaveRequest = () => saveHtml();
      editor.onContentResize = () => applyZoom();
      editor.onSlidesChanged = () => {};
      editor.attach(iframe);
      window.__editor = editor; // hook for automated tests
      fitZoom();
      status('Ready. Double-click any text to edit it; drag any element to move it.');
    };
    emptyState.hidden = true;
    zoomWrap.hidden = false;
    iframe.srcdoc = html;
  }

  // ---------- zoom ----------
  function applyZoom() {
    if (!editor) return;
    iframe.style.transform = `scale(${zoom})`;
    zoomWrap.style.width = Math.ceil(iframe.offsetWidth * zoom) + 'px';
    zoomWrap.style.height = Math.ceil(iframe.offsetHeight * zoom) + 'px';
    btnZoomLabel.textContent = Math.round(zoom * 100) + '%';
  }
  function setZoom(z) {
    zoom = Math.min(3, Math.max(0.25, z));
    applyZoom();
  }
  function fitZoom() {
    if (!editor) return;
    const avail = stage.clientWidth - 48;
    setZoom(Math.min(1.5, avail / iframe.offsetWidth));
  }

  // ---------- save (download) ----------
  function saveHtml() {
    if (!editor) { status('Nothing to save.'); return; }
    const html = editor.getCleanHtml();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = saveName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status('Downloaded: ' + saveName);
  }

  // ---------- images (embedded as data URLs so the saved file stays portable) ----------
  function pickTargetSlide() {
    const slides = editor.slides();
    if (!slides.length) return null;
    // The slide closest to the middle of the visible stage.
    const mid = stage.scrollTop + stage.clientHeight / 2;
    let best = slides[0], dist = Infinity;
    for (const s of slides) {
      const c = (s.offsetTop + s.offsetHeight / 2) * zoom;
      const d = Math.abs(c - mid);
      if (d < dist) { dist = d; best = s; }
    }
    return best;
  }

  function handleImages(files) {
    if (!editor || !files.length) return;
    const list = Array.from(files);
    if (imgMode === 'replace') {
      const rd = new FileReader();
      rd.onload = () => { editor.replaceSelected(rd.result); status('Replaced image.'); };
      rd.readAsDataURL(list[0]);
      return;
    }
    const slide = pickTargetSlide();
    list.forEach(f => {
      const rd = new FileReader();
      rd.onload = () => editor.insertImageInto(rd.result, f.name, slide);
      rd.readAsDataURL(f);
    });
    status('Image added — drag it where you want it.');
  }

  // ---------- export PDF (browser print dialog → "Save as PDF") ----------
  // Slide-deck detection: repeated same-size direct children of <body>
  // (e.g. div.slide 950x650). Each becomes exactly one PDF page.
  function detectSlides() {
    const doc = editor.doc;
    const kids = Array.from(doc.body.children).filter(el =>
      el.nodeType === 1 &&
      !/^ve-/.test(el.className) &&
      el.offsetWidth > 400 && el.offsetHeight > 250);
    if (kids.length < 2) return null;
    const w = kids[0].offsetWidth, h = kids[0].offsetHeight;
    const same = kids.filter(k =>
      Math.abs(k.offsetWidth - w) < 4 && Math.abs(k.offsetHeight - h) < 4);
    if (same.length < 2 || same.length < kids.length * 0.8) return null;
    return { width: w, height: h, els: same };
  }

  function buildPdfHtml() {
    const slides = detectSlides();
    let html, printCss;
    if (slides) {
      // Mark slides, snapshot HTML, then clean the live document again.
      slides.els.forEach(el => el.setAttribute('data-ve-page', ''));
      html = editor.getCleanHtml();
      slides.els.forEach(el => el.removeAttribute('data-ve-page'));
      printCss = `<style id="ve-print">
        @page { size: ${slides.width}px ${slides.height}px; margin: 0; }
        html, body { background: #fff !important; margin: 0 !important; padding: 0 !important;
                     -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        [data-ve-page] {
          margin: 0 auto !important;
          box-shadow: none !important;
          page-break-after: always; break-after: page;
          page-break-inside: avoid; break-inside: avoid;
        }
        [data-ve-page]:last-of-type { page-break-after: auto; break-after: auto; }
      </style>`;
    } else {
      html = editor.getCleanHtml();
      printCss = `<style id="ve-print">
        html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      </style>`;
    }
    return html.includes('</head>')
      ? html.replace('</head>', printCss + '</head>')
      : printCss + html;
  }

  let printFrame = null;
  async function exportPdf() {
    if (!editor) { status('Open a file first.'); return; }
    status('Preparing PDF — pick "Save as PDF" in the print dialog.');
    if (printFrame) printFrame.remove();
    // Real (off-screen) size: zero-size frames mis-evaluate media queries.
    printFrame = document.createElement('iframe');
    printFrame.style.cssText =
      'position:fixed; left:-12000px; top:0; width:1200px; height:800px; border:0;';
    document.body.appendChild(printFrame);
    await new Promise(res => { printFrame.onload = res; printFrame.srcdoc = buildPdfHtml(); });
    const pw = printFrame.contentWindow;
    // Wait for web fonts and every image before opening the dialog.
    try { if (pw.document.fonts && pw.document.fonts.ready) await pw.document.fonts.ready; } catch (e) {}
    await Promise.all(Array.from(pw.document.images).map(im =>
      im.complete ? null : new Promise(r => { im.onload = im.onerror = r; })));
    await new Promise(r => setTimeout(r, 200));
    pw.focus();
    pw.print();
  }

  // ---------- drag & drop ----------
  ['dragover', 'drop'].forEach(evt =>
    window.addEventListener(evt, (e) => e.preventDefault()));
  window.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    const html = files.find(f => /\.html?$/i.test(f.name));
    if (html) { openFile(html); return; }
    const imgs = files.filter(f => /^image\//.test(f.type));
    if (imgs.length && editor) { imgMode = 'insert'; handleImages(imgs); }
  });

  // ---------- wire up ----------
  $('#btn-open').addEventListener('click', () => fileInput.click());
  $('#btn-open-2').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { openFile(fileInput.files[0]); fileInput.value = ''; });
  imgInput.addEventListener('change', () => { handleImages(imgInput.files); imgInput.value = ''; });
  $('#btn-add-text').addEventListener('click', () => {
    if (!editor) { status('Open a file first.'); return; }
    editor.beginPlace('text');
    status('Click on the page where the text should go… (Esc cancels)');
  });
  $('#btn-add-image').addEventListener('click', () => {
    if (!editor) { status('Open a file first.'); return; }
    imgMode = 'insert';
    imgInput.click();
  });
  $('#btn-undo').addEventListener('click', () => editor && editor.undo());
  $('#btn-redo').addEventListener('click', () => editor && editor.redo());
  $('#btn-zoom-in').addEventListener('click', () => setZoom(zoom * 1.2));
  $('#btn-zoom-out').addEventListener('click', () => setZoom(zoom / 1.2));
  $('#btn-zoom-label').addEventListener('click', fitZoom);
  $('#btn-save').addEventListener('click', saveHtml);
  $('#btn-export').addEventListener('click', exportPdf);
  window.addEventListener('resize', () => applyZoom());
  window.addEventListener('keydown', (e) => {
    if (!editor) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveHtml(); }
  });
})();
