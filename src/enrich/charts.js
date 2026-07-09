/*
 * charts.js — turn a lecture's OWN table data into a themed SVG chart.
 *
 * Deterministic and offline: no AI, no invented numbers. It only ever plots
 * digits that already exist in the table, so a generated chart can never lie.
 * Output is a self-contained <svg> string (concrete hex colors, embedded text)
 * that drops into the RTL lecture and survives PDF export unchanged.
 *
 * Works in the renderer (window.EnrichCharts) and in Node (module.exports),
 * so buildBarChartSVG() can be unit-tested with `node src/enrich/charts.js`.
 */
(function (root) {
  'use strict';

  // Arabic-Indic / Persian digits → Western, then pull the first number out.
  function toNumber(s) {
    if (s == null) return null;
    const w = String(s)
      .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
      .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0)
      .replace(/[,٬،]/g, '');
    const m = w.match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function truncate(s, n) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Pull { categories, series } out of a <table> DOM element. Returns null when
  // the table has no column that is mostly numeric (i.e. nothing to chart).
  // `series` = one entry per numeric column; supports grouped bars.
  function extractTableData(tableEl) {
    if (!tableEl) return null;
    const rowEls = Array.from(tableEl.querySelectorAll('tr'));
    if (rowEls.length < 2) return null;

    // Header row: prefer <th>; else the first row.
    const headEls = tableEl.querySelectorAll('th');
    const headerRow = headEls.length ? Array.from(headEls) : Array.from(rowEls[0].children);
    const headers = headerRow.map(c => c.textContent.trim());

    const bodyRows = (tableEl.tBodies[0]
      ? Array.from(tableEl.tBodies[0].rows)
      : rowEls.slice(1)
    ).map(r => Array.from(r.children).map(c => c.textContent.trim()));
    if (!bodyRows.length) return null;

    const colCount = Math.max(...bodyRows.map(r => r.length));
    // Classify each column: what fraction of its cells parse as a number?
    const numeric = [];
    for (let c = 0; c < colCount; c++) {
      let nums = 0, total = 0;
      for (const r of bodyRows) {
        if (r[c] == null || r[c] === '') continue;
        total++;
        if (toNumber(r[c]) != null) nums++;
      }
      numeric[c] = total > 0 && nums / total >= 0.6;
    }
    const valueCols = [];
    for (let c = 0; c < colCount; c++) if (numeric[c]) valueCols.push(c);
    if (!valueCols.length) return null;

    // Category column = first non-numeric column (labels); fallback to col 0.
    let catCol = 0;
    for (let c = 0; c < colCount; c++) { if (!numeric[c]) { catCol = c; break; } }

    const categories = bodyRows.map(r => r[catCol] || '');
    const series = valueCols.map(c => ({
      name: headers[c] || '',
      values: bodyRows.map(r => toNumber(r[c]))
    }));
    const title = (tableEl.getAttribute('data-title') || '').trim();
    return { title, categoryLabel: headers[catCol] || '', categories, series };
  }

  // Palette rotation for series/bars. Falls back to a sensible brand-ish set.
  function seriesColors(palette) {
    const base = (palette && palette.length ? palette : ['#413258', '#1AD9C7', '#BFA19F', '#666666'])
      .filter(c => /^#|^rgb|^hsl/i.test(c));
    return base.length ? base : ['#413258', '#1AD9C7', '#BFA19F'];
  }

  // Horizontal bar chart — the safe default for long Arabic category labels.
  // opts: { palette:[hex], width, rtl, fontFamily, title }
  function buildBarChartSVG(data, opts = {}) {
    if (!data || !data.series || !data.series.length) return null;
    const rtl = opts.rtl !== false;
    const W = opts.width || 820;
    const colors = seriesColors(opts.palette);
    const font = opts.fontFamily ||
      "'Diodrum Arabic','Cairo','Segoe UI',sans-serif";
    const title = opts.title || data.title || '';
    const ink = '#1A1A1A', grid = '#E6E6E6', muted = '#666666';

    const cats = data.categories;
    const nSeries = data.series.length;
    const barH = 18, groupPad = 14;
    const groupH = nSeries * barH + (nSeries - 1) * 3 + groupPad;
    const padTop = title ? 54 : 26;
    const padBottom = 30;
    const labelW = 210;                       // room for category labels
    const valPad = 46;                        // room for value text at bar end
    const plotL = rtl ? valPad : labelW;
    const plotR = rtl ? labelW : valPad;
    const plotW = W - plotL - plotR;
    const H = padTop + cats.length * groupH + padBottom + (nSeries > 1 ? 24 : 0);

    let max = 0;
    for (const s of data.series) for (const v of s.values) if (v != null && v > max) max = v;
    max = max || 1;
    // "Nice" upper bound so gridlines are round-ish.
    const niceMax = niceCeil(max);

    const x = (v) => rtl
      ? plotL + plotW - (v / niceMax) * plotW    // grows right→left
      : plotL + (v / niceMax) * plotW;
    const axisAnchor = rtl ? 'end' : 'start';    // category labels hug the bars

    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
      `width="${W}" height="${H}" font-family="${font}" direction="${rtl ? 'rtl' : 'ltr'}" ` +
      `role="img">`);
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#FFFFFF"/>`);
    if (title) {
      parts.push(`<text x="${rtl ? W - 10 : 10}" y="30" text-anchor="${rtl ? 'end' : 'start'}" ` +
        `font-size="20" font-weight="700" fill="${colors[0]}">${esc(truncate(title, 60))}</text>`);
    }

    // Gridlines + scale ticks.
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (niceMax / ticks) * i;
      const gx = x(v);
      parts.push(`<line x1="${gx.toFixed(1)}" y1="${padTop - 6}" x2="${gx.toFixed(1)}" ` +
        `y2="${padTop + cats.length * groupH}" stroke="${grid}" stroke-width="1"/>`);
      parts.push(`<text x="${gx.toFixed(1)}" y="${padTop + cats.length * groupH + 18}" ` +
        `text-anchor="middle" font-size="11" fill="${muted}">${fmt(v)}</text>`);
    }

    // Bars, grouped by category.
    cats.forEach((cat, ci) => {
      const gy = padTop + ci * groupH + groupPad / 2;
      data.series.forEach((s, si) => {
        const v = s.values[ci];
        const by = gy + si * (barH + 3);
        const color = colors[si % colors.length];
        if (v != null) {
          const bx = x(v), zero = x(0);
          const left = Math.min(bx, zero), w = Math.abs(bx - zero);
          parts.push(`<rect x="${left.toFixed(1)}" y="${by}" width="${Math.max(1, w).toFixed(1)}" ` +
            `height="${barH}" rx="3" fill="${color}"/>`);
          const tx = rtl ? left - 6 : left + w + 6;
          parts.push(`<text x="${tx.toFixed(1)}" y="${by + barH - 4}" ` +
            `text-anchor="${rtl ? 'end' : 'start'}" font-size="12" font-weight="600" ` +
            `fill="${ink}">${fmt(v)}</text>`);
        }
      });
      // Category label on the label side.
      const lx = rtl ? W - 10 : 10;
      parts.push(`<text x="${lx}" y="${gy + (groupH - groupPad) / 2 + 4}" ` +
        `text-anchor="${axisAnchor}" font-size="13" fill="${ink}">${esc(truncate(cat, 28))}</text>`);
    });

    // Legend when there is more than one numeric column.
    if (nSeries > 1) {
      const ly = H - 14;
      let lx = rtl ? W - 10 : 10;
      data.series.forEach((s, si) => {
        const label = truncate(s.name, 22);
        const swatch = 11, textW = label.length * 8 + 20;
        if (rtl) {
          parts.push(`<rect x="${lx - swatch}" y="${ly - swatch}" width="${swatch}" height="${swatch}" rx="2" fill="${colors[si % colors.length]}"/>`);
          parts.push(`<text x="${lx - swatch - 5}" y="${ly}" text-anchor="end" font-size="12" fill="${ink}">${esc(label)}</text>`);
          lx -= textW;
        } else {
          parts.push(`<rect x="${lx}" y="${ly - swatch}" width="${swatch}" height="${swatch}" rx="2" fill="${colors[si % colors.length]}"/>`);
          parts.push(`<text x="${lx + swatch + 5}" y="${ly}" text-anchor="start" font-size="12" fill="${ink}">${esc(label)}</text>`);
          lx += textW;
        }
      });
    }

    parts.push('</svg>');
    return parts.join('');
  }

  function niceCeil(v) {
    if (v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  }
  function fmt(v) {
    if (v == null) return '';
    return (Math.round(v * 100) / 100).toString();
  }

  const api = { extractTableData, buildBarChartSVG, toNumber };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.EnrichCharts = api;

  // Node smoke test: `node src/enrich/charts.js`
  if (typeof module !== 'undefined' && require.main === module) {
    const demo = {
      title: 'الخطة الزمنية (دقيقة)',
      categories: ['الحوار التفاعلي', 'التعلم الاستقصائي', 'التعلم القائم على المشكلات', 'الورش الجماعية', 'التقييم الختامي'],
      series: [{ name: 'الزمن', values: [40, 60, 60, 60, 80] }]
    };
    const svg = buildBarChartSVG(demo, { palette: ['#413258', '#1AD9C7', '#BFA19F'], rtl: true });
    const fs = require('fs'), path = require('path');
    const out = path.join(require('os').tmpdir(), 'chart-demo.svg');
    fs.writeFileSync(out, svg);
    console.log('wrote', out, '(' + svg.length + ' bytes)');
    console.log('parses as SVG:', /^<svg[\s\S]+<\/svg>$/.test(svg));
  }
})(typeof window !== 'undefined' ? window : null);
