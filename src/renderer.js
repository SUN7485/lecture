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

  // Set by a home-screen card, consumed once the deck is on screen.
  let pendingIntent = null;

  /** Point the user at the export their chosen job was actually about. */
  function applyIntent(intent) {
    const btn = $(intent.kind === 'pptx' ? '#btn-export-pptx' : '#btn-export');
    if (!btn) return;
    btn.classList.add('suggest');
    // Nudge once, then get out of the way.
    btn.addEventListener('click', () => btn.classList.remove('suggest'), { once: true });
    if (intent.hint) toast(intent.hint);
  }

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
    if (!window.mammoth || !window.DeckImporter) { status('استيراد Word غير متاح الآن (تعذّر تحميل مكتبة mammoth).'); return; }
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
      status('تم الاستيراد من Word: ' + name + (result.messages.length ? ' (' + result.messages.length + ' ملاحظة)' : ''));
    } catch (e) {
      status('تعذّر استيراد Word: ' + e.message);
    }
  }

  // ---------- PDF import: reconstruct a PDF into an editable deck ----------
  // The reconstruction runs in the main process and blocks it, so the status is
  // painted (and given two frames to actually reach the screen) BEFORE the call
  // — otherwise a 2-second conversion looks like a dead button.
  async function importPdf() {
    const picked = await window.api.pickPdf();
    if (!picked) return;
    const name = picked.filePath.split(/[\\/]/).pop();
    status('جارٍ إعادة بناء ' + name + ' — قد يستغرق ذلك بضع ثوانٍ…');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    let res;
    try {
      res = await window.api.importPdf({ filePath: picked.filePath });
    } catch (e) {
      status('تعذّر استيراد PDF: ' + e.message);
      return;
    }
    if (!res) return;
    if (res.error) { status('تعذّر استيراد PDF: ' + res.error); return; }

    currentFile = { filePath: res.filePath, dir: res.dir, content: res.content };
    window.__currentFile = currentFile;
    loadIntoIframe(res.content, res.dir);
    // AFTER the load: loadIntoIframe clears this, and it is what marks the open
    // deck as PDF-sourced (test hook today, export routing tomorrow).
    window.__importedPdf = res.sourcePdf;
    status(
      `تم استيراد ${name}: ${res.stats.pages} صفحة و${res.stats.objects} عنصرًا ` +
      `في ${(res.stats.ms / 1000).toFixed(1)} ث. عدّلها ثم صدّرها PDF أو PowerPoint.`
    );
  }

  // LLM chats hand users HTML wrapped in a markdown fence or with prose
  // before <!DOCTYPE>. Any text before the doctype forces quirks mode and
  // the parser hoists the deck's <style> into <body>, where it beats the
  // <head> theme kit in cascade order — kits then change fonts but never
  // colors (EVO-013). Strip the junk before the markup reaches the DOM.
  function sanitizeLlmHtml(html) {
    if (!html) return html;
    const m = /<!DOCTYPE\s+html/i.exec(html) || /<html[\s>]/i.exec(html);
    let out = (m && m.index > 0) ? html.slice(m.index) : html;
    const end = out.toLowerCase().lastIndexOf('</html>');
    if (end !== -1) out = out.slice(0, end + 7) + '\n';
    return out;
  }

  function loadIntoIframe(html, dir) {
    // Whatever is being loaded, it is not a PDF import until importPdf() says
    // so immediately after this call. Leaving a stale value here would make a
    // plain HTML lecture look PDF-sourced to anything that routes on origin
    // (the planned "PDF-in uses the reconstruction exporter" rule).
    window.__importedPdf = null;
    html = sanitizeLlmHtml(html);
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
          status('تم استبدال الصورة.');
        }
      };
      editor.onPlaced = (type) => {
        if (!type) { status('أُلغي الإدراج.'); return; }
        status(type === 'text'
          ? 'اكتب النص — ثم انقر في أي مكان آخر عند الانتهاء.'
          : 'تم الإدراج. انقر عليه لتنسيقه أو تحديد حاويته أو حذفه.');
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
      status('جاهز. انقر مرتين على أي نص (أو حدّده واضغط ✏ تحرير النص) لتغيير الكلمات. اسحب الصور، وأضف الشرائح، وكبّر العرض لتعمل براحة.');
      // Consumed here rather than at click time: the deck has to be on screen
      // before pointing at the button that acts on it.
      if (pendingIntent) { applyIntent(pendingIntent); pendingIntent = null; }
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
      slideList.innerHTML = '<p class="hint">لم تُكتشف شرائح — يبدو أن هذا مستند عادي.</p>';
      return;
    }
    slideList.innerHTML = '';
    slides.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'slide-item' + (s === activeSlide ? ' active' : '');
      item.dataset.i = i;
      item.innerHTML =
        `<span class="drag" title="اسحب لإعادة الترتيب">⠿</span>` +
        `<span class="num">${i + 1}</span>` +
        `<span class="title"></span>` +
        `<span class="reorder">` +
          `<button class="up" title="تحريك لأعلى"${i === 0 ? ' disabled' : ''}>▲</button>` +
          `<button class="down" title="تحريك لأسفل"${i === slides.length - 1 ? ' disabled' : ''}>▼</button>` +
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
    status('اسحب لأعلى أو لأسفل ثم أفلت.');

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
    slideInfo.textContent = `شريحة ${idx + 1} من ${slides.length}`;
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
      frame.srcdoc = injectBase(sanitizeLlmHtml(html), baseHref);
      document.body.appendChild(frame);
      setTimeout(() => done(null), 8000); // safety net if onload never fires
    });
  }

  async function importSlidesFlow() {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    const res = await window.api.importHtml();
    if (!res) return;
    status('جارٍ قراءة الشرائح من ' + res.filePath + '…');
    const data = await loadSourceSlides(res.content, res.dir);
    if (!data || !data.slides.length) { status('لم تُكتشف شرائح في ذلك الملف.'); return; }
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
        `<div class="modal-head">📥 استيراد شرائح من <b></b></div>` +
        `<div class="modal-body">` +
          `<div class="imp-where">` +
            `<label><input type="radio" name="imp-pos" value="after"${curIdx >= 0 ? ' checked' : ''}> ` +
              `بعد الشريحة الحالية${curIdx >= 0 ? ' (' + (curIdx + 1) + ')' : ''}</label>` +
            `<label><input type="radio" name="imp-pos" value="end"${curIdx < 0 ? ' checked' : ''}> في النهاية</label>` +
          `</div>` +
          `<div class="imp-tools"><button data-all>تحديد الكل</button><button data-none>إلغاء التحديد</button>` +
            (mismatch ? `<span class="imp-warn">⚠ مقاس الشريحة يختلف عن هذا العرض — قد يتأثر التخطيط أو PDF (صفحة لكل شريحة).</span>` : '') +
          `</div>` +
          `<div class="imp-list">${rows}</div>` +
        `</div>` +
        `<div class="modal-foot">` +
          `<button data-cancel>إلغاء</button>` +
          `<button class="primary" data-confirm>استيراد</button>` +
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
    const cancel = () => { closeImportModal(); status('أُلغي الاستيراد.'); };
    backdrop.querySelector('[data-cancel]').addEventListener('click', cancel);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cancel(); });
    confirmBtn.addEventListener('click', () => {
      const chosen = checks().filter(c => c.checked).map(c => data.slides[+c.dataset.i]);
      if (!chosen.length) return;
      const pos = backdrop.querySelector('input[name=imp-pos]:checked').value;
      const afterSlide = pos === 'after' ? (cur || destSlides.slice(-1)[0]) : destSlides.slice(-1)[0];
      editor.importSlides(chosen.map(s => s.html), afterSlide, data.heads, name);
      closeImportModal();
      status(`استُوردت ${chosen.length} شريحة من ${name}.`);
    });
    updateConfirm();
  }

  // ---------- Asset panel ----------
  async function addImages() {
    const picked = await window.api.pickImages();
    if (picked && picked.length) {
      addAssets(picked);
      status(`أُضيفت ${picked.length} صورة إلى المكتبة.`);
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
      assetList.innerHTML = '<p class="hint">اضغط <b>🖼 صور</b> لتحميل الصور، ثم اسحبها إلى شريحة — أو انقر مرتين على صورة لإضافتها إلى الشريحة الحالية.</p>';
      return;
    }
    assetList.innerHTML = '';
    for (const a of assets) {
      const el = document.createElement('div');
      el.className = 'asset';
      el.title = 'اسحبها إلى شريحة — أو انقر مرتين لإضافتها إلى الشريحة الحالية';
      el.innerHTML = `<button class="asset-del" title="إزالة الصورة من القائمة">×</button>` +
        `<img src="${a.url}"><div class="name">${escapeHtml(a.name)}</div>`;
      el.addEventListener('pointerdown', (e) => startAssetDrag(e, a));
      // Double-click = drop it on the current slide (no dragging needed).
      el.addEventListener('dblclick', () => {
        if (!editor) { status('افتح محاضرة أولًا.'); return; }
        const slide = currentSlideEl();
        editor.insertImageInto(a.url, a.name, slide);
        if (slide) { activeSlide = slide; scrollToSlide(slide); updateSlideInfo(); }
        status('أُضيفت الصورة إلى الشريحة الحالية. اسحب زاويتها لتغيير حجمها.');
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
    status('أُزيلت الصورة من القائمة. (الصور الموضوعة في الصفحة تبقى كما هي.)');
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
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
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
    status('أفلت الصورة حيث يظهر الخط الأزرق…');

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
        status('أُدرجت الصورة. اسحب زاويتها لتغيير حجمها، وانقر مرتين على أي نص لتحريره.');
      } else {
        editor._hideInsert();
        status('أُلغي — أُفلتت خارج الصفحة.');
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
    if (!editor) { status('لا يوجد ما يُحفظ.'); return; }
    const html = editor.getCleanHtml();
    const suggested = baseName(currentFile?.filePath, '-edited.html');
    const res = await window.api.saveHtml({ html, suggestedName: suggested });
    if (res.ok) status('Saved: ' + res.filePath);
  }

  // Most frequent value in a list (ties -> the first seen).
  function commonest(nums) {
    const seen = new Map();
    for (const v of nums) seen.set(v, (seen.get(v) || 0) + 1);
    let best = nums[0], bestN = 0;
    for (const [v, c] of seen) if (c > bestN) { best = v; bestN = c; }
    return best;
  }

  // Slide-deck detection: repeated same-WIDTH direct children of <body>
  // (e.g. div.slide 950x650). Each becomes exactly one PDF page.
  //
  // Heights deliberately do NOT have to match. A deck authored with
  // `min-height` (as the generator now emits) lets every slide grow to its own
  // content, so a 16-slide lecture measured 680..1007px tall. Demanding equal
  // heights made detection fail on exactly those files and silently dropped
  // the export to Letter portrait, where a 1000px slide loses ~130px off each
  // side — the clipped-title bug.
  function detectSlides() {
    const doc = editor.doc;
    const kids = Array.from(doc.body.children).filter(el =>
      el.nodeType === 1 &&
      !/^ve-/.test(el.className) &&
      el.offsetWidth > 400 && el.offsetHeight > 250);
    if (kids.length < 2) return null;
    // Width is the trustworthy signal: a deck's slides are one fixed width.
    const w = commonest(kids.map(k => k.offsetWidth));
    const els = kids.filter(k => Math.abs(k.offsetWidth - w) < 4);
    if (els.length < 2 || els.length < kids.length * 0.8) return null;

    // The design box is the shortest slide — the floor `height`/`min-height`
    // sets, which every slide is built on. Sanity-checked against the median
    // so one freak short slide can't shrink the whole deck's page.
    const hs = els.map(k => k.offsetHeight).sort((a, b) => a - b);
    const median = hs[hs.length >> 1];
    const design = hs[0] >= median * 0.6 ? hs[0] : median;
    // One page size for the whole deck, tall enough for the tallest slide so
    // nothing is ever cut — capped at 1.5x the design box so a single runaway
    // slide can't inflate every other page (it is scaled to fit instead).
    const height = Math.min(hs[hs.length - 1], Math.round(design * 1.5));
    return { width: w, height, els };
  }

  // Build the print-ready HTML + page size (shared by export and preview).
  function buildPdfHtml() {
    const slides = detectSlides();
    let html, pageSize = null;
    if (slides) {
      const W = slides.width, H = slides.height;
      // Mark slides, snapshot HTML, then clean the live document again.
      const fits = new Set();
      slides.els.forEach((el, i) => {
        el.setAttribute('data-ve-page', '');
        if (i === slides.els.length - 1) el.setAttribute('data-ve-last', '');
        // Taller than the page (only reachable once the 1.5x cap bites):
        // shrink it to fit rather than let overflow:hidden cut it. `zoom`
        // scales the slide's own layout box so its clip scales with it — a
        // transform would clip at full size first, then shrink the stub.
        const h = el.offsetHeight;
        if (h > H + 1) {
          const z = Math.floor(H / h * 1000) / 1000;
          el.setAttribute('data-ve-fit', String(z));
          fits.add(z);
        }
        // A slide stretched to page height needs something that absorbs the
        // extra space or it prints with a white band. Content slides already
        // have one (a body with flex:1); a cover slide is a single full-bleed
        // wrapper plus an absolutely-positioned footer, so nothing grows.
        // Judged on layout, not markup: :only-child misses the cover exactly
        // because that footer is a second DOM child but not a flex item.
        const cs = (c) => editor.win.getComputedStyle(c);
        const inFlow = Array.from(el.children).filter(c => {
          const pos = cs(c).position;
          return pos !== 'absolute' && pos !== 'fixed';
        });
        if (inFlow.length === 1 && !(parseFloat(cs(inFlow[0]).flexGrow) > 0)) {
          inFlow[0].setAttribute('data-ve-fill', '');
        }
      });
      html = editor.getCleanHtml();
      slides.els.forEach(el => {
        el.removeAttribute('data-ve-page');
        el.removeAttribute('data-ve-last');
        el.removeAttribute('data-ve-fit');
        Array.from(el.children).forEach(c => c.removeAttribute('data-ve-fill'));
      });
      pageSize = { widthPx: W, heightPx: H };
      const printCss = `<style id="ve-print">
        @page { size: ${W}px ${H}px; margin: 0; }
        html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
        /* Only slides make pages: a stray wrapper or leftover chrome left in
           <body> would otherwise print as its own half-empty page. */
        body > *:not([data-ve-page]) { display: none !important; }
        [data-ve-page] {
          width: ${W}px !important;
          margin: 0 !important;
          box-shadow: none !important;
          border-radius: 0 !important;
          overflow: hidden !important;
          page-break-after: always; break-after: page;
          page-break-inside: avoid; break-inside: avoid;
        }
        /* Short slides fill the page instead of leaving a white band under the
           footer: these decks are flex columns with a growing body and a
           bottom-pinned footer, so filling the box is what they are built for. */
        [data-ve-page]:not([data-ve-fit]) {
          height: ${H}px !important; min-height: 0 !important; max-height: none !important;
        }
        /* The one wrapper that has to grow with the stretched slide (cover
           artwork), or it stops short of the page edge. min-height covers the
           case where the slide is a plain block, flex the case where it isn't. */
        [data-ve-fill] { flex: 1 1 auto !important; min-height: 100% !important; }
        [data-ve-fit] { height: auto !important; }
        ${[...fits].map(z => `[data-ve-fit="${z}"] { zoom: ${z}; }`).join('\n        ')}
        [data-ve-last] { page-break-after: auto; break-after: auto; }
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
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    status('جارٍ تصدير PDF…');
    const { html, pageSize, slideCount } = buildPdfHtml();
    if (slideCount) status(`جارٍ تصدير PDF — ${slideCount} شريحة، كل شريحة في صفحة…`);
    const suggested = baseName(currentFile?.filePath, '.pdf');
    const res = await window.api.exportPdf({ html, suggestedName: suggested, pageSize });
    if (res.ok) status('تم تصدير PDF: ' + res.filePath);
    else status('Export ' + (res.error ? 'failed: ' + res.error : 'cancelled.'));
  }

  async function previewPdf() {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    status('جارٍ تجهيز معاينة PDF…');
    const { html, pageSize } = buildPdfHtml();
    const res = await window.api.previewPdf({ html, pageSize });
    status(res.ok ? 'فُتحت المعاينة — راجعها ثم صدّر.' : 'تعذّرت المعاينة: ' + (res.error || ''));
  }

  // "Didn't check" and "checked and found problems" must never share a number.
  // Reads the report's verdict fields, not warnings.length (mission 034).
  function pptxExportStatus(res) {
    const report = res.report || {};
    const verified = report.verifiedSlideCount || 0;
    const failed = report.failedSlideCount || 0;
    const baked = (report.slides || []).reduce((total, slide) =>
      total + ((slide.bakedNodeIds || slide.healed?.demotedNodeIds || []).length), 0);
    // Every bake is confessed, never silent.
    const bakedNote = baked ? ` — ${baked} عنصر مطبوخ` : '';
    switch (report.verificationState) {
      case 'verified':
        return `تم التصدير — تم التحقق من ${verified} شريحة مطابقة${bakedNote}: ${res.filePath}`;
      case 'partial':
        return `تم التصدير — ${failed} شريحة غير مطابقة، راجع المعاينة${bakedNote}: ${res.filePath}`;
      default:
        return `تم التصدير بدون تحقق (PowerPoint غير متوفر)${bakedNote}: ${res.filePath}`;
    }
  }

  // Stage lines from the main process, so a minute-long verified export never
  // looks frozen. Live only while an export/preview is in flight.
  let stopPptxProgress = null;
  function watchPptxProgress(prefix) {
    if (stopPptxProgress) stopPptxProgress();
    stopPptxProgress = window.api.onPptxProgress
      ? window.api.onPptxProgress(({ label }) => status(`${prefix} ${label}`))
      : null;
  }
  function unwatchPptxProgress() {
    if (stopPptxProgress) stopPptxProgress();
    stopPptxProgress = null;
  }

  async function exportPptxDirect() {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    const sceneGraph = editor.serializeForPptx();
    const slideCount = sceneGraph?.slides?.length || 0;
    if (slideCount) status(`جارٍ التصدير — ${slideCount} شريحة…`);
    watchPptxProgress(`جارٍ التصدير (${slideCount} شريحة) —`);
    const suggested = baseName(currentFile?.filePath, '.pptx');
    const res = await window.api.exportPptx({
      sceneGraph,
      themeCss: sceneGraph?.themeCss,
      suggestedName: suggested,
      baseDir: currentFile?.dir || '',
      html: editor.getCleanHtml()
    });
    unwatchPptxProgress();
    if (res.ok) {
      status(pptxExportStatus(res));
    } else {
      if (res.report) showFidelityReport(res.report);
      status(res.error ? 'تعذّر تصدير PowerPoint: ' + res.error : 'أُلغي تصدير PowerPoint.');
    }
  }

  async function exportPptx() {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    await exportPptxDirect();
  }

  function baseName(filePath, ext) {
    if (!filePath) return 'lecture' + ext;
    const name = filePath.split(/[\\/]/).pop().replace(/\.html?$/i, '');
    return name + ext;
  }

  // ---------- Wire up ----------
  $('#btn-open').addEventListener('click', openHtml);

  // ---------- home screen ----------
  // Each card is a job. It picks the source, and remembers which export the
  // user said they were heading for so that button is nudged once the deck is
  // open — the job is not "open a file", it is "get a .pptx out of a PDF".
  const FLOWS = {
    'pdf-pptx':  { run: importPdf,  intent: 'pptx', hint: 'العرض جاهز — صدّره PowerPoint.' },
    'pdf-pdf':   { run: importPdf,  intent: 'pdf',  hint: 'العرض جاهز — صدّره PDF.' },
    'html-edit': { run: openHtml,   intent: null },
    'html-pdf':  { run: openHtml,   intent: 'pdf',  hint: 'المحاضرة جاهزة — صدّرها PDF.' },
    'word':      { run: importDocx, intent: null }
  };
  document.querySelectorAll('#empty-state [data-flow]').forEach((el) => {
    el.addEventListener('click', () => {
      const flow = FLOWS[el.dataset.flow];
      if (!flow) return;
      pendingIntent = flow.intent ? { kind: flow.intent, hint: flow.hint } : null;
      flow.run();
    });
  });
  $('#btn-import-docx').addEventListener('click', importDocx);
  $('#btn-import-pdf').addEventListener('click', importPdf);
  $('#btn-add-images').addEventListener('click', addImages);

  function beginPlace(type, msg) {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    editor.beginPlace(type);
    status(msg);
  }
  $('#btn-add-text').addEventListener('click', () =>
    beginPlace('text', 'انقر في المكان الذي تريد وضع النص فيه… (Esc للإلغاء)'));
  $('#btn-add-line').addEventListener('click', () =>
    beginPlace('line', 'انقر حيث تريد الخط الفاصل… (Esc للإلغاء)'));
  $('#btn-add-table').addEventListener('click', () =>
    beginPlace('table', 'انقر حيث تريد الجدول… (Esc للإلغاء)'));
  $('#btn-save').addEventListener('click', saveHtml);
  $('#btn-export').addEventListener('click', exportPdf);
  $('#btn-export-pptx').addEventListener('click', exportPptx);
  $('#btn-preview').addEventListener('click', previewPdf);
  $('#btn-preview-pptx')?.addEventListener('click', async () => {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    await previewPptx();
  });

  // ---------- MiM brand identity (one-click fonts + palette) ----------
  // Single toggle: click = apply the Screen palette (brand book v1.1), click
  // again = revert. The Pantone Print palette lives in the 🎨 Brand Kit modal
  // (print-shop use). Replaced the old Screen→Print→off cycle (user, 2026-07-26).
  const btnBrand = $('#btn-brand');
  function updateBrandBtn() {
    const kit = editor ? editor.activeThemeKit() : null;
    const on = !!kit && /^MiM/.test(kit);
    btnBrand.classList.toggle('active', on);
    const brandLbl = btnBrand.querySelector('.lbl') || btnBrand;
    brandLbl.textContent = kit === 'MiM-print' ? 'MiM طباعة ✓' : on ? 'MiM ✓' : 'هوية MiM';
    btnBrand.title = on
      ? 'هوية MiM مطبّقة. انقر للعودة إلى الخطوط والألوان الأصلية.'
      : 'تطبيق هوية MiM — خطوط الوزارة وألوان الشاشة الرسمية. (ألوان الطباعة: 🎨 حزمة الهوية.)';
  }
  window.__updateBrandBtn = updateBrandBtn; // brandkit.js keeps the toggle in sync for modal-applied kits
  btnBrand.addEventListener('click', async () => {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    const kit = editor.activeThemeKit();
    if (kit && /^MiM/.test(kit)) {
      editor.removeBrandTheme();
      updateBrandBtn();
      status('عادت الخطوط والألوان الأصلية.');
      return;
    }
    if (!brandFonts) {
      status('جارٍ تحميل خطوط الوزارة…');
      try { brandFonts = await window.api.getFonts(); } catch (_) { brandFonts = []; }
    }
    editor.applyBrandTheme(brandFonts, 'MiM');
    updateBrandBtn();
    const audit = editor.themeAudit();
    if (!brandFonts.length) {
      status('طُبّقت هوية MiM. (لم يُعثر على مجلد الخطوط — الألوان فقط.)');
    } else if (audit) {
      const fontMsg = audit.fontPct >= 90 ? `الخطوط تغطي ${audit.fontPct}% من النص`
        : audit.fontPct > 0 ? `⚠ الخطوط تغطي ${audit.fontPct}% فقط من النص`
        : '⚠ خطوط مضمّنة لا يستخدمها أي نص';
      const lostN = audit.lost ? audit.lost.length : 0;
      const colorMsg = `${audit.recolored.length}/${audit.recolored.length + audit.missed.length + lostN} لونًا أُعيد تعيينه`;
      const lostMsg = lostN ? ` ⚠ ${lostN} حجبتها أنماط العرض نفسه — شغّل 🩺 الفحص.` : '';
      status(`طُبّقت هوية MiM — ${fontMsg}، ${colorMsg}.${lostMsg}`);
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
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    const s = currentSlideEl();
    if (!s) { status('لا توجد شريحة لحذفها.'); return; }
    if (editor.slides().length <= 1) { status('لا يمكن حذف الشريحة الوحيدة.'); return; }
    editor.deleteSlide(s);
    status('تم حذف الشريحة.');
  }
  const ACTIONS = [
    { id: 'open', ar: 'فتح ملف', en: 'Open file', run: openHtml },
    { id: 'import-docx', ar: 'استيراد Word', en: 'Import Word document', run: importDocx },
    { id: 'import-pdf', ar: 'استيراد PDF', en: 'Import PDF lecture', run: importPdf },
    { id: 'save', ar: 'حفظ', en: 'Save', run: saveHtml },
    { id: 'export-pdf', ar: 'تصدير PDF', en: 'Export PDF', run: exportPdf },
    { id: 'export-pptx', ar: 'تصدير PPTX', en: 'Export PPTX', run: exportPptx },
    { id: 'preview-pptx', ar: 'معاينة PPTX', en: 'Preview PPTX', run: () => { $('#btn-preview-pptx')?.click(); } },
    { id: 'insert-text', ar: 'إدراج نص', en: 'Insert text', run: () => beginPlace('text', 'انقر في المكان الذي تريد وضع النص فيه… (Esc للإلغاء)') },
    { id: 'insert-image', ar: 'إدراج صورة', en: 'Insert image', run: addImages },
    { id: 'add-slide', ar: 'إضافة شريحة', en: 'Add slide', run: () => { if (!editor) return status('افتح محاضرة أولًا.'); editor.addSlide(currentSlideEl()); status('أُضيفت شريحة جديدة — عدّل عنوانها ومحتواها.'); } },
    { id: 'dup-slide', ar: 'تكرار الشريحة', en: 'Duplicate slide', run: () => { if (!editor) return status('افتح محاضرة أولًا.'); editor.duplicateSlide(currentSlideEl()); status('تم تكرار الشريحة.'); } },
    { id: 'del-slide', ar: 'حذف الشريحة', en: 'Delete slide', run: slideDeleteAction },
    { id: 'next-slide', ar: 'الشريحة التالية', en: 'Next slide', run: () => gotoSlide(1) },
    { id: 'prev-slide', ar: 'الشريحة السابقة', en: 'Previous slide', run: () => gotoSlide(-1) },
    { id: 'undo', ar: 'تراجع', en: 'Undo', run: () => editor && editor.undo() },
    { id: 'redo', ar: 'إعادة', en: 'Redo', run: () => editor && editor.redo() },
    { id: 'doctor', ar: 'فحص الشرائح', en: 'Run doctor', run: () => { if (window.SlideDoctor) toggleDoctor(); } },
    { id: 'brand', ar: 'تبديل هوية MiM', en: 'تبديل ثيم الهوية', run: () => btnBrand.click() },
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
    cmdkEl.innerHTML = '<div class="cmdk-box"><input class="cmdk-input" placeholder="اكتب أمرًا…"><ul class="cmdk-list"></ul></div>';
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
      li.textContent = a.ar; // English stays searchable (filter above), not shown
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
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
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
  let drCards = [];      // root-cause cards from SlideDoctor.aggregate — score + type view read these

  function ensureDoctorDock() {
    if (drDock) return drDock;
    drDock = document.createElement('aside');
    drDock.id = 'doctor-dock';
    drDock.innerHTML =
      '<div class="dr-head"><svg class="ic"><use href="#i-pulse"/></svg>فحص الشرائح<span class="dr-score" title="درجة سلامة العرض"></span><span class="spacer"></span>' +
      '<button class="dr-rescan" title="إعادة الفحص"><svg class="ic"><use href="#i-refresh"/></svg></button>' +
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

  // Run every auto-fixable issue on the live DOM, one commit per pass (each
  // pass = one undo step). Fixes may remove/insert elements (v5: slide deletes
  // & splits) — stale `el` refs then no-op safely on detached nodes; and a fix
  // may return a Promise (fonts-external), so each is awaited with its own
  // failure counted. Passes repeat until the scan converges (a split can push
  // a new issue into view), stopping the moment a pass makes no progress.
  let drFixing = false; // async guard: one fix run at a time
  async function fixAll() {
    if (!editor || !drIssues.length || drFixing) return;
    if (!drIssues.some((i) => i.fix)) { status('لا توجد ملاحظات قابلة للإصلاح تلقائيًا.'); return; }
    drFixing = true;
    const btn = drDock && drDock.querySelector('.dr-fixall');
    if (btn) btn.disabled = true;
    status('جارٍ الإصلاح…');
    const MAX_PASSES = 5;
    let fixed = 0, failed = 0, passes = 0;
    while (passes < MAX_PASSES) {
      const fixable = drIssues.filter((i) => i.fix);
      if (!fixable.length) break;
      const before = drIssues.length;
      for (const i of fixable) {
        try { await i.fix(); } catch (_) { failed++; }
      }
      editor.commit();
      runDoctor(); // re-scan; drIssues now reflects what actually remains
      passes++;
      if (drIssues.length >= before) break; // no progress — stop honestly
      fixed += before - drIssues.length;
    }
    drFixing = false;
    if (btn) btn.disabled = false;
    status(`أصلحت ${fixed} ملاحظة، المتبقّي ${drIssues.length}.` +
      (failed ? ` تعذّر ${failed} — تحقق من الاتصال بالإنترنت.` : ''));
  }

  function runDoctor() {
    if (!editor || !window.SlideDoctor) return;
    const t0 = performance.now();
    drIssues = window.SlideDoctor.analyze(editor);
    drScanMs = Math.max(1, Math.round(performance.now() - t0));
    const btn = $('#btn-doctor');
    drCards = window.SlideDoctor.aggregate ? window.SlideDoctor.aggregate(drIssues) : [];
    const ct = btn.querySelector('.ct');
    if (ct) { ct.textContent = drCards.length ? String(drCards.length) : ''; ct.hidden = !drCards.length; }
    else btn.textContent = 'الفحص' + (drCards.length ? ` (${drCards.length})` : '');
    btn.classList.toggle('has-issues', drCards.length > 0);
    if (drOpen) renderDoctor();
  }

  // Health score counts root causes (cards), not repeated rows — one bad
  // title color is one problem, not 25. Purely a motivational readout.
  function doctorScore() {
    const errs = drCards.filter((c) => c.severity === 'error').length;
    const warns = drCards.length - errs;
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

  // Brand verdict — the answer to "is this really MiM?", read from computed
  // styles. It exists because the HTML cannot be audited by eye: a deck still
  // says font-family:'Cairo' while rendering Diodrum bytes, so every reviewer
  // who reads the CSS reaches the wrong conclusion.
  function brandBlock() {
    if (!editor || !editor.brandReport) return null;
    const div = document.createElement('div');
    div.className = 'dr-brand';
    const r = editor.brandReport();
    if (!r) {
      div.innerHTML = '<div class="db-row">الهوية غير مطبَّقة — اضغط «MiM» لتطبيق ألوان الوزارة وخطوطها.</div>';
      return div;
    }
    const pill = (p) => '<b class="' + (p >= 100 ? 'ok' : p >= 90 ? 'mid' : 'bad') + '">' + p + '٪</b>';
    const names = (l) => l.map((x) => x.name + ' ×' + x.count).join('، ');
    div.innerHTML =
      '<div class="db-head">هوية ' + r.kit + '</div>' +
      '<div class="db-row">الألوان ' + pill(r.colorPct) + '<span>' +
        (r.offColors.length ? 'خارج اللوحة: ' + names(r.offColors) : 'كل الألوان من اللوحة الرسمية') +
      '</span></div>' +
      '<div class="db-row">الخطوط ' + pill(r.fontPct) + '<span>' +
        (r.headingFace ? 'العناوين ' + r.headingFace + ' · النصوص ' + (r.bodyFace || '—') : '') +
        (r.offFonts.length ? ' · خارج الهوية: ' + names(r.offFonts) : '') +
      '</span></div>';
    return div;
  }

  function renderDoctor() {
    renderDoctorMeta();
    const list = ensureDoctorDock().querySelector('.dr-list');
    list.innerHTML = '';
    const bb = brandBlock();
    if (bb) list.appendChild(bb);
    if (!drIssues.length) {
      list.insertAdjacentHTML('beforeend', '<div class="dr-empty">لا توجد ملاحظات — الشرائح سليمة ✅</div>');
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
        gh.textContent = (sIdx === -1 ? 'العرض كله' : 'شريحة ' + (sIdx + 1)) + ' (' + rows.length + ')';
        list.appendChild(gh);
        rows.sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));
        rows.forEach((iss) => list.appendChild(doctorRow(iss, iss.severity === 'error' ? 'err' : 'warn')));
      });
      return;
    }
    // Type view (v4): one card per root cause. Errors first, then warnings.
    [{ sev: 'error', label: 'أخطاء', cls: 'err' }, { sev: 'warn', label: 'تنبيهات', cls: 'warn' }]
      .forEach((g) => {
        const cards = drCards.filter((c) => c.severity === g.sev);
        if (!cards.length) return;
        const gh = document.createElement('div');
        gh.className = 'dr-group';
        gh.textContent = `${g.label} (${cards.length})`;
        list.appendChild(gh);
        cards.forEach((card) => list.appendChild(doctorCard(card, g.cls)));
      });
  }

  // One card = one root cause. Multi-slide cards show a count pill + clickable
  // slide chips; the fix button runs every member fix in ONE undo step.
  function doctorCard(card, cls) {
    const row = document.createElement('div');
    row.className = `dr-row ${cls}`;
    if (card.count > 1) {
      const pill = document.createElement('span');
      pill.className = 'dr-count';
      pill.textContent = `${card.count} موضعًا في ${card.slides.length} شريحة`;
      row.appendChild(pill);
    }
    const msg = document.createElement('div');
    msg.textContent = card.message;
    row.appendChild(msg);
    const chips = document.createElement('div');
    chips.className = 'dr-chips';
    const MAX_CHIPS = 12;
    card.slides.slice(0, MAX_CHIPS).forEach((sIdx) => {
      const chip = document.createElement('span');
      chip.className = 'dr-chip';
      chip.textContent = sIdx === -1 ? 'العرض كله' : `شريحة ${sIdx + 1}`;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = card.issues.find((i) => i.slideIndex === sIdx);
        if (target) focusIssue(target);
      });
      chips.appendChild(chip);
    });
    if (card.slides.length > MAX_CHIPS) {
      const more = document.createElement('span');
      more.className = 'dr-chip';
      more.textContent = `+${card.slides.length - MAX_CHIPS}`;
      chips.appendChild(more);
    }
    row.appendChild(chips);
    const actions = document.createElement('div');
    actions.className = 'dr-actions';
    if (card.fixable) {
      const fix = document.createElement('button');
      fix.className = 'dr-fix';
      fix.textContent = card.fixable > 1 ? `إصلاح الكل (${card.fixable})` : 'إصلاح';
      fix.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (drFixing) return;
        drFixing = true;
        fix.disabled = true;
        let failed = 0;
        for (const i of card.issues) {
          if (!i.fix) continue;
          try { await i.fix(); } catch (_) { failed++; }
        }
        editor.commit(); // ONE undo step for the whole card
        runDoctor();     // re-scan: card + issues are stale after commit
        drFixing = false;
        status(failed ? `تعذّر الإصلاح — تحقق من الاتصال بالإنترنت.` : `أصلحت ${card.fixable} موضعًا.`);
      });
      actions.appendChild(fix);
    }
    const ign = document.createElement('button');
    ign.className = 'dr-ign';
    ign.textContent = '✕';
    ign.title = 'تجاهل هذه الملاحظة في كل مواضعها (تُحفظ مع الملف)';
    ign.addEventListener('click', (e) => {
      e.stopPropagation();
      card.issues.forEach((i) => {
        const cur = i.el.getAttribute('data-ve-dr-ignore') || '';
        if (!(' ' + cur + ' ').includes(' ' + i.ruleId + ' ')) {
          i.el.setAttribute('data-ve-dr-ignore', (cur + ' ' + i.ruleId).trim());
        }
      });
      editor.commit(); runDoctor();
      status('تم تجاهل الملاحظة — «استعادة» في أسفل القائمة تعيدها.');
    });
    actions.appendChild(ign);
    row.appendChild(actions);
    row.addEventListener('click', () => focusIssue(card.issues[0]));
    return row;
  }

  function doctorRow(iss, cls) {
    const row = document.createElement('div');
    row.className = `dr-row ${cls}`;
    const chip = document.createElement('span');
    chip.className = 'dr-chip';
    chip.textContent = iss.slideIndex === -1 ? 'العرض كله' : `شريحة ${iss.slideIndex + 1}`;
    const msg = document.createElement('div');
    msg.textContent = iss.message;
    row.appendChild(chip);
    row.appendChild(msg);
    if (iss.fix) {
      const fix = document.createElement('button');
      fix.className = 'dr-fix';
      fix.textContent = 'إصلاح';
      fix.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (drFixing) return;
        drFixing = true;
        fix.disabled = true;
        let ok = true;
        try { await iss.fix(); } catch (_) { ok = false; }
        editor.commit(); runDoctor(); // re-scan: iss is stale after commit
        drFixing = false;
        status(ok ? 'تم الإصلاح.' : 'تعذّر الإصلاح — تحقق من الاتصال بالإنترنت.');
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
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    drOpen = !drOpen;
    ensureDoctorDock().classList.toggle('open', drOpen);
    if (drOpen) { runDoctor(); renderDoctor(); }
  }

  // ---------- Brand Kit (custom fonts + palette) ----------
  $('#btn-brandkit').addEventListener('click', () => {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    if (window.BrandKit) window.BrandKit.open();
  });

  // ---------- Arabic-first pack (011): numeral toggle + date helper ----------
  $('#btn-numerals').addEventListener('click', () => {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    // Untouched decks carry plain Western digits, so an unset attribute means
    // 'latin' — the first click's default action is to convert TO Arabic-Indic.
    const cur = editor.doc.documentElement.getAttribute('data-ve-numerals') || 'latin';
    const next = cur === 'ar' ? 'latin' : 'ar';
    editor.setNumerals(next);
    status(next === 'ar' ? 'تم التحويل إلى الأرقام العربية (١٢٣).' : 'تحوّلت الأرقام إلى العربية الغربية (123).');
  });
  $('#btn-date-hijri').addEventListener('click', () => {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    editor.insertDate('hijri');
    status('تم إدراج التاريخ الهجري.');
  });
  $('#btn-date-greg').addEventListener('click', () => {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    editor.insertDate('greg');
    status('تم إدراج التاريخ الميلادي.');
  });

  // ---------- Present mode (014) ----------
  $('#btn-present').addEventListener('click', () => {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
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
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    editor.addSlide(currentSlideEl());
    status('أُضيفت شريحة جديدة — عدّل عنوانها ومحتواها.');
  });
  $('#btn-slide-dup').addEventListener('click', () => {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    editor.duplicateSlide(currentSlideEl());
    status('تم تكرار الشريحة.');
  });
  $('#btn-slide-import').addEventListener('click', importSlidesFlow);
  window.__importFlow = importSlidesFlow; // hook for automated tests
  $('#btn-slide-del').addEventListener('click', () => {
    if (!editor) { status('افتح محاضرة أولًا.'); return; }
    const s = currentSlideEl();
    if (!s) { status('لا توجد شريحة لحذفها.'); return; }
    const n = editor.slides().length;
    if (n <= 1) { status('لا يمكن حذف الشريحة الوحيدة.'); return; }
    editor.deleteSlide(s);
    status('تم حذف الشريحة.');
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
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); editor.addSlide(currentSlideEl()); status('أُضيفت شريحة جديدة — عدّل عنوانها ومحتواها.'); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); editor.duplicateSlide(currentSlideEl()); status('تم تكرار الشريحة.'); }
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
      btn.textContent = '↩ إعادة فتح ' + name;
      btn.title = last.filePath;
      btn.addEventListener('click', () => {
        currentFile = last;
        window.__currentFile = last;
        loadIntoIframe(last.content, last.dir);
        status('Opened: ' + last.filePath);
      });
      // Its own slot in the home screen's secondary row — appending straight
      // into .empty-inner would drop a stray button into the card grid.
      const holder = document.querySelector('#home-recent');
      if (holder) holder.appendChild(btn);
    }
  })();

  // ---------- PPTX Preview & Doctor ----------
  function openModal(id) { const el = document.getElementById(id); if (el) el.hidden = false; }
  function closeModal(id) { const el = document.getElementById(id); if (el) el.hidden = true; }
  function toast(msg) {
    const el = document.getElementById('toast');
    const msgEl = document.getElementById('toast-msg');
    if (!el || !msgEl) return;
    msgEl.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3000);
  }

  // Each report names the exact stage and slide. Reuse the preview surface so
  // users can inspect hard export blockers and best-effort fidelity notes
  // without opening developer tools.
  function showFidelityReport(report) {
    const container = document.getElementById('preview-slides');
    if (!container || !report) return;
    container.innerHTML = '';
    const failures = report.failures || [];
    const warnings = report.warnings || [];
    const heading = document.createElement('div');
    heading.className = 'fidelity-report-summary';
    heading.textContent = failures.length
      ? `تعذّر تصدير PowerPoint عند مرحلة ${report.stage}. لم يُكتب أي ملف.`
      : warnings.length
        ? `اكتمل ملف PowerPoint القابل للتحرير مع ${warnings.length} ملاحظة في التعرّف الضوئي أو المطابقة البصرية.`
        : 'اكتمل ملف PowerPoint القابل للتحرير دون فروق مسجّلة في المطابقة.';
    container.appendChild(heading);
    (report.slides || []).forEach((slide, index) => {
      const card = document.createElement('section');
      card.className = 'preview-slide fidelity-report-slide';
      const title = document.createElement('h3');
      title.textContent = `شريحة ${slide.slideNumber || index + 1}`;
      card.appendChild(title);
      const info = document.createElement('p');
      const issuesForSlide = [
        ...(slide.failures || []).map(failure => ({ ...failure, kind: 'error' })),
        ...(slide.warnings || []).map(warning => ({ ...warning, kind: 'note' }))
      ];
      info.textContent = issuesForSlide.length
        ? issuesForSlide.map(issue => `${issue.kind}: ${issue.stage}: ${issue.message || issue.reason || issue.code}`).join('\n')
        : 'لا توجد ملاحظة خاصة بهذه الشريحة.';
      card.appendChild(info);
      const evidence = document.createElement('dl');
      [
        ['Source', slide.sourceRender], ['PowerPoint', slide.powerPointRender],
        ['Heatmap', slide.heatmap], ['OCR', slide.ocr?.ok === true ? 'passed' : slide.ocr?.errors?.map(e => e.code).join(', ')],
        ['Structure', slide.structural?.ok === true ? 'passed' : slide.structural?.errors?.map(e => e.code).join(', ')]
      ].forEach(([label, value]) => {
        if (!value) return;
        const term = document.createElement('dt'); term.textContent = label;
        const detail = document.createElement('dd'); detail.textContent = typeof value === 'string' ? value : JSON.stringify(value);
        evidence.append(term, detail);
      });
      card.appendChild(evidence);
      container.appendChild(card);
    });
    openModal('preview-modal');
  }

  // Preview the actual generated PPTX through PowerPoint, not the source HTML.
  // ---------- PPTX proof screen (mission 037) ----------
  // Every string here is derived from report fields (verdict, metrics, baked
  // ids). Never from warnings.length — "we didn't check" and "we checked and
  // found problems" are different facts and must never share a number.
  const VERDICT_CHIPS = {
    verified: { text: 'مطابقة', cls: 'is-verified' },
    failed: { text: 'غير مطابقة', cls: 'is-failed' },
    unverified: { text: 'غير متحقق', cls: 'is-unverified' }
  };

  function previewChip(slide) {
    if (slide.verdict === 'verified' && slide.bakedNodeIds.length) {
      return { text: `مُعالجة بالخَبز · ${slide.bakedNodeIds.length}`, cls: 'is-baked' };
    }
    return VERDICT_CHIPS[slide.verdict] || VERDICT_CHIPS.unverified;
  }

  function previewPane(labelText, src, altText, heatmapSrc) {
    const pane = document.createElement('div');
    pane.className = 'preview-pane';
    const label = document.createElement('div');
    label.className = 'preview-pane-label';
    label.textContent = labelText;
    pane.appendChild(label);
    const frame = document.createElement('div');
    frame.className = 'preview-pane-frame';
    if (src) {
      const image = document.createElement('img');
      image.src = src;
      image.alt = altText;
      frame.appendChild(image);
      if (heatmapSrc) {
        const layer = document.createElement('img');
        layer.className = 'heatmap-layer';
        layer.src = heatmapSrc;
        layer.alt = 'خريطة الفروق';
        frame.appendChild(layer);
      }
    } else {
      const missing = document.createElement('div');
      missing.className = 'preview-pane-missing';
      missing.textContent = 'لا توجد صورة لهذه الشريحة';
      frame.appendChild(missing);
    }
    pane.appendChild(frame);
    return pane;
  }

  function renderPreviewSlides(container, slides) {
    container.innerHTML = '';
    for (const slide of slides) {
      const row = document.createElement('div');
      row.className = 'preview-row';

      const head = document.createElement('div');
      head.className = 'preview-row-head';
      const num = document.createElement('span');
      num.className = 'slide-num';
      num.textContent = `شريحة ${slide.slide}`;
      head.appendChild(num);

      const chipInfo = previewChip(slide);
      const chip = document.createElement('span');
      chip.className = `verdict-chip ${chipInfo.cls}`;
      chip.textContent = chipInfo.text;
      head.appendChild(chip);

      if (slide.bakedNodeIds.length) {
        const badge = document.createElement('span');
        badge.className = 'baked-badge';
        badge.textContent = `عناصر مطبوخة: ${slide.bakedNodeIds.length}`;
        badge.title = slide.bakedNodeIds.join('\n');
        head.appendChild(badge);
      }

      const metrics = document.createElement('span');
      metrics.className = 'preview-row-metrics';
      metrics.textContent = Number.isFinite(slide.ssim)
        ? `SSIM ${slide.ssim.toFixed(4)} · اختلاف ${slide.mismatchPercent.toFixed(2)}%`
        : 'بدون قياس';
      head.appendChild(metrics);
      row.appendChild(head);

      const pair = document.createElement('div');
      pair.className = 'preview-pair';
      // RTL: the source sits on the right, its PowerPoint output on the left.
      pair.appendChild(previewPane('HTML (المصدر)', slide.sourcePng, `مصدر الشريحة ${slide.slide}`, null));
      pair.appendChild(previewPane('PowerPoint (الناتج)', slide.powerPointPng, `ناتج الشريحة ${slide.slide}`, slide.heatmapPng));
      row.appendChild(pair);
      container.appendChild(row);
    }
  }

  function previewSummaryText(summary) {
    const parts = [`تم التحقق من ${summary.verifiedSlideCount}/${summary.slideCount} شريحة`];
    if (summary.failedSlideCount) parts.push(`${summary.failedSlideCount} غير مطابقة`);
    if (summary.bakedCount) parts.push(`${summary.bakedCount} عنصر مطبوخ`);
    if (Number.isFinite(summary.minSsim)) parts.push(`SSIM الأدنى: ${summary.minSsim.toFixed(4)}`);
    if (summary.verificationState === 'unverified') parts.push('(PowerPoint غير متوفر)');
    return parts.join(' · ');
  }

  function setPreviewBusy(busy) {
    for (const id of ['btn-preview-export', 'btn-preview-retry', 'chk-preview-heatmap']) {
      const element = document.getElementById(id);
      if (element) element.disabled = busy;
    }
  }

  function showPreviewSkeletons(container, count) {
    container.innerHTML = '';
    for (let index = 0; index < Math.max(1, Math.min(count, 4)); index += 1) {
      const row = document.createElement('div');
      row.className = 'preview-row';
      const pair = document.createElement('div');
      pair.className = 'preview-pair';
      pair.appendChild(Object.assign(document.createElement('div'), { className: 'preview-skeleton' }));
      pair.appendChild(Object.assign(document.createElement('div'), { className: 'preview-skeleton' }));
      row.appendChild(pair);
      container.appendChild(row);
    }
  }

  async function previewPptx() {
    const container = document.getElementById('preview-slides');
    const summaryEl = document.getElementById('preview-summary');
    const errorBox = document.getElementById('preview-error');
    const emptyBox = document.getElementById('preview-empty');
    const advisory = document.getElementById('preview-advisory');
    if (!container) { status('المعاينة غير متاحة.'); return; }

    const show = (element, visible) => { if (element) element.hidden = !visible; };
    show(errorBox, false);
    show(emptyBox, !editor);
    if (!editor) {
      container.innerHTML = '';
      if (summaryEl) summaryEl.textContent = '';
      openModal('preview-modal');
      return;
    }

    openModal('preview-modal');
    setPreviewBusy(true);
    if (summaryEl) summaryEl.textContent = 'جارٍ التحقق — يُرسم الملف في PowerPoint…';
    let stopPreviewProgress = null;
    try {
      const sceneGraph = editor.serializeForPptx();
      showPreviewSkeletons(container, sceneGraph?.slides?.length || 1);

      // Doctor is advisory only — it never gates the export.
      show(advisory, false);
      try {
        const issues = runPptxDoctor({ showModal: false }) || [];
        if (issues.length && advisory) {
          advisory.textContent = `يقترح الفاحص ${issues.length} إصلاحًا قبل التصدير`;
          show(advisory, true);
        }
      } catch (_) { /* the advisory must never break the preview */ }

      // The header doubles as the progress line while PowerPoint renders.
      if (window.api.onPptxProgress) {
        stopPreviewProgress = window.api.onPptxProgress(({ label }) => {
          if (summaryEl) summaryEl.textContent = label;
        });
      }
      const result = await window.api.previewPptx({
        sceneGraph,
        themeCss: sceneGraph?.themeCss,
        baseDir: currentFile?.dir || '',
        html: editor.getCleanHtml()
      });
      if (!result.ok) throw new Error(result.error || 'تعذّر بناء المعاينة.');

      renderPreviewSlides(container, result.slides || []);
      const summaryText = previewSummaryText(result.summary || {});
      if (summaryEl) summaryEl.textContent = summaryText;
      applyPreviewHeatmap();
      status(summaryText);
    } catch (error) {
      console.error('تعذّرت معاينة PowerPoint', error);
      container.innerHTML = '';
      if (summaryEl) summaryEl.textContent = '';
      const text = document.getElementById('preview-error-text');
      if (text) text.textContent = String(error.message || error);
      show(errorBox, true);
      status('تعذّرت المعاينة — راجع الرسالة في النافذة.');
    } finally {
      if (stopPreviewProgress) stopPreviewProgress();
      setPreviewBusy(false);
    }
  }

  function applyPreviewHeatmap() {
    const on = document.getElementById('chk-preview-heatmap')?.checked;
    document.querySelectorAll('#preview-slides .preview-row')
      .forEach((row) => row.classList.toggle('show-heatmap', Boolean(on)));
  }

  // Doctor: validate the PPTX export plan
  function runPptxDoctor({ showModal = true } = {}) {
    if (!editor) { status('افتح محاضرة أولًا.'); return []; }
    const plan = editor.serializeForPptx();
    const issues = [];
    const slides = plan.slides || [];
    if (!slides.length) issues.push({ level: 'err', text: 'لا توجد شرائح في المحاضرة.' });
    // The exporter consumes the scene graph directly. Surface its exact
    // slide/node/property diagnostics here; never pre-rasterise unsupported
    // content as a way around a fidelity failure.
    (plan.errors || []).forEach((error) => {
      const index = Number.isInteger(error.slideIndex)
        ? error.slideIndex
        : (Number.isInteger(error.slide) ? Math.max(0, error.slide - 1) : null);
      const where = index == null ? '' : `شريحة ${index + 1}: `;
      const property = error.property ? ` (${error.property})` : '';
      issues.push({
        level: 'err',
        text: `${where}${error.message || error.code || 'ميزة غير مدعومة في PowerPoint القابل للتحرير'}${property}`,
        slide: index
      });
    });
    const container = document.getElementById('doctor-results');
    if (container) {
      if (!issues.length) {
          container.innerHTML = `<div class="doctor-issue ok"><div class="doctor-icon">✅</div><div class="doctor-text"><b>بنية الشرائح مدعومة.</b> ${slides.length} شريحة جاهزة لفحوص PowerPoint والتعرّف الضوئي والمطابقة البصرية والبنية.</div></div>`;
      } else {
        container.innerHTML = issues.map(issue => `
          <div class="doctor-issue ${issue.level}">
            <div class="doctor-icon">${issue.level === 'err' ? '❌' : '⚠️'}</div>
            <div class="doctor-text">
              <b>${issue.text}</b>
              ${issue.slide != null ? `<div class="doctor-actions"><button class="doctor-btn" data-goto="${issue.slide}">انتقل إلى الشريحة ${issue.slide + 1}</button></div>` : ''}
            </div>
          </div>
        `).join('');
        container.querySelectorAll('.doctor-btn[data-goto]').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.getAttribute('data-goto'));
            closeModal('doctor-modal');
            if (editor && editor.slides()[idx]) editor.select(editor.slides()[idx]);
          });
        });
      }
      if (showModal) openModal('doctor-modal');
    }
    return issues;
  }


  // Wire preview and doctor modals once. Both export routes invoke the same
  // strict editable-PPTX fidelity gate.
  const wireModal = (id, onExport) => {
    const modal = document.getElementById(id);
    if (!modal) return;
    const closeAll = () => closeModal(id);
    modal.querySelector('[data-close="' + id + '"]')?.addEventListener('click', closeAll);
    // Close only for a genuine outside click. The preview modal uses its root
    // as the dimmed overlay; the doctor modal retains its backdrop child.
    modal.addEventListener('click', (event) => {
      const content = modal.querySelector('.modal-content');
      if (content && !content.contains(event.target)) closeAll();
    });
    const closeBtn = modal.querySelector('.modal-close') || document.getElementById(id.replace('modal', 'close'));
    if (closeBtn) closeBtn.addEventListener('click', closeAll);
    const secondaryClose = modal.querySelector('.modal-footer .secondary');
    if (secondaryClose) secondaryClose.addEventListener('click', closeAll);
    const exportBtn = modal.querySelector('.modal-footer .primary') || document.getElementById(id.replace('modal', 'export'));
    if (exportBtn) exportBtn.addEventListener('click', () => { closeModal(id); onExport(); });
  };
  wireModal('preview-modal', exportPptxDirect);
  // `doctorFixAndExport` never existed: this line threw a ReferenceError on
  // every boot, killing the rest of this IIFE — so the doctor modal's own
  // export button was dead too. The doctor is advisory (mission 037), so its
  // primary action is simply "export anyway".
  wireModal('doctor-modal', exportPptxDirect);

  // Proof-screen controls: the heatmap overlays the diff on the PowerPoint side,
  // and retry re-runs the whole verification after a failure.
  document.getElementById('chk-preview-heatmap')?.addEventListener('change', applyPreviewHeatmap);
  document.getElementById('btn-preview-retry')?.addEventListener('click', () => { previewPptx(); });
})();
