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
  var TINY_FONT = 11;        // px floor — below this (<=10px) text won't survive a projector; 11px de-emphasized footers are common and legit
  var OVERFLOW_TOL = 8;      // px slack before slide content counts as spilling
  var ESCAPE_TOL = 24;       // px a floated unit may stick out before flagged
  var SHRINK_STEP = 0.93;    // one overflow fix click = one 7% font step down
  var UPSCALE_LIMIT = 1.8;   // rendered/natural width ratio that projects blurry
  var MIX_MIN_DIGITS = 2;    // need >=2 digits of EACH script to call it mixed
  var DUP_MIN_WORDS = 10;    // slides shorter than this are never "duplicates"
  var TITLE_SIZE_TOL = 2;    // px drift between slide titles before flagged
  var OFFPAL_DIST = 4000;    // squared RGB distance from palette = foreign color
  var GREY_SPAN = 24;        // channel spread under which a color is neutral

  // ---- WCAG 2.1 relative luminance + contrast ratio ----
  function _srgb(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function _lum(c) { return 0.2126 * _srgb(c[0]) + 0.7152 * _srgb(c[1]) + 0.0722 * _srgb(c[2]); }
  function _ratio(a, b) {
    var L1 = _lum(a), L2 = _lum(b), hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return (hi + 0.05) / (lo + 0.05);
  }
  // Move a foreground color toward whichever pole (black or white) yields more
  // contrast against `bg`, by the smallest step that reaches `need`. If neither
  // pole can reach it (mid-gray bg), returns the full swing — the best available.
  function _nudge(fg, bg, need) {
    var target = _ratio([0, 0, 0], bg) >= _ratio([255, 255, 255], bg) ? [0, 0, 0] : [255, 255, 255];
    var best = target;
    for (var t = 0.05; t <= 1.0001; t += 0.05) {
      var c = [fg[0] + (target[0] - fg[0]) * t,
               fg[1] + (target[1] - fg[1]) * t,
               fg[2] + (target[2] - fg[2]) * t];
      if (_ratio(c, bg) >= need) { best = c; break; }
    }
    return [Math.round(best[0]), Math.round(best[1]), Math.round(best[2])];
  }
  // Parse an authored color token (hex #rgb/#rrggbb or rgb()/rgba()) into [r,g,b].
  // Used for the deck's palette values (CSS custom props keep their authored form),
  // unlike _rgb() below which handles resolved computed colors (always rgb()).
  function _parseColor(str) {
    if (!str) return null;
    str = str.trim();
    var m = str.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      var p = m[1].split(',').map(function (s) { return parseFloat(s.trim()); });
      if (p.length >= 4 && p[3] === 0) return null;
      return [p[0], p[1], p[2]];
    }
    var h = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (h) {
      var hex = h[1];
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
    return null;
  }
  // From the deck's own palette, the color CLOSEST to the current text color that
  // still passes `need` against `bg`. Keeps the fix on-brand; null if none qualify
  // (e.g. text over a photo) so the caller can fall back to the black/white nudge.
  function _snapPalette(fg, bg, need, palette) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < palette.length; i++) {
      var c = palette[i];
      if (_ratio(c, bg) < need) continue;
      var d = (c[0] - fg[0]) * (c[0] - fg[0]) + (c[1] - fg[1]) * (c[1] - fg[1]) + (c[2] - fg[2]) * (c[2] - fg[2]);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
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

  // A dismissed issue rides as a token in data-ve-dr-ignore on the element
  // (or an ancestor), so «تجاهل» survives save/reload with the file itself.
  function _ignored(el, ruleId) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var ig = n.getAttribute && n.getAttribute('data-ve-dr-ignore');
      if (ig && (' ' + ig + ' ').indexOf(' ' + ruleId + ' ') !== -1) return true;
    }
    return false;
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

    // Deck palette (for the on-brand low-contrast fix) + brand-theme flag (for the
    // on-brand font-zoo fix). detectVars() returns the deck's declared CSS custom
    // props; we keep only the ones that parse as colors.
    var palette = [];
    if (editor.detectVars) {
      try {
        editor.detectVars().forEach(function (v) { var c = _parseColor(v.value); if (c) palette.push(c); });
      } catch (_) { palette = []; }
    }
    var brandOn = !!(editor.hasBrandTheme && editor.hasBrandTheme());
    var kitOn = !!(editor.activeThemeKit && editor.activeThemeKit());
    // Kit spacing minimum rides as a CSS var in the kit's :root override;
    // legacy MiM kits predate the token, so brand falls back to its constant.
    var rootCs = win.getComputedStyle(doc.documentElement);
    var kitLh = parseFloat(rootCs.getPropertyValue('--ve-line-height')) || (brandOn ? 1.68 : NaN);

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
        if (ratio < need && (!worst || ratio < worst.ratio)) worst = { el: el, ratio: ratio, need: need, fg: fg, bg: bg };
      });
      if (worst) {
        issues.push({ ruleId: 'low-contrast', severity: 'error', slideIndex: si, el: worst.el,
          message: 'تباين ضعيف بين النص والخلفية (النسبة ' + worst.ratio.toFixed(1) + ':1، المطلوب ≥' + worst.need + ') — الإصلاح يضبط لون النص من لوحة الألوان حتى يمرّ.',
          fix: (function (el, fg, bg, need) { return function () {
            // Prefer the nearest passing palette color (on-brand); else nudge to black/white.
            var c = _snapPalette(fg, bg, need, palette) || _nudge(fg, bg, need);
            el.style.color = 'rgb(' + c[0] + ', ' + c[1] + ', ' + c[2] + ')';
          }; })(worst.el, worst.fg, worst.bg, worst.need) });
      }

      // Rule 3 — font zoo (>2 primary families on one slide). Auto-fix collapses
      // every text element onto the slide's dominant family (the one the most
      // elements already use), copying that element's full computed stack so its
      // fallbacks survive.
      var famCount = {}, famRep = {};
      texts.forEach(function (el) {
        var f = _fam(win, el); if (!f) return;
        famCount[f] = (famCount[f] || 0) + 1;
        if (!famRep[f]) famRep[f] = el;
      });
      var famList = Object.keys(famCount);
      if (famList.length > FONT_LIMIT) {
        var fzMsg, fzFix;
        if (brandOn) {
          // A brand kit defines the deck's fonts in CSS; extra families are inline
          // style="font-family" overrides. Clear them so the brand pairing wins again
          // (same philosophy as the brand-spacing rule below).
          fzMsg = 'الشريحة تستخدم ' + famList.length + ' خطوط مختلفة — الإصلاح يزيل تجاوزات الخط ليعود خطّ الهوية.';
          fzFix = (function (els) { return function () {
            els.forEach(function (el) { if (el.style && el.style.fontFamily) el.style.fontFamily = ''; });
          }; })(texts.slice());
        } else {
          // No brand active: unify onto the family the most elements already use,
          // copying its full computed stack so fallbacks survive.
          var dom = famList.reduce(function (a, b) { return famCount[b] > famCount[a] ? b : a; });
          var domStack = win.getComputedStyle(famRep[dom]).fontFamily;
          fzMsg = 'الشريحة تستخدم ' + famList.length + ' خطوط مختلفة — الإصلاح يوحّدها على الخطّ الأكثر استخدامًا.';
          fzFix = (function (els, stack, domFam) { return function () {
            els.forEach(function (el) { if (_fam(win, el) !== domFam) el.style.fontFamily = stack; });
          }; })(texts.slice(), domStack, dom);
        }
        issues.push({ ruleId: 'font-zoo', severity: 'warn', slideIndex: si, el: slide, message: fzMsg, fix: fzFix });
      }

      // Rules 4 & 5 — one pass over images
      var imgs = slide.querySelectorAll('img');
      for (var k = 0; k < imgs.length; k++) {
        var img = imgs[k];
        if (img.closest('.ve-ghost') || img.closest('[data-ve-figlist]')) continue;

        // Rule 9 — broken image: a src is present but nothing decoded.
        if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
          issues.push({ ruleId: 'broken-image', severity: 'error', slideIndex: si, el: img,
            message: 'صورة مكسورة (المصدر لا يُحمَّل) — انقرها لاستبدالها أو احذفها.', fix: null });
          continue;
        }

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

        // Rule 10 — upscaled beyond its pixels: will project blurry.
        if (nw && rw && !/\.svg(\?|#|$)|image\/svg/i.test(img.currentSrc || img.src || '') &&
            rw * rh >= IMG_MIN_AREA && rw / nw > UPSCALE_LIMIT) {
          issues.push({ ruleId: 'blurry-image', severity: 'warn', slideIndex: si, el: img,
            message: 'الصورة معروضة أكبر من دقتها الأصلية (' + (rw / nw).toFixed(1) + '×) وستظهر مبكسلة — استبدلها بدقة أعلى أو صغّرها.', fix: null });
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

      // Rule 6 — kit spacing drift (any kit that declares --ve-line-height,
      // plus legacy MiM): an inline edit shrank the leading below the
      // identity's minimum; clearing the override restores the kit. One-sided
      // on purpose — airier-than-kit spacing is a design choice, not a bug.
      if (kitLh) {
        var content = slide.querySelector('.content');
        if (content && content.style.lineHeight) {
          var ccs = win.getComputedStyle(content);
          var lh = parseFloat(ccs.lineHeight) / (parseFloat(ccs.fontSize) || 16);
          if (lh && kitLh - lh > 0.18) {
            issues.push({ ruleId: 'brand-spacing', severity: 'warn', slideIndex: si, el: content,
              message: 'تباعد الأسطر أقل من قيمة الهوية (' + kitLh + ') — الإصلاح يزيل التجاوز.',
              fix: (function (c) { return function () { c.style.lineHeight = ''; }; })(content) });
          }
        }
      }

      // Rule 7 — overflow: what spills outside the slide box is invisible in
      // PDF export and present mode.
      // (a) flow overflow — the slide scrolls taller than its box. Each fix
      // click = one 7% font step down on this slide (floored so it never
      // creates tiny text); the re-scan shows whether one step was enough.
      if (slide.scrollHeight > slide.clientHeight + OVERFLOW_TOL) {
        issues.push({ ruleId: 'overflow', severity: 'error', slideIndex: si, el: slide,
          message: 'المحتوى أطول من الشريحة بـ ' + (slide.scrollHeight - slide.clientHeight) + 'px وسيُقصّ عند التصدير — الإصلاح يصغّر الخط درجة واحدة (كرّره أو قسّم الشريحة).',
          fix: (function (els) { return function () {
            els.forEach(function (el) {
              var fs = parseFloat(win.getComputedStyle(el).fontSize);
              if (fs) el.style.fontSize = Math.max(TINY_FONT, Math.round(fs * SHRINK_STEP * 10) / 10) + 'px';
            });
          }; })(texts.slice()) });
      }
      // (b) escapee — a drag-floated unit (position:absolute + inline left/top,
      // exactly what editor drags produce) sticking out of the slide; the fix
      // pulls it back to the nearest in-bounds position. Client px map 1:1 to
      // style px here (nothing between unit and offset parent is transformed).
      var srect = slide.getBoundingClientRect();
      var floats = slide.querySelectorAll('[style*="position"], .ve-slot');
      for (var f2 = 0; f2 < floats.length; f2++) {
        var fu = floats[f2];
        if (fu.closest('.ve-overlay, .ve-toolbar, .ve-guide, .ve-ghost')) continue;
        var fcs = win.getComputedStyle(fu);
        if (fcs.position !== 'absolute' || !fu.style.left || !fu.style.top) continue;
        var frect = fu.getBoundingClientRect();
        if (!frect.width || !frect.height) continue;
        var overX = Math.max(srect.left - frect.left, frect.right - srect.right, 0);
        var overY = Math.max(srect.top - frect.top, frect.bottom - srect.bottom, 0);
        if (overX <= ESCAPE_TOL && overY <= ESCAPE_TOL) continue;
        issues.push({ ruleId: 'off-slide', severity: 'error', slideIndex: si, el: fu,
          message: 'عنصر خارج حدود الشريحة وسيُقصّ عند التصدير — الإصلاح يعيده إلى داخلها.',
          fix: (function (u, sl) { return function () {
            var sr = sl.getBoundingClientRect(), ur = u.getBoundingClientRect();
            var dx = 0, dy = 0;
            if (ur.left < sr.left) dx = sr.left - ur.left;
            else if (ur.right > sr.right) dx = sr.right - ur.right;
            if (ur.top < sr.top) dy = sr.top - ur.top;
            else if (ur.bottom > sr.bottom) dy = sr.bottom - ur.bottom;
            u.style.left = Math.round(parseFloat(u.style.left) + dx) + 'px';
            u.style.top = Math.round(parseFloat(u.style.top) + dy) + 'px';
          }; })(fu, slide) });
      }

      // Rule 8 — unreadable text: below TINY_FONT nothing survives projection.
      var tiny = [];
      texts.forEach(function (el) {
        if (/^(SUB|SUP)$/i.test(el.tagName)) return;
        var fs2 = parseFloat(win.getComputedStyle(el).fontSize);
        if (fs2 && fs2 < TINY_FONT) tiny.push(el);
      });
      if (tiny.length) {
        issues.push({ ruleId: 'tiny-font', severity: 'warn', slideIndex: si, el: tiny[0],
          message: 'نص أصغر من ' + TINY_FONT + 'px في ' + tiny.length + ' عنصر — لن يُقرأ على الشاشة؛ الإصلاح يرفعه إلى الحد الأدنى.',
          fix: (function (els) { return function () {
            els.forEach(function (e2) { e2.style.fontSize = TINY_FONT + 'px'; });
          }; })(tiny) });
      }

      // Rule 11 — mixed numeral scripts on one slide (١٢٣ next to 123 reads
      // sloppy in a ministry deck). Fix converts the minority script to the
      // majority one — same numbers, different glyphs, fully reversible.
      var arDigits = (raw.match(/[٠-٩]/g) || []).length;
      var latDigits = (raw.match(/[0-9]/g) || []).length;
      if (arDigits >= MIX_MIN_DIGITS && latDigits >= MIX_MIN_DIGITS) {
        issues.push({ ruleId: 'mixed-numerals', severity: 'warn', slideIndex: si, el: slide,
          message: 'الشريحة تخلط أرقامًا عربية (١٢٣) ولاتينية (123) — الإصلاح يوحّدها على الأكثر استخدامًا.',
          fix: (function (sl, toAr) { return function () {
            var walker = doc.createTreeWalker(sl, 4, null, false), t;
            while ((t = walker.nextNode())) {
              var pe = t.parentElement;
              if (pe && pe.closest('.ve-overlay, .ve-toolbar, .ve-guide, .ve-ghost')) continue;
              t.nodeValue = toAr
                ? t.nodeValue.replace(/[0-9]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.charAt(+d); })
                : t.nodeValue.replace(/[٠-٩]/g, function (d) { return String.fromCharCode(48 + d.charCodeAt(0) - 0x0660); });
            }
          }; })(slide, arDigits >= latDigits) });
      }

      // Rule 13 — off-palette text color (only when a theme kit is active:
      // the user chose an identity, the doctor enforces it). Neutrals pass;
      // the fix snaps to the nearest palette color that keeps WCAG contrast.
      if (kitOn && palette.length >= 3) {
        var offEls = [], offCols = [];
        texts.forEach(function (el) {
          var oc = _rgb(win.getComputedStyle(el).color); if (!oc) return;
          if (Math.max(oc[0], oc[1], oc[2]) - Math.min(oc[0], oc[1], oc[2]) < GREY_SPAN) return;
          var dBest = Infinity;
          for (var p2 = 0; p2 < palette.length; p2++) {
            var pc = palette[p2];
            var dd = (pc[0] - oc[0]) * (pc[0] - oc[0]) + (pc[1] - oc[1]) * (pc[1] - oc[1]) + (pc[2] - oc[2]) * (pc[2] - oc[2]);
            if (dd < dBest) dBest = dd;
          }
          if (dBest > OFFPAL_DIST) { offEls.push(el); offCols.push(oc); }
        });
        if (offEls.length) {
          issues.push({ ruleId: 'off-palette', severity: 'warn', slideIndex: si, el: offEls[0],
            message: 'ألوان نص خارج لوحة الهوية في ' + offEls.length + ' عنصر — الإصلاح يقرّبها إلى أقرب لون من اللوحة دون كسر التباين.',
            fix: (function (els, cols) { return function () {
              els.forEach(function (el, i2) {
                var bg2 = _bgOf(el, win, [255, 255, 255]);
                var cs3 = win.getComputedStyle(el);
                var sz = parseFloat(cs3.fontSize) || 16;
                var bold2 = (parseInt(cs3.fontWeight, 10) || 400) >= 700;
                var need2 = (sz >= 24 || (bold2 && sz >= 18.66)) ? 3 : 4.5;
                var snap2 = _snapPalette(cols[i2], bg2, need2, palette);
                if (snap2) el.style.color = 'rgb(' + snap2[0] + ', ' + snap2[1] + ', ' + snap2[2] + ')';
              });
            }; })(offEls, offCols) });
        }
      }

      // Rule 15 — content slide with no heading; Rule 16 — near-empty slide.
      // First slide, .cover-slide, and heading-only divider designs are exempt.
      var hasHead = !!slide.querySelector('h1, h2, h3, h4');
      if (si > 0 && !slide.classList.contains('cover-slide')) {
        if (!hasHead && words > 15) {
          issues.push({ ruleId: 'missing-title', severity: 'warn', slideIndex: si, el: slide,
            message: 'الشريحة بلا عنوان — الإصلاح يضيف عنوانًا مؤقتًا حرّره بالنقر المزدوج.',
            fix: (function (sl) { return function () {
              var h2 = doc.createElement('h2');
              h2.textContent = 'عنوان الشريحة';
              var host = sl.querySelector('.content') || sl;
              host.insertBefore(h2, host.firstChild);
            }; })(slide) });
        }
        if (words < 3 && !hasHead && !slide.querySelector('img, svg, table, canvas, video')) {
          issues.push({ ruleId: 'empty-slide', severity: 'warn', slideIndex: si, el: slide,
            message: 'شريحة شبه فارغة — املأها أو احذفها (Ctrl+Delete).', fix: null });
        }
      }
    });

    // Rule 17 — title drift (deck-level): once >=3 content slides carry
    // titles and a clear majority share one size, stragglers get flagged.
    // Size-only: family drift is already the font-zoo rule's job.
    var titles = [];
    slides.forEach(function (slide, si) {
      if (si === 0 || slide.classList.contains('cover-slide')) return;
      var t = slide.querySelector('h1, h2, h3');
      if (t && /\S/.test(t.textContent)) {
        titles.push({ el: t, si: si, size: parseFloat(win.getComputedStyle(t).fontSize) });
      }
    });
    if (titles.length >= 3) {
      var sizeCount = {};
      titles.forEach(function (t) {
        var k = String(Math.round(t.size));
        sizeCount[k] = (sizeCount[k] || 0) + 1;
      });
      var domSize = +Object.keys(sizeCount).reduce(function (a, b) { return sizeCount[b] > sizeCount[a] ? b : a; });
      if (sizeCount[String(domSize)] > titles.length / 2) {
        titles.forEach(function (t) {
          if (Math.abs(t.size - domSize) <= TITLE_SIZE_TOL) return;
          issues.push({ ruleId: 'title-drift', severity: 'warn', slideIndex: t.si, el: t.el,
            message: 'حجم عنوان الشريحة (' + Math.round(t.size) + 'px) مختلف عن بقية العناوين (' + domSize + 'px) — الإصلاح يوحّده.',
            fix: (function (el, fs3) { return function () { el.style.fontSize = fs3 + 'px'; }; })(t.el, domSize) });
        });
      }
    }

    // Rule 18 — duplicate slide (usually a forgotten copy). O(n) via text map.
    var seenText = {};
    slides.forEach(function (slide, si) {
      var norm = (slide.textContent || '').replace(/\s+/g, ' ').trim();
      if (norm.split(' ').length < DUP_MIN_WORDS) return;
      if (seenText[norm] != null) {
        issues.push({ ruleId: 'duplicate-slide', severity: 'warn', slideIndex: si, el: slide,
          message: 'الشريحة مطابقة تمامًا للشريحة ' + (seenText[norm] + 1) + ' — غالبًا نسخة منسيّة.', fix: null });
      } else { seenText[norm] = si; }
    });

    // Dismissed issues (data-ve-dr-ignore) drop out here, one gate for all rules.
    return issues.filter(function (iss) { return !_ignored(iss.el, iss.ruleId); });
  }

  window.SlideDoctor = { analyze: analyze, version: 3 };
})();
