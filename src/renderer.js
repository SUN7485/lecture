/* Renderer: app UI logic. Wires toolbar, asset panel, drag-to-insert, save & export. */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const iframe = $('#canvas');
  const zoomWrap = $('#zoom-wrap');
  const stage = $('#stage');
  const emptyState = $('#empty-state');
  const assetList = $('#asset-list');
  const slideList = $('#slide-list');
  const slideCount = $('#slide-count');
  const slideInfo = $('#slide-info');
  const statusEl = $('#status');
  const btnUndo = $('#btn-undo');
  const btnRedo = $('#btn-redo');
  const btnZoomLabel = $('#btn-zoom-label');

  let editor = null;
  let currentFile = null;   // { filePath, dir, content }
  let assets = [];          // { url, name, path }
  let zoom = 1;
  let activeSlide = null;   // the slide element considered "current"

  function status(msg) { statusEl.textContent = msg; }

  // ---------- Open HTML ----------
  async function openHtml() {
    const res = await window.api.openHtml();
    if (!res) return;
    currentFile = res;
    loadIntoIframe(res.content, res.dir);
    status('Opened: ' + res.filePath);
  }

  function loadIntoIframe(html, dir) {
    const baseHref = 'file:///' + dir.replace(/\\/g, '/') + '/';
    const htmlWithBase = injectBase(html, baseHref);

    iframe.onload = () => {
      editor = new window.LectureEditor();
      editor.onChange = ({ canUndo, canRedo }) => {
        btnUndo.disabled = !canUndo;
        btnRedo.disabled = !canRedo;
      };
      editor.onReplaceRequest = async () => {
        const picked = await window.api.pickImages();
        if (picked && picked.length) {
          addAssets(picked);
          editor.replaceSelected(picked[0].url);
          status('Replaced image.');
        }
      };
      editor.onPlaced = (type) => {
        if (!type) { status('Insert cancelled.'); return; }
        status(type === 'text'
          ? 'Type your text — click anywhere else when done.'
          : 'Inserted. Click it to style, move up a container, or delete.');
      };
      editor.onSaveRequest = () => saveHtml();
      editor.onContentResize = () => applyZoom();
      editor.onSlidesChanged = (focus) => {
        refreshSlideList();
        if (focus) { activeSlide = focus; scrollToSlide(focus); }
        updateSlideInfo();
      };
      editor.attach(iframe);
      window.__editor = editor;       // hook for automated tests
      window.__addAssets = addAssets; // hook for automated tests
      applyZoom();
      refreshSlideList();
      updateSlideInfo();
      status('Ready. Double-click any text (or select it and press ✏ Edit text) to change the words. Drag images in, add slides, zoom to work comfortably.');
    };

    emptyState.hidden = true;
    zoomWrap.hidden = false;
    iframe.srcdoc = htmlWithBase;
  }

  // ---------- Zoom ----------
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

  // ---------- Slide navigator ----------
  function slideTitle(el, i) {
    const h = el.querySelector('h1, h2, [style*="font-size"]');
    const t = (h && h.textContent.trim()) || '';
    return t ? t.slice(0, 40) : 'Slide ' + (i + 1);
  }
  function refreshSlideList() {
    if (!editor) return;
    const slides = editor.slides();
    slideCount.textContent = slides.length ? '(' + slides.length + ')' : '';
    if (!slides.length) {
      slideList.innerHTML = '<p class="hint">No slides detected — this looks like a plain document.</p>';
      return;
    }
    slideList.innerHTML = '';
    slides.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'slide-item' + (s === activeSlide ? ' active' : '');
      item.innerHTML = `<span class="num">${i + 1}</span><span class="title"></span>`;
      item.querySelector('.title').textContent = slideTitle(s, i);
      item.addEventListener('click', () => { activeSlide = s; scrollToSlide(s); markActive(); updateSlideInfo(); });
      slideList.appendChild(item);
    });
  }
  function markActive() {
    const slides = editor.slides();
    Array.from(slideList.children).forEach((item, i) => {
      item.classList.toggle('active', slides[i] === activeSlide);
    });
  }
  function scrollToSlide(s) {
    // s.offsetTop is in the iframe's unscaled coords; multiply by zoom and
    // add the wrap's offset within the stage.
    const top = zoomWrap.offsetTop + s.offsetTop * zoom;
    stage.scrollTop = Math.max(0, top - 24);
  }
  // Which slide sits under the middle of the viewport right now.
  function currentSlideEl() {
    if (editor.selected) { const s = editor._slideOf(editor.selected); if (s) return s; }
    const slides = editor.slides();
    if (!slides.length) return null;
    const viewMid = (stage.scrollTop + stage.clientHeight / 2 - zoomWrap.offsetTop) / zoom;
    let best = slides[0], bestD = Infinity;
    slides.forEach(s => {
      const mid = s.offsetTop + s.offsetHeight / 2;
      const d = Math.abs(mid - viewMid);
      if (d < bestD) { bestD = d; best = s; }
    });
    return best;
  }
  function updateSlideInfo() {
    if (!editor) { slideInfo.textContent = ''; return; }
    const slides = editor.slides();
    if (!slides.length) { slideInfo.textContent = ''; return; }
    activeSlide = currentSlideEl();
    const idx = slides.indexOf(activeSlide);
    slideInfo.textContent = `Slide ${idx + 1} / ${slides.length}`;
    markActive();
  }
  stage.addEventListener('scroll', () => {
    if (editor) updateSlideInfo();
  });

  function injectBase(html, baseHref) {
    const baseTag = `<base href="${baseHref}">`;
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head[^>]*>/i, (m) => m + baseTag);
    }
    if (/<html[^>]*>/i.test(html)) {
      return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + baseTag + '</head>');
    }
    return '<head>' + baseTag + '</head>' + html;
  }

  // ---------- Asset panel ----------
  async function addImages() {
    const picked = await window.api.pickImages();
    if (picked && picked.length) {
      addAssets(picked);
      status(`Added ${picked.length} image(s) to the library.`);
    }
  }

  function addAssets(list) {
    for (const a of list) {
      if (assets.some(x => x.path === a.path)) continue;
      assets.push(a);
    }
    renderAssets();
  }

  function renderAssets() {
    if (!assets.length) {
      assetList.innerHTML = '<p class="hint">Click <b>Add Images</b> to load pictures here, then drag them onto the page.</p>';
      return;
    }
    assetList.innerHTML = '';
    for (const a of assets) {
      const el = document.createElement('div');
      el.className = 'asset';
      el.innerHTML = `<button class="asset-del" title="Remove this image from the list">×</button>` +
        `<img src="${a.url}"><div class="name">${escapeHtml(a.name)}</div>`;
      el.addEventListener('pointerdown', (e) => startAssetDrag(e, a));
      // The × removes the tile; keep its clicks from starting a drag.
      const del = el.querySelector('.asset-del');
      del.addEventListener('pointerdown', (e) => e.stopPropagation());
      del.addEventListener('click', (e) => { e.stopPropagation(); removeAsset(a); });
      assetList.appendChild(el);
    }
  }

  function removeAsset(a) {
    assets = assets.filter(x => x.path !== a.path);
    renderAssets();
    status('Removed image from the list. (Images already placed on the page stay.)');
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  }

  // ---------- Drag an asset onto the iframe ----------
  // Two tricks make this work across the iframe boundary:
  // 1. Pointer capture on the tile — every move/up is delivered to us, no
  //    matter what the cursor is over.
  // 2. pointer-events:none on the iframe during the drag — the frame can
  //    never steal the pointer stream.
  let ghost = null;
  function startAssetDrag(e, asset) {
    if (!editor) { status('Open a lecture first.'); return; }
    e.preventDefault();
    const tile = e.currentTarget;
    const stage = document.querySelector('#stage');
    try { tile.setPointerCapture(e.pointerId); } catch (_) {}
    iframe.style.pointerEvents = 'none';

    ghost = document.createElement('img');
    ghost.src = asset.url;
    Object.assign(ghost.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: 9999,
      width: '120px', opacity: '0.8', boxShadow: '0 4px 16px rgba(0,0,0,.3)',
      borderRadius: '6px', left: e.clientX + 12 + 'px', top: e.clientY + 12 + 'px'
    });
    document.body.appendChild(ghost);
    status('Drop the image where the blue line appears…');

    const move = (ev) => {
      ghost.style.left = ev.clientX + 12 + 'px';
      ghost.style.top = ev.clientY + 12 + 'px';
      // PowerPoint-style auto-scroll near the top/bottom edge of the page.
      const sr = stage.getBoundingClientRect();
      if (ev.clientY < sr.top + 48) stage.scrollTop -= 18;
      else if (ev.clientY > sr.bottom - 48) stage.scrollTop += 18;
      const pt = toIframeDoc(ev.clientX, ev.clientY);
      if (pt) editor.showInsertAt(pt.x, pt.y);
      else editor._hideInsert();
    };

    let finished = false;
    const finish = (ev, allowDrop) => {
      if (finished) return;
      finished = true;
      tile.removeEventListener('pointermove', move);
      iframe.style.pointerEvents = '';
      if (ghost) { ghost.remove(); ghost = null; }
      const pt = allowDrop ? toIframeDoc(ev.clientX, ev.clientY) : null;
      if (pt) {
        editor.showInsertAt(pt.x, pt.y); // make sure the target is current
        editor.dropInsert(asset.url, asset.name);
        status('Image inserted. Drag a corner to resize; double-click text to edit it.');
      } else {
        editor._hideInsert();
        status('Cancelled — dropped outside the page.');
      }
    };

    tile.addEventListener('pointermove', move);
    tile.addEventListener('pointerup', (ev) => finish(ev, true), { once: true });
    tile.addEventListener('pointercancel', (ev) => finish(ev, false), { once: true });
    tile.addEventListener('lostpointercapture', (ev) => finish(ev, false), { once: true });
  }

  // Convert app-window client coords to iframe-document coords (or null if
  // outside). The iframe is CSS-scaled by `zoom`, so screen deltas are divided
  // by zoom to get the document's own (unscaled) coordinates.
  function toIframeDoc(clientX, clientY) {
    const rect = iframe.getBoundingClientRect(); // already scaled on screen
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    const win = editor.win;
    return {
      x: (clientX - rect.left) / zoom + win.scrollX,
      y: (clientY - rect.top) / zoom + win.scrollY
    };
  }

  // ---------- Save / Export ----------
  async function saveHtml() {
    if (!editor) { status('Nothing to save.'); return; }
    const html = editor.getCleanHtml();
    const suggested = baseName(currentFile?.filePath, '-edited.html');
    const res = await window.api.saveHtml({ html, suggestedName: suggested });
    if (res.ok) status('Saved: ' + res.filePath);
  }

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

  async function exportPdf() {
    if (!editor) { status('Open a lecture first.'); return; }
    status('Exporting PDF…');

    const slides = detectSlides();
    let html, pageSize = null;
    if (slides) {
      // Mark slides, snapshot HTML, then clean the live document again.
      slides.els.forEach(el => el.setAttribute('data-ve-page', ''));
      html = editor.getCleanHtml();
      slides.els.forEach(el => el.removeAttribute('data-ve-page'));
      pageSize = { widthPx: slides.width, heightPx: slides.height };
      const printCss = `<style id="ve-print">
        @page { size: ${slides.width}px ${slides.height}px; margin: 0; }
        html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
        [data-ve-page] {
          margin: 0 auto !important;
          box-shadow: none !important;
          page-break-after: always; break-after: page;
          page-break-inside: avoid; break-inside: avoid;
        }
        [data-ve-page]:last-of-type { page-break-after: auto; break-after: auto; }
      </style>`;
      html = html.includes('</head>')
        ? html.replace('</head>', printCss + '</head>')
        : printCss + html;
      status(`Exporting PDF — ${slides.els.length} slides, one per page…`);
    } else {
      html = editor.getCleanHtml();
    }

    const suggested = baseName(currentFile?.filePath, '.pdf');
    const res = await window.api.exportPdf({ html, suggestedName: suggested, pageSize });
    if (res.ok) status('Exported PDF: ' + res.filePath);
    else status('Export ' + (res.error ? 'failed: ' + res.error : 'cancelled.'));
  }

  function baseName(filePath, ext) {
    if (!filePath) return 'lecture' + ext;
    const name = filePath.split(/[\\/]/).pop().replace(/\.html?$/i, '');
    return name + ext;
  }

  // ---------- Wire up ----------
  $('#btn-open').addEventListener('click', openHtml);
  $('#btn-open-2').addEventListener('click', openHtml);
  $('#btn-add-images').addEventListener('click', addImages);

  function beginPlace(type, msg) {
    if (!editor) { status('Open a lecture first.'); return; }
    editor.beginPlace(type);
    status(msg);
  }
  $('#btn-add-text').addEventListener('click', () =>
    beginPlace('text', 'Click on the page where the text should go… (Esc cancels)'));
  $('#btn-add-line').addEventListener('click', () =>
    beginPlace('line', 'Click where the divider line should go… (Esc cancels)'));
  $('#btn-add-table').addEventListener('click', () =>
    beginPlace('table', 'Click where the table should go… (Esc cancels)'));
  $('#btn-save').addEventListener('click', saveHtml);
  $('#btn-export').addEventListener('click', exportPdf);
  btnUndo.addEventListener('click', () => editor && editor.undo());
  btnRedo.addEventListener('click', () => editor && editor.redo());

  // Slide operations act on the current slide (selected, else viewport-center).
  $('#btn-slide-add').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    editor.addSlide(currentSlideEl());
    status('New slide added. Edit its title and content.');
  });
  $('#btn-slide-dup').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    editor.duplicateSlide(currentSlideEl());
    status('Slide duplicated.');
  });
  $('#btn-slide-del').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    const s = currentSlideEl();
    if (!s) { status('No slide to delete.'); return; }
    const n = editor.slides().length;
    if (n <= 1) { status('Cannot delete the only slide.'); return; }
    editor.deleteSlide(s);
    status('Slide deleted.');
  });

  // Zoom controls.
  $('#btn-zoom-in').addEventListener('click', () => setZoom(zoom + 0.1));
  $('#btn-zoom-out').addEventListener('click', () => setZoom(zoom - 0.1));
  $('#btn-zoom-label').addEventListener('click', () => setZoom(1));
  $('#btn-zoom-fit').addEventListener('click', fitZoom);
  // Ctrl + wheel to zoom, like every design tool.
  stage.addEventListener('wheel', (e) => {
    if (!editor || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });

  // App-level keyboard shortcuts (when focus isn't inside the iframe).
  window.addEventListener('keydown', (e) => {
    if (!editor) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveHtml(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(zoom + 0.1); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(zoom - 0.1); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom(1); }
    else if (e.key === 'Delete' && editor.selected) { editor.deleteSelected(); }
  });

  // Auto-open a file passed via the LVE_OPEN env var (used by automated tests;
  // later this powers "reopen last file").
  (async () => {
    const auto = await window.api.autoOpen();
    if (auto) {
      currentFile = auto;
      loadIntoIframe(auto.content, auto.dir);
      status('Opened: ' + auto.filePath);
    }
  })();
})();
