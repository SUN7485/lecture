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
  let brandFonts = null;    // cached [{ name, b64 }] from main, loaded on first use
  let zoom = 1;
  let activeSlide = null;   // the slide element considered "current"

  function status(msg) { statusEl.textContent = msg; }

  // ---------- Open HTML ----------
  async function openHtml() {
    const res = await window.api.openHtml();
    if (!res) return;
    currentFile = res;
    window.__currentFile = res;   // so the Enrich drawer can cache next to the file
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
      updateBrandBtn(); // reflect whether the opened file already carries the theme
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
      item.dataset.i = i;
      item.innerHTML =
        `<span class="drag" title="Drag to reorder">⠿</span>` +
        `<span class="num">${i + 1}</span>` +
        `<span class="title"></span>` +
        `<span class="reorder">` +
          `<button class="up" title="Move up"${i === 0 ? ' disabled' : ''}>▲</button>` +
          `<button class="down" title="Move down"${i === slides.length - 1 ? ' disabled' : ''}>▼</button>` +
        `</span>`;
      item.querySelector('.title').textContent = slideTitle(s, i);
      // Click the row (but not a control) to make it the current slide.
      item.addEventListener('click', (e) => {
        if (e.target.closest('button, .drag')) return;
        activeSlide = s; scrollToSlide(s); markActive(); updateSlideInfo();
      });
      item.querySelector('.up').addEventListener('click', (e) => { e.stopPropagation(); editor.moveSlide(s, i - 1); });
      item.querySelector('.down').addEventListener('click', (e) => { e.stopPropagation(); editor.moveSlide(s, i + 1); });
      item.querySelector('.drag').addEventListener('pointerdown', (e) => startSlideDrag(e, s, item));
      slideList.appendChild(item);
    });
  }

  // Drag a slide up/down the navigator to renumber it. Same pointer-capture
  // trick as the asset drag: every move/up comes to us regardless of hover.
  function startSlideDrag(e, slide, item) {
    if (!editor) return;
    const slides = editor.slides();
    if (slides.length < 2) return;
    e.preventDefault();
    try { item.setPointerCapture(e.pointerId); } catch (_) {}
    item.classList.add('dragging');
    status('Drag up or down, then release to drop.');

    const items = () => Array.from(slideList.children);
    const clearMarks = () => items().forEach(c => c.classList.remove('drop-above', 'drop-below'));
    const others = slides.filter(s => s !== slide);
    let targetK = null;

    const move = (ev) => {
      const list = items();
      let k = 0;
      for (const o of others) {
        const it = list[slides.indexOf(o)];
        const r = it.getBoundingClientRect();
        if (ev.clientY > r.top + r.height / 2) k++;
      }
      targetK = k;
      clearMarks();
      if (k < others.length) list[slides.indexOf(others[k])].classList.add('drop-above');
      else list[slides.indexOf(others[others.length - 1])].classList.add('drop-below');
      const lr = slideList.getBoundingClientRect();
      if (ev.clientY < lr.top + 24) slideList.scrollTop -= 12;
      else if (ev.clientY > lr.bottom - 24) slideList.scrollTop += 12;
    };

    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      item.removeEventListener('pointermove', move);
      item.classList.remove('dragging');
      clearMarks();
      if (commit && targetK != null) editor.moveSlide(slide, targetK);
    };
    item.addEventListener('pointermove', move);
    item.addEventListener('pointerup', () => finish(true), { once: true });
    item.addEventListener('pointercancel', () => finish(false), { once: true });
    item.addEventListener('lostpointercapture', () => finish(true), { once: true });
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

  // ---------- Import slides from another lecture (merge) ----------
  // Top-level sizable children = slides, same rule the canvas uses.
  function detectSlidesInDoc(doc) {
    return Array.from(doc.body.children).filter(el =>
      el.nodeType === 1 && el.offsetHeight > 150 && el.offsetWidth > 200);
  }

  // Rewrite a single element's inline `url(...)` refs to absolute file URLs.
  function fixStyleUrls(el, baseHref) {
    const s = el.getAttribute && el.getAttribute('style');
    if (!s || s.indexOf('url(') < 0) return;
    el.setAttribute('style', s.replace(/url\((['"]?)([^'")]+)\1\)/gi, (m, q, u) => {
      if (/^(data:|https?:|file:)/i.test(u)) return m;
      try { return 'url(' + q + new URL(u, baseHref).href + q + ')'; } catch (_) { return m; }
    }));
  }

  // Make a slide's relative asset URLs absolute so they keep resolving after the
  // slide is merged into a lecture that lives in a different folder.
  function absolutizeUrls(root, baseHref) {
    fixStyleUrls(root, baseHref);
    root.querySelectorAll('img').forEach(img => {
      const raw = img.getAttribute('src');
      if (raw && !/^(data:|https?:|file:)/i.test(raw)) img.setAttribute('src', img.src);
    });
    root.querySelectorAll('[style*="url("]').forEach(el => fixStyleUrls(el, baseHref));
  }

  // <style>/<link> from the source's <head>, so imported slides aren't naked
  // if the two lectures were built with different CSS.
  function collectImportedHead(doc, baseHref) {
    const out = [];
    doc.querySelectorAll('style').forEach(s => {
      if (s.id && /^ve-/.test(s.id)) return;
      out.push(s.outerHTML);
    });
    doc.querySelectorAll('link[rel~="stylesheet"]').forEach(l => {
      const href = l.getAttribute('href');
      if (href) { try { l.setAttribute('href', new URL(href, baseHref).href); } catch (_) {} }
      out.push(l.outerHTML);
    });
    return out;
  }

  // Render the source file in a throwaway hidden iframe so we can detect its
  // slides by layout (offset sizes), exactly like the main canvas does.
  function loadSourceSlides(html, dir) {
    return new Promise((resolve) => {
      const baseHref = 'file:///' + dir.replace(/\\/g, '/') + '/';
      const frame = document.createElement('iframe');
      Object.assign(frame.style, {
        position: 'fixed', left: '-10000px', top: '0',
        width: '1280px', height: '900px', border: '0', visibility: 'hidden'
      });
      let settled = false;
      const done = (val) => { if (settled) return; settled = true; frame.remove(); resolve(val); };
      frame.onload = () => setTimeout(() => {
        try {
          const doc = frame.contentDocument;
          const slides = detectSlidesInDoc(doc).map((el, i) => {
            absolutizeUrls(el, baseHref);
            return { title: slideTitle(el, i), w: el.offsetWidth, h: el.offsetHeight, html: el.outerHTML };
          });
          done({ slides, heads: collectImportedHead(doc, baseHref) });
        } catch (_) { done(null); }
      }, 60);
      frame.srcdoc = injectBase(html, baseHref);
      document.body.appendChild(frame);
      setTimeout(() => done(null), 8000); // safety net if onload never fires
    });
  }

  async function importSlidesFlow() {
    if (!editor) { status('Open a lecture first.'); return; }
    const res = await window.api.importHtml();
    if (!res) return;
    status('Reading slides from ' + res.filePath + '…');
    const data = await loadSourceSlides(res.content, res.dir);
    if (!data || !data.slides.length) { status('No slides detected in that file.'); return; }
    openImportModal(res, data);
  }

  let importModal = null;
  function closeImportModal() { if (importModal) { importModal.remove(); importModal = null; } }

  function openImportModal(res, data) {
    closeImportModal();
    const name = res.filePath.split(/[\\/]/).pop();
    const destSlides = editor.slides();
    const cur = currentSlideEl();
    const curIdx = destSlides.indexOf(cur);
    const dw = destSlides[0] && destSlides[0].offsetWidth;
    const dh = destSlides[0] && destSlides[0].offsetHeight;
    const mismatch = dw && data.slides.some(s => Math.abs(s.w - dw) > 6 || Math.abs(s.h - dh) > 6);

    const rows = data.slides.map((s, i) =>
      `<label class="imp-item"><input type="checkbox" data-i="${i}" checked>` +
      `<span class="imp-num">${i + 1}</span><span class="imp-title"></span></label>`).join('');

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      `<div class="modal">` +
        `<div class="modal-head">📥 Import slides from <b></b></div>` +
        `<div class="modal-body">` +
          `<div class="imp-where">` +
            `<label><input type="radio" name="imp-pos" value="after"${curIdx >= 0 ? ' checked' : ''}> ` +
              `After current slide${curIdx >= 0 ? ' (' + (curIdx + 1) + ')' : ''}</label>` +
            `<label><input type="radio" name="imp-pos" value="end"${curIdx < 0 ? ' checked' : ''}> At the end</label>` +
          `</div>` +
          `<div class="imp-tools"><button data-all>Select all</button><button data-none>Select none</button>` +
            (mismatch ? `<span class="imp-warn">⚠ Slide size differs from this deck — layout / one-page-per-slide PDF may be affected.</span>` : '') +
          `</div>` +
          `<div class="imp-list">${rows}</div>` +
        `</div>` +
        `<div class="modal-foot">` +
          `<button data-cancel>Cancel</button>` +
          `<button class="primary" data-confirm>Import</button>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(backdrop);
    importModal = backdrop;
    // Fill titles/name as text so lecture content can't inject markup.
    backdrop.querySelector('.modal-head b').textContent = name;
    backdrop.querySelectorAll('.imp-item').forEach((row, i) => {
      row.querySelector('.imp-title').textContent = data.slides[i].title;
    });

    const confirmBtn = backdrop.querySelector('[data-confirm]');
    const checks = () => Array.from(backdrop.querySelectorAll('.imp-list input[type=checkbox]'));
    const updateConfirm = () => {
      const n = checks().filter(c => c.checked).length;
      confirmBtn.textContent = n ? `Import ${n} slide${n > 1 ? 's' : ''}` : 'Import';
      confirmBtn.disabled = !n;
    };
    backdrop.querySelector('[data-all]').addEventListener('click', () => { checks().forEach(c => c.checked = true); updateConfirm(); });
    backdrop.querySelector('[data-none]').addEventListener('click', () => { checks().forEach(c => c.checked = false); updateConfirm(); });
    backdrop.querySelector('.imp-list').addEventListener('change', updateConfirm);
    const cancel = () => { closeImportModal(); status('Import cancelled.'); };
    backdrop.querySelector('[data-cancel]').addEventListener('click', cancel);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cancel(); });
    confirmBtn.addEventListener('click', () => {
      const chosen = checks().filter(c => c.checked).map(c => data.slides[+c.dataset.i]);
      if (!chosen.length) return;
      const pos = backdrop.querySelector('input[name=imp-pos]:checked').value;
      const afterSlide = pos === 'after' ? (cur || destSlides.slice(-1)[0]) : destSlides.slice(-1)[0];
      editor.importSlides(chosen.map(s => s.html), afterSlide, data.heads, name);
      closeImportModal();
      status(`Imported ${chosen.length} slide(s) from ${name}.`);
    });
    updateConfirm();
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
      assetList.innerHTML = '<p class="hint">Click <b>🖼 Image</b> to load pictures, then drag them onto a slide — or double-click a picture to drop it on the current slide.</p>';
      return;
    }
    assetList.innerHTML = '';
    for (const a of assets) {
      const el = document.createElement('div');
      el.className = 'asset';
      el.title = 'Drag onto a slide — or double-click to add it to the current slide';
      el.innerHTML = `<button class="asset-del" title="Remove this image from the list">×</button>` +
        `<img src="${a.url}"><div class="name">${escapeHtml(a.name)}</div>`;
      el.addEventListener('pointerdown', (e) => startAssetDrag(e, a));
      // Double-click = drop it on the current slide (no dragging needed).
      el.addEventListener('dblclick', () => {
        if (!editor) { status('Open a lecture first.'); return; }
        const slide = currentSlideEl();
        editor.insertImageInto(a.url, a.name, slide);
        if (slide) { activeSlide = slide; scrollToSlide(slide); updateSlideInfo(); }
        status('Added image to the current slide. Drag a corner to resize.');
      });
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

  // ---------- MiM brand identity (one-click fonts + palette) ----------
  const btnBrand = $('#btn-brand');
  function updateBrandBtn() {
    const on = !!(editor && editor.hasBrandTheme());
    btnBrand.classList.toggle('active', on);
    btnBrand.textContent = on ? '✨ MiM Identity ✓' : '✨ MiM Identity';
    btnBrand.title = on
      ? 'MiM identity applied — real ministry fonts + official palette. Click to revert to the original.'
      : 'Apply the full MiM identity — real ministry fonts + official color palette. Click again to revert.';
  }
  btnBrand.addEventListener('click', async () => {
    if (!editor) { status('Open a lecture first.'); return; }
    if (editor.hasBrandTheme()) {
      editor.removeBrandTheme();
      updateBrandBtn();
      status('Reverted to the original fonts and colors.');
      return;
    }
    if (!brandFonts) {
      status('Loading ministry fonts…');
      try { brandFonts = await window.api.getFonts(); } catch (_) { brandFonts = []; }
    }
    editor.applyBrandTheme(brandFonts);
    updateBrandBtn();
    status(brandFonts.length
      ? 'Applied MiM identity — real fonts + official palette (off-brand gold → ministry pink). Click again to compare with the original.'
      : 'Applied MiM palette. (Fonts folder not found — colors only.)');
  });

  // ---------- Lecture Studio (docked AI enrichment panel) ----------
  $('#btn-enrich').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    if (window.Studio) window.Studio.toggle();
  });

  // Scroll the stage so a node inside the editor iframe is centered — used by
  // Studio to bring a ghost preview into view. getBoundingClientRect inside the
  // iframe is content-local, so map it through the iframe's on-screen position
  // and effective zoom.
  function revealInStage(node) {
    if (!node || !editor || !editor.iframe) return;
    const ifr = editor.iframe;
    const ir = ifr.getBoundingClientRect();
    const scale = ir.width / (ifr.offsetWidth || ir.width) || 1;
    let nr;
    try { nr = node.getBoundingClientRect(); } catch (_) { return; }
    const sr = stage.getBoundingClientRect();
    const screenY = ir.top + nr.top * scale;
    const target = stage.scrollTop + (screenY - sr.top) - stage.clientHeight / 2 + (nr.height * scale) / 2;
    stage.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
  window.__revealInStage = revealInStage;

  // ---------- Brand Kit (custom fonts + palette) ----------
  $('#btn-brandkit').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    if (window.BrandKit) window.BrandKit.open();
  });

  // ---------- Settings (API keys) ----------
  $('#btn-settings').addEventListener('click', () => {
    if (window.Settings) window.Settings.open();
  });

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
  $('#btn-slide-import').addEventListener('click', importSlidesFlow);
  window.__importFlow = importSlidesFlow; // hook for automated tests
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
      window.__currentFile = auto;
      loadIntoIframe(auto.content, auto.dir);
      status('Opened: ' + auto.filePath);
      return;
    }
    // Offer to reopen the last lecture straight from the empty screen.
    const last = await window.api.getLastFile();
    if (last) {
      const name = last.filePath.split(/[\\/]/).pop();
      const btn = document.createElement('button');
      btn.className = 'big';
      btn.style.marginLeft = '10px';
      btn.textContent = '↩ Reopen ' + name;
      btn.title = last.filePath;
      btn.addEventListener('click', () => {
        currentFile = last;
        window.__currentFile = last;
        loadIntoIframe(last.content, last.dir);
        status('Opened: ' + last.filePath);
      });
      const holder = document.querySelector('.empty-inner');
      if (holder) holder.appendChild(btn);
    }
  })();
})();
