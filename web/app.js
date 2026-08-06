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
  let fileHandle = null;    // File System Access handle (null = plain download fallback)
  let dirty = false;        // unsaved edits since the last successful save

  function status(msg) { statusEl.textContent = msg; }

  // ---------- persistence (019): IndexedDB = autosave (1 record) + recents (<=8) ----------
  const IDB_NAME = 'lve', IDB_VER = 1;
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(IDB_NAME, IDB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('autosave')) db.createObjectStore('autosave');
        if (!db.objectStoreNames.contains('recents')) db.createObjectStore('recents', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function idbPut(store, key, val) {
    return idb().then(db => new Promise((res, rej) => {
      const os = db.transaction(store, 'readwrite').objectStore(store);
      const req = os.keyPath ? os.put(val) : os.put(val, key);
      req.onsuccess = () => res(); req.onerror = () => rej(req.error);
    }));
  }
  function idbGet(store, key) {
    return idb().then(db => new Promise((res, rej) => {
      const req = db.transaction(store).objectStore(store).get(key);
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    }));
  }
  function idbAll(store) {
    return idb().then(db => new Promise((res, rej) => {
      const req = db.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error);
    }));
  }
  async function clearAutosave() { try { await idbPut('autosave', 'cur', null); } catch (_) {} }

  // ---------- Arabic-first pack (011E): RTL + Arabic UI when the browser asks for it ----------
  // Simple lookup, no i18n framework — English is the default/fallback.
  const AR_LABELS = {
    // texts land in each button's .lbl span — icons (SVG) survive the swap.
    brand: { text: 'محرر الشرائح' },
    'btn-open': { text: 'فتح', title: 'فتح ملف HTML' },
    'btn-add-text': { text: 'نص', title: 'إدراج كتلة نص' },
    'btn-add-image': { text: 'صورة', title: 'إدراج صورة (تُضمَّن داخل الملف)' },
    'btn-undo': { title: 'تراجع (Ctrl+Z)' },
    'btn-redo': { title: 'إعادة (Ctrl+Y)' },
    'btn-zoom-label': { title: 'ملء النافذة' },
    'btn-export': { text: 'PDF', title: "تصدير PDF — اختر «Save as PDF» في نافذة الطباعة" },
    'btn-save': { text: 'حفظ HTML', title: 'تنزيل ملف HTML المعدّل (Ctrl+S)' },
    'btn-open-2': { text: 'اختر ملف HTML' },
    'btn-theme': { text: 'الثيم', title: 'الثيمات الجاهزة، تصدير واستيراد .theme.json' },
    'btn-fonts': { title: 'مكتبة الخطوط — عناوين، نص، أو العنصر المحدد' },
    'btn-present': { text: 'عرض', title: 'عرض الشرائح ملء الشاشة + نافذة الملقّن' },
  };
  function applyArabicUi() {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('lang', 'ar');
    Object.keys(AR_LABELS).forEach((id) => {
      const el = id === 'brand' ? document.querySelector('.toolbar .brand, #toolbar .brand') : document.getElementById(id);
      if (!el) return;
      const l = AR_LABELS[id];
      if (l.text) { const lbl = el.querySelector('.lbl'); (lbl || el).textContent = l.text; }
      if (l.title) el.title = l.title;
    });
    const h1 = document.querySelector('#empty-state h1');
    if (h1) h1.textContent = 'حرّر أي صفحة HTML وكأنها عرض شرائح';
    const p1 = document.querySelector('#empty-state p');
    if (p1) p1.innerHTML = 'أفلت ملف .html هنا — من ChatGPT أو Claude أو Gemini؟ عدّل النص، وحرّك أي عنصر أو غيّر حجمه، ثم نزّل الملف أو صدّره PDF.';
    const p2 = document.querySelector('#empty-state p + p');
    if (p2) p2.innerHTML = '<strong>لا يُرفع شيء لأي خادم.</strong> كل شيء يعمل داخل متصفحك.';
    const alt = document.querySelector('#empty-state .alt');
    if (alt) { const icon = alt.querySelector('svg'); alt.textContent = 'أو ابدأ من قالب عربي جاهز ←'; if (icon) alt.prepend(icon); }
    status('افتح ملف HTML للبدء.');
  }
  if (navigator.language && navigator.language.toLowerCase().startsWith('ar')) applyArabicUi();

  // ---------- open ----------
  async function openFile(file) {
    if (!file) return;
    fileHandle = null; // cleared here; openViaPicker restores it for .html only
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

  function loadIntoIframe(html) {
    html = sanitizeLlmHtml(html);
    iframe.onload = () => {
      editor = new window.LectureEditor();
      editor.onChange = ({ canUndo, canRedo }) => {
        btnUndo.disabled = !canUndo;
        btnRedo.disabled = !canRedo;
        if (canUndo) { dirty = true; scheduleAutosave(); } // 019: only autosave once a real edit exists (not on fresh load)
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
      readTypoFromDeck(); // restore per-role font assignments saved in the deck
      if (window.SlideDoctor) runDoctor(); // seed the 🩺 badge count for this deck
      fitZoom();
      saveRecent(); // 019: remember this deck for the empty-state recents list
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
    document.body.appendChild(drDock); // fixed overlay on the right (web has no #body)
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
  // says font-family:'Cairo' while rendering brand bytes, so every reviewer who
  // reads the CSS reaches the wrong conclusion.
  function brandBlock() {
    if (!editor || !editor.brandReport) return null;
    const div = document.createElement('div');
    div.className = 'dr-brand';
    const r = editor.brandReport();
    if (!r) {
      div.innerHTML = '<div class="db-row">الهوية غير مطبَّقة — طبّق «✨ MiM» من 🎨 الثيم.</div>';
      return div;
    }
    const pill = (p) => '<b class="' + (p >= 100 ? 'ok' : p >= 90 ? 'mid' : 'bad') + '">' + p + '٪</b>';
    const names = (l) => l.map((x) => x.name + ' ×' + x.count).join('، ');
    const th = editor.doc.getElementById('ve-theme');
    const standin = r.kit === 'MiM' && th ? th.dataset.veStandin : '';
    const standinNote = standin
      ? ' — بخط ' + standin + ' البديل (الخطان الأصليان في تطبيق سطح المكتب)'
      : '';
    div.innerHTML =
      '<div class="db-head">هوية ' + r.kit + '</div>' +
      '<div class="db-row">الألوان ' + pill(r.colorPct) + '<span>' +
        (r.offColors.length ? 'خارج اللوحة: ' + names(r.offColors) : 'كل الألوان من اللوحة الرسمية') +
      '</span></div>' +
      '<div class="db-row">الخطوط ' + pill(r.fontPct) + '<span>' +
        (r.headingFace ? 'العناوين ' + r.headingFace + ' · النصوص ' + (r.bodyFace || '—') + standinNote : '') +
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

  // ---------- save (019): save-in-place via File System Access, download fallback ----------
  const HAS_FS = 'showSaveFilePicker' in window;
  async function saveHtml() {
    if (!editor) { status('Nothing to save.'); return; }
    const html = editor.getCleanHtml();
    if (HAS_FS) {
      try {
        if (!fileHandle) {
          fileHandle = await window.showSaveFilePicker({
            suggestedName: saveName,
            types: [{ description: 'HTML', accept: { 'text/html': ['.html'] } }],
          });
        }
        const w = await fileHandle.createWritable();
        await w.write(html);
        await w.close();
        dirty = false;
        await clearAutosave();
        status('Saved: ' + fileHandle.name);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') { status('Save cancelled.'); return; }
        // any other FS error (permission, disk) → fall through to the download path
      }
    }
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = saveName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    dirty = false;
    await clearAutosave();
    status('Downloaded: ' + saveName);
  }

  // ---------- open via File System Access so save-in-place has a handle (019) ----------
  async function openViaPicker() {
    if (!('showOpenFilePicker' in window)) { fileInput.click(); return; }
    try {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: 'HTML', accept: { 'text/html': ['.html', '.htm'] } }],
      });
      const file = await h.getFile();
      await openFile(file);                              // resets fileHandle=null internally
      if (/\.html?$/i.test(file.name)) fileHandle = h;   // reuse handle for .html save-in-place only
    } catch (e) { if (!(e && e.name === 'AbortError')) fileInput.click(); }
  }

  // ---------- autosave + crash recovery (019) ----------
  let autosaveTimer = null;
  function scheduleAutosave() { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(doAutosave, 1500); }
  async function doAutosave() {
    if (!editor || !dirty) return;
    try { await idbPut('autosave', 'cur', { html: editor.getCleanHtml(), name: saveName, ts: Date.now() }); } catch (_) {}
  }
  window.addEventListener('beforeunload', () => { if (dirty) doAutosave(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) doAutosave(); });

  // ---------- recent decks (019): thumbnail + store + empty-state list ----------
  async function makeThumb() {
    try {
      const s = editor.slides()[0]; if (!s) return '';
      const bg = iframe.contentWindow.getComputedStyle(s).backgroundColor || '#ffffff';
      const title = ((s.querySelector('h1,h2') || {}).textContent || '').slice(0, 40);
      const esc = t => t.replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
      const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='90'>" +
        "<rect width='160' height='90' fill='" + bg + "'/>" +
        "<text x='8' y='50' font-family='sans-serif' font-size='11' fill='#333'>" + esc(title) + "</text></svg>";
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    } catch (_) { return ''; }
  }
  async function saveRecent() {
    if (!editor) return;
    try {
      const rec = { id: saveName, name: saveName, html: editor.getCleanHtml(), thumb: await makeThumb(), ts: Date.now() };
      await idbPut('recents', null, rec);
      const all = (await idbAll('recents')).sort((a, b) => b.ts - a.ts);
      if (all.length > 8) {
        const db = await idb();
        const tx = db.transaction('recents', 'readwrite');
        all.slice(8).forEach(r => tx.objectStore('recents').delete(r.id));
      }
    } catch (_) {}
  }
  function openRecent(rec) {
    fileHandle = null; saveName = rec.name || saveName;
    loadIntoIframe(rec.html);
    status('Opened recent: ' + saveName);
  }
  function offerRecovery(rec) {
    const bar = document.createElement('div');
    bar.className = 've-recover';
    bar.innerHTML = '<span>استعادة العرض غير المحفوظ؟</span>' +
      '<button class="primary" data-yes>استعادة</button><button data-no>تجاهل</button>';
    document.body.appendChild(bar);
    bar.querySelector('[data-yes]').addEventListener('click', () => { openRecent(rec); bar.remove(); });
    bar.querySelector('[data-no]').addEventListener('click', () => { clearAutosave(); bar.remove(); });
  }
  function renderRecents(list) {
    if (!list || !list.length) return;
    const host = document.getElementById('empty-state'); if (!host) return;
    const old = document.getElementById('recents'); if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'recents';
    wrap.innerHTML = '<div class="rc-title">المشاريع الأخيرة</div>';
    const row = document.createElement('div'); row.className = 'rc-row';
    list.sort((a, b) => b.ts - a.ts).slice(0, 8).forEach(rec => {
      const card = document.createElement('button');
      card.className = 'rc-card';
      card.innerHTML = (rec.thumb ? '<img alt="">' : '<div class="rc-noimg"></div>') + '<span class="rc-name"></span>';
      if (rec.thumb) card.querySelector('img').src = rec.thumb;
      card.querySelector('.rc-name').textContent = rec.name || 'بدون اسم';
      card.addEventListener('click', () => openRecent(rec));
      row.appendChild(card);
    });
    wrap.appendChild(row);
    host.appendChild(wrap);
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
  // `min-height` lets every slide grow to its own content, so a 16-slide
  // lecture measured 680..1007px tall. Demanding equal heights made detection
  // fail on exactly those files and silently dropped the export to the
  // printer's default paper, where a 1000px slide is clipped on both sides.
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

  function buildPdfHtml() {
    const slides = detectSlides();
    let html, printCss;
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
      printCss = `<style id="ve-print">
        @page { size: ${W}px ${H}px; margin: 0; }
        html, body { background: #fff !important; margin: 0 !important; padding: 0 !important;
                     -webkit-print-color-adjust: exact; print-color-adjust: exact; }
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
    { id: 'fonts', ar: 'مكتبة الخطوط', en: 'Font library', run: () => toggleFontsPop() },
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
  // Role CSS only — the fonts themselves are EMBEDDED as data: faces by
  // applyBuiltinPreset (was an @import here, which made presets online-only).
  function typoCss(p) {
    return `.slide h1,.slide h2,.slide h3{font-family:'${p.heading}',sans-serif;}\n` +
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
  async function applyBuiltinPreset(name) {
    if (!editor) { status('Open a file first.'); return; }
    if (name === 'MiM') {
      // The licensed Lyon/Diodrum files stay desktop-only, but colors-alone
      // made this button look like it did nothing (decks authored on the MiM
      // palette see zero color change). Web stand-in: embed Cairo — the
      // identity's official secondary face — under BOTH canonical families,
      // so the same adoption machinery re-types the whole deck with it.
      let raw = [];
      try {
        status('تحميل خط الهوية (Cairo)…');
        const faces = await fetchGoogleFontFaces('Cairo', [400, 700]);
        faces.forEach((f) => {
          const w = f.weight >= 700 ? 'bold' : 'regular';
          raw.push({ name: `diodrum-${w}`, b64: f.b64, ext: f.ext });
          raw.push({ name: `lyon-${w}`, b64: f.b64, ext: f.ext });
        });
      } catch (_) { raw = []; /* offline: colors still apply below */ }
      editor.applyBrandTheme(raw, 'MiM'); // exact BRAND_PALETTES.MiM — not retyped
      // The web ships Cairo UNDER the Lyon/Diodrum names (the licensed files are
      // desktop-only). Mark it, so the brand report names the stand-in instead
      // of claiming a face this build cannot actually embed.
      const th = editor.doc.getElementById('ve-theme');
      if (th) { if (raw.length) th.dataset.veStandin = 'Cairo'; else delete th.dataset.veStandin; }
      themeName = name;
      const audit = editor.themeAudit();
      const lostNote = audit && audit.lost && audit.lost.length
        ? ` — ⚠ ${audit.lost.length} لونًا لم يتغيّر لأن أنماط العرض نفسها تتقدّم (شغّل 🩺 الفحص)`
        : '';
      status(raw.length
        ? `طُبّقت هوية MiM: الألوان الرسمية + خط Cairo (الثانوي الرسمي) يغطي ${audit ? audit.fontPct : 0}% من النص — خطا Lyon/Diodrum الأساسيان في تطبيق سطح المكتب.${lostNote}`
        : `طُبّقت ألوان MiM فقط — تعذّر تحميل الخط (بدون اتصال).${lostNote}`);
      if (themePop) themePop.classList.remove('open');
      return;
    }
    const p = NEUTRAL_PRESETS[name];
    if (!p) return;
    // Embed the preset's Google fonts as data: URLs so the saved deck renders
    // offline + in PDF (was an @import before — online-only). Colors still
    // apply if the fetch fails; the fonts then fall back to system.
    let fonts = [];
    try {
      status(`تحميل خطوط نمط "${name}"…`);
      const heading = await fetchGoogleFontFaces(p.typo.heading, [700]);
      const body = await fetchGoogleFontFaces(p.typo.body, [400, 700]);
      fonts = dedupeFonts(heading.concat(body));
    } catch (e) { /* offline: fall through with colors only */ }
    editor.applyThemeKit({ name, fonts, varsCss: varsToCss(p.vars) + '\n' + typoCss(p.typo) });
    themeName = name;
    status(fonts.length
      ? `طُبّق نمط "${name}" بخطوط مضمّنة (تعمل دون اتصال).`
      : `طُبّقت ألوان "${name}"؛ تعذّر تضمين الخطوط (بدون اتصال).`);
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
    const json = window.ThemeIO.toJson({ name, vars, fonts, typography: typoState });
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
    typoState = Object.assign({ heading: null, body: null }, parsed.typography || {});
    const st = editor.doc.getElementById('ve-theme');
    if (st) st.dataset.veTypo = JSON.stringify(typoState);
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
    if (fontsPop && fontsPop.classList.contains('open') && !fontsPop.contains(e.target) && e.target.id !== 'btn-fonts') {
      fontsPop.classList.remove('open');
    }
  });

  // ---------- Typography Kit (017): font library + per-role fonts ----------
  // Fonts are EMBEDDED (woff2 -> data: URL via the kit's @font-face machinery),
  // never linked — the saved deck renders offline and inside PDF export.
  const FONT_LIB = [
    { family: 'Cairo', cat: 'حديثة' }, { family: 'Tajawal', cat: 'حديثة' },
    { family: 'Almarai', cat: 'حديثة' }, { family: 'Readex Pro', cat: 'حديثة' },
    { family: 'IBM Plex Sans Arabic', cat: 'حديثة' }, { family: 'Noto Kufi Arabic', cat: 'حديثة' },
    { family: 'Changa', cat: 'عناوين' }, { family: 'El Messiri', cat: 'عناوين' },
    { family: 'Aref Ruqaa', cat: 'عناوين' },
    { family: 'Amiri', cat: 'تقليدية' }, { family: 'Noto Naskh Arabic', cat: 'تقليدية' },
    { family: 'Markazi Text', cat: 'تقليدية' },
  ];
  const FONT_SAMPLE = 'العلم نور والمعرفة قوة 123';
  let typoState = { heading: null, body: null };
  const embeddedFams = new Set();   // families already fetched this session
  const uploadedFonts = [];         // [{family, faces:[{family,weight,ext,b64}]}]

  // Google Fonts css2 -> embedded faces. gstatic serves CORS *, so the woff2
  // binaries can be fetched and inlined as data: URLs. css2 labels each block
  // with a /* subset */ comment — keep arabic + latin (digits/Latin terms).
  async function fetchGoogleFontFaces(family, weights) {
    const url = 'https://fonts.googleapis.com/css2?family=' +
      encodeURIComponent(family).replace(/%20/g, '+') +
      ':wght@' + weights.join(';') + '&display=swap';
    const css = await (await fetch(url)).text();
    const wanted = [];
    const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const subset = m[1], body = m[2];
      if (subset !== 'arabic' && subset !== 'latin') continue;
      const weight = parseInt((body.match(/font-weight:\s*(\d+)/) || [])[1], 10) || 400;
      const src = (body.match(/src:\s*url\((https:[^)]+\.woff2)\)/) || [])[1];
      if (src) wanted.push({ weight, src });
    }
    if (!wanted.length) throw new Error('لم يُعثر على أوجه مناسبة للخط');
    const fonts = [];
    for (const f of wanted) {
      const buf = await (await fetch(f.src)).arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      fonts.push({ family, weight: f.weight, ext: 'woff2', b64: btoa(bin) });
    }
    return fonts;
  }

  // Current kit contents so a typography change PRESERVES palette + fonts.
  // Strips @font-face (re-added from parsed fonts) and any previous ve-typo
  // block (re-generated from typoState) — idempotent re-apply.
  function currentKitState() {
    const style = editor.doc.getElementById('ve-theme');
    const fonts = style ? extractLiveFonts(style.textContent) : [];
    let css = style ? style.textContent.replace(/@font-face\{[^}]*\}/g, '') : '';
    css = css.replace(/\/\*ve-typo\*\/[\s\S]*?\/\*\/ve-typo\*\//, '').trim();
    return { name: (style && style.dataset.kit) || themeName || 'custom', fonts, css };
  }

  function dedupeFonts(fonts) {
    const seen = new Set();
    return fonts.filter((f) => {
      const k = f.family + '|' + (f.weight || 400) + '|' + (f.style || 'normal');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // Re-apply the kit with merged fonts + regenerated role CSS, and persist
  // the assignment on the style tag so save/reload/export all see it.
  function applyTypoKit(newFaces) {
    const cur = currentKitState();
    const fonts = dedupeFonts(cur.fonts.concat(newFaces || []));
    const varsCss = (cur.css ? cur.css + '\n' : '') + window.ThemeIO.typographyCss(typoState);
    editor.applyThemeKit({ name: cur.name, fonts, varsCss });
    const style = editor.doc.getElementById('ve-theme');
    if (style) style.dataset.veTypo = JSON.stringify(typoState);
  }

  // role: 'heading' | 'body' | 'selection'. faces==null means already embedded.
  async function assignFont(role, family, getFaces) {
    if (!editor) { status('Open a file first.'); return; }
    if (role === 'selection' && !editor.selected) { status('اختر عنصرًا في الشريحة أولًا ثم طبّق الخط.'); return; }
    let faces = [];
    if (!embeddedFams.has(family)) {
      status('تحميل خط ' + family + '…');
      try { faces = await getFaces(); }
      catch (e) { status('تعذّر تحميل الخط — تحقق من الاتصال بالإنترنت.'); return; }
      embeddedFams.add(family);
    }
    if (role === 'selection') {
      applyTypoKit(faces);   // faces must exist in the kit for the inline style to render
      editor.selected.style.fontFamily = "'" + family + "', sans-serif";
      editor.commit();
      status('طُبّق ' + family + ' على العنصر المحدد.');
    } else {
      typoState[role] = { family };
      applyTypoKit(faces);
      editor.commit();
      status(role === 'heading' ? 'خط العناوين الآن: ' + family : 'خط النص الآن: ' + family);
    }
    renderFontsPop();
  }

  function clearTypography() {
    if (!editor) return;
    typoState = { heading: null, body: null };
    applyTypoKit([]);
    editor.commit();
    status('أُزيلت تخصيصات الخطوط (الهوية والألوان باقية).');
    renderFontsPop();
  }

  // Restore typoState when a saved deck (or imported theme) carries it.
  function readTypoFromDeck() {
    typoState = { heading: null, body: null };
    const style = editor && editor.doc.getElementById('ve-theme');
    if (style && style.dataset.veTypo) {
      try { typoState = Object.assign(typoState, JSON.parse(style.dataset.veTypo)); } catch (_) {}
    }
  }

  let fontsPop = null, fontUpload = null, previewsLoaded = false;
  function loadFontPreviews() {
    if (previewsLoaded) return;
    previewsLoaded = true;
    FONT_LIB.forEach((f) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=' +
        encodeURIComponent(f.family).replace(/%20/g, '+') +
        ':wght@700&text=' + encodeURIComponent(FONT_SAMPLE + f.family) + '&display=swap';
      document.head.appendChild(l);
    });
  }

  function fontRow(family, getFaces) {
    const row = document.createElement('div');
    row.className = 'fp-row';
    const sample = document.createElement('div');
    sample.className = 'fp-sample';
    sample.style.fontFamily = "'" + family + "', sans-serif";
    sample.innerHTML = '<strong>' + family + '</strong> — ' + FONT_SAMPLE;
    row.appendChild(sample);
    [['heading', 'عناوين'], ['body', 'نص'], ['selection', 'المحدد']].forEach(([role, label]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', async () => {
        row.classList.add('busy');
        await assignFont(role, family, getFaces);
        row.classList.remove('busy');
      });
      row.appendChild(b);
    });
    return row;
  }

  function renderFontsPop() {
    if (!fontsPop) return;
    const cur = fontsPop.querySelector('.fp-current');
    cur.innerHTML = 'العناوين: <strong>' + (typoState.heading ? typoState.heading.family : 'الافتراضي') +
      '</strong> · النص: <strong>' + (typoState.body ? typoState.body.family : 'الافتراضي') + '</strong>';
  }

  function ensureFontsPop() {
    if (fontsPop) return fontsPop;
    fontsPop = document.createElement('div');
    fontsPop.id = 'fonts-pop';
    fontsPop.innerHTML = '<div class="fp-current"></div><div class="fp-list"></div>' +
      '<div class="fp-tools"><button data-upload>⬆ رفع ملف خط</button><button data-clear>إزالة تخصيصات الخط</button></div>';
    const list = fontsPop.querySelector('.fp-list');
    let lastCat = '';
    FONT_LIB.forEach((f) => {
      if (f.cat !== lastCat) {
        lastCat = f.cat;
        const h = document.createElement('div');
        h.className = 'fp-cat';
        h.textContent = f.cat;
        list.appendChild(h);
      }
      list.appendChild(fontRow(f.family, () => fetchGoogleFontFaces(f.family, [400, 700])));
    });
    fontUpload = document.createElement('input');
    fontUpload.type = 'file';
    fontUpload.accept = '.ttf,.otf,.woff2,.woff';
    fontUpload.hidden = true;
    fontUpload.addEventListener('change', () => {
      const file = fontUpload.files[0];
      fontUpload.value = '';
      if (!file) return;
      const family = file.name.replace(/\.(ttf|otf|woff2?|)$/i, '').replace(/[-_]+/g, ' ').trim() || 'خط مرفوع';
      const ext = (file.name.match(/\.(ttf|otf|woff2?)$/i) || [, 'otf'])[1].toLowerCase();
      const rd = new FileReader();
      rd.onload = () => {
        const b64 = String(rd.result).split(',')[1];
        const faces = [{ family, weight: 400, ext, b64 }, { family, weight: 700, ext, b64 }];
        uploadedFonts.push({ family, faces });
        embeddedFams.delete(family);   // force the new faces into the kit on first assign
        const h = document.createElement('div');
        h.className = 'fp-cat';
        h.textContent = 'مرفوع';
        list.insertBefore(h, list.firstChild);
        // Register the face in the APP document too so the row previews itself.
        const st = document.createElement('style');
        st.textContent = "@font-face{font-family:'" + family + "';src:url(data:font/" + ext + ";base64," + b64 + ");}";
        document.head.appendChild(st);
        list.insertBefore(fontRow(family, () => Promise.resolve(faces)), h.nextSibling);
        status('رُفع الخط ' + family + ' — اختر أين يُطبَّق.');
      };
      rd.readAsDataURL(file);
    });
    fontsPop.querySelector('[data-upload]').addEventListener('click', () => fontUpload.click());
    fontsPop.querySelector('[data-clear]').addEventListener('click', clearTypography);
    document.body.appendChild(fontsPop);
    document.body.appendChild(fontUpload);
    return fontsPop;
  }

  function toggleFontsPop() {
    if (!editor) { status('Open a file first.'); return; }
    const pop = ensureFontsPop();
    loadFontPreviews();
    readTypoFromDeck();
    renderFontsPop();
    const r = $('#btn-fonts').getBoundingClientRect();
    pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 336)) + 'px';
    pop.classList.toggle('open');
  }

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
  $('#btn-open').addEventListener('click', openViaPicker);
  $('#btn-open-2').addEventListener('click', openViaPicker);
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
  $('#btn-fonts').addEventListener('click', toggleFontsPop);
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

  // ---------- startup (019): offer crash recovery + render recents on the empty state ----------
  (async () => {
    if (location.search.includes('template=')) return; // the template route loads a deck itself
    try {
      const rec = await idbGet('autosave', 'cur');
      if (rec && rec.html && !editor) offerRecovery(rec);
    } catch (_) {}
    try { renderRecents(await idbAll('recents')); } catch (_) {}
  })();

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
