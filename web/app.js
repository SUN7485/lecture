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

  // ---------- Arabic-first pack (011E): RTL + Arabic UI when the browser asks for it ----------
  // Simple lookup, no i18n framework — English is the default/fallback.
  const AR_LABELS = {
    brand: { text: '📘 محرر الشرائح' },
    'btn-open': { text: '📂 فتح', title: 'فتح ملف HTML' },
    'btn-add-text': { text: '➕ نص', title: 'إدراج كتلة نص' },
    'btn-add-image': { text: '🖼 صورة', title: 'إدراج صورة (تُضمَّن داخل الملف)' },
    'btn-undo': { text: '↶ تراجع', title: 'تراجع (Ctrl+Z)' },
    'btn-redo': { text: '↷ إعادة', title: 'إعادة (Ctrl+Y)' },
    'btn-zoom-label': { title: 'ملء النافذة' },
    'btn-export': { text: '⬇ PDF', title: "تصدير PDF — اختر «Save as PDF» في نافذة الطباعة" },
    'btn-save': { text: '💾 حفظ HTML', title: 'تنزيل ملف HTML المعدّل (Ctrl+S)' },
    'btn-open-2': { text: '📂 اختر ملف HTML' },
    'btn-theme': { text: '🎨 الثيم', title: 'الثيمات الجاهزة، تصدير واستيراد .theme.json' },
    'btn-present': { text: '🎤 عرض', title: 'عرض الشرائح ملء الشاشة + نافذة الملقّن' },
  };
  function applyArabicUi() {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('lang', 'ar');
    Object.keys(AR_LABELS).forEach((id) => {
      const el = id === 'brand' ? document.querySelector('.toolbar .brand, #toolbar .brand') : document.getElementById(id);
      if (!el) return;
      const l = AR_LABELS[id];
      if (l.text) el.textContent = l.text;
      if (l.title) el.title = l.title;
    });
    const h1 = document.querySelector('#empty-state h1');
    if (h1) h1.textContent = 'حرّر أي صفحة HTML وكأنها عرض شرائح';
    const p1 = document.querySelector('#empty-state p');
    if (p1) p1.innerHTML = 'أفلت ملف .html هنا — من ChatGPT أو Claude أو Gemini؟ عدّل النص، وحرّك أي عنصر أو غيّر حجمه، ثم نزّل الملف أو صدّره PDF.';
    const p2 = document.querySelector('#empty-state p + p');
    if (p2) p2.innerHTML = '<strong>لا يُرفع شيء لأي خادم.</strong> كل شيء يعمل داخل متصفحك.';
    status('افتح ملف HTML للبدء.');
  }
  if (navigator.language && navigator.language.toLowerCase().startsWith('ar')) applyArabicUi();

  // ---------- open ----------
  async function openFile(file) {
    if (!file) return;
    if (/\.docx$/i.test(file.name)) { openDocx(file); return; }
    saveName = file.name.replace(/\.html?$/i, '') + '-edited.html';
    const html = await file.text();
    loadIntoIframe(html);
    status('Opened: ' + file.name);
  }

  // ---------- Word import (010B): .docx -> mammoth -> DeckImporter -> deck ----------
  async function openDocx(file) {
    if (!window.mammoth || !window.DeckImporter) { status('Word import is unavailable (mammoth failed to load).'); return; }
    status('Converting ' + file.name + '…');
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await window.mammoth.convertToHtml({ arrayBuffer });
      const title = file.name.replace(/\.docx$/i, '');
      const deckHtml = window.DeckImporter.fromWordHtml(result.value, { title });
      saveName = title + '-edited.html';
      loadIntoIframe(deckHtml);
      status('Imported from Word: ' + file.name + (result.messages.length ? ' (' + result.messages.length + ' mammoth notice(s))' : ''));
    } catch (e) {
      status('Word import failed: ' + e.message);
    }
  }

  function loadIntoIframe(html) {
    iframe.onload = () => {
      editor = new window.LectureEditor();
      editor.onChange = ({ canUndo, canRedo }) => {
        btnUndo.disabled = !canUndo;
        btnRedo.disabled = !canRedo;
        if (window.SlideDoctor) runDoctor(); // keep the 🩺 badge live as the user edits
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
      if (window.SlideDoctor) runDoctor(); // seed the 🩺 badge count for this deck
      fitZoom();
      status('Ready. Double-click any text to edit it; drag any element to move it.');
    };
    emptyState.hidden = true;
    zoomWrap.hidden = false;
    iframe.srcdoc = html;
  }

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
    document.body.appendChild(drDock); // fixed overlay on the right (web has no #body)
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
    if (!editor) { status('Open a file first.'); return; }
    drOpen = !drOpen;
    ensureDoctorDock().classList.toggle('open', drOpen);
    if (drOpen) { runDoctor(); renderDoctor(); }
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

  // ---------- Speed layer (009): Ctrl+K command palette + slide hotkeys ----------
  // ACTIONS is the single source of truth: the palette lists it, hotkeys below
  // dispatch the same run() functions, so the two entry points never drift.
  function currentSlideEl() {
    if (editor.selected) { const s = editor._slideOf(editor.selected); if (s) return s; }
    return pickTargetSlide();
  }
  function scrollToSlide(s) {
    const top = (s.offsetTop) * zoom;
    stage.scrollTop = Math.max(0, top - 24);
  }
  function gotoSlide(dir) {
    if (!editor) return;
    const slides = editor.slides();
    if (!slides.length) return;
    let idx = slides.indexOf(currentSlideEl());
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(slides.length - 1, idx + dir));
    editor.select(slides[idx]);
    scrollToSlide(slides[idx]);
  }
  function slideDeleteAction() {
    if (!editor) { status('Open a file first.'); return; }
    const s = currentSlideEl();
    if (!s) { status('No slide to delete.'); return; }
    if (editor.slides().length <= 1) { status('Cannot delete the only slide.'); return; }
    editor.deleteSlide(s);
    status('Slide deleted.');
  }
  const ACTIONS = [
    { id: 'open', ar: 'فتح ملف', en: 'Open file', run: () => fileInput.click() },
    { id: 'save', ar: 'حفظ', en: 'Save', run: saveHtml },
    { id: 'export-pdf', ar: 'تصدير PDF', en: 'Export PDF', run: exportPdf },
    { id: 'insert-text', ar: 'إدراج نص', en: 'Insert text', run: () => { if (!editor) return status('Open a file first.'); editor.beginPlace('text'); status('Click on the page where the text should go… (Esc cancels)'); } },
    { id: 'insert-image', ar: 'إدراج صورة', en: 'Insert image', run: () => { if (!editor) return status('Open a file first.'); imgMode = 'insert'; imgInput.click(); } },
    { id: 'add-slide', ar: 'إضافة شريحة', en: 'Add slide', run: () => { if (!editor) return status('Open a file first.'); editor.addSlide(currentSlideEl()); status('New slide added. Edit its title and content.'); } },
    { id: 'dup-slide', ar: 'تكرار الشريحة', en: 'Duplicate slide', run: () => { if (!editor) return status('Open a file first.'); editor.duplicateSlide(currentSlideEl()); status('Slide duplicated.'); } },
    { id: 'del-slide', ar: 'حذف الشريحة', en: 'Delete slide', run: slideDeleteAction },
    { id: 'next-slide', ar: 'الشريحة التالية', en: 'Next slide', run: () => gotoSlide(1) },
    { id: 'prev-slide', ar: 'الشريحة السابقة', en: 'Previous slide', run: () => gotoSlide(-1) },
    { id: 'undo', ar: 'تراجع', en: 'Undo', run: () => editor && editor.undo() },
    { id: 'redo', ar: 'إعادة', en: 'Redo', run: () => editor && editor.redo() },
    { id: 'doctor', ar: 'فحص الشرائح', en: 'Run doctor', run: () => { if (window.SlideDoctor) toggleDoctor(); } },
    { id: 'numerals', ar: 'تبديل الأرقام عربي لاتيني', en: 'Toggle numerals', run: () => $('#btn-numerals').click() },
    { id: 'date-hijri', ar: 'إدراج تاريخ هجري', en: 'Insert Hijri date', run: () => $('#btn-date-hijri').click() },
    { id: 'date-greg', ar: 'إدراج تاريخ ميلادي', en: 'Insert Gregorian date', run: () => $('#btn-date-greg').click() },
    { id: 'theme', ar: 'الثيمات وتصدير/استيراد', en: 'Theme presets / export / import', run: () => toggleThemePop() },
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

  // ---------- Theme files + built-in presets (012) ----------
  // Web has no brand-kit modal yet, so this is a small toolbar popover with
  // the same three actions as the Electron Brand Kit's theme section: MiM
  // (colors-only here — no ministry font files to fetch client-side), two
  // neutral palette+font-pair presets, and Export/Import of a .theme.json.
  // All three reuse editor.applyThemeKit — no second theming mechanism.
  function varsToCss(vars) {
    const decls = Object.keys(vars || {}).map(k => `${k}:${vars[k]};`).join('');
    return decls ? `:root{${decls}}` : '';
  }
  function typoCss(p) {
    return `@import url('https://fonts.googleapis.com/css2?family=${encodeURIComponent(p.heading)}:wght@700&family=${encodeURIComponent(p.body)}:wght@400;700&display=swap');\n` +
      `.slide h1,.slide h2,.slide h3{font-family:'${p.heading}',sans-serif;}\n` +
      `.slide .content,.slide p,.slide li{font-family:'${p.body}',sans-serif;line-height:${p.lineHeight};}`;
  }
  const NEUTRAL_PRESETS = {
    Slate: {
      vars: { '--purple': '#2B3A55', '--cyan': '#5AA9C9', '--pink': '#8AA6B8', '--gold': '#8AA6B8',
        '--dark': '#1A1A1A', '--bg-gray': '#F2F4F6', '--white': '#FFFFFF',
        '--grey-dark': '#5B6470', '--grey-mid': '#9AA5B1', '--grey-light': '#E3E7EC', '--ve-line-height': '1.75' },
      typo: { heading: 'Cairo', body: 'Tajawal', lineHeight: 1.75 },
    },
    Warm: {
      vars: { '--purple': '#7A4E2D', '--cyan': '#C97B4A', '--pink': '#E3B27B', '--gold': '#E3B27B',
        '--dark': '#241A12', '--bg-gray': '#FBF3EA', '--white': '#FFFFFF',
        '--grey-dark': '#6B5A4A', '--grey-mid': '#B39B86', '--grey-light': '#EFE2D3', '--ve-line-height': '1.8' },
      typo: { heading: 'Almarai', body: 'Cairo', lineHeight: 1.8 },
    },
  };
  let themeName = '';
  function applyBuiltinPreset(name) {
    if (!editor) { status('Open a file first.'); return; }
    if (name === 'MiM') {
      editor.applyBrandTheme([], 'MiM'); // exact BRAND_PALETTES.MiM; no font files client-side
    } else {
      const p = NEUTRAL_PRESETS[name];
      if (!p) return;
      editor.applyThemeKit({ name, fonts: [], varsCss: varsToCss(p.vars) + '\n' + typoCss(p.typo) });
    }
    themeName = name;
    status(`Applied "${name}" preset.`);
    if (themePop) themePop.classList.remove('open'); // else it can overlap neighboring toolbar buttons
  }
  function extractLiveFonts(cssText) {
    const fonts = [];
    const re = /@font-face\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(cssText || ''))) {
      const body = m[1];
      const fam = (body.match(/font-family:\s*'([^']+)'/) || [])[1];
      const weight = parseInt((body.match(/font-weight:\s*(\d+)/) || [])[1], 10) || 400;
      const src = body.match(/url\(data:([^;]+);base64,([^)]+)\)\s*format\('([^']+)'\)/);
      if (!fam || !src) continue;
      const fmt = src[3];
      const ext = fmt === 'truetype' ? 'ttf' : fmt === 'woff2' ? 'woff2' : fmt === 'woff' ? 'woff' : 'otf';
      fonts.push({ family: fam, weight, ext, b64: src[2] });
    }
    return fonts;
  }
  function exportTheme() {
    if (!editor) { status('Open a file first.'); return; }
    const vars = {};
    editor.detectVars().forEach(v => { vars[v.name] = v.declared || v.value; });
    const style = editor.doc.getElementById('ve-theme');
    const fonts = style ? extractLiveFonts(style.textContent) : [];
    const name = themeName || editor.activeThemeKit() || 'Untitled';
    const json = window.ThemeIO.toJson({ name, vars, fonts });
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[^\w-]+/g, '-') + '.theme.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status(`Exported "${name}" theme.`);
    if (themePop) themePop.classList.remove('open');
  }
  async function importThemeFile(file) {
    if (!editor || !file) return;
    let parsed;
    try { parsed = window.ThemeIO.parse(await file.text()); }
    catch (e) { status('Theme import failed: ' + e.message); return; }
    editor.applyThemeKit(parsed);
    themeName = parsed.name;
    status(`Imported theme "${parsed.name}".`);
    if (themePop) themePop.classList.remove('open');
  }

  let themePop = null, themeFileInput = null;
  function ensureThemePop() {
    if (themePop) return themePop;
    themePop = document.createElement('div');
    themePop.id = 'theme-pop';
    themePop.innerHTML =
      '<div class="tp-title">Presets</div>' +
      '<div class="tp-row"><button data-preset="MiM">✨ MiM</button><button data-preset="Slate">🩶 Slate</button><button data-preset="Warm">🟤 Warm</button></div>' +
      '<div class="tp-title">.theme.json</div>' +
      '<div class="tp-row"><button data-export>⬇ Export</button><button data-import>⬆ Import</button></div>';
    themePop.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => applyBuiltinPreset(b.dataset.preset)));
    themePop.querySelector('[data-export]').addEventListener('click', exportTheme);
    themeFileInput = document.createElement('input');
    themeFileInput.type = 'file'; themeFileInput.accept = '.theme.json,application/json'; themeFileInput.hidden = true;
    themeFileInput.addEventListener('change', () => { importThemeFile(themeFileInput.files[0]); themeFileInput.value = ''; });
    themePop.querySelector('[data-import]').addEventListener('click', () => themeFileInput.click());
    document.body.appendChild(themePop);
    document.body.appendChild(themeFileInput);
    return themePop;
  }
  function toggleThemePop() {
    if (!editor) { status('Open a file first.'); return; }
    const pop = ensureThemePop();
    const btn = $('#btn-theme');
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(4, r.left) + 'px';
    pop.classList.toggle('open');
  }
  document.addEventListener('mousedown', (e) => {
    if (themePop && themePop.classList.contains('open') && !themePop.contains(e.target) && e.target.id !== 'btn-theme') {
      themePop.classList.remove('open');
    }
  });

  // ---------- drag & drop ----------
  ['dragover', 'drop'].forEach(evt =>
    window.addEventListener(evt, (e) => e.preventDefault()));
  window.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    const doc = files.find(f => /\.html?$|\.docx$/i.test(f.name));
    if (doc) { openFile(doc); return; }
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
  $('#btn-doctor').addEventListener('click', toggleDoctor);
  $('#btn-numerals').addEventListener('click', () => {
    if (!editor) { status('Open a file first.'); return; }
    // Untouched decks carry plain Western digits, so an unset attribute means
    // 'latin' — the first click's default action is to convert TO Arabic-Indic.
    const cur = editor.doc.documentElement.getAttribute('data-ve-numerals') || 'latin';
    const next = cur === 'ar' ? 'latin' : 'ar';
    editor.setNumerals(next);
    status(next === 'ar' ? 'Converted to Arabic-Indic numerals (١٢٣).' : 'Converted to Western numerals (123).');
  });
  $('#btn-date-hijri').addEventListener('click', () => {
    if (!editor) { status('Open a file first.'); return; }
    editor.insertDate('hijri');
    status('Hijri date inserted.');
  });
  $('#btn-date-greg').addEventListener('click', () => {
    if (!editor) { status('Open a file first.'); return; }
    editor.insertDate('greg');
    status('Gregorian date inserted.');
  });
  $('#btn-theme').addEventListener('click', toggleThemePop);
  $('#btn-present').addEventListener('click', () => {
    if (!editor) { status('Open a file first.'); return; }
    if (window.Presenter) window.Presenter.start(editor);
  });
  $('#btn-zoom-in').addEventListener('click', () => setZoom(zoom * 1.2));
  $('#btn-zoom-out').addEventListener('click', () => setZoom(zoom / 1.2));
  $('#btn-zoom-label').addEventListener('click', fitZoom);
  $('#btn-save').addEventListener('click', saveHtml);
  $('#btn-export').addEventListener('click', exportPdf);
  window.addEventListener('resize', () => applyZoom());
  window.addEventListener('keydown', (e) => {
    if (!editor) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveHtml(); }
    // ---- 009 slide hotkeys: skip entirely while typing text elsewhere ----
    else if (typingElsewhere()) { /* no-op */ }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); editor.addSlide(currentSlideEl()); status('New slide added. Edit its title and content.'); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); editor.duplicateSlide(currentSlideEl()); status('Slide duplicated.'); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); slideDeleteAction(); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); gotoSlide(1); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); gotoSlide(-1); }
  });

  // ---------- Template gallery route (013): ?template=<name> ----------
  // Loads a same-origin template deck straight into the editor, bypassing
  // the file picker — the link from templates.html.
  (async () => {
    const name = new URLSearchParams(location.search).get('template');
    if (!name || !/^[\w-]+$/.test(name)) return; // guard against unknown/unsafe names
    try {
      const res = await fetch('templates/' + name + '.html');
      if (!res.ok) throw new Error('not found');
      const html = await res.text();
      saveName = name + '-edited.html';
      loadIntoIframe(html);
      status('Template loaded: ' + name);
    } catch (_) {
      status('Could not load template "' + name + '".');
    }
  })();
})();
