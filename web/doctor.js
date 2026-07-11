/*
 * doctor.js — Slide Doctor: a deterministic "Grammarly for slides" lint engine.
 * Pure DOM, zero AI, zero network. Loaded verbatim by BOTH the Electron renderer
 * and the static web port — keep web/doctor.js byte-identical to src/doctor.js.
 * Exposes window.SlideDoctor.analyze(editor) -> issues[]. Each issue:
 *   { ruleId, severity: 'error'|'warn', slideIndex, el, message (ar), fix|null }
 * fix() (when present) mutates the DOM in place; the caller records one undo
 * step via editor.commit(). After any fix/undo the caller MUST re-run analyze()
 * because undo replaces body.innerHTML and invalidates every `el` reference.
 */
(function () {
  'use strict';

  // Thresholds — tuned for ministry lecture decks; deliberately conservative
  // so a clean deck reports zero issues.
  var TEXT_WORD_LIMIT = 70;   // words per slide before it reads as a wall of text
  var TEXT_CHAR_LIMIT = 420;  // char backstop for dense scripts
  var FONT_LIMIT = 2;         // brand rule: at most two families per slide
  var ASPECT_TOL = 0.12;      // >12% aspect drift = visibly distorted image
  var IMG_MIN_AREA = 40000;   // ignore small/decorative images (~200x200)

  // ---- WCAG 2.1 relative luminance + contrast ratio ----
  function _srgb(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function _lum(c) { return 0.2126 * _srgb(c[0]) + 0.7152 * _srgb(c[1]) + 0.0722 * _srgb(c[2]); }
  function _ratio(a, b) {
    var L1 = _lum(a), L2 = _lum(b), hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return (hi + 0.05) / (lo + 0.05);
  }
  // Computed color -> [r,g,b], or null when fully transparent (alpha 0) so
  // background resolution can fall through to the parent element.
  function _rgb(str) {
    if (!str) return null;
    var m = str.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    var p = m[1].split(',').map(function (s) { return parseFloat(s.trim()); });
    if (p.length >= 4 && p[3] === 0) return null;
    return [p[0], p[1], p[2]];
  }
  // Effective background behind an element: first ancestor with a non-transparent
  // background-color, else the given fallback (slide bg, else white).
  function _bgOf(el, win, fallback) {
    var n = el;
    while (n && n.nodeType === 1) {
      var bg = _rgb(win.getComputedStyle(n).backgroundColor);
      if (bg) return bg;
      n = n.parentElement;
    }
    return fallback;
  }
  // First (primary) font family a computed style requests, unquoted.
  function _fam(win, el) {
    return (win.getComputedStyle(el).fontFamily.split(',')[0] || '').trim().replace(/^['"]|['"]$/g, '');
  }
  // Elements that directly hold visible text (mirrors editor.themeAudit sampling);
  // skips the editor's own overlay chrome.
  function _textEls(slide) {
    var out = [], all = slide.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest('.ve-overlay, .ve-toolbar, .ve-palette, .ve-wandmenu, .ve-guide, .ve-ghost')) continue;
      var has = false;
      for (var c = 0; c < el.childNodes.length; c++) {
        var node = el.childNodes[c];
        if (node.nodeType === 3 && /\S/.test(node.nodeValue)) { has = true; break; }
      }
      if (has) out.push(el);
    }
    return out;
  }

  // Wrap an uncaptioned image in the editor's numbered-figure convention so
  // renumberFigures() (run by editor.commit) auto-labels it «شكل N — …».
  function _captionFix(img, doc) {
    return function () {
      var fig = img.closest('figure');
      if (!fig) {
        fig = doc.createElement('figure');
        fig.className = 've-slot';
        img.parentNode.insertBefore(fig, img);
        fig.appendChild(img);
      }
      fig.setAttribute('data-ve-figure', '');
      if (!fig.getAttribute('data-ve-caption')) fig.setAttribute('data-ve-caption', 'وصف الشكل');
      if (!fig.querySelector('figcaption')) fig.appendChild(doc.createElement('figcaption'));
    };
  }

  function analyze(editor) {
    if (!editor || !editor.doc || !editor.win) return [];
    var doc = editor.doc, win = editor.win;
    var slides = editor.slides();
    var issues = [];

    slides.forEach(function (slide, si) {
      var texts = _textEls(slide);

      // Rule 1 — text overload (advisory)
      var raw = (slide.textContent || '').replace(/\s+/g, ' ').trim();
      var words = raw ? raw.split(' ').length : 0;
      if (words > TEXT_WORD_LIMIT || raw.length > TEXT_CHAR_LIMIT) {
        issues.push({ ruleId: 'text-overload', severity: 'warn', slideIndex: si, el: slide,
          message: 'الشريحة مزدحمة بالنص (' + words + ' كلمة) — فكّر في تقسيمها إلى شريحتين.', fix: null });
      }

      // Rule 2 — low contrast (advisory; report the single worst text element)
      var worst = null;
      texts.forEach(function (el) {
        var cs = win.getComputedStyle(el);
        var fg = _rgb(cs.color); if (!fg) return;
        var bg = _bgOf(el, win, [255, 255, 255]);
        var ratio = _ratio(fg, bg);
        var size = parseFloat(cs.fontSize) || 16;
        var bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
        var large = size >= 24 || (bold && size >= 18.66);
        var need = large ? 3 : 4.5;
        if (ratio < need && (!worst || ratio < worst.ratio)) worst = { el: el, ratio: ratio, need: need };
      });
      if (worst) {
        issues.push({ ruleId: 'low-contrast', severity: 'error', slideIndex: si, el: worst.el,
          message: 'تباين ضعيف بين النص والخلفية (النسبة ' + worst.ratio.toFixed(1) + ':1، المطلوب ≥' + worst.need + ').', fix: null });
      }

      // Rule 3 — font zoo (advisory; >2 primary families on one slide)
      var fams = {};
      texts.forEach(function (el) { var f = _fam(win, el); if (f) fams[f] = 1; });
      var famList = Object.keys(fams);
      if (famList.length > FONT_LIMIT) {
        issues.push({ ruleId: 'font-zoo', severity: 'warn', slideIndex: si, el: slide,
          message: 'الشريحة تستخدم ' + famList.length + ' خطوط مختلفة — التزم بخطّين على الأكثر.', fix: null });
      }

      // Rules 4 & 5 — one pass over images
      var imgs = slide.querySelectorAll('img');
      for (var k = 0; k < imgs.length; k++) {
        var img = imgs[k];
        if (img.closest('.ve-ghost') || img.closest('[data-ve-figlist]')) continue;

        // Rule 4 — stretched / distorted image (auto-fixable)
        // Only object-fit:fill (the default) distorts; contain/cover/scale-down/none all
        // preserve the image's aspect, so skip them — this is also what makes the one-click
        // fix (which sets object-fit:contain) actually clear the issue on the next scan.
        var nw = img.naturalWidth, nh = img.naturalHeight, rw = img.offsetWidth, rh = img.offsetHeight;
        var fit = win.getComputedStyle(img).objectFit || 'fill';
        if (fit === 'fill' && nw && nh && rw && rh) {
          var drift = Math.abs((rw / rh) / (nw / nh) - 1);
          if (drift > ASPECT_TOL) {
            issues.push({ ruleId: 'stretched-image', severity: 'warn', slideIndex: si, el: img,
              message: 'الصورة مشوّهة (تغيّرت نسبة أبعادها) — الإصلاح يحافظ على تناسبها.',
              fix: (function (image) { return function () { image.style.objectFit = 'contain'; }; })(img) });
          }
        }

        // Rule 5 — content image with no numbered «شكل N» caption (auto-fixable)
        if (img.offsetWidth * img.offsetHeight >= IMG_MIN_AREA) {
          var numbered = img.closest('[data-ve-figure]');
          if (!(numbered && numbered.querySelector('figcaption'))) {
            issues.push({ ruleId: 'figure-no-caption', severity: 'warn', slideIndex: si, el: img,
              message: 'الصورة بلا تسمية مرقّمة «شكل N» — الإصلاح يضيف تعليقًا قابلًا للتحرير.',
              fix: _captionFix(img, doc) });
          }
        }
      }
    });

    return issues;
  }

  window.SlideDoctor = { analyze: analyze, version: 1 };
})();
