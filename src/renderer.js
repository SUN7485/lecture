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

  // ---------- Word import (010B): .docx -> mammoth -> DeckImporter -> deck ----------
  async function importDocx() {
    const res = await window.api.openDocx();
    if (!res) return;
    if (!window.mammoth || !window.DeckImporter) { status('Word import is unavailable (mammoth failed to load).'); return; }
    status('Converting ' + res.filePath + '…');
    try {
      const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
      const result = await window.mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
      const name = res.filePath.split(/[\\/]/).pop().replace(/\.docx$/i, '');
      const deckHtml = window.DeckImporter.fromWordHtml(result.value, { title: name });
      const dir = res.filePath.slice(0, res.filePath.length - res.filePath.split(/[\\/]/).pop().length - 1);
      currentFile = { filePath: dir + '\\' + name + '.html', dir, content: deckHtml };
      window.__currentFile = currentFile;
      loadIntoIframe(deckHtml, dir);
      status('Imported from Word: ' + name + (result.messages.length ? ' (' + result.messages.length + ' mammoth notice(s))' : ''));
    } catch (e) {
      status('Word import failed: ' + e.message);
    }
  }

  function loadIntoIframe(html, dir) {
    const baseHref = 'file:///' + dir.replace(/\\/g, '/') + '/';
    const htmlWithBase = injectBase(html, baseHref);

    iframe.onload = () => {
      editor = new window.LectureEditor();
      editor.onChange = ({ canUndo, canRedo }) => {
        btnUndo.disabled = !canUndo;
        btnRedo.disabled = !canRedo;
        if (window.SlideDoctor) runDoctor(); // keep the 🩺 badge live as the user edits
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
      if (window.SlideDoctor) runDoctor(); // seed the 🩺 badge count for this deck
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
    // Older app versions saved a stale <base> into the file; strip any before
    // inserting the fresh load-time one (which getCleanHtml removes on save).
    html = html.replace(/<base\b[^>]*>/gi, '');
    const baseTag = `<base data-ve-base href="${baseHref}">`;
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

  // Build the print-ready HTML + page size (shared by export and preview).
  function buildPdfHtml() {
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
    } else {
      html = editor.getCleanHtml();
    }
    return { html, pageSize, slideCount: slides ? slides.els.length : 0 };
  }

  async function exportPdf() {
    if (!editor) { status('Open a lecture first.'); return; }
    status('Exporting PDF…');
    const { html, pageSize, slideCount } = buildPdfHtml();
    if (slideCount) status(`Exporting PDF — ${slideCount} slides, one per page…`);
    const suggested = baseName(currentFile?.filePath, '.pdf');
    const res = await window.api.exportPdf({ html, suggestedName: suggested, pageSize });
    if (res.ok) status('Exported PDF: ' + res.filePath);
    else status('Export ' + (res.error ? 'failed: ' + res.error : 'cancelled.'));
  }

  async function previewPdf() {
    if (!editor) { status('Open a lecture first.'); return; }
    status('Building PDF preview…');
    const { html, pageSize } = buildPdfHtml();
    const res = await window.api.previewPdf({ html, pageSize });
    status(res.ok ? 'Preview opened — check it, then export.' : 'Preview failed: ' + (res.error || ''));
  }

  function baseName(filePath, ext) {
    if (!filePath) return 'lecture' + ext;
    const name = filePath.split(/[\\/]/).pop().replace(/\.html?$/i, '');
    return name + ext;
  }

  // ---------- Wire up ----------
  $('#btn-open').addEventListener('click', openHtml);
  $('#btn-open-2').addEventListener('click', openHtml);
  $('#btn-import-docx').addEventListener('click', importDocx);
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
  $('#btn-preview').addEventListener('click', previewPdf);

  // ---------- MiM brand identity (one-click fonts + palette) ----------
  const btnBrand = $('#btn-brand');
  function updateBrandBtn() {
    const kit = editor ? editor.activeThemeKit() : null;
    const on = kit === 'MiM' || kit === 'MiM-print';
    btnBrand.classList.toggle('active', on);
    btnBrand.textContent = kit === 'MiM' ? '✨ MiM Screen ✓'
      : kit === 'MiM-print' ? '✨ MiM Print ✓' : '✨ MiM Identity';
    btnBrand.title = kit === 'MiM'
      ? 'MiM Screen palette (brand book v1.1) applied. Click for the Print palette (Pantone sheet).'
      : kit === 'MiM-print'
      ? 'MiM Print palette (official Pantone sheet) applied. Click to revert to the original.'
      : 'Apply the MiM identity — ministry fonts + official palette. Cycles: Screen → Print → off.';
  }
  btnBrand.addEventListener('click', async () => {
    if (!editor) { status('Open a lecture first.'); return; }
    const kit = editor.activeThemeKit();
    if (kit === 'MiM-print') {
      editor.removeBrandTheme();
      updateBrandBtn();
      status('Reverted to the original fonts and colors.');
      return;
    }
    if (!brandFonts) {
      status('Loading ministry fonts…');
      try { brandFonts = await window.api.getFonts(); } catch (_) { brandFonts = []; }
    }
    const next = kit === 'MiM' ? 'MiM-print' : 'MiM';
    editor.applyBrandTheme(brandFonts, next);
    updateBrandBtn();
    const audit = editor.themeAudit();
    const label = next === 'MiM-print' ? 'Print palette' : 'Screen palette';
    const hint = next === 'MiM-print' ? 'Click again to revert.' : 'Click again for the Print palette.';
    if (!brandFonts.length) {
      status(`Applied MiM ${label}. (Fonts folder not found — colors only.) ${hint}`);
    } else if (audit) {
      const fontMsg = audit.fontPct >= 90 ? `fonts cover ${audit.fontPct}% of text`
        : audit.fontPct > 0 ? `⚠ fonts only cover ${audit.fontPct}% of text`
        : '⚠ fonts embedded but no text uses them';
      status(`Applied MiM ${label} — ${fontMsg}, ${audit.recolored.length}/${audit.recolored.length + audit.missed.length} colors remapped. ${hint}`);
    }
  });

  // ---------- Speed layer (009): Ctrl+K command palette + slide hotkeys ----------
  // ACTIONS is the single source of truth: the palette lists it, hotkeys below
  // dispatch the same run() functions, so the two entry points never drift.
  function gotoSlide(dir) {
    if (!editor) return;
    const slides = editor.slides();
    if (!slides.length) return;
    let idx = slides.indexOf(currentSlideEl());
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(slides.length - 1, idx + dir));
    editor.select(slides[idx]);
    activeSlide = slides[idx];
    scrollToSlide(slides[idx]);
    updateSlideInfo();
  }
  function slideDeleteAction() {
    if (!editor) { status('Open a lecture first.'); return; }
    const s = currentSlideEl();
    if (!s) { status('No slide to delete.'); return; }
    if (editor.slides().length <= 1) { status('Cannot delete the only slide.'); return; }
    editor.deleteSlide(s);
    status('Slide deleted.');
  }
  const ACTIONS = [
    { id: 'open', ar: 'فتح ملف', en: 'Open file', run: openHtml },
    { id: 'import-docx', ar: 'استيراد Word', en: 'Import Word document', run: importDocx },
    { id: 'save', ar: 'حفظ', en: 'Save', run: saveHtml },
    { id: 'export-pdf', ar: 'تصدير PDF', en: 'Export PDF', run: exportPdf },
    { id: 'insert-text', ar: 'إدراج نص', en: 'Insert text', run: () => beginPlace('text', 'Click on the page where the text should go… (Esc cancels)') },
    { id: 'insert-image', ar: 'إدراج صورة', en: 'Insert image', run: addImages },
    { id: 'add-slide', ar: 'إضافة شريحة', en: 'Add slide', run: () => { if (!editor) return status('Open a lecture first.'); editor.addSlide(currentSlideEl()); status('New slide added. Edit its title and content.'); } },
    { id: 'dup-slide', ar: 'تكرار الشريحة', en: 'Duplicate slide', run: () => { if (!editor) return status('Open a lecture first.'); editor.duplicateSlide(currentSlideEl()); status('Slide duplicated.'); } },
    { id: 'del-slide', ar: 'حذف الشريحة', en: 'Delete slide', run: slideDeleteAction },
    { id: 'next-slide', ar: 'الشريحة التالية', en: 'Next slide', run: () => gotoSlide(1) },
    { id: 'prev-slide', ar: 'الشريحة السابقة', en: 'Previous slide', run: () => gotoSlide(-1) },
    { id: 'undo', ar: 'تراجع', en: 'Undo', run: () => editor && editor.undo() },
    { id: 'redo', ar: 'إعادة', en: 'Redo', run: () => editor && editor.redo() },
    { id: 'doctor', ar: 'فحص الشرائح', en: 'Run doctor', run: () => { if (window.SlideDoctor) toggleDoctor(); } },
    { id: 'brand', ar: 'تبديل هوية MiM', en: 'Toggle brand theme', run: () => btnBrand.click() },
    { id: 'numerals', ar: 'تبديل الأرقام عربي لاتيني', en: 'Toggle numerals', run: () => $('#btn-numerals').click() },
    { id: 'date-hijri', ar: 'إدراج تاريخ هجري', en: 'Insert Hijri date', run: () => $('#btn-date-hijri').click() },
    { id: 'date-greg', ar: 'إدراج تاريخ ميلادي', en: 'Insert Gregorian date', run: () => $('#btn-date-greg').click() },
    { id: 'present', ar: 'عرض الشرائح', en: 'Present', run: () => $('#btn-present').click() },
  ];

  let cmdkEl = null, cmdkIndex = 0, cmdkFiltered = ACTIONS;

  function ensureCmdk() {
    if (cmdkEl) return cmdkEl;
    cmdkEl = document.createElement('div');
    cmdkEl.id = 'cmdk';
    cmdkEl.innerHTML = '<div class="cmdk-box"><input class="cmdk-input" placeholder="اكتب أمرًا… (Type a command…)"><ul class="cmdk-list"></ul></div>';
    cmdkEl.addEventListener('mousedown', (e) => { if (e.target === cmdkEl) closeCmdk(); });
    const input = cmdkEl.querySelector('.cmdk-input');
    input.addEventListener('input', () => { cmdkIndex = 0; renderCmdk(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdkIndex = Math.min(cmdkFiltered.length - 1, cmdkIndex + 1); renderCmdk(input.value); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkIndex = Math.max(0, cmdkIndex - 1); renderCmdk(input.value); }
      else if (e.key === 'Enter') { e.preventDefault(); runCmdk(cmdkIndex); }
      else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
    });
    document.body.appendChild(cmdkEl);
    return cmdkEl;
  }
  function renderCmdk(q) {
    const needle = (q || '').trim().toLowerCase();
    cmdkFiltered = !needle ? ACTIONS : ACTIONS.filter(a => (a.ar + ' ' + a.en + ' ' + a.id).toLowerCase().includes(needle));
    if (cmdkIndex >= cmdkFiltered.length) cmdkIndex = 0;
    const list = cmdkEl.querySelector('.cmdk-list');
    list.innerHTML = '';
    cmdkFiltered.forEach((a, i) => {
      const li = document.createElement('li');
      li.className = 'cmdk-row' + (i === cmdkIndex ? ' on' : '');
      li.textContent = `${a.ar} — ${a.en}`;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); runCmdk(i); });
      list.appendChild(li);
    });
  }
  function runCmdk(i) {
    const a = cmdkFiltered[i];
    closeCmdk();
    if (a) a.run();
  }
  function openCmdk() {
    const el = ensureCmdk();
    el.classList.add('open');
    cmdkIndex = 0;
    const input = el.querySelector('.cmdk-input');
    input.value = '';
    renderCmdk('');
    input.focus();
  }
  function closeCmdk() { if (cmdkEl) cmdkEl.classList.remove('open'); }
  window.__openCmdk = openCmdk; // hook for automated tests

  // True while the user is typing in a normal input/textarea or editing text
  // inside the deck — slide hotkeys and shorthand must never fire there.
  function typingElsewhere() {
    const ae = document.activeElement;
    if (ae && /^(input|textarea)$/i.test(ae.tagName)) return true;
    if (ae && ae.isContentEditable) return true;
    const iae = editor && editor.doc && editor.doc.activeElement;
    return !!(iae && iae.isContentEditable);
  }

  // ---------- Lecture Studio (docked AI enrichment panel) ----------
  $('#btn-enrich').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    if (window.Studio) window.Studio.toggle();
  });

  $('#btn-doctor').addEventListener('click', toggleDoctor);

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

  // ---------- Slide Doctor (008B): lint badge + docked issue list ----------
  // UI over window.SlideDoctor.analyze(editor). Issue objects are invalid across
  // editor.commit()/undo() — always re-scan (runDoctor) rather than reuse them.
  let drOpen = false;
  let drIssues = [];
  let drDock = null;
  let drScanMs = 0;
  let drView = 'type';   // 'type' | 'slide' — dock grouping mode

  function ensureDoctorDock() {
    if (drDock) return drDock;
    drDock = document.createElement('aside');
    drDock.id = 'doctor-dock';
    drDock.innerHTML =
      '<div class="dr-head">🩺 فحص الشرائح<span class="dr-score" title="درجة سلامة العرض"></span><span class="spacer"></span>' +
      '<button class="dr-rescan" title="إعادة الفحص">🔄</button>' +
      '<button class="dr-fixall" title="إصلاح كل الملاحظات القابلة للإصلاح">إصلاح الكل</button>' +
      '<button class="dr-x" title="إغلاق">✕</button></div>' +
      '<div class="dr-tabs"><button data-v="type" class="on">حسب النوع</button><button data-v="slide">حسب الشريحة</button></div>' +
      '<div class="dr-list"></div>' +
      '<div class="dr-foot"></div>';
    drDock.querySelector('.dr-fixall').addEventListener('click', fixAll);
    drDock.querySelector('.dr-x').addEventListener('click', () => toggleDoctor());
    drDock.querySelector('.dr-rescan').addEventListener('click', () => { runDoctor(); renderDoctor(); status('أُعيد الفحص.'); });
    drDock.querySelectorAll('.dr-tabs button').forEach((b) => b.addEventListener('click', () => {
      drView = b.dataset.v;
      drDock.querySelectorAll('.dr-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      renderDoctor();
    }));
    $('#body').appendChild(drDock); // flex sibling of #stage, docks on the right
    return drDock;
  }

  // Run every auto-fixable issue on the live DOM, then a SINGLE commit (one undo
  // step). Issue `el` refs stay valid across fixes because no fix replaces an
  // element or innerHTML — only commit/undo does, so we commit just once at the end.
  function fixAll() {
    if (!editor || !drIssues.length) return;
    const fixable = drIssues.filter((i) => i.fix);
    if (!fixable.length) { status('لا توجد ملاحظات قابلة للإصلاح تلقائيًا.'); return; }
    const before = drIssues.length;
    fixable.forEach((i) => i.fix());
    editor.commit();
    runDoctor(); // re-scan; drIssues now reflects what actually remains
    status(`أصلحت ${before - drIssues.length} ملاحظة، المتبقّي ${drIssues.length}.`);
  }

  function runDoctor() {
    if (!editor || !window.SlideDoctor) return;
    const t0 = performance.now();
    drIssues = window.SlideDoctor.analyze(editor);
    drScanMs = Math.max(1, Math.round(performance.now() - t0));
    const btn = $('#btn-doctor');
    btn.textContent = '🩺 الفحص' + (drIssues.length ? ` (${drIssues.length})` : '');
    btn.classList.toggle('has-issues', drIssues.length > 0);
    if (drOpen) renderDoctor();
  }

  // Health score: start at 100, errors cost 12, warnings 4. Purely a
  // motivational readout — the list is the real product.
  function doctorScore() {
    const errs = drIssues.filter((i) => i.severity === 'error').length;
    const warns = drIssues.length - errs;
    return Math.max(0, 100 - 12 * errs - 4 * warns);
  }
  function renderDoctorMeta() {
    const dock = ensureDoctorDock();
    const score = doctorScore();
    const pill = dock.querySelector('.dr-score');
    pill.textContent = score + '/100';
    pill.className = 'dr-score ' + (score >= 90 ? 'ok' : score >= 60 ? 'mid' : 'bad');
    const ignored = editor ? editor.doc.querySelectorAll('[data-ve-dr-ignore]').length : 0;
    const foot = dock.querySelector('.dr-foot');
    foot.innerHTML = 'فُحصت ' + (editor ? editor.slides().length : 0) + ' شريحة في ' + drScanMs + 'ms' +
      (ignored ? ' · <a class="dr-restore" href="#">استعادة ' + ignored + ' متجاهَلة</a>' : '');
    const rst = foot.querySelector('.dr-restore');
    if (rst) rst.addEventListener('click', (e) => {
      e.preventDefault();
      editor.doc.querySelectorAll('[data-ve-dr-ignore]').forEach((el) => el.removeAttribute('data-ve-dr-ignore'));
      editor.commit(); runDoctor(); renderDoctor();
      status('استُعيدت الملاحظات المتجاهَلة.');
    });
  }

  function renderDoctor() {
    renderDoctorMeta();
    const list = ensureDoctorDock().querySelector('.dr-list');
    list.innerHTML = '';
    if (!drIssues.length) {
      list.innerHTML = '<div class="dr-empty">لا توجد ملاحظات — الشرائح سليمة ✅</div>';
      return;
    }
    if (drView === 'slide') {
      const bySlide = new Map();
      drIssues.forEach((iss) => {
        if (!bySlide.has(iss.slideIndex)) bySlide.set(iss.slideIndex, []);
        bySlide.get(iss.slideIndex).push(iss);
      });
      [...bySlide.keys()].sort((a, b) => a - b).forEach((sIdx) => {
        const rows = bySlide.get(sIdx);
        const gh = document.createElement('div');
        gh.className = 'dr-group';
        gh.textContent = 'شريحة ' + (sIdx + 1) + ' (' + rows.length + ')';
        list.appendChild(gh);
        rows.sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));
        rows.forEach((iss) => list.appendChild(doctorRow(iss, iss.severity === 'error' ? 'err' : 'warn')));
      });
      return;
    }
    // Errors first, then warnings.
    [{ sev: 'error', label: 'أخطاء', cls: 'err' }, { sev: 'warn', label: 'تنبيهات', cls: 'warn' }]
      .forEach((g) => {
        const rows = drIssues
          .map((iss, idx) => ({ iss, idx }))
          .filter((x) => x.iss.severity === g.sev);
        if (!rows.length) return;
        const gh = document.createElement('div');
        gh.className = 'dr-group';
        gh.textContent = `${g.label} (${rows.length})`;
        list.appendChild(gh);
        rows.forEach(({ iss }) => list.appendChild(doctorRow(iss, g.cls)));
      });
  }

  function doctorRow(iss, cls) {
    const row = document.createElement('div');
    row.className = `dr-row ${cls}`;
    const chip = document.createElement('span');
    chip.className = 'dr-chip';
    chip.textContent = `شريحة ${iss.slideIndex + 1}`;
    const msg = document.createElement('div');
    msg.textContent = iss.message;
    row.appendChild(chip);
    row.appendChild(msg);
    if (iss.fix) {
      const fix = document.createElement('button');
      fix.className = 'dr-fix';
      fix.textContent = 'إصلاح';
      fix.addEventListener('click', (e) => {
        e.stopPropagation();
        iss.fix(); editor.commit(); runDoctor(); // re-scan: iss is stale after commit
        status('تم الإصلاح.');
      });
      row.appendChild(fix);
    }
    const ign = document.createElement('button');
    ign.className = 'dr-ign';
    ign.textContent = '✕';
    ign.title = 'تجاهل هذه الملاحظة (تُحفظ مع الملف)';
    ign.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = iss.el.getAttribute('data-ve-dr-ignore') || '';
      if (!(' ' + cur + ' ').includes(' ' + iss.ruleId + ' ')) {
        iss.el.setAttribute('data-ve-dr-ignore', (cur + ' ' + iss.ruleId).trim());
      }
      editor.commit(); runDoctor();
      status('تم تجاهل الملاحظة — «استعادة» في أسفل القائمة تعيدها.');
    });
    row.appendChild(ign);
    row.addEventListener('click', () => focusIssue(iss));
    return row;
  }

  function focusIssue(issue) {
    const el = issue.el;
    if (!el || !el.isConnected) return;
    // The iframe is scaled by `zoom`; center the element inside the scrolling stage.
    // Slides are position:relative, so el.offsetTop is slide-relative — accumulate
    // offsetTop up the offsetParent chain to get the true document-top of the element.
    const z = (typeof zoom === 'number') ? zoom : 1;
    const stageEl = $('#stage');
    let y = 0;
    for (let n = el; n; n = n.offsetParent) y += n.offsetTop;
    const top = (y + el.offsetHeight / 2) * z - stageEl.clientHeight / 2;
    stageEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    const d = editor.doc;
    if (!d.getElementById('ve-dr-style')) {
      const st = d.createElement('style');
      st.id = 've-dr-style';
      st.textContent = '.ve-dr-flash{outline:3px solid #e11d48 !important;outline-offset:2px;transition:outline-color .2s;}';
      d.head.appendChild(st);
    }
    el.classList.add('ve-dr-flash');
    setTimeout(() => el.classList.remove('ve-dr-flash'), 1600);
  }

  function toggleDoctor() {
    if (!editor) { status('Open a lecture first.'); return; }
    drOpen = !drOpen;
    ensureDoctorDock().classList.toggle('open', drOpen);
    if (drOpen) { runDoctor(); renderDoctor(); }
  }

  // ---------- Brand Kit (custom fonts + palette) ----------
  $('#btn-brandkit').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    if (window.BrandKit) window.BrandKit.open();
  });

  // ---------- Arabic-first pack (011): numeral toggle + date helper ----------
  $('#btn-numerals').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    // Untouched decks carry plain Western digits, so an unset attribute means
    // 'latin' — the first click's default action is to convert TO Arabic-Indic.
    const cur = editor.doc.documentElement.getAttribute('data-ve-numerals') || 'latin';
    const next = cur === 'ar' ? 'latin' : 'ar';
    editor.setNumerals(next);
    status(next === 'ar' ? 'تم التحويل إلى الأرقام العربية (١٢٣).' : 'Converted to Western numerals (123).');
  });
  $('#btn-date-hijri').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    editor.insertDate('hijri');
    status('تم إدراج التاريخ الهجري.');
  });
  $('#btn-date-greg').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    editor.insertDate('greg');
    status('تم إدراج التاريخ الميلادي.');
  });

  // ---------- Present mode (014) ----------
  $('#btn-present').addEventListener('click', () => {
    if (!editor) { status('Open a lecture first.'); return; }
    if (window.Presenter) window.Presenter.start(editor);
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveHtml(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(zoom + 0.1); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(zoom - 0.1); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom(1); }
    else if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && editor.selected) { editor.deleteSelected(); }
    // ---- 009 slide hotkeys: skip entirely while typing text elsewhere ----
    else if (typingElsewhere()) { /* no-op */ }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); editor.addSlide(currentSlideEl()); status('New slide added. Edit its title and content.'); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); editor.duplicateSlide(currentSlideEl()); status('Slide duplicated.'); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); slideDeleteAction(); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); gotoSlide(1); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); gotoSlide(-1); }
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
