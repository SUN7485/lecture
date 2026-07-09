/*
 * diagrams.js — deterministic diagram renderer (the fix for "LLM SVG is buggy").
 *
 * The language model supplies ONLY content — { layout, title, nodes, links } —
 * and this module computes every coordinate, wraps every Arabic label, and
 * emits a self-contained themed SVG. Same philosophy as charts.js: the model's
 * worst failure mode becomes bad wording, never a broken picture.
 *
 * Layouts: flow, steps, cycle, hierarchy, timeline, comparison, pyramid.
 * Works in the renderer (window.EnrichDiagrams) and in Node (module.exports);
 * `node src/enrich/diagrams.js` renders a demo of every layout.
 */
(function (root) {
  'use strict';

  const W = 820;                    // fixed viewBox width, scales to the slot
  const INK = '#1A1A1A', MUTED = '#666666', LINE = '#B3B3B3', BG = '#FFFFFF';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function tint(hex, a) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return `rgba(65,50,88,${a})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  }

  // Greedy word-wrap sized for Arabic glyph widths (~0.52em average).
  function wrap(text, fontSize, maxWidthPx, maxLines) {
    const maxChars = Math.max(4, Math.floor(maxWidthPx / (fontSize * 0.52)));
    const words = String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const cand = cur ? cur + ' ' + w : w;
      if (cand.length <= maxChars || !cur) cur = cand;
      else { lines.push(cur); cur = w; }
      if (lines.length === maxLines) break;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    else if (cur && lines.length === maxLines) {
      lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, '…');
    }
    return lines.length ? lines : [''];
  }

  function textLines(x, y, lines, fs, fill, weight, anchor) {
    return lines.map((ln, i) =>
      `<text x="${r1(x)}" y="${r1(y + i * (fs * 1.35))}" text-anchor="${anchor || 'middle'}" ` +
      `font-size="${fs}"${weight ? ` font-weight="${weight}"` : ''} fill="${fill}">${esc(ln)}</text>`
    ).join('');
  }

  function r1(v) { return Math.round(v * 10) / 10; }

  // ---- shared skeleton ------------------------------------------------------
  function makeCtx(opts) {
    const palette = (opts && opts.palette && opts.palette.length ? opts.palette : ['#413258', '#1AD9C7', '#BFA19F'])
      .filter(c => /^#|^rgb/i.test(c));
    return {
      rtl: !opts || opts.rtl !== false,
      primary: palette[0] || '#413258',
      accent: palette[1] || '#1AD9C7',
      third: palette[2] || palette[0] || '#BFA19F',
      font: (opts && opts.fontFamily) || "'Diodrum Arabic','Cairo','Segoe UI',sans-serif",
      mid: (Math.random() * 1e9 | 0).toString(36)   // unique marker id per svg
    };
  }

  function open(ctx, H) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ` +
      `font-family="${ctx.font.replace(/"/g, "'")}" direction="${ctx.rtl ? 'rtl' : 'ltr'}" role="img">` +
      `<defs><marker id="ah${ctx.mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M0,0 L10,5 L0,10 z" fill="${MUTED}"/></marker></defs>` +
      `<rect x="0" y="0" width="${W}" height="${H}" fill="${BG}"/>`;
  }

  function titleBlock(ctx, title) {
    if (!title) return { svg: '', y0: 26 };
    const tx = ctx.rtl ? W - 24 : 24;
    const anchor = ctx.rtl ? 'end' : 'start';
    const barX = ctx.rtl ? W - 24 - 120 : 24;
    return {
      svg: `<text x="${tx}" y="36" text-anchor="${anchor}" font-size="19" font-weight="700" fill="${ctx.primary}">${esc(title)}</text>` +
        `<rect x="${barX}" y="46" width="120" height="3" rx="1.5" fill="${ctx.accent}"/>`,
      y0: 66
    };
  }

  function arrow(ctx, x1, y1, x2, y2, curve) {
    const d = curve
      ? `M${r1(x1)},${r1(y1)} Q${r1((x1 + x2) / 2)},${r1(curve)} ${r1(x2)},${r1(y2)}`
      : `M${r1(x1)},${r1(y1)} L${r1(x2)},${r1(y2)}`;
    return `<path d="${d}" fill="none" stroke="${MUTED}" stroke-width="2" marker-end="url(#ah${ctx.mid})"/>`;
  }

  // A standard node box: label (bold) + optional sub line(s).
  function nodeBox(ctx, x, y, w, h, node, opts) {
    const em = opts && opts.emphasis;
    const fill = em ? ctx.primary : tint(ctx.primary, 0.06);
    const stroke = em ? ctx.primary : ctx.primary;
    const labelFill = em ? BG : ctx.primary;
    const subFill = em ? tint('#FFFFFF', 0.85) : MUTED;
    const labelLines = wrap(node.label, 14, w - 18, 2);
    const subLines = node.sub ? wrap(node.sub, 12, w - 18, 2) : [];
    const totalTextH = labelLines.length * 19 + (subLines.length ? subLines.length * 16 + 4 : 0);
    let ty = y + (h - totalTextH) / 2 + 14;
    let svg = `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="9" ` +
      `fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    svg += textLines(x + w / 2, ty, labelLines, 14, labelFill, 700);
    if (subLines.length) svg += textLines(x + w / 2, ty + labelLines.length * 19 + 2, subLines, 12, subFill);
    return svg;
  }

  // ---- layouts --------------------------------------------------------------

  function flow(data, ctx) {
    const nodes = data.nodes.slice(0, 8);
    const n = nodes.length;
    const perRow = n <= 4 ? n : Math.ceil(n / 2);
    const gap = 44, margin = 28;
    const boxW = Math.min(180, (W - margin * 2 - (perRow - 1) * gap) / perRow);
    const boxH = 66;
    const t = titleBlock(ctx, data.title);
    const rows = Math.ceil(n / perRow);
    const H = t.y0 + rows * boxH + (rows - 1) * 54 + 28;
    let svg = open(ctx, H) + t.svg;

    const pos = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, n - row * perRow);
      const rowW = inRow * boxW + (inRow - 1) * gap;
      const x0 = (W - rowW) / 2;
      const k = i - row * perRow;
      // RTL: first item of the row sits rightmost.
      const x = ctx.rtl ? x0 + rowW - boxW - k * (boxW + gap) : x0 + k * (boxW + gap);
      const y = t.y0 + row * (boxH + 54);
      pos.push({ x, y });
    }
    for (let i = 0; i < n; i++) {
      svg += nodeBox(ctx, pos[i].x, pos[i].y, boxW, boxH, nodes[i], { emphasis: data.emphasis === i });
      if (i < n - 1) {
        const a = pos[i], b = pos[i + 1];
        if (Math.abs(a.y - b.y) < 2) {
          const dir = b.x > a.x ? 1 : -1;
          svg += arrow(ctx, a.x + (dir > 0 ? boxW : 0) + dir * 4, a.y + boxH / 2,
            b.x + (dir > 0 ? -4 : boxW + 4), b.y + boxH / 2);
        } else {
          svg += arrow(ctx, a.x + boxW / 2, a.y + boxH + 4, b.x + boxW / 2, b.y - 4,
            a.y + boxH + 34);
        }
      }
    }
    return svg + '</svg>';
  }

  // Numbered step columns — the style of the user's reference infographic.
  function steps(data, ctx) {
    const nodes = data.nodes.slice(0, 6);
    const n = Math.max(2, nodes.length);
    const gap = 10, margin = 22;
    const colW = (W - margin * 2 - (n - 1) * gap) / n;
    const t = titleBlock(ctx, data.title);
    const bandY = t.y0, bandH = 208;
    const H = bandY + bandH + 20;
    let svg = open(ctx, H) + t.svg;

    for (let i = 0; i < nodes.length; i++) {
      const k = ctx.rtl ? n - 1 - i : i;              // step 1 rightmost in RTL
      const x = margin + k * (colW + gap);
      svg += `<rect x="${r1(x)}" y="${bandY}" width="${r1(colW)}" height="${bandH}" rx="10" ` +
        `fill="${tint(ctx.primary, i % 2 ? 0.10 : 0.05)}"/>`;
      svg += `<text x="${r1(x + colW / 2)}" y="${bandY + 36}" text-anchor="middle" font-size="26" ` +
        `font-weight="700" fill="${ctx.primary}">${i + 1}</text>`;
      const labelLines = wrap(nodes[i].label, 13.5, colW - 16, 2);
      svg += textLines(x + colW / 2, bandY + 60, labelLines, 13.5, ctx.primary, 700);
      // Arrow strip between columns (pointing in reading direction).
      if (i < nodes.length - 1) {
        const ax = ctx.rtl ? x - gap + 1 : x + colW + gap - 1;
        const bx = ctx.rtl ? x + 1 : x + colW - 1;
        svg += arrow(ctx, bx, bandY + 30, ax, bandY + 30);
      }
      if (nodes[i].sub) {
        const boxY = bandY + 96, boxH2 = 94;
        svg += `<rect x="${r1(x + 8)}" y="${boxY}" width="${r1(colW - 16)}" height="${boxH2}" rx="8" ` +
          `fill="${BG}" stroke="${ctx.accent}" stroke-width="1.5"/>`;
        const subLines = wrap(nodes[i].sub, 12, colW - 30, 4);
        svg += textLines(x + colW / 2, boxY + 22, subLines, 12, INK);
      }
    }
    return svg + '</svg>';
  }

  function cycle(data, ctx) {
    const nodes = data.nodes.slice(0, 8);
    const n = nodes.length;
    const boxW = 150, boxH = 54;
    const R = n <= 4 ? 118 : 118 + (n - 4) * 16;
    const t = titleBlock(ctx, data.title);
    const cx = W / 2, cy = t.y0 + R + boxH / 2 + 12;
    const H = cy + R + boxH / 2 + 24;
    let svg = open(ctx, H) + t.svg;

    const pos = [];
    for (let i = 0; i < n; i++) {
      // Start at top; RTL reads counter-clockwise, LTR clockwise.
      const ang = -Math.PI / 2 + (ctx.rtl ? -1 : 1) * (2 * Math.PI * i / n);
      pos.push({ x: cx + R * Math.cos(ang) - boxW / 2, y: cy + R * Math.sin(ang) - boxH / 2, ang });
    }
    // Arrows first (under the boxes): arc between consecutive centers.
    for (let i = 0; i < n; i++) {
      const a = pos[i], b = pos[(i + 1) % n];
      const ax = a.x + boxW / 2 + Math.cos(a.ang + (ctx.rtl ? -0.5 : 0.5)) * (boxW / 2 + 6);
      const ay = a.y + boxH / 2 + Math.sin(a.ang + (ctx.rtl ? -0.5 : 0.5)) * (boxH / 2 + 18);
      const bx = b.x + boxW / 2 + Math.cos(b.ang - (ctx.rtl ? -0.5 : 0.5)) * (boxW / 2 + 6);
      const by = b.y + boxH / 2 + Math.sin(b.ang - (ctx.rtl ? -0.5 : 0.5)) * (boxH / 2 + 18);
      const mx = cx + (R + 44) * Math.cos((a.ang + b.ang) / 2 + (Math.abs(a.ang - b.ang) > Math.PI ? Math.PI : 0));
      const my = cy + (R + 44) * Math.sin((a.ang + b.ang) / 2 + (Math.abs(a.ang - b.ang) > Math.PI ? Math.PI : 0));
      svg += `<path d="M${r1(ax)},${r1(ay)} Q${r1(mx)},${r1(my)} ${r1(bx)},${r1(by)}" fill="none" ` +
        `stroke="${MUTED}" stroke-width="2" marker-end="url(#ah${ctx.mid})"/>`;
    }
    for (let i = 0; i < n; i++) {
      svg += nodeBox(ctx, pos[i].x, pos[i].y, boxW, boxH, nodes[i], { emphasis: data.emphasis === i });
    }
    return svg + '</svg>';
  }

  function hierarchy(data, ctx) {
    const nodes = data.nodes.slice(0, 10);
    const n = nodes.length;
    // Build levels from links (parent→child); default: node 0 is root of all.
    const links = Array.isArray(data.links) && data.links.length
      ? data.links.filter(l => Array.isArray(l) && l[0] < n && l[1] < n)
      : nodes.slice(1).map((_, i) => [0, i + 1]);
    const parentOf = {};
    links.forEach(([p, c]) => { if (parentOf[c] == null && p !== c) parentOf[c] = p; });
    const level = (i, seen) => {
      seen = seen || new Set();
      if (parentOf[i] == null || seen.has(i)) return 0;
      seen.add(i);
      return 1 + level(parentOf[i], seen);
    };
    const levels = [];
    for (let i = 0; i < n; i++) {
      const L = Math.min(level(i), 3);
      (levels[L] || (levels[L] = [])).push(i);
    }
    const boxH = 56, vGap = 58, margin = 24;
    const t = titleBlock(ctx, data.title);
    const H = t.y0 + levels.length * boxH + (levels.length - 1) * vGap + 24;
    let svg = open(ctx, H);

    const pos = {};
    levels.forEach((row, L) => {
      const count = row.length;
      const gap = 26;
      const boxW = Math.min(200, (W - margin * 2 - (count - 1) * gap) / count);
      const rowW = count * boxW + (count - 1) * gap;
      const x0 = (W - rowW) / 2;
      row.forEach((idx, k) => {
        const kk = ctx.rtl ? count - 1 - k : k;
        pos[idx] = { x: x0 + kk * (boxW + gap), y: t.y0 + L * (boxH + vGap), w: boxW };
      });
    });
    // Elbow connectors parent → child.
    for (const [c, p] of Object.entries(parentOf)) {
      const a = pos[p], b = pos[c];
      if (!a || !b) continue;
      const x1 = a.x + a.w / 2, y1 = a.y + boxH;
      const x2 = b.x + b.w / 2, y2 = b.y;
      const my = (y1 + y2) / 2;
      svg += `<path d="M${r1(x1)},${r1(y1)} L${r1(x1)},${r1(my)} L${r1(x2)},${r1(my)} L${r1(x2)},${r1(y2 - 4)}" ` +
        `fill="none" stroke="${MUTED}" stroke-width="2" marker-end="url(#ah${ctx.mid})"/>`;
    }
    for (let i = 0; i < n; i++) {
      if (!pos[i]) continue;
      const em = data.emphasis != null ? data.emphasis === i : parentOf[i] == null;
      svg += nodeBox(ctx, pos[i].x, pos[i].y, pos[i].w, boxH, nodes[i], { emphasis: em });
    }
    return svg + t.svg + '</svg>';
  }

  function timeline(data, ctx) {
    const nodes = data.nodes.slice(0, 8);
    const n = nodes.length;
    const margin = 60;
    const t = titleBlock(ctx, data.title);
    const axisY = t.y0 + 92;
    const H = axisY + 118;
    let svg = open(ctx, H) + t.svg;
    svg += `<line x1="${margin - 20}" y1="${axisY}" x2="${W - margin + 20}" y2="${axisY}" ` +
      `stroke="${LINE}" stroke-width="2.5"/>`;
    const step = (W - margin * 2) / Math.max(1, n - 1);
    for (let i = 0; i < n; i++) {
      const k = ctx.rtl ? n - 1 - i : i;
      const x = margin + k * step;
      const above = i % 2 === 0;
      const boxW = Math.min(170, step + 30), boxH = 58;
      const by = above ? axisY - 26 - boxH : axisY + 26;
      svg += `<circle cx="${r1(x)}" cy="${axisY}" r="7" fill="${i === data.emphasis ? ctx.accent : ctx.primary}"/>`;
      svg += `<line x1="${r1(x)}" y1="${above ? axisY - 26 : axisY + 8}" x2="${r1(x)}" ` +
        `y2="${above ? axisY - 8 : axisY + 26}" stroke="${LINE}" stroke-width="2"/>`;
      const bx = Math.max(8, Math.min(W - boxW - 8, x - boxW / 2));
      svg += nodeBox(ctx, bx, by, boxW, boxH, nodes[i], { emphasis: data.emphasis === i });
    }
    return svg + '</svg>';
  }

  function comparison(data, ctx) {
    const nodes = data.nodes.slice(0, 3);
    const n = Math.max(2, nodes.length);
    const gap = 22, margin = 30;
    const colW = (W - margin * 2 - (n - 1) * gap) / n;
    const t = titleBlock(ctx, data.title);
    const headH = 46;
    const bodyLines = nodes.map(nd => wrap(nd.sub || '', 13, colW - 28, 7));
    const bodyH = Math.max(90, Math.max(...bodyLines.map(l => l.length)) * 19 + 30);
    const H = t.y0 + headH + bodyH + 26;
    let svg = open(ctx, H) + t.svg;
    const colColor = [ctx.primary, ctx.accent, ctx.third];
    for (let i = 0; i < nodes.length; i++) {
      const k = ctx.rtl ? n - 1 - i : i;
      const x = margin + k * (colW + gap);
      svg += `<rect x="${r1(x)}" y="${t.y0}" width="${r1(colW)}" height="${headH}" rx="9" fill="${colColor[i % 3]}"/>`;
      svg += textLines(x + colW / 2, t.y0 + headH / 2 + 5, wrap(nodes[i].label, 15, colW - 20, 1), 15, BG, 700);
      svg += `<rect x="${r1(x)}" y="${t.y0 + headH + 8}" width="${r1(colW)}" height="${bodyH}" rx="9" ` +
        `fill="${tint(colColor[i % 3], 0.06)}" stroke="${colColor[i % 3]}" stroke-width="1.2"/>`;
      svg += textLines(x + colW / 2, t.y0 + headH + 34, bodyLines[i], 13, INK);
    }
    return svg + '</svg>';
  }

  function pyramid(data, ctx) {
    const nodes = data.nodes.slice(0, 6);
    const n = nodes.length;
    const t = titleBlock(ctx, data.title);
    const levH = 52, gap = 6;
    const H = t.y0 + n * (levH + gap) + 18;
    let svg = open(ctx, H) + t.svg;
    const wMin = 220, wMax = W - 120;
    for (let i = 0; i < n; i++) {
      const wTop = wMin + (wMax - wMin) * (i / Math.max(1, n - 1)) * (n === 1 ? 0 : 1);
      const wBot = n === 1 ? wTop : wMin + (wMax - wMin) * ((i + 0.85) / Math.max(1, n - 1));
      const y = t.y0 + i * (levH + gap);
      const x1 = (W - wTop) / 2, x2 = (W + wTop) / 2;
      const x3 = (W + Math.min(wBot, wMax)) / 2, x4 = (W - Math.min(wBot, wMax)) / 2;
      const alpha = 0.92 - i * (0.75 / Math.max(1, n - 1));
      svg += `<path d="M${r1(x1)},${y} L${r1(x2)},${y} L${r1(x3)},${y + levH} L${r1(x4)},${y + levH} z" ` +
        `fill="${tint(ctx.primary, Math.max(0.12, alpha))}"/>`;
      const dark = alpha > 0.45;
      const label = nodes[i].sub ? nodes[i].label + ' — ' + nodes[i].sub : nodes[i].label;
      svg += textLines(W / 2, y + levH / 2 + 5, wrap(label, 14, Math.min(wTop, wBot) - 30, 1), 14, dark ? BG : ctx.primary, 700);
    }
    return svg + '</svg>';
  }

  const LAYOUTS = { flow, steps, cycle, hierarchy, timeline, comparison, pyramid };

  // Entry point. Unknown layouts fall back to flow; bad node lists error early.
  function render(data, opts) {
    if (!data || !Array.isArray(data.nodes) || data.nodes.length < 2) return null;
    const nodes = data.nodes
      .map(nd => typeof nd === 'string' ? { label: nd } : nd)
      .filter(nd => nd && nd.label);
    if (nodes.length < 2) return null;
    const layout = LAYOUTS[String(data.layout || '').toLowerCase()] || flow;
    return layout(Object.assign({}, data, { nodes }), makeCtx(opts));
  }

  const api = { render, layouts: Object.keys(LAYOUTS) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.EnrichDiagrams = api;

  // Demo: `node src/enrich/diagrams.js` renders one SVG per layout to tmp.
  if (typeof module !== 'undefined' && require.main === module) {
    const fs = require('fs'), path = require('path'), os = require('os');
    const opts = { palette: ['#413258', '#1AD9C7', '#BFA19F'], rtl: true };
    const demos = {
      flow: { layout: 'flow', title: 'خطوات معالجة البيانات', nodes: [
        { label: 'جمع القراءات', sub: 'من الحساسات' }, { label: 'التنقية', sub: 'عزل الشواذ' },
        { label: 'التحليل', sub: 'إحصائيًا' }, { label: 'القرار', sub: 'تشغيلي' }], emphasis: 3 },
      steps: { layout: 'steps', title: 'تحليل تكلفة هدر التوقف', nodes: [
        { label: 'مصدر البيانات', sub: 'سجلات نظام سكادا للوردية' },
        { label: 'تحديد فترات التوقف', sub: 'تعطل الماكينة 12 دقيقة، تغيير القالب 18 دقيقة' },
        { label: 'تجميع إجمالي الوقت', sub: 'إجمالي وقت التوقف 45 دقيقة' },
        { label: 'تطبيق تكلفة الساعة', sub: '450 ريال سعودي لكل ساعة' },
        { label: 'النتيجة النهائية', sub: 'إجمالي خسارة الهدر 337.5 ريال' }] },
      cycle: { layout: 'cycle', title: 'دورة التحسين المستمر', nodes: [
        { label: 'خطط' }, { label: 'نفذ' }, { label: 'افحص' }, { label: 'صحح' }] },
      hierarchy: { layout: 'hierarchy', title: 'تصنيف قنوات البيانات اللحظية', nodes: [
        { label: 'المورد الرقمي' }, { label: 'قراءات الحساسات', sub: 'لحظية مستمرة' },
        { label: 'سجلات الإنتاج', sub: 'تراكمية' }, { label: 'حساس الضغط' },
        { label: 'مجس الحرارة' }, { label: 'كميات المخرجات' }],
        links: [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5]] },
      timeline: { layout: 'timeline', title: 'الخطة الزمنية للدرس', nodes: [
        { label: 'الاختبار القبلي', sub: '40 دقيقة' }, { label: 'الشرح المفهومي', sub: '60 دقيقة' },
        { label: 'أنظمة سكادا', sub: '60 دقيقة' }, { label: 'النمذجة الرياضية', sub: '60 دقيقة' },
        { label: 'التقييم الختامي', sub: '80 دقيقة' }] },
      comparison: { layout: 'comparison', title: 'قراءات الحساسات مقابل سجلات الإنتاج', nodes: [
        { label: 'قراءات الحساسات', sub: 'لحظية بالملي ثانية، خام ومستمرة، من أرضية المعمل مباشرة، حجم هائل' },
        { label: 'سجلات الإنتاج', sub: 'تراكمية لكل وردية، منظمة في جداول، توثق التوقف والاستهلاك، حجم محدود' }] },
      pyramid: { layout: 'pyramid', title: 'الهرم الرقمي للمصانع', nodes: [
        { label: 'القرار', sub: 'ERP' }, { label: 'الإشراف', sub: 'SCADA' },
        { label: 'التحكم', sub: 'PLC' }, { label: 'الميدان', sub: 'حساسات' }] }
    };
    const dir = path.join(os.tmpdir(), 'lve-diagrams');
    fs.mkdirSync(dir, { recursive: true });
    let ok = 0;
    for (const [name, spec] of Object.entries(demos)) {
      const svg = render(spec, opts);
      const valid = svg && /^<svg[\s\S]+<\/svg>$/.test(svg) && !/NaN|undefined/.test(svg);
      if (valid) { fs.writeFileSync(path.join(dir, name + '.svg'), svg); ok++; }
      console.log((valid ? 'OK  ' : 'FAIL') + ' ' + name + (valid ? ` (${svg.length}b)` : ''));
    }
    console.log(ok + '/' + Object.keys(demos).length + ' →', dir);
  }
})(typeof window !== 'undefined' ? window : null);
