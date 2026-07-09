/*
 * panel.js — Lecture Studio v3: a docked side panel, not a full-page mode.
 *
 * The editor stays on screen and editable. AI is a layer over it:
 *   • every FREE visual (chart / diagram / equation) arrives already RENDERED —
 *     the card shows the finished picture, not a "generate first" promise;
 *   • hovering a card drops a live GHOST of the visual into the REAL slide
 *     (dashed «معاينة» outline) so the preview IS the result;
 *   • أدرِج commits it (one Ctrl+Z away), تجاهل drops it;
 *   • only IMAGES cost money, behind a button that says exactly what it spends.
 *
 * Two visible states — مقترح (with preview) → على الشريحة. The pipeline keeps
 * its internal state machine; the panel never shows it. See docs/studio-v3-plan.md.
 */
(function () {
  'use strict';
  const P = window.EnrichPipeline;

  let dock = null;
  let selId = null;          // the "opened" card (inline editor shown, ghost pinned)
  let busy = false;          // a review/suggest batch is running
  let reviewProg = null;     // { done, total } during a review
  const getEditor = () => window.__editor;
  const setStatus = (m) => { const el = document.querySelector('#status'); if (el) el.textContent = m; };

  const KIND_ICON = { chart: '📊', diagram: '◧', image: '🖼', equation: '∑', quiz: '❓', pending: '…' };

  // ---------- lifecycle ----------
  async function open() {
    const editor = getEditor();
    if (!editor) { setStatus('Open a lecture first.'); return; }
    build();
    dock.classList.add('open');
    document.body.classList.add('studio-docked');
    selId = null; busy = false; reviewProg = null;
    P.onUpdate = onPipelineUpdate;
    render();   // show a loading hint immediately
    await P.init(editor, (window.__currentFile && window.__currentFile.filePath) || null);
    render();
  }
  function close() {
    if (dock) dock.classList.remove('open');
    document.body.classList.remove('studio-docked');
    if (P.clearGhost) P.clearGhost();
    setStatus('Studio closed — anything you inserted is in the lecture (Ctrl+Z undoes).');
  }
  function toggle() { (dock && dock.classList.contains('open')) ? close() : open(); }

  // Open the panel only if it isn't already (used by the wand — never re-inits
  // and wipes an open session's proposals).
  async function ensureOpen() {
    if (dock && dock.classList.contains('open')) return;
    await open();
  }

  // Focus a specific proposal card: open its inline editor, pin its ghost into
  // the slide, and scroll both the panel card and the stage to it. Called by the
  // wand after it drops a fresh proposal in.
  function focus(targetId) {
    if (!dock) return;
    selId = targetId;
    renderList();
    const p = P.proposals.find(x => x.targetId === targetId);
    if (!p) return;
    if (p.result && !p.onSlide) pin(p);
    const cardEl = dock.querySelector(`.sd-card[data-id="${CSS.escape(targetId)}"]`);
    if (cardEl) cardEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Re-render on pipeline changes — but never yank a card out from under the
  // user while they are typing in its inline editor (only the meter refreshes).
  function onPipelineUpdate() {
    if (!dock || !dock.classList.contains('open')) return;
    renderMeter();
    const ae = document.activeElement;
    if (ae && dock.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    renderList();
  }

  // ---------- skeleton ----------
  function build() {
    if (dock) return;
    dock = document.createElement('aside');
    dock.id = 'studio-dock';
    dock.innerHTML =
      '<div class="sd-head">' +
        '<span class="sd-title">🎬 Studio</span>' +
        '<span class="sd-meter" id="sd-meter"></span>' +
        '<button class="sd-x" title="العودة إلى المحرر">✕</button>' +
      '</div>' +
      '<div class="sd-actions" id="sd-actions"></div>' +
      '<div class="sd-list" id="sd-list"></div>' +
      '<div class="sd-foot" id="sd-foot"></div>';
    document.querySelector('#body').appendChild(dock);
    dock.querySelector('.sd-x').addEventListener('click', close);
    // Peeking a card ends when the pointer leaves the whole list → revert to the
    // pinned (opened) card's ghost, or clear.
    dock.querySelector('#sd-list').addEventListener('mouseleave', () => repin());
  }

  function render() { renderMeter(); renderActions(); renderList(); renderFoot(); }

  function renderMeter() {
    const m = dock && dock.querySelector('#sd-meter');
    if (m) m.textContent = P.meterText ? P.meterText() : '';
  }

  // ---------- top actions (review / suggest / apply-all) ----------
  function renderActions() {
    const box = dock.querySelector('#sd-actions');
    if (!P.editor) { box.innerHTML = '<p class="sd-hint">جارٍ الفحص…</p>'; return; }
    const caps = P.caps || {};
    const c = P.counts();
    box.innerHTML = '';

    if (!caps.text) {
      const b = document.createElement('div');
      b.className = 'sd-banner';
      b.innerHTML = '⚠ لا يوجد مفتاح للنموذج النصي — أضِفه من ⚙️ لتفعيل الاقتراح والمراجعة. ' +
        'الرسوم البيانية من جداول الدرس تعمل بدون مفتاح.';
      box.appendChild(b);
    }

    const review = mkBtn(
      busy && reviewProg ? `⏳ يراجع… ${reviewProg.done}/${reviewProg.total}`
        : (P.reviewed ? '🔍 أعد مراجعة المحاضرة' : '🔍 راجع كل المحاضرة'),
      'sd-btn wide', () => runReview(), !caps.text || busy);
    review.title = 'الذكاء يقرأ كل الشرائح ويقترح صورًا/مخططات حيث تفيد — بالخلفية، وأنت تحرّر.';
    box.appendChild(review);

    if (P.needsSuggest() && !P.suggested) {
      box.appendChild(mkBtn(`✨ اقترح لمواضع الصور (${c.pending})`, 'sd-btn wide',
        () => runSuggest(), !caps.text || busy));
    }

    const readyFree = P.proposals.filter(p => p.state === 'ready' && !p.onSlide && p.kind !== 'image' && p.result);
    if (readyFree.length > 1) {
      box.appendChild(mkBtn(`📥 أدرِج كل الجاهز (${readyFree.length})`, 'sd-btn wide ins',
        () => { readyFree.forEach(p => P.apply(p)); setStatus('أُدرجت كل العناصر الجاهزة — مرقمة «شكل N» تلقائيًا.'); render(); }));
    }
  }

  // ---------- the card list (grouped by slide) ----------
  function renderList() {
    const list = dock.querySelector('#sd-list');
    if (!list) return;
    const editor = getEditor();
    const props = P.proposals
      .filter(p => p.state !== 'rejected' && p.kind !== 'pending')
      .sort((a, b) => (a.slideIndex - b.slideIndex) || String(a.targetId).localeCompare(b.targetId));

    if (!props.length) {
      list.innerHTML = '<div class="sd-empty">' +
        '<p>لا مقترحات بعد.</p>' +
        '<p class="sd-hint">شغّل «🔍 راجع كل المحاضرة» لاقتراح صور ومخططات، ' +
        'أو حدِّد قائمةً/جدولًا في المحرر واستخدم ✨.<br><br>' +
        'أي جدول أرقام في الدرس يظهر هنا رسمًا بيانيًا جاهزًا — بدون أي استدعاء.</p></div>';
      return;
    }

    list.innerHTML = '';
    let curSlide = -1;
    for (const p of props) {
      if (p.slideIndex !== curSlide) {
        curSlide = p.slideIndex;
        list.appendChild(groupHeader(editor, curSlide));
      }
      list.appendChild(card(p));
    }
  }

  // Slide-group header + a per-slide speaker-notes toggle. Notes are separate
  // from the proposal/card list on purpose: invisible metadata, never rendered
  // into the slide — so there is no ghost/apply, just read / edit / optional
  // AI-draft / save.
  function groupHeader(editor, i) {
    const wrap = document.createElement('div');
    const h = document.createElement('div');
    h.className = 'sd-group';
    const title = document.createElement('span');
    title.textContent = `شريحة ${i + 1} — ${slideTitle(editor, i)}`;
    h.appendChild(title);
    const hasNotes = !!(P.getNotes && P.getNotes(i));
    h.appendChild(mkBtn(hasNotes ? '📝 ملاحظات ✓' : '📝 ملاحظات', 'sd-b sm',
      () => toggleNotesBox(wrap, i)));
    wrap.appendChild(h);
    return wrap;
  }

  function toggleNotesBox(wrap, i) {
    const existing = wrap.querySelector('.sd-notesbox');
    if (existing) { existing.remove(); return; }
    const box = document.createElement('div');
    box.className = 'sd-notesbox';
    const ta = document.createElement('textarea');
    ta.rows = 3; ta.dir = 'rtl'; ta.placeholder = 'نقاط للمحاضر — لا تظهر على الشريحة…';
    ta.value = (P.getNotes && P.getNotes(i)) || '';
    ta.addEventListener('change', () => {
      getEditor().setSpeakerNotes(getEditor().slides()[i], ta.value.trim());
      refreshGroupNotesLabel(wrap, i);
    });
    box.appendChild(ta);
    const row = document.createElement('div');
    row.className = 'sd-nrow';
    row.appendChild(mkBtn('✨ اقترح ملاحظات (استدعاء واحد)', 'sd-b sm', async () => {
      setStatus('يقترح ملاحظات للمحاضر… (استدعاء واحد)');
      const r = await P.suggestNotes(i);
      if (r.ok) { ta.value = r.notes; setStatus('وصلت ملاحظات — عدِّلها ثم احفظ.'); }
      else setStatus('تعذّر الاقتراح: ' + r.error);
      refreshGroupNotesLabel(wrap, i);
    }, !(P.caps && P.caps.text)));
    box.appendChild(row);
    wrap.appendChild(box);
  }

  function refreshGroupNotesLabel(wrap, i) {
    const btn = wrap.querySelector(':scope > .sd-group > button');
    if (!btn) return;
    const has = !!(P.getNotes && P.getNotes(i));
    btn.textContent = has ? '📝 ملاحظات ✓' : '📝 ملاحظات';
  }

  function slideTitle(editor, i) {
    const s = editor.slides()[i];
    if (!s) return '';
    const h = s.querySelector('h1, h2');
    const t = (h && h.textContent.trim()) || '';
    return t ? t.slice(0, 30) : '—';
  }

  function card(p) {
    const opened = p.targetId === selId;
    const el = document.createElement('div');
    el.className = 'sd-card' + (opened ? ' open' : '') + (p.onSlide ? ' on' : '');
    el.dataset.id = p.targetId;

    // header: kind + why (+ extra/onSlide chips)
    const head = document.createElement('div');
    head.className = 'sd-chead';
    head.innerHTML =
      `<span class="sd-kind">${KIND_ICON[p.kind] || ''} ${esc(P.kindLabel(p.kind))}</span>` +
      (p.isExtra ? '<span class="sd-chip x">➕ إضافي</span>' : '') +
      (p.onSlide ? '<span class="sd-chip on">✓ على الشريحة</span>' : '');
    el.appendChild(head);
    if (p.why) { const w = document.createElement('p'); w.className = 'sd-why'; w.textContent = '💭 ' + p.why; el.appendChild(w); }

    // preview: finished visual, or (image) a prompt card
    el.appendChild(preview(p));
    if (p.error) { const e = document.createElement('p'); e.className = 'sd-err'; e.textContent = p.error; el.appendChild(e); }

    // actions
    el.appendChild(actions(p));

    // inline editor (only when opened)
    if (opened) el.appendChild(editorBox(p));

    // hover → peek ghost; click (not on a control) → open/pin
    el.addEventListener('mouseenter', () => { if (p.result && !p.onSlide) peek(p); });
    el.addEventListener('click', (ev) => {
      // Ignore controls AND anything inside the open inline editor (the diagram
      // lab's carousel thumbs are plain divs — a click there must not collapse
      // the card).
      if (ev.target.closest('button, input, textarea, select, label, .sd-edit')) return;
      selId = (selId === p.targetId) ? null : p.targetId;
      renderList();
      if (selId) pin(p);
    });
    return el;
  }

  function preview(p) {
    const box = document.createElement('div');
    if (p.result) {
      box.className = 'sd-prev';
      box.innerHTML = p.result.html;   // svg or <img>
      return box;
    }
    // image with no result yet → prompt card + cost
    box.className = 'sd-promptcard';
    box.innerHTML =
      '<div class="sd-pcicon">🖼</div>' +
      `<div class="sd-pctext" dir="auto">${esc((p.spec && p.spec.imagePrompt) || p.slotText || '')}</div>` +
      '<div class="sd-cost">🪙 التوليد يستهلك استدعاء صورة واحدًا</div>';
    return box;
  }

  function actions(p) {
    const box = document.createElement('div');
    box.className = 'sd-cactions';
    if (p.onSlide) {
      if (p.kind === 'image')
        box.appendChild(mkBtn('🎲 صورة أخرى', 'sd-b gen', () => { runGenerate(p); setStatus('تُولَّد صورة جديدة وتحل محلها…'); }, p.generating));
      box.appendChild(mkBtn('🗑 إزالة', 'sd-b rej', () => { P.removeFromSlide(p); setStatus('أُزيل من الشريحة.'); render(); }));
      box.appendChild(mkBtn('✎ عدّل', 'sd-b', () => openCard(p)));
      return box;
    }
    if (p.result) {
      box.appendChild(mkBtn('📥 أدرِج', 'sd-b ins', () => { P.apply(p); setStatus('أُدرج «' + (p.caption || P.kindLabel(p.kind)) + '» — شكل مرقم تلقائيًا.'); render(); }));
    } else if (p.kind === 'image') {
      box.appendChild(mkBtn(p.generating ? '⏳ يولّد…' : '⚡ ولّد الصورة', 'sd-b gen', () => runGenerate(p), p.generating || !(P.caps && P.caps.image)));
    }
    box.appendChild(mkBtn('✎ عدّل', 'sd-b', () => openCard(p)));
    box.appendChild(mkBtn('🗑 تجاهل', 'sd-b rej', () => { P.discard(p); setStatus('تم تجاهل المقترح.'); if (selId === p.targetId) selId = null; render(); }));
    return box;
  }

  function openCard(p) { selId = p.targetId; renderList(); pin(p); }

  // ---------- inline editor (light — the full labs are v3 phases 3–4) ----------
  function editorBox(p) {
    const box = document.createElement('div');
    box.className = 'sd-edit';

    // caption (all kinds)
    box.appendChild(field('التسمية (تظهر تحت الشكل وفي قائمة الأشكال)', () => {
      const inp = document.createElement('input');
      inp.dir = 'rtl'; inp.value = p.caption || ''; inp.placeholder = 'وصف الشكل…';
      inp.addEventListener('change', () => { P.setCaption(p, inp.value.trim()); refreshCard(p); });
      return inp;
    }));

    if (p.kind === 'diagram') {
      // Phase 3 diagram lab: layout carousel + node chips + revise. Falls back
      // to a plain layout-select + textarea if the module didn't load.
      if (window.DiagramLab) {
        const lab = document.createElement('div');
        lab.className = 'dl-lab';
        box.appendChild(lab);
        window.DiagramLab.mount(lab, p, { commit: commitFree, revise: runRevise });
      } else {
        const d = p.spec.diagram || (p.spec.diagram = { layout: 'flow', nodes: [] });
        const lays = [['flow', 'تدفق'], ['steps', 'خطوات'], ['cycle', 'دورة'], ['hierarchy', 'هرمي/شجري'],
          ['timeline', 'زمني'], ['comparison', 'مقارنة'], ['pyramid', 'هرم']];
        box.appendChild(field('شكل المخطط', () => {
          const sel = document.createElement('select');
          sel.innerHTML = lays.map(([v, l]) => `<option value="${v}"${d.layout === v ? ' selected' : ''}>${l}</option>`).join('');
          sel.addEventListener('change', () => { d.layout = sel.value; reRenderFree(p); });
          return sel;
        }));
        box.appendChild(field('العقد — سطر لكل عنصر: عنوان | تفصيل', () => {
          const ta = document.createElement('textarea');
          ta.rows = 5; ta.dir = 'rtl';
          ta.value = (d.nodes || []).map(n => n.sub ? `${n.label} | ${n.sub}` : n.label).join('\n');
          ta.addEventListener('change', () => {
            d.nodes = ta.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
              const [label, sub] = l.split('|').map(x => x.trim());
              return sub ? { label, sub } : { label };
            });
            reRenderFree(p);
          });
          return ta;
        }));
      }
    } else if (p.kind === 'equation') {
      box.appendChild(field('المعادلة (LaTeX) — تُرسم محليًا مجانًا', () => {
        const ta = document.createElement('textarea');
        ta.rows = 3; ta.dir = 'ltr'; ta.className = 'ltr'; ta.value = p.spec.latex || '';
        ta.addEventListener('change', () => { p.spec.latex = ta.value.trim(); reRenderFree(p); });
        return ta;
      }));
    } else if (p.kind === 'quiz') {
      const q = p.spec.quiz || (p.spec.quiz = { question: '', options: [], correctIndex: 0, explanation: '' });
      box.appendChild(field('السؤال', () => {
        const ta = document.createElement('textarea');
        ta.rows = 2; ta.dir = 'rtl'; ta.value = q.question || '';
        ta.addEventListener('change', () => { q.question = ta.value.trim(); reRenderFree(p); });
        return ta;
      }));
      box.appendChild(field('الخيارات — سطر لكل خيار، ضع * قبل الإجابة الصحيحة', () => {
        const ta = document.createElement('textarea');
        ta.rows = 4; ta.dir = 'rtl';
        ta.value = (q.options || []).map((o, i) => (i === q.correctIndex ? '*' : '') + o).join('\n');
        ta.addEventListener('change', () => {
          const lines = ta.value.split('\n').map(l => l.trim()).filter(Boolean);
          q.options = lines.map(l => l.replace(/^\*/, ''));
          q.correctIndex = Math.max(0, lines.findIndex(l => l.startsWith('*')));
          reRenderFree(p);
        });
        return ta;
      }));
      box.appendChild(field('شرح الإجابة (اختياري)', () => {
        const ta = document.createElement('textarea');
        ta.rows = 2; ta.dir = 'rtl'; ta.value = q.explanation || '';
        ta.addEventListener('change', () => { q.explanation = ta.value.trim(); reRenderFree(p); });
        return ta;
      }));
    } else if (p.kind === 'image') {
      if (window.ImageLab) {
        const lab = document.createElement('div');
        lab.className = 'il-lab';
        box.appendChild(lab);
        window.ImageLab.mount(lab, p, {
          generate: (n) => runGenVariants(p, n),
          pick: (i) => runPickVariant(p, i)
        });
      } else {
        // fallback: keep the previous simple prompt + style radios
        box.appendChild(field('وصف الصورة (إنجليزي أدق للنموذم)', () => {
          const ta = document.createElement('textarea');
          ta.rows = 4; ta.dir = 'auto'; ta.value = (p.spec && p.spec.imagePrompt) || '';
          ta.addEventListener('change', () => { p.spec.imagePrompt = ta.value.trim(); P.touch(p); refreshCard(p); });
          return ta;
        }));
        const isInfo = p.spec.style === 'infographic';
        const styles = document.createElement('div');
        styles.className = 'sd-styles';
        styles.innerHTML =
          `<label><input type="radio" name="sty-${p.targetId}" value="photo"${!isInfo ? ' checked' : ''}> صورة (بدون نصوص — آمن)</label>` +
          `<label><input type="radio" name="sty-${p.targetId}" value="infographic"${isInfo ? ' checked' : ''}> إنفوجرافيك (نصوص عربية)</label>`;
        styles.querySelectorAll('input').forEach(rb => rb.addEventListener('change', () => { p.spec.style = rb.value; P.touch(p); refreshCard(p); }));
        box.appendChild(styles);
      }
    } else if (p.kind === 'chart') {
      const n = (p.spec.chart && (p.spec.chart.categories || []).length) || 0;
      const note = document.createElement('p');
      note.className = 'sd-note';
      note.textContent = `📊 من جدول الشريحة نفسها (${n} صفوف) — يتولد محليًا مجانًا، لا يخترع أرقامًا.`;
      box.appendChild(note);
    }
    return box;
  }

  function field(label, makeControl) {
    const wrap = document.createElement('div');
    wrap.className = 'sd-field';
    const lbl = document.createElement('label');
    lbl.className = 'sd-lbl'; lbl.textContent = label;
    wrap.appendChild(lbl);
    wrap.appendChild(makeControl());
    return wrap;
  }

  // Commit a free edit: re-render locally (no call), refresh the card, re-ghost.
  function reRenderFree(p) {
    p.result = null;
    P._renderFree(p);
    refreshCard(p);
    if (p.targetId === selId) pin(p);
  }

  // Diagram-lab commit: re-render locally and update ONLY the card preview +
  // ghost (or the on-slide figure) in place — never rebuild the card, so the
  // lab's chips keep focus while the user types. No API call.
  function commitFree(p) {
    p.result = null;
    P._renderFree(p);
    const c = dock.querySelector(`.sd-card[data-id="${CSS.escape(p.targetId)}"]`);
    const prev = c && c.querySelector('.sd-prev');
    if (prev) prev.innerHTML = p.result ? p.result.html : '<span class="sd-hint">أضِف عنصرين على الأقل للمعاينة…</span>';
    if (p.onSlide && p.result) getEditor().replaceFigureContent(p.targetId, p.result.html, p.caption || '', p.kind);
    else if (p.result && p.targetId === selId && !p.onSlide) pin(p);
    else if (!p.result) P.clearGhost();
    renderMeter();
  }

  // Wording polish for a diagram — the one optional text call in the lab.
  async function runRevise(p, note) {
    if (!(P.caps && P.caps.text)) { setStatus('لا يوجد مفتاح نصي — أضِفه من ⚙️.'); return; }
    setStatus('يحسّن صياغة المخطط بالذكاء… (استدعاء واحد)');
    await P.generate(p, note || undefined);
    setStatus(p.error ? 'تعذّر التحسين: ' + p.error : 'حُدِّثت صياغة المخطط.');
    refreshCard(p);
    if (p.targetId === selId && !p.onSlide) pin(p);
  }

  // Re-render just this card in place (keeps scroll; used after inline edits).
  function refreshCard(p) {
    const old = dock.querySelector(`.sd-card[data-id="${CSS.escape(p.targetId)}"]`);
    if (old) old.replaceWith(card(p)); else renderList();
    renderMeter();
  }

  // ---------- ghost preview control ----------
  function peek(p) { const g = P.previewGhost(p); reveal(g); }
  function pin(p) { const g = P.previewGhost(p); reveal(g); }
  function repin() {
    const p = selId && P.proposals.find(x => x.targetId === selId);
    if (p && p.result && !p.onSlide) { const g = P.previewGhost(p); reveal(g); }
    else P.clearGhost();
  }
  function reveal(node) { if (node && window.__revealInStage) window.__revealInStage(node); }

  // ---------- footer (figures) ----------
  function renderFoot() {
    const foot = dock.querySelector('#sd-foot');
    if (!foot || !P.editor) { if (foot) foot.innerHTML = ''; return; }
    const editor = getEditor();
    editor.renumberFigures();
    const n = editor.figures().length;
    foot.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'sd-fign';
    label.textContent = n ? `🔢 ${n} شكل مرقّم` : '🔢 لا أشكال بعد';
    foot.appendChild(label);
    if (n) {
      const has = !!editor.doc.querySelector('[data-ve-figlist]');
      foot.appendChild(mkBtn(has ? 'حدّث قائمة الأشكال' : 'أنشئ قائمة الأشكال', 'sd-b sm',
        () => { editor.buildFiguresSlide(); setStatus('شريحة «قائمة الأشكال» جاهزة في نهاية المحاضرة.'); renderFoot(); }));
    }
  }

  // ---------- async runners (background — editor stays usable) ----------
  async function runReview() {
    busy = true; reviewProg = { done: 0, total: 1 }; renderActions();
    const r = await P.reviewLecture((done, total) => { reviewProg = { done, total }; renderActions(); });
    busy = false; reviewProg = null;
    if (!r.ok) setStatus('فشلت المراجعة: ' + r.error);
    else setStatus(r.extras ? `المراجعة اقترحت ${r.extras} عنصرًا إضافيًا (بعلامة ➕).`
      : 'المراجعة انتهت — لا إضافات مقترحة (المحاضرة واضحة).');
    render();
  }
  async function runSuggest() {
    busy = true; renderActions();
    const r = await P.suggest();
    busy = false;
    setStatus(r.ok ? 'وصلت المقترحات — عاينها وأدرِج ما يعجبك.' : 'فشل الاقتراح: ' + r.error);
    render();
  }
  async function runGenerate(p) {
    await P.generate(p);
    if (p.state === 'ready' || p.state === 'inserted') { openCard(p); }
    refreshCard(p);
  }
  async function runGenVariants(p, n) {
    setStatus(`يولّد ${n} نسخة… (${n} استدعاء صور)`);
    const r = await P.generateVariants(p, n);
    setStatus(r.ok ? `وصلت ${r.made} نسخة — اختر واحدة.` : 'تعذّر التوليد: ' + (r.error || ''));
    refreshCard(p);
    if (p.targetId === selId && p.result && !p.onSlide) pin(p);
  }
  function runPickVariant(p, i) {
    P.pickVariant(p, i);
    setStatus('اختيرت النسخة — «أدرِج» لتثبيتها.');
    refreshCard(p);
    if (p.targetId === selId && p.result && !p.onSlide) pin(p);
  }

  // ---------- tiny DOM helpers ----------
  function mkBtn(label, cls, fn, disabled) {
    const b = document.createElement('button');
    b.className = cls || 'sd-b';
    b.innerHTML = label;
    if (disabled) b.disabled = true;
    if (fn) b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  window.Studio = { open, close, toggle, ensureOpen, focus };
})();
