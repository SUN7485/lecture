/*
 * wand.js — Lecture Studio v3, Phase 2: the ✨ point-of-work wand.
 *
 * The editor already lets you select any block (a bullet list, a table, a line
 * of text). The ✨ button on the selection toolbar turns that block into a
 * visual *right where you are*, with zero ceremony:
 *
 *   • bullet / numbered list  → مخطط (diagram)   — items parsed into nodes OFFLINE
 *   • table with numbers      → رسم بياني (chart) — same free chart engine as scan
 *   • formula-looking text    → معادلة (equation) — MathJax, local
 *   • any text                → صورة (image)      — prompt card, paid on click
 *
 * The first three cost NOTHING: the user's own text becomes the content, the
 * deterministic engines draw it, and a ghost preview lands in the real slide
 * instantly. AI stops being a mode you enter and becomes a verb on a selection.
 *
 * This module only PARSES (offline) and HANDS OFF to the pipeline + panel. The
 * ✨ button and its little menu live in editor.js; the cards, ghosts and Apply
 * flow are the same Phase-1 machinery. See docs/studio-v3-plan.md §D4.
 */
(function () {
  'use strict';

  const status = (m) => { const el = document.querySelector('#status'); if (el) el.textContent = m; };
  const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  // ---------- selection classifiers ----------
  function listOf(el) {
    if (!el) return null;
    if (el.matches && el.matches('ul, ol')) return el;
    const up = el.closest && el.closest('ul, ol');
    if (up) return up;
    const inner = el.querySelector && el.querySelector('ul, ol');
    return inner || null;
  }
  function listItems(list) {
    return Array.from(list.children)
      .filter(c => c.tagName === 'LI')
      .map(li => splitLabel((li.textContent || '').replace(/\s+/g, ' ').trim()))
      .filter(n => n.label);
  }
  // "Title: detail" / "title — detail" / "title - detail" → { label, sub }.
  function splitLabel(raw) {
    const t = (raw || '').trim();
    const parts = t.split(/\s*[:：]\s*|\s+[—–]\s+|\s+-\s+/);
    if (parts.length >= 2 && parts[0] && parts[0].length <= 40) {
      return { label: clip(parts[0], 40), sub: clip(parts.slice(1).join(' — '), 60) };
    }
    return { label: clip(t, 42) };
  }

  // Formula-ish text: a math command, a relational/operator symbol next to
  // alphanumerics, or a super/sub-script. Kept short so prose never qualifies.
  function looksLikeFormula(t) {
    if (!t || t.length > 160) return false;
    if (/\\[a-zA-Z]+/.test(t)) return true;
    if (/[=≠≈≤≥±×÷√∑∫∞πθ]/.test(t) && /[0-9A-Za-z]/.test(t)) return true;
    if (/[A-Za-z0-9]\s*[\^_]\s*[A-Za-z0-9({]/.test(t)) return true;
    return false;
  }
  function toLatex(t) {
    return String(t)
      .replace(/×/g, ' \\times ').replace(/÷/g, ' \\div ').replace(/√/g, '\\sqrt ')
      .replace(/≤/g, ' \\le ').replace(/≥/g, ' \\ge ').replace(/≠/g, ' \\ne ')
      .replace(/≈/g, ' \\approx ').replace(/±/g, ' \\pm ')
      .replace(/∑/g, ' \\sum ').replace(/∫/g, ' \\int ').replace(/∞/g, ' \\infty ')
      .replace(/π/g, ' \\pi ').replace(/θ/g, ' \\theta ').replace(/·/g, ' \\cdot ')
      .replace(/\s+/g, ' ').trim();
  }

  function slideHeading(el) {
    const ed = window.__editor;
    if (!ed || !ed.slideIndexOf) return '';
    const i = ed.slideIndexOf(el);
    const s = i >= 0 && ed.slides()[i];
    const h = s && s.querySelector('h1, h2');
    return h ? clip(h.textContent, 40) : '';
  }

  // ---------- what can the wand do with this selection? ----------
  function actionsFor(el) {
    if (!el || !window.EnrichPipeline) return [];
    const acts = [];
    const table = el.closest && el.closest('table');
    const list = listOf(el);
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();

    if (table && window.EnrichCharts && window.EnrichCharts.extractTableData(table))
      acts.push({ id: 'chart', label: '📊 ارسم رسمًا بيانيًا', cost: 'free' });
    if (!table && list && listItems(list).length >= 2)
      acts.push({ id: 'diagram', label: '◧ حوّل إلى مخطط', cost: 'free' });
    if (!table && !list && looksLikeFormula(txt))
      acts.push({ id: 'equation', label: '∑ معادلة منسّقة', cost: 'free' });
    if (!table && txt.length >= 8)
      acts.push({ id: 'image', label: '🖼 أضف صورة عن هذا', cost: 'paid' });
    return acts;
  }

  // ---------- builders: element → offline proposal spec ----------
  const build = {
    chart(el) {
      const table = el.closest && el.closest('table');
      const data = table && window.EnrichCharts && window.EnrichCharts.extractTableData(table);
      if (!data) return null;
      return {
        anchor: table, kind: 'chart', applyMode: 'after',
        spec: { chart: data },
        caption: data.title || slideHeading(el) || 'رسم بياني',
        why: 'رسم من جدول محدَّد — بدون أي استدعاء'
      };
    },
    diagram(el) {
      const list = listOf(el);
      const nodes = list && listItems(list);
      if (!nodes || nodes.length < 2) return null;
      return {
        anchor: list, kind: 'diagram', applyMode: 'after',
        spec: { diagram: { layout: list.tagName === 'OL' ? 'steps' : 'flow', title: slideHeading(el), nodes } },
        caption: slideHeading(el) || 'مخطط',
        why: 'حوّلت قائمة الشريحة إلى مخطط — بدون أي استدعاء'
      };
    },
    equation(el) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) return null;
      return {
        anchor: el, kind: 'equation', applyMode: 'after',
        spec: { latex: toLatex(t) }, caption: '',
        why: 'معادلة منسّقة من النص المحدد — تُرسم محليًا'
      };
    },
    image(el) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        anchor: el, kind: 'image', applyMode: 'after',
        spec: { imagePrompt: t.slice(0, 200), style: 'photo' },
        slotText: t, caption: clip(t, 60),
        why: 'صورة مقترحة من النص المحدد'
      };
    }
  };

  // ---------- run an action ----------
  async function run(id, el) {
    const P = window.EnrichPipeline;
    if (!P || !window.Studio) { status('الاستوديو غير جاهز.'); return; }
    const b = build[id] && build[id](el);
    if (!b) { status('تعذّر تحويل هذا العنصر — جرّب تحديدًا آخر.'); return; }

    await window.Studio.ensureOpen();
    const p = P.wandProposal({
      el: b.anchor || el, kind: b.kind, spec: b.spec,
      caption: b.caption, why: b.why, applyMode: b.applyMode
    });
    if (!p) { status('تعذّر إنشاء المقترح.'); return; }
    if (b.slotText) p.slotText = b.slotText;     // image prompt-card text / aspect
    window.Studio.focus(p.targetId);

    status(b.kind === 'image'
      ? 'أُضيفت بطاقة صورة في الاستوديو — عدّل الوصف ثم «ولّد» (تستهلك استدعاء صورة).'
      : 'جاهز ✓ عاينه في الشريحة ثم «أدرِج» — بدون أي استدعاء.');
  }

  window.Wand = { actionsFor, run };
})();
