/*
 * diagramEditor.js — Lecture Studio v3, Phase 3: the diagram lab.
 *
 * Because diagrams render locally and instantly (zero API cost), editing one
 * should feel like play, not like filling a form:
 *
 *   • LAYOUT CAROUSEL — the SAME nodes drawn in all 7 layouts as live thumbs;
 *     click a shape to switch. (Nobody online has instant multi-layout preview
 *     for Arabic diagrams.)
 *   • NODE CHIPS — add / remove / reorder / edit each node inline, ⭐ to
 *     emphasise; every keystroke re-renders the real preview + ghost.
 *   • متقدم — the raw "title | sub" textarea survives for power edits.
 *   • حسّن الصياغة — one optional text call to polish wording only.
 *
 * The lab mounts into the card's inline editor. It mutates p.spec.diagram in
 * place and calls ctx.commit(p) (panel re-renders the preview/ghost with no API
 * call) or ctx.revise(p, note) (the single wording call). See plan §D5.
 */
(function () {
  'use strict';

  const LAYOUTS = [
    ['flow', 'تدفق'], ['steps', 'خطوات'], ['cycle', 'دورة'], ['hierarchy', 'هرمي'],
    ['timeline', 'زمني'], ['comparison', 'مقارنة'], ['pyramid', 'هرم']
  ];
  const MAX_NODES = 8, MIN_NODES = 2;

  function themeCtx() {
    const ed = window.__editor;
    const c = (ed && ed.themeContext && ed.themeContext()) || {};
    return { palette: c.palette, rtl: c.rtl !== false, fontFamily: c.fontFamily };
  }
  function spec(p) {
    p.spec = p.spec || {};
    const d = p.spec.diagram || (p.spec.diagram = { layout: 'flow', nodes: [] });
    d.nodes = (d.nodes || []).map(n => (typeof n === 'string' ? { label: n } : n)).filter(n => n && 'label' in n);
    return d;
  }
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

  function mount(container, p, ctx) {
    const d = spec(p);
    const capable = !!(window.EnrichPipeline && window.EnrichPipeline.caps && window.EnrichPipeline.caps.text);
    // Keep every lab click inside the lab. Thumbs/chips are rebuilt on click, so
    // by the time a click bubbles up its target is detached — the card's
    // open/close toggle can't tell it came from here. Stop it at the root.
    container.addEventListener('click', (e) => e.stopPropagation());
    paint();

    // Full repaint (structure changed: nodes added/removed/reordered/layout).
    function paint() {
      container.innerHTML = '';
      container.appendChild(secLabel('التخطيط — اختر الشكل:'));
      container.appendChild(carousel());
      container.appendChild(secLabel('العناصر — عدّل النص، ⭐ للإبراز:'));
      container.appendChild(chips());
      container.appendChild(reviseRow());
      container.appendChild(advanced());
    }
    // Preview-only refresh (text edit): re-render the visual, keep focus/DOM.
    const commit = () => ctx.commit(p);
    // Structure change: rebuild the lab UI, then re-render the visual.
    const structural = () => { paint(); commit(); };

    function secLabel(t) { const s = el('div', 'dl-seclbl'); s.textContent = t; return s; }

    // ---- layout carousel ----
    function carousel() {
      const D = window.EnrichDiagrams, tc = themeCtx();
      const row = el('div', 'dl-carousel');
      LAYOUTS.forEach(([lay, name]) => {
        const th = el('div', 'dl-thumb' + (d.layout === lay ? ' on' : ''));
        th.title = name;
        let svg = '';
        try { svg = D.render(Object.assign({}, d, { layout: lay }), tc) || ''; } catch (_) {}
        th.innerHTML = (svg || '<div class="dl-thempty">—</div>') + `<span class="dl-thlabel">${name}</span>`;
        th.addEventListener('click', () => { if (d.layout !== lay) { d.layout = lay; structural(); } });
        row.appendChild(th);
      });
      return row;
    }

    // ---- node chips ----
    function chips() {
      const wrap = el('div', 'dl-chips');
      d.nodes.forEach((node, i) => wrap.appendChild(chip(node, i)));
      const addRow = el('div', 'dl-addrow');
      const add = el('button', 'sd-b sm');
      add.textContent = '➕ عنصر';
      add.disabled = d.nodes.length >= MAX_NODES;
      add.addEventListener('click', () => { d.nodes.push({ label: 'عنصر جديد' }); structural(); });
      addRow.appendChild(add);
      wrap.appendChild(addRow);
      return wrap;
    }

    function chip(node, i) {
      const c = el('div', 'dl-chip');
      const row = el('div', 'dl-chiprow');

      const star = el('button', 'dl-star' + (d.emphasis === i ? ' on' : ''));
      star.textContent = d.emphasis === i ? '⭐' : '☆';
      star.title = 'إبراز هذا العنصر';
      star.addEventListener('click', () => { d.emphasis = (d.emphasis === i ? undefined : i); structural(); });

      const label = el('input', 'dl-lblin');
      label.value = node.label || '';
      label.placeholder = 'عنوان العنصر';
      label.addEventListener('input', () => { node.label = label.value; commit(); });
      label.addEventListener('change', paintThumbs);   // refresh carousel after commit

      const up = mini('▲', 'أعلى', i === 0, () => { move(i, -1); });
      const down = mini('▼', 'أسفل', i === d.nodes.length - 1, () => { move(i, 1); });
      const del = mini('✕', 'حذف', d.nodes.length <= MIN_NODES, () => {
        d.nodes.splice(i, 1);
        if (d.emphasis === i) d.emphasis = undefined;
        else if (typeof d.emphasis === 'number' && d.emphasis > i) d.emphasis--;
        structural();
      });
      del.classList.add('dl-del');

      row.append(star, label, up, down, del);

      const sub = el('input', 'dl-subin');
      sub.value = node.sub || '';
      sub.placeholder = 'تفصيل اختياري';
      sub.addEventListener('input', () => { node.sub = sub.value.trim() || undefined; commit(); });
      sub.addEventListener('change', paintThumbs);

      c.append(row, sub);
      return c;
    }

    function mini(txt, title, disabled, fn) {
      const b = el('button', 'dl-mini');
      b.textContent = txt; b.title = title; b.disabled = !!disabled;
      b.addEventListener('click', fn);
      return b;
    }
    function move(i, dir) {
      const j = i + dir;
      if (j < 0 || j >= d.nodes.length) return;
      const [n] = d.nodes.splice(i, 1);
      d.nodes.splice(j, 0, n);
      if (d.emphasis === i) d.emphasis = j;
      else if (d.emphasis === j) d.emphasis = i;
      structural();
    }
    // Re-render only the carousel thumbnails (after a committed text edit) so
    // the shape picker reflects new wording without stealing input focus.
    function paintThumbs() {
      const old = container.querySelector('.dl-carousel');
      if (old) old.replaceWith(carousel());
    }

    // ---- revise wording (1 text call) ----
    function reviseRow() {
      const box = el('div', 'dl-field');
      box.appendChild(secLabel('حسّن الصياغة بالذكاء (اختياري — استدعاء نصي واحد):'));
      const row = el('div', 'dl-revise');
      const note = el('input');
      note.placeholder = capable ? 'مثال: اجعل العناوين أقصر' : 'أضف مفتاحًا نصيًا من ⚙️ لتفعيله';
      note.disabled = !capable;
      const go = el('button', 'sd-b');
      go.textContent = '✨ حسّن';
      go.disabled = !capable;
      go.addEventListener('click', () => { ctx.revise(p, note.value.trim()); });
      row.append(note, go);
      box.appendChild(row);
      return box;
    }

    // ---- advanced: raw textarea ----
    function advanced() {
      const det = el('details', 'dl-adv');
      const sum = el('summary');
      sum.textContent = 'متقدم — تحرير نصي (سطر لكل عنصر: عنوان | تفصيل)';
      det.appendChild(sum);
      const ta = el('textarea');
      ta.rows = 5; ta.dir = 'rtl';
      ta.value = d.nodes.map(n => (n.sub ? `${n.label} | ${n.sub}` : n.label)).join('\n');
      ta.addEventListener('change', () => {
        const parsed = ta.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
          const [label, sub] = l.split('|').map(x => x.trim());
          return sub ? { label, sub } : { label };
        });
        if (parsed.length >= MIN_NODES) { d.nodes = parsed; if (d.emphasis >= parsed.length) d.emphasis = undefined; structural(); }
      });
      det.appendChild(ta);
      return det;
    }
  }

  window.DiagramLab = { mount };
})();
