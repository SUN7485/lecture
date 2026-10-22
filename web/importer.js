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

  // ---- Deck-shape sniffer -------------------------------------------------
  // The editor's slides are the large direct children of <body>. Decks from
  // ChatGPT/Claude/Gemini rarely look like that: they are <section>s shown one
  // at a time by a script (all but one display:none), or reveal.js
  // (.reveal > .slides > section), sized in vw/vh. Opened as-is they arrive as
  // ONE slide. This rewrites such a deck into the editor's shape: every slide
  // a visible 16:9 page directly under <body>, nav chrome and the slideshow
  // script removed. Decks that already have .slide elements are untouched.
  var NAV_SEL = 'nav, .nav, .navigation, .controls, .progress, .slide-number, .slide-counter, .pagination, ' +
    '[class*="nav-"], [id*="nav"], [id*="prev"], [id*="next"], [class*="prev"], [class*="next"]';
  var SNIFF_CSS =
    '.slide{display:block !important;position:relative !important;width:1280px !important;height:720px !important;' +
    'min-height:0 !important;max-width:none !important;margin:24px auto !important;box-sizing:border-box;overflow:hidden;' +
    'opacity:1 !important;visibility:visible !important;transform:none !important;left:auto !important;top:auto !important;}';

  function candidateSlides(doc) {
    var reveal = doc.querySelectorAll('.reveal .slides > section');
    if (reveal.length >= 2) {
      // vertical stacks: a section holding sections — each inner one is a slide
      var flat = [];
      Array.prototype.forEach.call(reveal, function (s) {
        var inner = s.querySelectorAll(':scope > section');
        if (inner.length) Array.prototype.push.apply(flat, inner); else flat.push(s);
      });
      return flat;
    }
    var groups = [
      doc.querySelectorAll('body > section, body > main > section, body > div > section'),
      doc.querySelectorAll('[class~="slide-item"], [class~="page"], [data-slide]'),
      doc.querySelectorAll('[class*="slide"]:not([class*="slides"]):not([class*="slider"])')
    ];
    for (var g = 0; g < groups.length; g++) {
      var list = Array.prototype.filter.call(groups[g], function (el) {
        return !el.parentElement || !el.parentElement.closest('section, [class*="slide"]:not([class*="slides"])');
      });
      if (list.length >= 2) return list;
    }
    return [];
  }

  function normalizeDeckShape(html) {
    if (!html || typeof DOMParser === 'undefined') return { html: html, slides: 0 };
    var doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.querySelector('.slide')) return { html: html, slides: 0 };
    var slides = candidateSlides(doc);
    if (slides.length < 2) return { html: html, slides: 0 };

    slides.forEach(function (s) {
      s.classList.add('slide');
      s.classList.remove('active', 'present', 'past', 'future', 'hidden');
      s.removeAttribute('hidden');
      s.removeAttribute('aria-hidden');
      if (s.style) { s.style.removeProperty('display'); s.style.removeProperty('opacity'); s.style.removeProperty('visibility'); s.style.removeProperty('transform'); }
    });
    // The slideshow machinery: its script would hide the slides again, its
    // buttons are not content.
    Array.prototype.forEach.call(doc.querySelectorAll('script'), function (n) { n.remove(); });
    Array.prototype.forEach.call(doc.querySelectorAll(NAV_SEL), function (n) {
      if (!n.closest('.slide') && !n.querySelector('.slide')) n.remove();
    });
    Array.prototype.forEach.call(doc.querySelectorAll('body > button'), function (n) { n.remove(); });
    // Slides become direct children of <body>, in order; wrappers that held
    // nothing else go away with them.
    var body = doc.body;
    var wrappers = [];
    slides.forEach(function (s) {
      var p = s.parentElement;
      if (p && p !== body && wrappers.indexOf(p) === -1) wrappers.push(p);
      body.appendChild(s);
    });
    wrappers.forEach(function (w) {
      var cur = w;
      while (cur && cur !== body && !cur.textContent.trim() && !cur.querySelector('img, svg, video, canvas')) {
        var up = cur.parentElement; cur.remove(); cur = up;
      }
    });
    // vw/vh meant "the screen" when one slide filled it. In the editor the
    // viewport is the whole tall canvas, so 8vh became a slide's worth of
    // padding. Pin them to the 1280x720 page each slide now is.
    var pinUnits = function (css) {
      return css.replace(/(-?\d*\.?\d+)(vh|vw|vmin|vmax)\b/g, function (m, n, u) {
        var per = u === 'vh' ? 7.2 : u === 'vw' ? 12.8 : u === 'vmin' ? 7.2 : 12.8;
        return Math.round(parseFloat(n) * per * 100) / 100 + 'px';
      });
    };
    Array.prototype.forEach.call(doc.querySelectorAll('style'), function (st) { st.textContent = pinUnits(st.textContent); });
    Array.prototype.forEach.call(doc.querySelectorAll('[style]'), function (el) { el.setAttribute('style', pinUnits(el.getAttribute('style'))); });

    var style = doc.createElement('style');
    style.setAttribute('data-ve-sniffed', String(slides.length));
    style.textContent = SNIFF_CSS;
    doc.head.appendChild(style);
    return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, slides: slides.length };
  }

  // ---- Bytes -> HTML (browser twin of src/decode-html.js) -----------------
  // Arabic HTML saved by older Windows/Office/FrontPage is windows-1256;
  // read as UTF-8 it became a wall of U+FFFD. BOM, then <meta charset>, then
  // windows-1256 when UTF-8 produces replacement characters and 1256 yields
  // Arabic. The result always declares UTF-8 (Save writes UTF-8).
  var META_RE = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i;
  function decodeHtml(buffer) {
    var bytes = new Uint8Array(buffer);
    var enc = null;
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) enc = 'utf-8';
    else if (bytes[0] === 0xFF && bytes[1] === 0xFE) enc = 'utf-16le';
    else if (bytes[0] === 0xFE && bytes[1] === 0xFF) enc = 'utf-16be';
    if (!enc) {
      var m = META_RE.exec(new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096)));
      if (m) enc = m[1].toLowerCase();
    }
    var text = null, used = enc || 'utf-8';
    if (enc && enc !== 'utf-8' && enc !== 'utf8') {
      try { text = new TextDecoder(enc).decode(bytes); } catch (_) { text = null; used = 'utf-8'; }
    }
    if (text === null) {
      text = new TextDecoder('utf-8').decode(bytes);
      var bad = (text.match(/�/g) || []).length;
      if (bad > 3) {
        var ar = new TextDecoder('windows-1256').decode(bytes);
        if (/[؀-ۿ]{3,}/.test(ar) && (ar.match(/�/g) || []).length < bad) { text = ar; used = 'windows-1256'; }
      }
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (used !== 'utf-8' && used !== 'utf8') {
      text = text
        .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*>/ig, '<meta charset="utf-8">')
        .replace(/(<meta[^>]+charset\s*=\s*["']?\s*)[\w-]+/i, '$1utf-8');
    }
    return { html: text, encoding: used };
  }

  // ---- Files that are not decks ---------------------------------------------
  // Classifies what normalizeDeckShape could not turn into slides, and turns
  // what can be into a deck: plain text (one paragraph per line) and articles
  // (split at their headings, the Word-import way). Empty files and decks that
  // build their slides with JavaScript are only named, so the editor can say
  // what is going on instead of «جاهز» over an empty canvas.
  function latinMajority(s) {
    return (s.match(/[A-Za-z]/g) || []).length > (s.match(/[؀-ۿ]/g) || []).length;
  }
  function asLtr(deckHtml) {
    return deckHtml.replace('<html lang="ar" dir="rtl">', '<html lang="en" dir="ltr">').replace('direction:rtl;', 'direction:ltr;');
  }
  function convertNonDeck(html) {
    var raw = String(html || '');
    if (!raw.trim()) return { html: html, kind: 'empty' };
    if (!/<[a-z!][^>]*>/i.test(raw)) {
      var lines = raw.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
      var esc = function (s) { return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
      var deck = fromWordHtml(lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join(''), { title: lines[0].slice(0, 60) });
      return { html: latinMajority(raw) ? asLtr(deck) : deck, kind: 'text' };
    }
    var doc = new DOMParser().parseFromString(raw, 'text/html');
    // Already a deck: .slide elements, or several heading-bearing blocks
    // straight under <body> (a custom slide class the sniffer did not know).
    if (doc.querySelector('.slide')) return { html: html, kind: 'deck' };
    var blocks = Array.prototype.filter.call(doc.body.children, function (c) { return c.querySelector('h1, h2, h3') && !/^(HEADER|NAV|FOOTER|MAIN|ARTICLE)$/.test(c.tagName); });
    if (blocks.length >= 3) return { html: html, kind: 'deck' };
    var scripts = doc.querySelectorAll('script').length;
    Array.prototype.forEach.call(doc.querySelectorAll('script, style, noscript, template'), function (n) { n.remove(); });
    var bodyText = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    var hasMedia = !!doc.body.querySelector('img, svg, video, canvas, iframe');
    if (!bodyText && !hasMedia) return { html: html, kind: scripts ? 'scripted' : 'empty' };
    if (bodyText.length < 40 && scripts && !hasMedia) return { html: html, kind: 'scripted' };
    // An article: one long flow with headings. The main content root is the
    // biggest of article/main/[role=main]/body by text.
    var roots = [].concat(Array.prototype.slice.call(doc.querySelectorAll('article, main, [role="main"]')), [doc.body]);
    var root = roots.reduce(function (a, b) { return (b.textContent || '').length > (a.textContent || '').length * 1.2 ? b : a; });
    var headings = root.querySelectorAll('h1, h2, h3').length;
    if (bodyText.length < 1200 && headings < 2) return { html: html, kind: 'deck' };
    Array.prototype.forEach.call(root.querySelectorAll('nav, header, footer, aside, form, button, [role="navigation"]'), function (n) { n.remove(); });
    // the Word splitter groups on h1/h2: promote h3 when that is all there is
    if (!root.querySelector('h1, h2')) Array.prototype.forEach.call(root.querySelectorAll('h3'), function (h) {
      var h2 = doc.createElement('h2'); h2.innerHTML = h.innerHTML; h.replaceWith(h2);
    });
    // flatten wrappers so headings and paragraphs are siblings for the splitter
    var flat = [];
    (function walk(el) {
      Array.prototype.forEach.call(el.children, function (c) {
        if (/^(DIV|SECTION|ARTICLE|MAIN|SPAN)$/.test(c.tagName) && c.querySelector('h1,h2,p,ul,ol,table,img')) walk(c);
        else flat.push(c.outerHTML);
      });
    })(root);
    var title = (doc.title || (root.querySelector('h1') || {}).textContent || 'مقال').trim().slice(0, 80);
    var out = fromWordHtml(flat.join(''), { title: title });
    return { html: latinMajority(bodyText) ? asLtr(out) : out, kind: 'article' };
  }

  window.DeckImporter = { fromWordHtml: fromWordHtml, normalizeDeckShape: normalizeDeckShape,
                          decodeHtml: decodeHtml, convertNonDeck: convertNonDeck };
})();
