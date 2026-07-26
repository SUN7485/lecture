/*
 * doctor.js — Slide Doctor: a deterministic "Grammarly for slides" lint engine.
 * Pure DOM, zero AI. Analysis is zero-network; the single exception is the
 * fonts-external FIX, which fetches web fonts once in order to REMOVE the
 * deck's network dependency. Loaded verbatim by BOTH the Electron renderer
 * and the static web port — keep web/doctor.js byte-identical to src/doctor.js.
 * Exposes window.SlideDoctor.analyze(editor) -> issues[]. Each issue:
 *   { ruleId, severity: 'error'|'warn', slideIndex, el, message (ar), fix|null }
 * fix() (when present) mutates the DOM in place — and MAY return a Promise
 * (fonts-external does); callers must await it, then record one undo step via
 * editor.commit(). After any fix/undo the caller MUST re-run analyze()
 * because undo replaces body.innerHTML and invalidates every `el` reference.
 * v5: every rule is now auto-fixable, so «إصلاح الكل» really fixes all.
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
  var OVERLOAD_FACTOR = 1.5;  // deck-relative overload: only slides >1.5x the deck's own median are outliers
  var SPLIT_MIN_WORDS = 10;  // don't split content thinner than this
  // Families safe without @font-face (CSS generics + fonts on effectively
  // every Windows/Office machine these decks are shown on).
  var GENERIC_FAMS = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|math|emoji|arial|helvetica|helvetica neue|tahoma|verdana|segoe ui|calibri|cambria|georgia|times|times new roman|courier|courier new|trebuchet ms|impact)$/i;
  // Known web-font hosts (Rule 19b detection + its embed fix share this).
  var FONT_HOST = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|fontlibrary\.org|use\.fontawesome\.com/i;
  // Editor chrome that must never count as slide content.
  var CHROME_SEL = '.ve-overlay, .ve-toolbar, .ve-palette, .ve-wandmenu, .ve-guide, .ve-ghost';

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
  // A gradient IS a background. background-color stays transparent when a deck
  // paints a cover with linear-gradient(), so walking past it lands on the
  // slide's white and reports white-on-white — and then "fixes" white cover text
  // to dark grey ON A DARK GRADIENT, which is worse than the problem it set out
  // to solve. Averaging the stops is close enough to judge contrast against, and
  // it kills the false positive at the source. Photo backgrounds (url(...))
  // still fall through: nobody can judge contrast against an unknown image.
  function _gradientBg(cssImage) {
    if (!cssImage || cssImage.indexOf('gradient(') === -1) return null;
    var cols = [], m, re = /rgba?\(([^)]+)\)/g;
    while ((m = re.exec(cssImage))) {
      var p = m[1].split(',').map(function (s) { return parseFloat(s.trim()); });
      if (p.length < 3 || (p.length >= 4 && p[3] === 0)) continue;
      cols.push(p);
    }
    if (!cols.length) return null;
    var sum = [0, 0, 0];
    for (var i = 0; i < cols.length; i++) {
      sum[0] += cols[i][0]; sum[1] += cols[i][1]; sum[2] += cols[i][2];
    }
    return [sum[0] / cols.length, sum[1] / cols.length, sum[2] / cols.length];
  }
  // Effective background behind an element: first ancestor painting something —
  // a background-color or a gradient — else the given fallback (slide bg, else
  // white).
  function _bgOf(el, win, fallback) {
    var n = el;
    while (n && n.nodeType === 1) {
      var cs = win.getComputedStyle(n);
      var bg = _rgb(cs.backgroundColor);
      if (bg) return bg;
      var grad = _gradientBg(cs.backgroundImage);
      if (grad) return grad;
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

  // ---- Rule 21 helpers: colors hardcoded past the reach of any theme kit ----
  // A kit recolors a deck by overriding CSS variables. A literal color written
  // into a rule, an inline style, or an SVG fill= attribute is simply invisible
  // to it — the deck's fonts change, half its colors don't, and nothing reports
  // an error. The fix rewrites each literal to var(--kitToken, #original): with
  // a kit applied the brand color wins; with the kit removed the authored color
  // comes back through the fallback, so the rewrite is reversible by
  // construction rather than by undo. Snapping is delegated to the editor so
  // the kit and this fix always pick the same "nearest" color.

  // Colors inside url(...) (SVG data URIs) and quoted strings are content, not
  // style — a var() there would corrupt them. Colors already inside var() are
  // the fallbacks we wrote ourselves: counting those would make the rule fire
  // forever (EVO-009). Masking with same-length spaces keeps match offsets
  // valid against the original string.
  function _maskNonColor(v) {
    return String(v).replace(/url\([^)]*\)|"[^"]*"|'[^']*'|var\([^()]*\)/gi, function (m) {
      return new Array(m.length + 1).join(' ');
    });
  }
  var COLOR_LITERAL = /#[0-9a-f]{6}(?![0-9a-f])|#[0-9a-f]{3}(?![0-9a-f])|rgba?\([^()]*\)/gi;
  // SVG paints live in presentation attributes, which no variable can reach. We
  // never rewrite the attribute — it stays as the authored last-resort color —
  // and instead set the matching INLINE STYLE, which outranks it and rides in
  // the editor's undo snapshots.
  var SVG_PAINT_ATTRS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color'];

  function _colorsIn(val) {
    var masked = _maskNonColor(val), out = [], m;
    COLOR_LITERAL.lastIndex = 0;
    while ((m = COLOR_LITERAL.exec(masked))) out.push({ index: m.index, text: m[0] });
    return out;
  }
  function _countSolid(val, ed) {
    var hits = _colorsIn(val), n = 0;
    for (var i = 0; i < hits.length; i++) if (ed.parseSolidColor(hits[i].text)) n++;
    return n;
  }
  // Rewrite every opaque literal in one declaration value; null when nothing
  // changed, so callers only touch what they must.
  function _tokenizeColors(val, ed, idx, tokens) {
    var hits = _colorsIn(val), out = '', last = 0, n = 0;
    for (var i = 0; i < hits.length; i++) {
      var c = ed.parseSolidColor(hits[i].text);
      if (!c) continue;
      var repl = _tokenRef(c, ed, idx, tokens);
      if (!repl) continue;
      out += val.slice(last, hits[i].index) + repl;
      last = hits[i].index + hits[i].text.length;
      n++;
    }
    return n ? out + val.slice(last) : null;
  }
  // A literal equal to a variable the deck already declares AND the kit
  // overrides is that token spelled out: reference it by name, no fallback
  // needed. Everything else snaps to the nearest kit color and keeps its
  // original as the fallback.
  function _tokenRef(c, ed, idx, tokens) {
    var hx = ed.colorToHex(c);
    // Deck-declared token: no fallback needed — with the kit off it still holds
    // the deck's own authored color, so the reference is a no-op.
    if (idx[hx]) return 'var(' + idx[hx] + ')';
    var t = ed.nearestKitToken(c, tokens);
    // Kit-private alias (--ve-k-*), never the palette name itself: decks declare
    // --purple/--gold themselves, and a defined variable swallows the fallback,
    // so var(--purple, #original) could never give the original color back.
    return t ? 'var(' + (t.alias || t.name) + ', ' + hx + ')' : null;
  }
  function _deckTokenIndex(editor, tokens) {
    var idx = {}, own = {};
    for (var i = 0; i < tokens.length; i++) own[tokens[i].name] = true;
    try {
      editor.detectVars({ skipKit: true }).forEach(function (v) {
        if (!own[v.name]) return;
        var c = editor.parseSolidColor(v.declared || v.value);
        if (!c) return;
        var hx = editor.colorToHex(c);
        if (!idx[hx]) idx[hx] = v.name;
      });
    } catch (eIdx) { /* unreadable sheet — fall through to nearest-color snapping */ }
    return idx;
  }
  // The deck's OWN stylesheets. The kit sheet and the editor's sheets are ours
  // and must never be rewritten (rewriting the kit would erase the palette).
  function _deckSheets(doc) {
    var out = [];
    for (var i = 0; i < doc.styleSheets.length; i++) {
      var sheet = doc.styleSheets[i], node = sheet.ownerNode;
      if (!node || node.tagName !== 'STYLE') continue;
      if (node.id && node.id.indexOf('ve-') === 0) continue;
      var rules; try { rules = sheet.cssRules; } catch (eS) { continue; }
      if (rules) out.push({ sheet: sheet, node: node });
    }
    return out;
  }
  // Style rules only, including inside @media/@supports. @font-face and
  // @keyframes carry no selectorText and are skipped.
  function _eachStyleDecl(rules, fn) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.style && r.selectorText) fn(r.style);
      if (r.cssRules && r.cssRules.length) _eachStyleDecl(r.cssRules, fn);
    }
  }
  // One walker, two modes (count / rewrite) so detection and fix can never
  // disagree — the rule stops firing exactly when the fix runs out of work.
  function _walkHardcoded(editor, apply, idx, tokens) {
    var doc = editor.doc, n = 0;
    var maybeColor = function (v) { return !!v && (v.indexOf('#') !== -1 || v.toLowerCase().indexOf('rgb') !== -1); };

    var sheets = _deckSheets(doc);
    for (var s = 0; s < sheets.length; s++) {
      var dirty = false;
      _eachStyleDecl(sheets[s].sheet.cssRules, function (decl) {
        var names = [];
        for (var p = 0; p < decl.length; p++) names.push(decl[p]);
        for (var q = 0; q < names.length; q++) {
          var name = names[q];
          if (name.indexOf('--') === 0) continue; // the deck's own tokens: the kit adopts those
          var val = decl.getPropertyValue(name);
          if (!maybeColor(val)) continue;
          if (!apply) { n += _countSolid(val, editor); continue; }
          var next = _tokenizeColors(val, editor, idx, tokens);
          if (next != null) { decl.setProperty(name, next, decl.getPropertyPriority(name)); dirty = true; n++; }
        }
      });
      // CSSOM edits do not touch the <style> element's text, and the saved file
      // is serialized from the DOM — write the rules back or the fix would look
      // right on screen and vanish on export.
      if (apply && dirty) {
        var parts = [];
        for (var cr = 0; cr < sheets[s].sheet.cssRules.length; cr++) parts.push(sheets[s].sheet.cssRules[cr].cssText);
        sheets[s].node.textContent = parts.join('\n');
      }
    }

    var styled = doc.querySelectorAll('[style]');
    for (var e = 0; e < styled.length; e++) {
      var el = styled[e];
      if (el.closest(CHROME_SEL)) continue;
      var inNames = [];
      for (var k = 0; k < el.style.length; k++) inNames.push(el.style[k]);
      for (var j = 0; j < inNames.length; j++) {
        var nm = inNames[j];
        if (nm.indexOf('--') === 0) continue;
        var v2 = el.style.getPropertyValue(nm);
        if (!maybeColor(v2)) continue;
        if (!apply) { n += _countSolid(v2, editor); continue; }
        var nv = _tokenizeColors(v2, editor, idx, tokens);
        if (nv != null) { el.style.setProperty(nm, nv, el.style.getPropertyPriority(nm)); n++; }
      }
    }

    for (var a = 0; a < SVG_PAINT_ATTRS.length; a++) {
      var attr = SVG_PAINT_ATTRS[a];
      var painted = doc.querySelectorAll('[' + attr + ']');
      for (var pi = 0; pi < painted.length; pi++) {
        var pel = painted[pi];
        if (pel.closest(CHROME_SEL)) continue;
        if (pel.style && pel.style.getPropertyValue(attr)) continue; // already ours
        var c2 = editor.parseSolidColor(pel.getAttribute(attr));
        if (!c2) continue;
        if (!apply) { n++; continue; }
        var ref = _tokenRef(c2, editor, idx, tokens);
        if (ref) { pel.style.setProperty(attr, ref); n++; }
      }
    }
    return n;
  }

  // ---- v5 fix helpers: slide surgery + font embedding ----

  // Delete a whole slide (empty-slide / duplicate-slide fixes). Plain DOM
  // removal so the caller's single commit() records one undo step; deselect
  // first so the editor overlay never floats over a detached element.
  function _removeSlideFix(editor, slide) {
    return function () {
      if (!slide.isConnected) return;
      if (editor.selected && slide.contains(editor.selected) && editor._deselect) editor._deselect();
      slide.remove();
    };
  }

  // The blocks of a slide that may move to a continuation slide. Inside a
  // .content host everything is flow content; at slide level, headings,
  // footers, logos and drag-floated (inline position:absolute) units stay put.
  function _splitBlocks(slide, host) {
    var out = [];
    for (var i = 0; i < host.children.length; i++) {
      var b = host.children[i];
      if (b.matches && b.matches(CHROME_SEL)) continue;
      if (host === slide) {
        if (/^(H1|H2|H3|H4|H5|H6|HEADER|FOOTER|NAV|IMG)$/i.test(b.tagName)) continue;
        if (/(^|\s)(footer|slide-footer|mim-logo|logo)(\s|$)/i.test(b.className || '')) continue;
      }
      if (b.style && b.style.position === 'absolute') continue;
      out.push(b);
    }
    return out;
  }
  function _wordsOf(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t ? t.split(' ').length : 0;
  }
  // Flatten a slide's splittable content into ordered units: list items open
  // up individually (the common overload shape — one giant UL), every other
  // block moves whole. `list` remembers the parent so halves rebuild cleanly.
  function _splitUnits(slide, host) {
    var units = [];
    _splitBlocks(slide, host).forEach(function (b) {
      if (/^(UL|OL)$/i.test(b.tagName) && b.children.length >= 2) {
        for (var i = 0; i < b.children.length; i++) units.push({ el: b.children[i], list: b });
      } else {
        units.push({ el: b, list: null });
      }
    });
    return units;
  }
  function _dropUnit(u) {
    var list = u.list;
    u.el.remove();
    if (list && !list.children.length) list.remove();
  }
  // Where an overloaded slide can be cut in two: the unit boundary that best
  // balances the word count, never right after a heading (it would dangle at
  // the bottom of the first half). null = no clean cut exists (single
  // paragraph, lone table…) — the issue stays advisory.
  function _splitPlan(slide) {
    var host = slide.querySelector('.content') || slide;
    var units = _splitUnits(slide, host);
    if (units.length < 2) return null;
    var total = 0;
    var w = units.map(function (u) { var n = _wordsOf(u.el); total += n; return n; });
    if (total < SPLIT_MIN_WORDS) return null;
    var acc = 0, cut = -1, bestDiff = Infinity;
    for (var i = 0; i < units.length - 1; i++) {
      acc += w[i];
      if (/^H[1-6]$/i.test(units[i].el.tagName)) continue; // no dangling heading
      var diff = Math.abs(acc - total / 2);
      if (diff < bestDiff) { bestDiff = diff; cut = i + 1; }
    }
    return cut > 0 ? { cut: cut } : null;
  }
  // Execute a split plan: clone the slide shell (title, footer, logo ride
  // along), keep the first half here, the second half on the clone, and mark
  // the clone's title as a continuation. Bails silently if the slide changed
  // shape since the scan — the next re-scan re-offers a correct fix.
  function _splitFix(editor, slide, plan) {
    return function () {
      if (!slide.isConnected || !slide.parentNode) return;
      var clone = editor._cleanClone ? editor._cleanClone(slide) : slide.cloneNode(true);
      clone.removeAttribute('id'); // duplicate ids corrupt anchors
      var ids = clone.querySelectorAll('[id]');
      for (var i = 0; i < ids.length; i++) ids[i].removeAttribute('id');
      var srcU = _splitUnits(slide, slide.querySelector('.content') || slide);
      var dstU = _splitUnits(clone, clone.querySelector('.content') || clone);
      if (srcU.length !== dstU.length || plan.cut >= srcU.length) return;
      for (var k = srcU.length - 1; k >= plan.cut; k--) _dropUnit(srcU[k]);
      for (k = plan.cut - 1; k >= 0; k--) _dropUnit(dstU[k]);
      var head = clone.querySelector('h1, h2, h3');
      if (head && !/\(تابع\)\s*$/.test(head.textContent)) head.textContent = head.textContent.replace(/\s+$/, '') + ' (تابع)';
      slide.parentNode.insertBefore(clone, slide.nextSibling);
    };
  }

  // Rule 19b's one-click fix — the doctor's ONLY network operation, and it
  // exists to REMOVE a network dependency: download each web-font stylesheet
  // once, inline its binaries as data: @font-face rules in the deck's head
  // (kept by getCleanHtml, so the saved file is self-contained), THEN strip
  // the <link>s/@imports. Nothing is removed unless embedding succeeded, so a
  // failed/offline run leaves the deck exactly as it was. Returns a Promise.
  function _embedExternalFonts(doc) {
    var IMP_RE = /@import\s+(?:url\(\s*)?['"]?(https?:[^'")\s]+)['"]?\s*\)?[^;]*;?/gi;
    var links = [], styles = [], urls = [], seen = {};
    var linkEls = doc.querySelectorAll('link[href]');
    for (var i = 0; i < linkEls.length; i++) {
      var href = linkEls[i].getAttribute('href') || '';
      if (!FONT_HOST.test(href)) continue;
      links.push(linkEls[i]);
      var abs = linkEls[i].href || href;
      if (!seen[abs]) { seen[abs] = 1; urls.push(abs); }
    }
    var styleEls = doc.querySelectorAll('style');
    for (var s = 0; s < styleEls.length; s++) {
      var txt = styleEls[s].textContent || '', m, hit = false;
      IMP_RE.lastIndex = 0;
      while ((m = IMP_RE.exec(txt))) {
        if (!FONT_HOST.test(m[1])) continue;
        hit = true;
        if (!seen[m[1]]) { seen[m[1]] = 1; urls.push(m[1]); }
      }
      if (hit) styles.push(styleEls[s]);
    }
    if (!urls.length) return Promise.reject(new Error('لا توجد روابط خطوط خارجية'));
    return Promise.all(urls.map(function (u) {
      return fetch(u).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
    })).then(function (cssTexts) {
      var faces = [];
      cssTexts.forEach(function (css) {
        // css2 labels each face with a /* subset */ comment — keep arabic +
        // latin (digits/Latin terms) and drop the rest to keep the file lean.
        // A sheet without subset labels keeps all its faces.
        var labelled = /\/\*\s*[\w-]+\s*\*\/\s*@font-face/.test(css);
        var re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
        var m2;
        while ((m2 = re.exec(css))) {
          var subset = m2[1] || '';
          if (labelled && subset && subset !== 'arabic' && subset !== 'latin') continue;
          faces.push(m2[2]);
        }
      });
      if (!faces.length) throw new Error('لم يُعثر على أوجه خطوط في الرابط');
      return Promise.all(faces.map(function (body) {
        var src = (body.match(/url\(\s*['"]?(https?:[^'")\s]+)['"]?\s*\)/) || [])[1];
        if (!src) return null;
        return fetch(src).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
          .then(function (buf) {
            var bytes = new Uint8Array(buf), bin = '';
            for (var j = 0; j < bytes.length; j += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
            var ext = ((src.match(/\.(woff2|woff|ttf|otf)(\?|#|$)/i) || [])[1] || 'woff2').toLowerCase();
            var fmt = ext === 'ttf' ? 'truetype' : ext === 'otf' ? 'opentype' : ext;
            var mime = ext === 'ttf' ? 'font/ttf' : ext === 'otf' ? 'font/otf' : 'font/' + ext;
            var decls = body.replace(/src\s*:[^;]+;?/i, '').replace(/\s+/g, ' ').trim();
            if (decls && !/;$/.test(decls)) decls += ';';
            return '@font-face{' + decls + "src:url(data:" + mime + ';base64,' + btoa(bin) + ") format('" + fmt + "');}";
          });
      }));
    }).then(function (rules) {
      var cssOut = rules.filter(Boolean).join('\n');
      if (!cssOut) throw new Error('تعذّر تضمين أوجه الخطوط');
      var st = doc.getElementById('ve-embedded-fonts');
      if (!st) { st = doc.createElement('style'); st.id = 've-embedded-fonts'; doc.head.appendChild(st); }
      st.textContent = (st.textContent ? st.textContent + '\n' : '') + cssOut;
      // Only now that the binaries live in the file: cut the network cords.
      links.forEach(function (l) { l.remove(); });
      styles.forEach(function (stl) {
        stl.textContent = stl.textContent.replace(IMP_RE, function (full, u) { return FONT_HOST.test(u) ? '' : full; });
      });
    });
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

  // Put elements back on `domFam`. Overrides come off first — an inline style,
  // or SVG's font-family presentation ATTRIBUTE, neither of which a kit's CSS
  // can outrank — and only if the element still renders in the wrong family is
  // the stack stated outright. Skipping the attribute step made the brand-kit
  // fix a silent no-op on chart labels: the card came back on every pass,
  // forever (EVO-009). `only` limits the sweep to named intruder families;
  // null means "everything not already on domFam".
  function _famFix(win, els, stack, domFam, only) {
    return function () {
      els.forEach(function (el) {
        var cur = _fam(win, el);
        if (only ? only.indexOf(cur) === -1 : cur === domFam) return;
        if (el.style && el.style.fontFamily) el.style.fontFamily = '';
        if (el.hasAttribute && el.hasAttribute('font-family')) el.removeAttribute('font-family');
        if (_fam(win, el) !== domFam) el.style.fontFamily = stack;
      });
    };
  }

  function analyze(editor) {
    if (!editor || !editor.doc || !editor.win) return [];
    var doc = editor.doc, win = editor.win;
    var slides = editor.slides();
    var issues = [];
    var wordCounts = [], charCounts = [], famData = [];

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

      // Rule 1 (v4) — text overload became deck-relative; counts are collected
      // here and judged after the loop (a lecture deck is dense by genre —
      // only outliers vs the deck's own median are worth flagging).
      var raw = (slide.textContent || '').replace(/\s+/g, ' ').trim();
      var words = raw ? raw.split(' ').length : 0;
      wordCounts[si] = words; charCounts[si] = raw.length;

      // Rule 2 — low contrast. v5: collect EVERY failing text element — the
      // old worst-only report meant each fix click just surfaced the next
      // worst and the card never cleared in one pass. The fix snaps each to
      // the nearest passing palette color (on-brand); else nudges black/white.
      var lowItems = [], lowWorst = null;
      texts.forEach(function (el) {
        var cs = win.getComputedStyle(el);
        var fg = _rgb(cs.color); if (!fg) return;
        var bg = _bgOf(el, win, [255, 255, 255]);
        var ratio = _ratio(fg, bg);
        var size = parseFloat(cs.fontSize) || 16;
        var bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
        var large = size >= 24 || (bold && size >= 18.66);
        var need = large ? 3 : 4.5;
        if (ratio >= need) return;
        lowItems.push({ el: el, fg: fg, bg: bg, need: need });
        if (!lowWorst || ratio < lowWorst.ratio) lowWorst = { el: el, ratio: ratio, need: need };
      });
      if (lowWorst) {
        issues.push({ ruleId: 'low-contrast', severity: 'error', slideIndex: si, el: lowWorst.el,
          message: 'تباين ضعيف بين النص والخلفية في ' + lowItems.length + ' عنصر (الأسوأ ' + lowWorst.ratio.toFixed(1) + ':1، المطلوب ≥' + lowWorst.need + ') — الإصلاح يضبط اللون من لوحة الألوان حتى يمرّ.',
          fix: (function (items) { return function () {
            items.forEach(function (it) {
              var c = _snapPalette(it.fg, it.bg, it.need, palette) || _nudge(it.fg, it.bg, it.need);
              it.el.style.color = 'rgb(' + c[0] + ', ' + c[1] + ', ' + c[2] + ')';
            });
          }; })(lowItems) });
      }

      // Rule 3 (v4) — font families are collected per slide; the zoo verdict
      // is deck-aware and happens after the loop.
      var famCount = {}, famRep = {};
      texts.forEach(function (el) {
        var f = _fam(win, el); if (!f) return;
        famCount[f] = (famCount[f] || 0) + 1;
        if (!famRep[f]) famRep[f] = el;
      });
      famData[si] = { count: famCount, rep: famRep, list: Object.keys(famCount), texts: texts.slice() };

      // Rules 4 & 5 — one pass over images
      var imgs = slide.querySelectorAll('img');
      for (var k = 0; k < imgs.length; k++) {
        var img = imgs[k];
        if (img.closest('.ve-ghost') || img.closest('[data-ve-figlist]')) continue;

        // Rule 9 — broken image: a src is present but nothing decoded. The
        // pixels can't be conjured back, so the honest one-click fix removes
        // it (undo-able); click the image first if you'd rather replace it.
        if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
          issues.push({ ruleId: 'broken-image', severity: 'error', slideIndex: si, el: img,
            message: 'صورة مكسورة (المصدر لا يُحمَّل) — الإصلاح يحذفها، أو انقرها لاستبدالها قبل الإصلاح.',
            fix: (function (image) { return function () {
              var fig = image.closest('figure');
              image.remove();
              if (fig && !fig.querySelector('img, svg, canvas, video')) fig.remove();
            }; })(img) });
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

        // Rule 10 — upscaled beyond its pixels: will project blurry. Sharpness
        // can't be invented, so the fix takes the message's second option:
        // shrink the image back to its true pixel size (crisp again).
        if (nw && rw && !/\.svg(\?|#|$)|image\/svg/i.test(img.currentSrc || img.src || '') &&
            rw * rh >= IMG_MIN_AREA && rw / nw > UPSCALE_LIMIT) {
          issues.push({ ruleId: 'blurry-image', severity: 'warn', slideIndex: si, el: img,
            message: 'الصورة معروضة أكبر من دقتها الأصلية (' + (rw / nw).toFixed(1) + '×) وستظهر مبكسلة — الإصلاح يصغّرها إلى حجمها الحقيقي، أو استبدلها بدقة أعلى.',
            fix: (function (image, natW) { return function () {
              image.style.width = Math.round(natW) + 'px';
              image.style.height = 'auto';
              image.style.maxWidth = '100%';
            }; })(img, nw) });
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
      // (a) flow overflow (v4) — measured by what actually paints past the
      // slide box. scrollHeight lied on whole templates (padding artifacts +
      // design-time overflow:hidden produced a constant phantom "25px" on
      // every slide); only visible content extent can be cut in export.
      // Drag-floated absolute units are the off-slide rule's job — skipped
      // here so one escapee doesn't fire two rules. Each fix click = one 7%
      // font step down on this slide (floored so it never creates tiny text).
      var srect3 = slide.getBoundingClientRect();
      var maxBottom3 = -Infinity;
      var kids3 = slide.querySelectorAll('*');
      for (var k3 = 0; k3 < kids3.length; k3++) {
        var kel3 = kids3[k3];
        if (kel3.closest('.ve-overlay, .ve-toolbar, .ve-palette, .ve-wandmenu, .ve-guide, .ve-ghost')) continue;
        var kcs3 = win.getComputedStyle(kel3);
        if (kcs3.position === 'absolute' && kel3.style.left && kel3.style.top) continue;
        var kr3 = kel3.getBoundingClientRect();
        if (!kr3.width || !kr3.height) continue;
        if (kr3.bottom > maxBottom3) maxBottom3 = kr3.bottom;
      }
      var spill3 = maxBottom3 === -Infinity ? 0 : Math.round(maxBottom3 - srect3.bottom);
      if (spill3 > OVERFLOW_TOL) {
        issues.push({ ruleId: 'overflow', severity: 'error', slideIndex: si, el: slide,
          message: 'المحتوى أطول من الشريحة بـ ' + spill3 + 'px وسيُقصّ عند التصدير — الإصلاح يصغّر الخط درجة واحدة (كرّره أو قسّم الشريحة).',
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
            message: 'شريحة شبه فارغة — الإصلاح يحذفها، أو املأها بالمحتوى.',
            fix: _removeSlideFix(editor, slide) });
        }
      }
    });

    // Rule 3 (v4) — font zoo, deck-aware. A family set repeated on most slides
    // IS the deck's design system (brand pairings are 2–3 families by design);
    // flagging it on every slide was noise. Deviating slides — families outside
    // the deck's dominant set — are the real zoo. Decks too small for a
    // "dominant" verdict keep the old per-slide rule.
    var famPass = [];
    if (slides.length >= 4) {
      var setCount = {};
      famData.forEach(function (d) {
        if (!d) return;
        var key = d.list.slice().sort().join('|');
        setCount[key] = (setCount[key] || 0) + 1;
      });
      var setKeys = Object.keys(setCount);
      var domKey = setKeys.length ? setKeys.reduce(function (a, b) { return setCount[b] > setCount[a] ? b : a; }) : '';
      var domSet = domKey ? domKey.split('|') : [];
      famData.forEach(function (d, si2) {
        if (!d) return;
        var intruders = d.list.filter(function (f) { return domSet.indexOf(f) === -1; });
        if (!intruders.length || d.list.length <= FONT_LIMIT) return;
        famPass.push({ si: si2, d: d, intruders: intruders });
      });
    } else {
      famData.forEach(function (d, si2) {
        if (d && d.list.length > FONT_LIMIT) famPass.push({ si: si2, d: d, intruders: null });
      });
    }
    famPass.forEach(function (p) {
      var d = p.d, si3 = p.si, fzMsg, fzFix;
      if (p.intruders) {
        // Strip only the intruder families back onto the slide's dominant
        // LEGIT one. The intruders must be excluded from that vote: a chart
        // with many labels can make the intruder the slide's most-used family,
        // and "restore to itself" is a silent no-op (real case: 8 SVG labels
        // in Cairo vs 5 Lyon elements — the fix targeted Cairo).
        var legit = d.list.filter(function (f) { return p.intruders.indexOf(f) === -1; });
        var domF = (legit.length ? legit : d.list).reduce(function (a, b) { return d.count[b] > d.count[a] ? b : a; });
        var domStack = win.getComputedStyle(d.rep[domF]).fontFamily;
        fzMsg = brandOn
          ? 'خط دخيل على هوية العرض في هذه الشريحة (' + p.intruders.join('، ') + ') — الإصلاح يعيده إلى خطّ الهوية.'
          : 'خط دخيل على نظام خطوط العرض في هذه الشريحة (' + p.intruders.join('، ') + ') — الإصلاح يعيده إلى خطوط العرض.';
        fzFix = _famFix(win, d.texts, domStack, domF, p.intruders);
      } else {
        // Small deck: unify onto the family the most elements already use.
        var domF2 = d.list.reduce(function (a, b) { return d.count[b] > d.count[a] ? b : a; });
        var domStack2 = win.getComputedStyle(d.rep[domF2]).fontFamily;
        fzMsg = 'الشريحة تستخدم ' + d.list.length + ' خطوط مختلفة — الإصلاح يوحّدها على الخطّ الأكثر استخدامًا.';
        fzFix = _famFix(win, d.texts, domStack2, domF2, null);
      }
      issues.push({ ruleId: 'font-zoo', severity: 'warn', slideIndex: si3, el: slides[si3], message: fzMsg, fix: fzFix });
    });

    // Rule 1 (v4) — text overload, deck-relative: flag only outliers above
    // OVERLOAD_FACTOR x the deck's own median (floored by the absolute
    // limits), so a uniformly dense lecture deck isn't nagged on 24 of 26 slides.
    var sortedW = wordCounts.slice().sort(function (a, b) { return a - b; });
    var medW = sortedW.length ? sortedW[Math.floor(sortedW.length / 2)] : 0;
    var sortedC = charCounts.slice().sort(function (a, b) { return a - b; });
    var medC = sortedC.length ? sortedC[Math.floor(sortedC.length / 2)] : 0;
    var wLimit = Math.max(TEXT_WORD_LIMIT, Math.round(medW * OVERLOAD_FACTOR));
    var cLimit = Math.max(TEXT_CHAR_LIMIT, Math.round(medC * OVERLOAD_FACTOR));
    slides.forEach(function (slide, si4) {
      if (wordCounts[si4] > wLimit || charCounts[si4] > cLimit) {
        // Fixable when a clean cut point exists (block boundary or a long
        // list); a lone paragraph/table stays advisory rather than pretending.
        var plan = _splitPlan(slide);
        issues.push({ ruleId: 'text-overload', severity: 'warn', slideIndex: si4, el: slide,
          message: plan
            ? 'الشريحة مزدحمة بالنص (' + wordCounts[si4] + ' كلمة — أعلى بكثير من بقية العرض) — الإصلاح يقسمها إلى شريحتين.'
            : 'الشريحة مزدحمة بالنص (' + wordCounts[si4] + ' كلمة — أعلى بكثير من بقية العرض) — فكّر في تقسيمها إلى شريحتين.',
          fix: plan ? _splitFix(editor, slide, plan) : null });
      }
    });

    // Rule 19 — fonts at genuine risk. A distinctive family (not web-safe, not
    // @font-face embedded) is only a real problem when its OWN fallback stack
    // has nothing web-safe to degrade to — then a machine without the font gets
    // an unpredictable substitute or tofu. A stack that ends in a system font
    // or generic (the responsible pattern our templates deliberately use)
    // renders fine everywhere, so it is NOT flagged — no nagging a deliberate
    // offline-stack design. This catches the true landmine: a custom font used
    // with no safe fallback (common in AI-generated decks). One deck-level
    // finding (slideIndex -1, anchored to slide 1 so «تجاهل» persists in the
    // saved file); skipped when a cross-origin stylesheet may supply faces we
    // cannot read.
    var declared = {}, sheetsUnreadable = false;
    try {
      for (var sh = 0; sh < doc.styleSheets.length; sh++) {
        var sRules;
        try { sRules = doc.styleSheets[sh].cssRules; } catch (e1) { sheetsUnreadable = true; continue; }
        if (!sRules) continue;
        for (var r4 = 0; r4 < sRules.length; r4++) {
          if (sRules[r4].type === 5) {
            var fdecl = (sRules[r4].style.getPropertyValue('font-family') || '').trim().replace(/^['"]|['"]$/g, '');
            if (fdecl) declared[fdecl.toLowerCase()] = true;
          }
        }
      }
    } catch (e2) { sheetsUnreadable = true; }
    var atRisk = {}, atRiskOrder = [];
    famData.forEach(function (d) {
      if (!d) return;
      d.texts.forEach(function (el) {
        var stack = win.getComputedStyle(el).fontFamily.split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); });
        var primary = stack[0];
        if (!primary || GENERIC_FAMS.test(primary) || declared[primary.toLowerCase()]) return;
        var hasSafeFallback = stack.slice(1).some(function (f) { return GENERIC_FAMS.test(f); });
        if (!hasSafeFallback && !atRisk[primary]) { atRisk[primary] = true; atRiskOrder.push(primary); }
      });
    });
    if (!sheetsUnreadable && atRiskOrder.length && slides.length) {
      var famLabel = atRiskOrder.slice(0, 3).join('، ') + (atRiskOrder.length > 3 ? '…' : '');
      issues.push({ ruleId: 'fonts-not-embedded', severity: 'warn', slideIndex: -1, el: slides[0],
        message: 'خط غير مضمّن وبلا بديل آمن (' + famLabel + ') — قد يظهر بخط غير متوقّع على جهاز لا تملكه. الإصلاح يثبّت له بديلًا آمنًا (Tahoma)؛ وللمظهر الأصلي ضمّنه من 🔤 الخطوط.',
        // A local() fallback chain per at-risk family: a machine WITH the font
        // still uses it; a machine without gets Tahoma instead of a random
        // substitute. Declaring the face also satisfies this rule's own
        // `declared` check, deterministically and offline.
        fix: (function (fams) { return function () {
          var st = doc.getElementById('ve-font-fallback');
          if (!st) { st = doc.createElement('style'); st.id = 've-font-fallback'; doc.head.appendChild(st); }
          var css = st.textContent || '';
          for (var fi = 0; fi < fams.length; fi++) {
            var f = fams[fi].replace(/['"\\]/g, '');
            if (css.indexOf("font-family:'" + f + "'") !== -1) continue;
            css += "\n@font-face{font-family:'" + f + "';src:local('" + f + "'),local('Tahoma');}" +
              "\n@font-face{font-family:'" + f + "';font-weight:bold;src:local('" + f + "'),local('Tahoma Bold'),local('Tahoma');}";
          }
          st.textContent = css;
        }; })(atRiskOrder.slice(0)) });
    }

    // Rule 19b — fonts loaded from the network. An @import or <link> to a web-font
    // host (Google Fonts, Typekit, …) renders on the author's connected machine but
    // the intended face vanishes on any device without a connection — the deck then
    // silently falls back to a substitute (no crash, no tofu, just the wrong
    // typeface). Distinct from Rule 19: there a fallback is missing; here one exists
    // but the design still isn't portable. Deterministic, zero false positives (a
    // network dependency is a fact) — and the responsible offline stacks our
    // templates use carry no external @import, so a deliberate design stays silent.
    // Deck-level (slideIndex -1, anchored to slide 1 so «تجاهل» persists).
    var hostOf = function (u) { var m = /^https?:\/\/([^\/?#]+)/i.exec(u); return m ? m[1] : u; };
    var netHosts = {};
    try {
      for (var ssi = 0; ssi < doc.styleSheets.length; ssi++) {
        var impRules;
        try { impRules = doc.styleSheets[ssi].cssRules; } catch (eImp) { continue; }
        if (!impRules) continue;
        for (var ri = 0; ri < impRules.length; ri++) {
          if (impRules[ri].type === 3 && impRules[ri].href && FONT_HOST.test(impRules[ri].href)) netHosts[hostOf(impRules[ri].href)] = true;
        }
      }
    } catch (eSheets) { /* cross-origin sheet — ignore, we only care about readable @imports */ }
    var fontLinks = doc.querySelectorAll('link[href]');
    for (var li = 0; li < fontLinks.length; li++) {
      var lhref = fontLinks[li].getAttribute('href') || '';
      if (FONT_HOST.test(lhref)) netHosts[hostOf(lhref)] = true;
    }
    var netKeys = Object.keys(netHosts);
    if (netKeys.length && slides.length) {
      issues.push({ ruleId: 'fonts-external', severity: 'warn', slideIndex: -1, el: slides[0],
        message: 'خطوط تُحمَّل من الإنترنت (' + netKeys.slice(0, 2).join('، ') + ') — على جهاز دون اتصال تظهر الشرائح بخط بديل. الإصلاح يضمّنها داخل الملف نفسه (يحتاج اتصالًا مرة واحدة) فيظهر العرض كما صمّمته على كل جهاز.',
        // Async fix (returns a Promise — the docks await it). Fails safe: the
        // deck is untouched unless the binaries actually landed in the file.
        fix: function () { return _embedExternalFonts(doc); } });
    }

    // Rule 20 — stray pre-DOCTYPE markup / stylesheet parsed into <body>.
    // LLM-generated decks often arrive wrapped in a markdown fence: any text
    // before <!DOCTYPE> forces quirks mode and the parser hoists the deck's
    // whole <style> into <body>, where it FOLLOWS (and beats) the <head>
    // theme kit in cascade order — kits then change fonts but never colors
    // (EVO-013). Fixable live: move the stylesheet(s) back to <head> (before
    // #ve-theme so an applied kit keeps winning) and delete fence text nodes.
    // Box-model quirks fully clear on save + reopen (getCleanHtml always
    // writes the DOCTYPE). Fires only while fixable things remain, so the
    // fix-all convergence loop terminates (EVO-009).
    var SM_FENCE = /^\s*`{3,}[a-z]*\s*$/i;
    var smStyles = [];
    for (var smA = 0; smA < doc.body.children.length; smA++) {
      if (doc.body.children[smA].tagName === 'STYLE') smStyles.push(doc.body.children[smA]);
    }
    var smFences = [];
    var smEdges = [doc.body.firstChild, doc.body.lastChild];
    for (var smB = 0; smB < smEdges.length; smB++) {
      var smNode = smEdges[smB];
      if (smNode && smNode.nodeType === 3 && SM_FENCE.test(smNode.nodeValue) &&
          smFences.indexOf(smNode) === -1) smFences.push(smNode);
    }
    if ((smStyles.length || smFences.length) && slides.length) {
      issues.push({ ruleId: 'stray-markup', severity: 'error', slideIndex: -1, el: slides[0],
        message: 'الملف يبدأ بنص غريب قبل HTML (غالبًا سياج ماركداون من محادثة ذكاء اصطناعي) — انزلقت التنسيقات إلى داخل الصفحة فصارت تتقدّم على أي هوية/ثيم تطبّقه ولا تتغيّر الألوان. الإصلاح يعيد التنسيقات لمكانها ويحذف النص الغريب؛ احفظ الملف وأعد فتحه ليكتمل التصحيح.',
        fix: (function (styles, fences) { return function () {
          var theme = doc.getElementById('ve-theme');
          for (var smC = 0; smC < styles.length; smC++) {
            if (theme && theme.parentNode === doc.head) doc.head.insertBefore(styles[smC], theme);
            else doc.head.appendChild(styles[smC]);
          }
          for (var smD = 0; smD < fences.length; smD++) {
            if (fences[smD].parentNode) fences[smD].parentNode.removeChild(fences[smD]);
          }
        }; })(smStyles, smFences) });
    }

    // Rule 21 — colors hardcoded past the reach of the theme kit. A kit
    // overrides CSS variables, so literal colors in the deck's rules, inline
    // styles and SVG fills stay exactly as authored: the user clicks the
    // identity, the fonts change, half the colors don't, and nothing anywhere
    // says why. Only meaningful once a kit IS applied — without one there is no
    // "right" color to snap to — so the rule is gated on an active kit and
    // stays silent for every other deck. Deck-level (slideIndex -1, anchored to
    // slide 1 so «تجاهل» persists in the saved file).
    if (kitOn && slides.length && editor.kitTokens && editor.parseSolidColor) {
      var hcTokens = editor.kitTokens();
      var hcCount = hcTokens.length ? _walkHardcoded(editor, false) : 0;
      if (hcCount) {
        issues.push({ ruleId: 'hardcoded-colors', severity: 'warn', slideIndex: -1, el: slides[0],
          message: 'العرض يكتب ' + hcCount + ' لونًا داخل التنسيقات مباشرة، فلا تصل إليها الهوية ولا أي ثيم — لهذا تتغيّر الخطوط ويبقى جزء من الألوان كما هو. الإصلاح يربط كل لون بأقرب لون رسمي ويُبقي الأصلي بديلًا، فتعود الألوان الأصلية فور إيقاف الهوية.',
          fix: (function (toks) { return function () {
            _walkHardcoded(editor, true, _deckTokenIndex(editor, toks), toks);
          }; })(hcTokens) });
      }
    }

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
          message: 'الشريحة مطابقة تمامًا للشريحة ' + (seenText[norm] + 1) + ' — غالبًا نسخة منسيّة؛ الإصلاح يحذف النسخة.',
          fix: _removeSlideFix(editor, slide) });
      } else { seenText[norm] = si; }
    });

    // Dismissed issues (data-ve-dr-ignore) drop out here, one gate for all rules.
    return issues.filter(function (iss) { return !_ignored(iss.el, iss.ruleId); });
  }

  // Group the flat issue list into root-cause cards: same rule + same
  // digit-stripped message text = one decision or template artifact repeated
  // across slides (e.g. the same low-contrast title color on 25 slides).
  // The UI renders one card per group; per-slide granularity stays available
  // via card.issues. analyze() keeps its flat shape — Electron's renderer
  // consumes it unchanged.
  function aggregate(issues) {
    var map = {}, order = [];
    for (var i = 0; i < issues.length; i++) {
      var iss = issues[i];
      var sig = iss.ruleId + '|' + iss.severity + '|' + iss.message.replace(/[0-9٠-٩٫.,]+/g, '#');
      if (!map[sig]) {
        map[sig] = { ruleId: iss.ruleId, severity: iss.severity, message: iss.message, issues: [], slides: [] };
        order.push(sig);
      }
      map[sig].issues.push(iss);
      if (map[sig].slides.indexOf(iss.slideIndex) === -1) map[sig].slides.push(iss.slideIndex);
    }
    return order.map(function (k) {
      var g = map[k];
      g.count = g.issues.length;
      g.fixable = g.issues.filter(function (x) { return !!x.fix; }).length;
      return g;
    });
  }

  window.SlideDoctor = { analyze: analyze, aggregate: aggregate, version: 5 };
})();
