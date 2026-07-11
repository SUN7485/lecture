/*
 * importer.js — Word (.docx via mammoth) -> editable deck HTML.
 * Pure DOM, zero Electron APIs. Loaded verbatim by BOTH the Electron renderer
 * and the static web port — keep web/importer.js byte-identical to
 * src/importer.js. Exposes window.DeckImporter.fromWordHtml(html, opts).
 *
 * Design reconciled against docs/import-findings.md (mission 010A):
 *  - Split a new slide on every <h1>/<h2> mammoth emits (real Word heading
 *    styles convert cleanly). A doc with ZERO headings — confirmed to
 *    happen when a teacher only bolds/enlarges text instead of using Word's
 *    Heading styles — falls back to grouping every FALLBACK_GROUP_SIZE
 *    block-level elements into a slide, so it still produces a usable deck.
 *  - Images already arrive as data: URLs from mammoth — carried through
 *    as-is via outerHTML, never rewritten to external/local refs.
 *  - Tables kept as real HTML <table> — mammoth's table fidelity was clean.
 *  - Mammoth's output has NO dir/lang of its own — this module wraps the
 *    whole deck in <html lang="ar" dir="rtl"> itself.
 *  - Long sections overflow into a "<title> (تابع)" continuation slide,
 *    split by a rough character budget (CONTENT_CHAR_BUDGET).
 */
(function () {
  'use strict';

  var CONTENT_CHAR_BUDGET = 900;  // rough per-slide text budget before a continuation slide
  var FALLBACK_GROUP_SIZE = 5;    // block elements per slide when the doc has no headings

  // Same .slide/.content/h1/h2 structure + CSS var names as the app's own
  // templates (mission 013) and the MiM brand palette (BRAND_PALETTES.MiM)
  // — not a new slide CSS, and theme-file presets (012) recolor it for free.
  var TEMPLATE_CSS =
    ':root{--purple:#413258;--cyan:#1AD9C7;--pink:#BFA19F;--gold:#BFA19F;' +
    '--dark:#1A1A1A;--bg-gray:#F4F4F6;--white:#FFFFFF;' +
    '--grey-dark:#666666;--grey-mid:#B3B3B3;--grey-light:#E6E6E6;}' +
    '*{box-sizing:border-box;}' +
    'body{margin:0;background:var(--bg-gray);font-family:Cairo,sans-serif;direction:rtl;}' +
    '.slide{width:950px;height:650px;margin:40px auto;background:var(--white);' +
    'padding:45px 60px;position:relative;box-shadow:0 25px 50px rgba(0,0,0,.12);' +
    'border-right:12px solid var(--purple);overflow:hidden;}' +
    '.slide h1{color:var(--purple);font-size:30px;margin:0 0 10px;border-bottom:3px solid var(--cyan);padding-bottom:8px;}' +
    '.content{font-size:17px;line-height:1.75;color:var(--dark);height:460px;overflow:hidden;}' +
    '.content p,.content ul,.content ol{margin:0 0 10px;}' +
    '.content img{max-width:100%;height:auto;}' +
    'table{width:100%;border-collapse:collapse;font-size:14px;}' +
    'th,td{border:1px solid var(--grey-light);padding:6px 9px;text-align:right;}' +
    'th{background:var(--purple);color:var(--white);}';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Group mammoth's flat top-level nodes into { title, contentNodes[] }
  // sections, splitting on real headings when present.
  function groupByHeadings(nodes, fallbackTitle) {
    var groups = [];
    var current = null;
    nodes.forEach(function (n) {
      if (/^H[12]$/.test(n.tagName)) {
        current = { title: (n.textContent || '').trim() || fallbackTitle, contentNodes: [] };
        groups.push(current);
      } else {
        if (!current) { current = { title: fallbackTitle, contentNodes: [] }; groups.push(current); }
        current.contentNodes.push(n);
      }
    });
    return groups;
  }

  function groupByCount(nodes, title, size) {
    var groups = [];
    for (var i = 0; i < nodes.length; i += size) {
      groups.push({ title: title, contentNodes: nodes.slice(i, i + size) });
    }
    return groups.length ? groups : [{ title: title, contentNodes: [] }];
  }

  // Split an overflowing section into one or more slides by a rough
  // character budget, naming continuations "<title> (تابع)".
  function splitByBudget(group) {
    var chunks = [[]];
    var budget = CONTENT_CHAR_BUDGET;
    group.contentNodes.forEach(function (n) {
      var len = (n.textContent || '').length;
      if (budget - len < 0 && chunks[chunks.length - 1].length) {
        chunks.push([]);
        budget = CONTENT_CHAR_BUDGET;
      }
      chunks[chunks.length - 1].push(n);
      budget -= len;
    });
    return chunks.map(function (chunk, idx) {
      return { title: group.title + (idx > 0 ? ' (تابع)' : ''), contentNodes: chunk };
    });
  }

  function fromWordHtml(html, opts) {
    opts = opts || {};
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var nodes = Array.prototype.slice.call(doc.body.children);
    var introTitle = opts.title || 'مقدمة';
    var hasHeadings = nodes.some(function (n) { return /^H[12]$/.test(n.tagName); });

    var groups = hasHeadings
      ? groupByHeadings(nodes, introTitle)
      : groupByCount(nodes, opts.title || 'محتوى مستورد', FALLBACK_GROUP_SIZE);

    var slidesData = [];
    groups.forEach(function (g) { splitByBudget(g).forEach(function (s) { slidesData.push(s); }); });

    var slidesHtml = slidesData.map(function (s) {
      var contentHtml = s.contentNodes.map(function (n) { return n.outerHTML; }).join('\n');
      return '<div class="slide"><h1>' + escapeHtml(s.title) + '</h1><div class="content">' + contentHtml + '</div></div>';
    }).join('\n');

    return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
      '<title>' + escapeHtml(opts.title || 'مستند مستورد') + '</title>' +
      '<style>' + TEMPLATE_CSS + '</style></head><body>' + slidesHtml + '</body></html>';
  }

  window.DeckImporter = { fromWordHtml: fromWordHtml };
})();
