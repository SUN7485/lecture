/*
 * LectureEditor — operates on a same-origin iframe document.
 * Features: drag-to-insert images (flow based), select, resize, align, replace, delete,
 * undo/redo (HTML snapshots). Runs entirely in the renderer; no injection into the iframe.
 */
(function () {
  // Layout CSS that INSERTED content depends on. This must survive PDF export,
  // so it lives in its own <style id="ve-export-css"> that getCleanHtml keeps.
  // (Putting these in the interactive-only sheet caused dropped images to lose
  //  their max-width in the exported PDF and blow up to natural size.)
  const EXPORT_CSS = `
    .ve-slot { margin: 12px 0; text-align: center; }
    .ve-slot.ve-align-left { text-align: left; }
    .ve-slot.ve-align-right { text-align: right; }
    .ve-slot img { max-width: 100%; height: auto; }
    .ve-slot figcaption { font-size: 13px; color: #555; text-align: center; margin-top: 6px; }
  `;

  const EDITOR_CSS = `
    html, body { height: auto !important; min-height: 0 !important; }
    .ve-selected { outline: 2px solid #2f6df6 !important; outline-offset: 1px; cursor: move; }
    .ve-editing { outline: 2px dashed #8b5cf6 !important; outline-offset: 2px; cursor: text; }
    /* Alignment / snap guides shown while free-dragging an image. */
    .ve-guide { position: absolute; background: #f5288f; pointer-events: none; z-index: 2147483001; }
    .ve-guide.v { width: 1px; }
    .ve-guide.h { height: 1px; }
    .ve-insert-line {
      position: absolute; height: 3px; background: #2f6df6; border-radius: 2px;
      pointer-events: none; z-index: 2147483000; box-shadow: 0 0 6px rgba(47,109,246,.6);
    }
    .ve-overlay { position: absolute; pointer-events: none; z-index: 2147483001; }
    .ve-handle {
      position: absolute; width: 14px; height: 14px; background: #fff;
      border: 2px solid #2f6df6; border-radius: 50%; pointer-events: auto;
      transform: translate(-50%, -50%); touch-action: none;
    }
    .ve-handle.nw, .ve-handle.se { cursor: nwse-resize; }
    .ve-handle.ne, .ve-handle.sw { cursor: nesw-resize; }
    .ve-handle.n, .ve-handle.s { cursor: ns-resize; }
    .ve-handle.e, .ve-handle.w { cursor: ew-resize; }
    .ve-tag { padding: 4px 6px; color: #9aa4b8; }
    .ve-palette {
      position: absolute; z-index: 2147483003; display: grid;
      grid-template-columns: repeat(6, 24px); gap: 6px; background: #1f2430;
      padding: 10px; border-radius: 10px; box-shadow: 0 6px 18px rgba(0,0,0,.35);
    }
    .ve-swatch { width: 24px; height: 24px; border-radius: 5px; cursor: pointer; border: 2px solid rgba(255,255,255,.25); }
    .ve-swatch:hover { border-color: #fff; }
    .ve-palette input[type="color"] { grid-column: span 3; width: 100%; height: 26px; padding: 0; border: none; background: none; cursor: pointer; }
    .ve-toolbar {
      position: absolute; display: flex; gap: 4px; background: #1f2430; color: #fff;
      padding: 4px 6px; border-radius: 8px; font: 12px -apple-system, "Segoe UI", sans-serif;
      pointer-events: auto; z-index: 2147483002; box-shadow: 0 4px 12px rgba(0,0,0,.3);
      white-space: nowrap;
    }
    .ve-toolbar button {
      background: #333a49; color: #fff; border: none; border-radius: 5px;
      padding: 4px 8px; cursor: pointer; font: inherit;
    }
    .ve-toolbar button:hover { background: #45506a; }
    .ve-toolbar button.primary { background: #2f6df6; }
    .ve-toolbar button.primary:hover { background: #4a82ff; }
    .ve-toolbar button.danger:hover { background: #c0392b; }
    .ve-toolbar button.wand { background: #6d4bd6; }
    .ve-toolbar button.wand:hover { background: #855ff0; }
    /* Wand menu: point-of-work AI actions, styled like the color palette. */
    .ve-wandmenu {
      position: absolute; z-index: 2147483003; display: flex; flex-direction: column;
      gap: 4px; background: #1f2430; color: #fff; padding: 6px; border-radius: 10px;
      box-shadow: 0 6px 18px rgba(0,0,0,.35); min-width: 180px;
      font: 12px -apple-system, "Segoe UI", sans-serif;
    }
    .ve-wandmenu button {
      background: #333a49; color: #fff; border: none; border-radius: 6px;
      padding: 7px 9px; cursor: pointer; font: inherit; text-align: start;
      display: flex; justify-content: space-between; gap: 10px; align-items: center;
    }
    .ve-wandmenu button:hover { background: #45506a; }
    .ve-wandmenu .ve-wcost { font-size: 10px; color: #9aa4b8; }
    .ve-wandmenu .ve-wcost.paid { color: #e0b060; }
    /* Studio ghost preview: a live, in-place preview of a generated visual. */
    .ve-ghost { position: relative; outline: 2px dashed var(--purple, #7c3aed); outline-offset: 3px; opacity: .85; pointer-events: none; animation: ve-ghost-in .18s ease; }
    .ve-ghost::after { content: "معاينة"; position: absolute; top: -3px; inset-inline-start: -3px; background: var(--purple, #7c3aed); color: #fff; font: 600 11px "Segoe UI", system-ui, sans-serif; padding: 2px 9px; border-radius: 7px; z-index: 6; pointer-events: none; }
    .ve-ghost-hidden { display: none !important; }
    @keyframes ve-ghost-in { from { opacity: 0; transform: translateY(4px); } to { opacity: .85; transform: none; } }
  `;

  const BLOCK_TAGS = new Set(['P','DIV','H1','H2','H3','H4','H5','H6','UL','OL','LI','SECTION','ARTICLE','TABLE','BLOCKQUOTE','PRE','FIGURE','HR','IMG']);

  // ---- MiM (Ministry of Industry) brand identity ----
  // Fonts: each file key maps to a real family + weight. We register every
  // weight under the clean family name AND under the "…Regular" alias the
  // existing lectures already ask for — so old decks that say
  // `font-family:'Lyon Arabic Regular'; font-weight:bold` pick the *real* Bold
  // file instead of Windows fake-bolding a Regular. Keys match src/fonts/*.otf.
  const BRAND_FONTS = {
    'diodrum-extralight': { fam: 'Diodrum Arabic', weight: 200 },
    'diodrum-light':      { fam: 'Diodrum Arabic', weight: 300 },
    'diodrum-regular':    { fam: 'Diodrum Arabic', weight: 400 },
    'diodrum-medium':     { fam: 'Diodrum Arabic', weight: 500 },
    'diodrum-semibold':   { fam: 'Diodrum Arabic', weight: 600 },
    'diodrum-bold':       { fam: 'Diodrum Arabic', weight: 700 },
    'lyon-regular':       { fam: 'Lyon Arabic Text', weight: 400 },
    'lyon-semibold':      { fam: 'Lyon Arabic Text', weight: 600 },
    'lyon-bold':          { fam: 'Lyon Arabic Text', weight: 700 },
    'lyon-black':         { fam: 'Lyon Arabic Text', weight: 900 },
  };
  const FONT_ALIASES = {
    'Diodrum Arabic': ['Diodrum Arabic Regular'],
    'Lyon Arabic Text': ['Lyon Arabic Regular'],
  };

  // Official MiM palette (brand book, pages 30–34). The lecture already uses
  // var(--purple)/var(--cyan)/var(--gold) etc., so overriding :root recolors
  // everything. Note --gold is deliberately mapped to MiM Pink #BFA19F: gold
  // is NOT a ministry color; pink is the real third accent. Purple-tint tokens
  // let hardcoded fades (e.g. the title-button shadow) track the base color.
  const BRAND_PALETTE_CSS = `:root{
  --purple:#413258; --cyan:#1AD9C7; --pink:#BFA19F; --gold:#BFA19F;
  --dark:#1A1A1A; --bg-gray:#F4F4F6; --white:#FFFFFF;
  --grey-dark:#666666; --grey-mid:#B3B3B3; --grey-light:#E6E6E6;
  --purple-70:rgba(65,50,88,.70); --purple-40:rgba(65,50,88,.40);
  --purple-15:rgba(65,50,88,.15); --purple-08:rgba(65,50,88,.08);
}`;

  class LectureEditor {
    constructor() {
      this.doc = null;
      this.win = null;
      this.selected = null;
      this.overlay = null;
      this.toolbar = null;
      this.insertLine = null;
      this.undoStack = [];
      this.redoStack = [];
      this.onChange = () => {};
      this._raf = null;
    }

    attach(iframe) {
      this.iframe = iframe;
      this.doc = iframe.contentDocument;
      this.win = iframe.contentWindow;

      // Inject editor styles. Two sheets:
      //  - #ve-export-css: layout rules inserted content needs; KEPT on export.
      //  - #ve-styles: interactive-only chrome (handles/toolbar/outlines); stripped.
      const exportStyle = this.doc.createElement('style');
      exportStyle.id = 've-export-css';
      exportStyle.textContent = EXPORT_CSS;
      this.doc.head.appendChild(exportStyle);

      const style = this.doc.createElement('style');
      style.id = 've-styles';
      style.textContent = EDITOR_CSS;
      this.doc.head.appendChild(style);

      // Size the iframe to its content so the app window scrolls naturally
      // (no scrollbar-inside-a-scrollbar).
      this._sizeToContent();
      if (this.win.ResizeObserver) {
        this._ro = new this.win.ResizeObserver(() => this._sizeToContent());
        this._ro.observe(this.doc.documentElement);
        if (this.doc.body) this._ro.observe(this.doc.body);
      }

      // Make existing images editable too.
      this.doc.addEventListener('click', (e) => this._onDocClick(e), true);
      this.doc.addEventListener('dblclick', (e) => this._onDblClick(e));
      this.win.addEventListener('scroll', () => this._reposition(), true);
      this.win.addEventListener('resize', () => this._reposition());
      this.doc.addEventListener('keydown', (e) => this._onKey(e));

      this.undoStack = [this._snapshot()];
      this.redoStack = [];
      this._emit();
    }

    _sizeToContent() {
      if (!this.doc || !this.doc.body || !this.iframe) return;
      const cs = this.win.getComputedStyle(this.doc.body);
      const bodyH = this.doc.body.scrollHeight
        + (parseFloat(cs.marginTop) || 0)
        + (parseFloat(cs.marginBottom) || 0);
      // Take the taller of body vs. documentElement, plus a 2px buffer. If the
      // iframe is even a pixel shorter than its content, the inner document
      // grows its own scrollbar — and because the lecture is RTL that scrollbar
      // lands on the LEFT, a confusing second bar next to the stage's own.
      const h = Math.max(bodyH, this.doc.documentElement.scrollHeight);
      this.iframe.style.height = Math.max(400, Math.ceil(h) + 2) + 'px';
      // Wide lectures (slide decks) get the full width they ask for; the
      // stage scrolls horizontally instead of cutting the slide off.
      const w = Math.max(this.doc.documentElement.scrollWidth, this.doc.body.scrollWidth);
      if (w > this.iframe.clientWidth + 2) this.iframe.style.width = w + 'px';
      this.onContentResize && this.onContentResize();
    }

    // ---------- snapshots / undo ----------
    _snapshot() {
      // Clone and strip editor UI so undo/redo never re-materializes ghost
      // toolbars/handles into the document.
      const clone = this.doc.body.cloneNode(true);
      clone.querySelectorAll('.ve-overlay, .ve-toolbar, .ve-insert-line, .ve-guide').forEach(n => n.remove());
      // Studio ghost previews are transient — never let one survive into an
      // undo/redo snapshot (or it would resurrect on undo).
      clone.querySelectorAll('.ve-ghost').forEach(n => n.remove());
      clone.querySelectorAll('.ve-ghost-hidden').forEach(n => n.classList.remove('ve-ghost-hidden'));
      clone.querySelectorAll('.ve-selected').forEach(n => n.classList.remove('ve-selected'));
      clone.querySelectorAll('[contenteditable], .ve-editing').forEach(n => {
        n.removeAttribute('contenteditable');
        n.classList.remove('ve-editing');
      });
      return clone.innerHTML;
    }
    _pushHistory() {
      // Figure numbers («شكل N») follow document order; recompute before every
      // snapshot so insert/delete/move keeps them correct — and undo/redo
      // states always carry consistent numbering.
      try { this.renumberFigures(); } catch (_) {}
      this.undoStack.push(this._snapshot());
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
      this._emit();
    }
    undo() {
      if (this.undoStack.length <= 1) return;
      this.redoStack.push(this.undoStack.pop());
      this.doc.body.innerHTML = this.undoStack[this.undoStack.length - 1];
      this._deselect();
      this._emit();
      this.onSlidesChanged && this.onSlidesChanged(null);
    }
    redo() {
      if (!this.redoStack.length) return;
      const html = this.redoStack.pop();
      this.undoStack.push(html);
      this.doc.body.innerHTML = html;
      this._deselect();
      this._emit();
      this.onSlidesChanged && this.onSlidesChanged(null);
    }
    canUndo() { return this.undoStack.length > 1; }
    canRedo() { return this.redoStack.length > 0; }
    _emit() { this.onChange({ canUndo: this.canUndo(), canRedo: this.canRedo() }); }

    _onKey(e) {
      // While editing text, let the browser handle typing and native undo.
      if (this._editingEl) {
        if (e.key === 'Escape') { e.preventDefault(); this._editingEl.blur(); }
        return;
      }
      if (this._placeType && e.key === 'Escape') {
        e.preventDefault();
        this.cancelPlace();
        this.onPlaced && this.onPlaced(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.onSaveRequest && this.onSaveRequest();
        return;
      }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (this.selected && arrows[e.key] && this._canFloat(this.selected.closest('.ve-slot') || this.selected)) {
        // Precise positioning: arrows nudge 1px, Shift+arrows 10px. Nudging
        // floats the element first (same as a drag would).
        e.preventDefault();
        const [ux, uy] = arrows[e.key];
        const step = e.shiftKey ? 10 : 1;
        this._nudge(ux * step, uy * step);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
        e.preventDefault();
        this.deleteSelected();
      } else if (e.key === 'Escape' && this.selected) {
        this._deselect();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
      }
    }

    // ---------- text editing (double-click, PowerPoint style) ----------
    // An element whose words can be edited in place: a real text block, a
    // table cell, or a "leaf" box that only holds text.
    _isTextEditable(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.matches('p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, figcaption, pre, dt, dd, caption, summary')) return true;
      if ((el.tagName === 'DIV' || el.tagName === 'SPAN') &&
          !el.querySelector('p,h1,h2,h3,h4,h5,h6,li,table,div,ul,ol,img') &&
          el.textContent.trim().length) return true;
      return false;
    }

    _onDblClick(e) {
      if (e.target.closest('img, .ve-slot, .ve-toolbar, .ve-overlay, .ve-handle')) return;
      let el = e.target.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, figcaption, pre, dt, dd, caption, summary');
      if (!el) {
        const leaf = this._selectableBlock(e.target);
        if (this._isTextEditable(leaf)) el = leaf;
      }
      if (!el || el === this._editingEl) return;
      this._startTextEdit(el);
    }

    _startTextEdit(el) {
      this._deselect();
      if (this._editingEl) this._editingEl.blur();
      this._editingEl = el;
      el.setAttribute('contenteditable', 'true');
      el.classList.add('ve-editing');
      el.focus();

      // If focus didn't land a caret inside (e.g. we entered via the toolbar
      // button, not a double-click), drop the caret at the end of the text.
      const sel = this.win.getSelection();
      if (!sel.anchorNode || !el.contains(sel.anchorNode)) {
        const rng = this.doc.createRange();
        rng.selectNodeContents(el);
        rng.collapse(false);
        sel.removeAllRanges();
        sel.addRange(rng);
      }

      // Mini format bar: Bold / Italic / Underline + an explicit Done so it's
      // obvious how to finish (Ctrl+B/I/U and clicking away work too).
      const bar = this.doc.createElement('div');
      bar.className = 've-toolbar';
      bar.innerHTML = `
        <button data-c="bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button data-c="italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button data-c="underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <button data-done="1" title="Finish editing (or click anywhere else)">✓ Done</button>`;
      bar.addEventListener('mousedown', (e) => e.preventDefault());
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.done) { el.blur(); return; }
        this.doc.execCommand(b.dataset.c, false, null);
      });
      const r = el.getBoundingClientRect();
      bar.style.left = (r.left + this.win.scrollX) + 'px';
      bar.style.top = Math.max(0, r.top + this.win.scrollY - 40) + 'px';
      this.doc.body.appendChild(bar);
      this._editBar = bar;

      const end = () => {
        el.removeAttribute('contenteditable');
        el.classList.remove('ve-editing');
        this._editingEl = null;
        if (this._editBar) { this._editBar.remove(); this._editBar = null; }
        this._pushHistory();
      };
      el.addEventListener('blur', end, { once: true });
    }

    // ---------- insert placement mode (+ Text / ─ Line / ⊞ Table) ----------
    beginPlace(type) {
      this._placeType = type;
      this.doc.body.style.cursor = 'crosshair';
    }

    cancelPlace() {
      this._placeType = null;
      this.doc.body.style.cursor = '';
    }

    _placeAt(type, clientX, clientY) {
      const target = this._findInsertTarget(clientX + this.win.scrollX, clientY + this.win.scrollY);
      const isAr = (this.doc.documentElement.lang || '').toLowerCase().startsWith('ar')
        || this.doc.documentElement.dir === 'rtl';
      let el;
      if (type === 'text') {
        // A plain <p> — it inherits the lecture's own fonts/styles from CSS.
        el = this.doc.createElement('p');
        el.textContent = isAr ? 'اكتب النص هنا' : 'Type your text here';
      } else if (type === 'line') {
        el = this.doc.createElement('hr');
        const c = this.themeColors()[0] || '#444444';
        el.style.cssText = `border:none;border-top:3px solid ${c};margin:12px 0;`;
      } else if (type === 'table') {
        el = this._makeTable(isAr);
      }
      if (!el) return;

      if (target && target.el) {
        const ref = target.el;
        const before = target.replace ? true : target.before;
        ref.parentElement.insertBefore(el, before ? ref : ref.nextSibling);
      } else {
        this.doc.body.appendChild(el);
      }
      this._pushHistory();
      if (type === 'text') {
        this._startTextEdit(el);
        const rng = this.doc.createRange();
        rng.selectNodeContents(el);
        const sel = this.win.getSelection();
        sel.removeAllRanges();
        sel.addRange(rng);
      } else {
        this.select(el);
      }
      this.onPlaced && this.onPlaced(type);
    }

    _makeTable(isAr) {
      const t = this.doc.createElement('table');
      // Inherit the document's own table styling when it exists; otherwise
      // add simple visible borders so the table isn't invisible.
      const probe = this.doc.querySelector('td, th');
      const styled = probe && this.win.getComputedStyle(probe).borderTopStyle !== 'none';
      if (!styled) t.style.cssText = 'width:100%;border-collapse:collapse;';
      const mk = (tag, txt) => {
        const c = this.doc.createElement(tag);
        c.textContent = txt;
        if (!styled) c.style.cssText = 'border:1px solid #999;padding:4px 8px;';
        return c;
      };
      const head = this.doc.createElement('tr');
      for (let i = 1; i <= 3; i++) head.appendChild(mk('th', (isAr ? 'عنوان ' : 'Header ') + i));
      t.appendChild(head);
      for (let r = 0; r < 2; r++) {
        const tr = this.doc.createElement('tr');
        for (let i = 0; i < 3; i++) tr.appendChild(mk('td', ' '));
        t.appendChild(tr);
      }
      return t;
    }

    // Colors declared as CSS variables in the lecture (its own identity).
    themeColors() {
      const out = [];
      for (const sheet of this.doc.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch (_) { continue; }
        for (const rule of rules || []) {
          if (!rule.style) continue;
          for (const name of rule.style) {
            if (name.startsWith('--')) {
              const v = rule.style.getPropertyValue(name).trim();
              if (/^#|^rgb|^hsl/i.test(v)) out.push(v);
            }
          }
        }
      }
      return [...new Set(out)].slice(0, 9);
    }

    // ---------- selection (any element, PowerPoint style) ----------
    _onDocClick(e) {
      if (!e.target.closest) return;
      // A just-finished free-drag ends with a click; keep the current selection.
      if (this._justDragged) { this._justDragged = false; e.preventDefault(); e.stopPropagation(); return; }
      if (e.target.closest('.ve-toolbar, .ve-handle, .ve-overlay, .ve-palette, .ve-wandmenu')) return;
      if (this._placeType) {
        e.preventDefault();
        e.stopPropagation();
        const t = this._placeType;
        this.cancelPlace();
        this._placeAt(t, e.clientX, e.clientY);
        return;
      }
      // Clicking inside text being edited: leave the caret alone.
      if (this._editingEl && e.target.closest('[contenteditable]')) return;
      const img = e.target.closest('img');
      if (img) {
        e.preventDefault();
        this.select(img);
        return;
      }
      // Generated charts/diagrams are <svg>; select the svg so it can be moved,
      // aligned, layered and deleted exactly like an inserted image.
      const svg = e.target.closest('svg');
      if (svg) {
        e.preventDefault();
        this.select(svg);
        return;
      }
      const block = this._selectableBlock(e.target);
      if (block) this.select(block);
      else this._deselect();
    }

    // Smallest sensible element under the click: text blocks, tables,
    // placeholders, or "leaf" boxes (divs with no block children).
    _selectableBlock(t) {
      const TEXTY = 'p, h1, h2, h3, h4, h5, h6, li, table, figure, blockquote, pre, hr';
      let el = t.nodeType === 1 ? t : t.parentElement;
      while (el && el !== this.doc.body) {
        if (el.matches(TEXTY)) return el;
        if (el.matches('[class*="placeholder"]')) return el;
        if ((el.tagName === 'DIV' || el.tagName === 'SPAN') &&
            !el.querySelector('p,h1,h2,h3,h4,h5,h6,li,table,div,ul,ol,img')) return el;
        el = el.parentElement;
      }
      return null;
    }

    _selectableParent(el) {
      let p = el.closest('.ve-slot') || el;
      p = p.parentElement;
      while (p && p !== this.doc.body) {
        if (p.matches('p,h1,h2,h3,h4,h5,h6,li,table,figure,blockquote,pre,ul,ol,div,section,article')) return p;
        p = p.parentElement;
      }
      return null;
    }

    select(el) {
      this._deselect();
      this.selected = el;
      el.classList.add('ve-selected');
      this._buildOverlay();
      this._reposition();
    }

    _deselect() {
      if (this._dragImg && this._dragDown) {
        this._dragImg.removeEventListener('pointerdown', this._dragDown);
      }
      this._dragImg = null;
      this._dragDown = null;
      if (this.selected) this.selected.classList.remove('ve-selected');
      this.selected = null;
      if (this.overlay) { this.overlay.remove(); this.overlay = null; }
      if (this.toolbar) { this.toolbar.remove(); this.toolbar = null; }
      this._closePalette();
      this._closeWandMenu();
    }

    _buildOverlay() {
      const doc = this.doc;
      const isImg = this.selected.tagName === 'IMG';
      this.overlay = doc.createElement('div');
      this.overlay.className = 've-overlay';
      if (isImg) {
        // 8 handles like PowerPoint: corners keep proportions, edges stretch.
        ['nw','n','ne','e','se','s','sw','w'].forEach(pos => {
          const h = doc.createElement('div');
          h.className = 've-handle ' + pos;
          h.dataset.pos = pos;
          h.addEventListener('pointerdown', (e) => this._startResize(e, pos));
          this.overlay.appendChild(h);
        });
      }
      doc.body.appendChild(this.overlay);

      // Any selectable element inside a slide can be free-dragged (not just
      // images): press its body and move to lift it into absolute positioning.
      const dragUnit = this.selected.closest('.ve-slot') || this.selected;
      if (this._canFloat(dragUnit)) {
        this._dragImg = this.selected;
        this._dragDown = (e) => this._startDrag(e);
        this._dragImg.addEventListener('pointerdown', this._dragDown);
      }

      this.toolbar = doc.createElement('div');
      this.toolbar.className = 've-toolbar';
      const inSlide = this._slideOf(this.selected);
      const dupBtn = inSlide ? `<button data-act="dupslide" title="Duplicate this slide">⧉ Slide</button>` : '';
      if (isImg) {
        // Once an image is free-floating it can overlap others, so offer layering.
        const floated = (this.selected.closest('.ve-slot') || this.selected).dataset.veFloat === '1';
        const zBtns = floated ? `
          <button data-act="front" title="Bring to front">⤒ Front</button>
          <button data-act="back" title="Send to back">⤓ Back</button>` : '';
        this.toolbar.innerHTML = `
          <span class="ve-tag" title="Drag the image to move it anywhere on the slide (arrow keys nudge)">✥ drag to move</span>
          <button data-act="left" title="Align left">⬅</button>
          <button data-act="center" title="Center">⬍</button>
          <button data-act="right" title="Align right">➡</button>
          ${zBtns}
          <button data-act="replace" title="Replace image">Replace</button>
          <button data-act="parent" title="Select the box that contains this">⬆ Box</button>
          ${dupBtn}
          <button data-act="delete" class="danger" title="Delete">🗑 Delete</button>`;
      } else {
        const label = this.selected.tagName.toLowerCase() +
          (this.selected.classList.length ? '.' + this.selected.classList[0] : '');
        const isTable = !!this.selected.closest('table');
        const tableBtns = isTable ? `
          <button data-act="rowadd" title="Add a row">+Row</button>
          <button data-act="coladd" title="Add a column">+Col</button>
          <button data-act="rowdel" title="Remove the last row">−Row</button>
          <button data-act="coldel" title="Remove the last column">−Col</button>` : '';
        const editBtn = this._isTextEditable(this.selected)
          ? `<button data-act="edit" class="primary" title="Edit the words (or double-click the text)">✏ Edit text</button>` : '';
        // ✨ point-of-work AI: only offer it when the wand module finds an
        // action for this selection (list→diagram, table→chart, formula, image).
        const wandBtn = (window.Wand && window.Wand.actionsFor(this.selected).length)
          ? `<button data-act="wand" class="wand" title="حوّل هذا العنصر بالذكاء (✨)">✨</button>` : '';
        const canFloat = this._canFloat(this.selected);
        const dragHint = canFloat
          ? `<span class="ve-tag" title="Drag to move it anywhere on the slide (arrow keys nudge)">✥ move</span>` : '';
        const floated = this.selected.dataset.veFloat === '1';
        const zBtns = floated ? `
          <button data-act="front" title="Bring to front">⤒ Front</button>
          <button data-act="back" title="Send to back">⤓ Back</button>` : '';
        this.toolbar.innerHTML = `
          <span class="ve-tag">${label}</span>
          ${dragHint}
          ${wandBtn}
          ${editBtn}
          <button data-act="color" title="Text color">🎨</button>
          <button data-act="fill" title="Fill / background color">🖌</button>
          ${tableBtns}
          ${zBtns}
          ${dupBtn}
          <button data-act="parent" title="Select the container of this element">⬆ Container</button>
          <button data-act="delete" class="danger" title="Delete (or press Del)">🗑 Delete</button>`;
      }
      this.toolbar.addEventListener('mousedown', (e) => e.preventDefault());
      this.toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        const act = btn && btn.dataset.act;
        if (!act) return;
        if (act === 'delete') this.deleteSelected();
        else if (act === 'wand') this._showWandMenu();
        else if (act === 'edit') this._startTextEdit(this.selected);
        else if (act === 'replace') this.onReplaceRequest && this.onReplaceRequest(this.selected);
        else if (act === 'parent') {
          const p = this._selectableParent(this.selected);
          if (p) this.select(p);
        }
        else if (act === 'color') this._showPalette('color');
        else if (act === 'fill') this._showPalette('background');
        else if (act === 'front' || act === 'back') this._zorder(act);
        else if (act === 'dupslide') this.duplicateSlide();
        else if (act.startsWith('row') || act.startsWith('col')) this._tableOp(act);
        else this.align(act);
      });
      doc.body.appendChild(this.toolbar);
    }

    // ---------- color palette ----------
    _showPalette(mode) {
      this._closePalette();
      if (!this.selected) return;
      const doc = this.doc;
      const pal = doc.createElement('div');
      pal.className = 've-palette';
      const colors = [...new Set([
        ...this.themeColors(),
        '#000000', '#ffffff', '#d32f2f', '#1976d2', '#388e3c', '#f9a825'
      ])].slice(0, 12);
      colors.forEach(c => {
        const sw = doc.createElement('div');
        sw.className = 've-swatch';
        sw.style.background = c;
        sw.title = c;
        sw.addEventListener('click', () => this._applyColor(mode, c));
        pal.appendChild(sw);
      });
      const custom = doc.createElement('input');
      custom.type = 'color';
      custom.title = 'Custom color…';
      custom.addEventListener('change', () => this._applyColor(mode, custom.value));
      pal.appendChild(custom);
      pal.style.left = this.toolbar.style.left;
      pal.style.top = (parseFloat(this.toolbar.style.top) + 38) + 'px';
      doc.body.appendChild(pal);
      this._palette = pal;
    }

    _closePalette() {
      if (this._palette) { this._palette.remove(); this._palette = null; }
    }

    // ---------- wand menu (point-of-work AI) ----------
    // A small popup of the actions Wand offers for the current selection. The
    // heavy lifting (offline parse → pipeline proposal → Studio card + ghost)
    // lives in studio/wand.js; the editor just renders the menu in the iframe.
    _showWandMenu() {
      this._closeWandMenu();
      if (!this.selected || !window.Wand) return;
      const acts = window.Wand.actionsFor(this.selected);
      if (!acts.length) return;
      const el = this.selected;                 // capture — actions run async
      const doc = this.doc;
      const menu = doc.createElement('div');
      menu.className = 've-wandmenu';
      acts.forEach(a => {
        const b = doc.createElement('button');
        b.innerHTML = `<span>${a.label}</span>` +
          `<span class="ve-wcost${a.cost === 'paid' ? ' paid' : ''}">${a.cost === 'paid' ? '🪙 صورة' : 'مجاني'}</span>`;
        b.addEventListener('click', () => { this._closeWandMenu(); window.Wand.run(a.id, el); });
        menu.appendChild(b);
      });
      menu.style.left = this.toolbar.style.left;
      menu.style.top = (parseFloat(this.toolbar.style.top) + 38) + 'px';
      doc.body.appendChild(menu);
      this._wandMenu = menu;
    }
    _closeWandMenu() {
      if (this._wandMenu) { this._wandMenu.remove(); this._wandMenu = null; }
    }

    // Stamp (or reuse) a stable data-ve-id so a wand proposal can anchor its
    // insert back to this exact element after DOM moves. Mirrors enrichTargets.
    ensureTargetId(el) {
      if (!el) return null;
      let id = el.getAttribute('data-ve-id');
      if (!id) { this._veId = (this._veId || 0) + 1; id = 'vw' + this._veId; el.setAttribute('data-ve-id', id); }
      return id;
    }
    // Index of the slide containing el, in slides() order (-1 if none).
    slideIndexOf(el) {
      const s = this._slideOf(el);
      return s ? this.slides().indexOf(s) : -1;
    }

    _applyColor(mode, c) {
      const el = this.selected;
      if (!el) return;
      if (el.tagName === 'HR') el.style.borderTopColor = c;
      else if (mode === 'color') el.style.color = c;
      else el.style.background = c;
      this._closePalette();
      this._pushHistory();
    }

    // ---------- tables ----------
    _tableOp(op) {
      const t = this.selected && this.selected.closest && this.selected.closest('table');
      if (!t || !t.rows.length) return;
      const rows = t.rows;
      if (op === 'rowadd') {
        const last = rows[rows.length - 1];
        const tr = last.cloneNode(true);
        Array.from(tr.cells).forEach(c => { c.textContent = ' '; });
        last.parentNode.insertBefore(tr, last.nextSibling);
      } else if (op === 'rowdel' && rows.length > 1) {
        rows[rows.length - 1].remove();
      } else if (op === 'coladd') {
        Array.from(rows).forEach(row => {
          const src = row.cells[row.cells.length - 1];
          const c = src.cloneNode(false);
          c.textContent = ' ';
          row.appendChild(c);
        });
      } else if (op === 'coldel') {
        Array.from(rows).forEach(row => {
          if (row.cells.length > 1) row.cells[row.cells.length - 1].remove();
        });
      }
      this._reposition();
      this._pushHistory();
    }

    // ---------- slides ----------
    _slideOf(el) {
      if (!el) return null;
      let n = el;
      while (n && n.parentElement && n.parentElement !== this.doc.body) n = n.parentElement;
      if (!n || n === this.doc.body || n.nodeType !== 1) return null;
      return n.offsetHeight > 150 ? n : null;
    }

    // All top-level "slide" blocks, in document order. Excludes only the
    // editor's own overlay UI — NOT slides that merely carry a ve- state
    // class like `ve-selected` (that mistake made selected slides invisible).
    slides() {
      return Array.from(this.doc.body.children).filter(el =>
        el.nodeType === 1 &&
        !el.matches('.ve-overlay, .ve-toolbar, .ve-insert-line, .ve-palette, .ve-wandmenu, .ve-guide, .ve-ghost') &&
        el.offsetHeight > 150 && el.offsetWidth > 200);
    }

    _cleanClone(el) {
      const c = el.cloneNode(true);
      c.querySelectorAll('.ve-selected').forEach(n => n.classList.remove('ve-selected'));
      c.querySelectorAll('.ve-editing').forEach(n => n.classList.remove('ve-editing'));
      c.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
      c.querySelectorAll('.ve-overlay, .ve-toolbar, .ve-insert-line, .ve-palette, .ve-wandmenu, .ve-guide, .ve-ghost').forEach(n => n.remove());
      c.querySelectorAll('.ve-ghost-hidden').forEach(n => n.classList.remove('ve-ghost-hidden'));
      return c;
    }

    duplicateSlide(ref) {
      const s = ref || this._slideOf(this.selected) || this.slides()[0];
      if (!s) return null;
      const c = this._cleanClone(s);
      s.after(c);
      this._pushHistory();
      this.select(c);
      this.onSlidesChanged && this.onSlidesChanged(c);
      return c;
    }

    // Add a blank slide: clone the reference slide (to inherit its exact
    // styling, dimensions and footer), then wipe its editable content.
    addSlide(ref) {
      const s = ref || this._slideOf(this.selected) || this.slides().slice(-1)[0];
      const isAr = (this.doc.documentElement.lang || '').toLowerCase().startsWith('ar')
        || this.doc.documentElement.dir === 'rtl';
      let c;
      if (s) {
        c = this._cleanClone(s);
        const content = c.querySelector('.content');
        if (content) {
          content.innerHTML = '';
          const p = this.doc.createElement('p');
          p.textContent = isAr ? 'اكتب المحتوى هنا…' : 'Type content here…';
          content.appendChild(p);
        }
        const h1 = c.querySelector('h1');
        if (h1) h1.textContent = isAr ? 'عنوان الشريحة الجديدة' : 'New slide title';
        const h2 = c.querySelector('h2');
        if (h2) h2.textContent = isAr ? 'العنوان الفرعي' : 'Subtitle';
        // Drop leftover images/tables from the cloned body of the slide.
        c.querySelectorAll('.content img, .content table, .ve-slot').forEach(n => n.remove());
        s.after(c);
      } else {
        // No detectable slide (plain document): append a simple section.
        c = this.doc.createElement('div');
        c.innerHTML = `<h2>${isAr ? 'عنوان جديد' : 'New heading'}</h2><p>${isAr ? 'نص…' : 'Text…'}</p>`;
        this.doc.body.appendChild(c);
      }
      this._pushHistory();
      this.select(c);
      this.onSlidesChanged && this.onSlidesChanged(c);
      return c;
    }

    deleteSlide(ref) {
      const s = ref || this._slideOf(this.selected);
      if (!s) return;
      const all = this.slides();
      const idx = all.indexOf(s);
      s.remove();
      this._deselect();
      this._pushHistory();
      const next = this.slides()[Math.max(0, idx - 1)];
      this.onSlidesChanged && this.onSlidesChanged(next || null);
    }

    // Reorder: move a slide to a new position. `targetIndex` is the desired
    // 0-based index among the OTHER slides (i.e. where it lands once itself is
    // taken out). Numbering everywhere derives from DOM order, so a single
    // DOM move is all it takes — the navigator and "Slide N / M" follow.
    moveSlide(slideEl, targetIndex) {
      const slides = this.slides();
      const from = slides.indexOf(slideEl);
      if (from < 0 || slides.length < 2) return;
      const rest = slides.filter(s => s !== slideEl);
      const to = Math.max(0, Math.min(rest.length, targetIndex));
      if (to === from) return;                 // already in place
      const ref = rest[to] || null;            // insert before this (null = end)
      if (ref) ref.before(slideEl);
      else rest[rest.length - 1].after(slideEl);
      this._pushHistory();
      this.onSlidesChanged && this.onSlidesChanged(slideEl);
    }

    // Merge <style>/<link rel=stylesheet> from an imported file into our <head>,
    // skipping any we already have (dedup by CSS text / href). Like the brand
    // theme, these live in <head> so getCleanHtml keeps them for save + export.
    _mergeImportedHead(headHtmlList, sourceName) {
      const holder = this.doc.createElement('div');
      for (const h of (headHtmlList || [])) {
        holder.innerHTML = h;
        const node = holder.firstElementChild;
        if (!node) continue;
        let dup = false;
        if (node.tagName === 'STYLE') {
          const txt = node.textContent.trim();
          dup = Array.from(this.doc.head.querySelectorAll('style'))
            .some(s => s.textContent.trim() === txt);
        } else if (node.tagName === 'LINK') {
          dup = Array.from(this.doc.head.querySelectorAll('link[rel~="stylesheet"]'))
            .some(l => l.href === node.href);
        }
        if (dup) continue;
        node.setAttribute('data-ve-import', sourceName || '1');
        this.doc.head.appendChild(node);
      }
    }

    // Merge slides from another lecture. `htmlList` = each slide's outerHTML
    // (image URLs already absolutized by the caller); inserted after
    // `afterSlide`, or appended if that's null. Returns the inserted elements.
    importSlides(htmlList, afterSlide, headHtmlList, sourceName) {
      if (!htmlList || !htmlList.length) return null;
      this._mergeImportedHead(headHtmlList, sourceName);
      const holder = this.doc.createElement('div');
      holder.innerHTML = htmlList.join('\n');
      const inserted = Array.from(holder.children);
      if (!inserted.length) return null;
      let anchor = afterSlide || this.slides().slice(-1)[0] || null;
      for (const node of inserted) {
        if (anchor) { anchor.after(node); anchor = node; }
        else { this.doc.body.appendChild(node); anchor = node; }
      }
      this._pushHistory();
      this.select(inserted[0]);
      this.onSlidesChanged && this.onSlidesChanged(inserted[0]);
      return inserted;
    }

    _reposition() {
      if (!this.selected || !this.overlay) return;
      const r = this.selected.getBoundingClientRect();
      const sx = this.win.scrollX, sy = this.win.scrollY;
      const left = r.left + sx, top = r.top + sy;
      Object.assign(this.overlay.style, {
        left: left + 'px', top: top + 'px',
        width: r.width + 'px', height: r.height + 'px'
      });
      const spots = {
        nw: [0, 0], n: [r.width / 2, 0], ne: [r.width, 0], e: [r.width, r.height / 2],
        se: [r.width, r.height], s: [r.width / 2, r.height], sw: [0, r.height], w: [0, r.height / 2]
      };
      for (const h of this.overlay.children) {
        const [x, y] = spots[h.dataset.pos] || [0, 0];
        h.style.left = x + 'px';
        h.style.top = y + 'px';
      }
      this.toolbar.style.left = left + 'px';
      this.toolbar.style.top = Math.max(0, top - 40) + 'px';
      this._closeWandMenu();   // avoid drift on scroll/resize; reopen from ✨
    }

    // ---------- resize ----------
    _startResize(e, pos) {
      e.preventDefault();
      e.stopPropagation();
      const img = this.selected;
      if (!img) return;
      const handle = e.currentTarget;
      const startX = e.clientX, startY = e.clientY;
      const r0 = img.getBoundingClientRect();
      const startW = r0.width, startH = r0.height;
      const kind = pos.length === 2 ? 'corner' : (pos === 'e' || pos === 'w') ? 'x' : 'y';
      const dirX = (pos === 'ne' || pos === 'se' || pos === 'e') ? 1 : -1;
      const dirY = (pos === 'se' || pos === 'sw' || pos === 's') ? 1 : -1;
      // Edge handles stretch one axis freely — freeze the other axis first
      // so the image fills exactly the space you pull it over.
      if (kind === 'x') img.style.height = Math.round(startH) + 'px';
      if (kind === 'y') img.style.width = Math.round(startW) + 'px';
      // Pointer capture: the handle keeps receiving moves even if the cursor
      // races ahead of it or leaves the page.
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}

      let done = false;
      const move = (ev) => {
        if (kind === 'corner') {
          const w = Math.max(40, startW + (ev.clientX - startX) * dirX);
          img.style.width = Math.round(w) + 'px';
          img.style.height = 'auto';
        } else if (kind === 'x') {
          const w = Math.max(40, startW + (ev.clientX - startX) * dirX);
          img.style.width = Math.round(w) + 'px';
        } else {
          const h = Math.max(30, startH + (ev.clientY - startY) * dirY);
          img.style.height = Math.round(h) + 'px';
        }
        this._reposition();
      };
      const up = () => {
        if (done) return;
        done = true;
        handle.removeEventListener('pointermove', move);
        this._pushHistory();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('lostpointercapture', up, { once: true });
    }

    // ---------- free-floating drag (move image anywhere on the slide) ----------
    // Pointer capture on the image, exactly like resize: the drag lives entirely
    // inside the iframe so screen deltas are already in the document's own coords
    // (no zoom math) and the parent window never steals the pointer.
    // An element that can be lifted into free positioning: anything selectable
    // that lives inside a slide — but never a whole top-level slide itself.
    _canFloat(unit) {
      if (!unit || unit === this.doc.body || unit.nodeType !== 1) return false;
      const slide = this._slideOf(unit);
      if (slide && slide === unit) return false;
      return true;
    }

    _startDrag(e) {
      if (e.button !== 0 || !this.selected) return;
      const el = this.selected;
      const unit = el.closest('.ve-slot') || el;
      if (!this._canFloat(unit)) return;
      e.preventDefault();
      e.stopPropagation();
      let slide = this._slideOf(unit);
      const allSlides = this.slides(); // cached: slide set is stable during a drag
      let startX = e.clientX, startY = e.clientY;
      const prevTouch = unit.style.touchAction;
      unit.style.touchAction = 'none';
      try { el.setPointerCapture(e.pointerId); } catch (_) {}

      let moved = false, base = null;
      const move = (ev) => {
        let dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        if (!moved) { moved = true; base = this._floatUnit(unit, slide); }
        // Cross-slide: if the cursor crossed into another slide, re-home the
        // unit there and re-anchor at its current on-screen spot (no jump).
        const over = this._slideAtPoint(ev.clientX, ev.clientY, allSlides);
        if (over && over !== slide && over !== unit && !over.contains(unit)) {
          const rect = unit.getBoundingClientRect();
          const cs = this.win.getComputedStyle(over);
          if (cs.position === 'static') over.style.position = 'relative';
          over.appendChild(unit);
          slide = over;
          base = this._floatUnit(unit, slide, rect);
          startX = ev.clientX; startY = ev.clientY;
          dx = 0; dy = 0;
        }
        // Snap in client space (1:1 with style left/top since nothing between
        // the unit and its offset parent is transformed), then map back.
        const snap = this._applySnap(unit, slide, base.clientLeft + dx, base.clientTop + dy, base.w, base.h);
        unit.style.left = Math.round(base.styleLeft + (snap.left - base.clientLeft)) + 'px';
        unit.style.top = Math.round(base.styleTop + (snap.top - base.clientTop)) + 'px';
        this._reposition();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        unit.style.touchAction = prevTouch;
        this._clearGuides();
        if (moved) {
          // Swallow the click that fires on pointerup so it doesn't re-run
          // selection logic; clear the flag next tick if no click arrives.
          this._justDragged = true;
          this.win.setTimeout(() => { this._justDragged = false; }, 0);
          this._pushHistory();
          // Rebuild the overlay so the toolbar now offers Front/Back layering.
          this.select(el);
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up, { once: true });
      el.addEventListener('lostpointercapture', up, { once: true });
    }

    // Find the top-level slide whose box contains a client point (for
    // cross-slide dragging). Null if the cursor is in the gap between slides.
    _slideAtPoint(cx, cy, list) {
      for (const s of (list || this.slides())) {
        const r = s.getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return s;
      }
      return null;
    }

    // Lift a unit (the .ve-slot figure, or a bare img) out of the document flow
    // into absolute positioning within its slide. Returns the starting client
    // rect + the style left/top we assigned, so the drag can map deltas back.
    // `preRect` (optional) is the on-screen rect to anchor to — used when
    // re-homing into another slide, read BEFORE the re-parent so there's no jump.
    _floatUnit(unit, slide, preRect) {
      const ur = preRect || unit.getBoundingClientRect();
      if (!unit.style.width) unit.style.width = Math.round(ur.width) + 'px';
      unit.style.margin = '0';
      unit.style.position = 'absolute';
      unit.dataset.veFloat = '1';
      // Make the slide the positioning context so coords stay slide-local and
      // survive PDF export (slides are fixed-size body children).
      if (slide) {
        const cs = this.win.getComputedStyle(slide);
        if (cs.position === 'static') slide.style.position = 'relative';
      }
      const parent = unit.offsetParent || slide || this.doc.body;
      const pr = parent.getBoundingClientRect();
      const styleLeft = ur.left - pr.left - parent.clientLeft + parent.scrollLeft;
      const styleTop = ur.top - pr.top - parent.clientTop + parent.scrollTop;
      unit.style.left = Math.round(styleLeft) + 'px';
      unit.style.top = Math.round(styleTop) + 'px';
      // Baseline layer: above the slide's content, never behind its background.
      if (!unit.style.zIndex) unit.style.zIndex = '1';
      return { styleLeft, styleTop, clientLeft: ur.left, clientTop: ur.top, w: ur.width, h: ur.height };
    }

    // Given a proposed client-space top-left, snap the unit's edges/centers to
    // the slide's edges/center and to sibling elements, drawing pink guides for
    // whichever axis snapped. Returns the (possibly nudged) client top-left.
    _applySnap(unit, slide, cl, ct, w, h) {
      this._clearGuides();
      const TH = 6;
      const vx = [], hy = [];
      const sibs = [];
      if (slide) {
        const sr = slide.getBoundingClientRect();
        vx.push(sr.left, sr.left + sr.width / 2, sr.right);
        hy.push(sr.top, sr.top + sr.height / 2, sr.bottom);
        for (const sib of this._snapSiblings(slide, unit)) {
          const r = sib.getBoundingClientRect();
          sibs.push(r);
          vx.push(r.left, r.left + r.width / 2, r.right);
          hy.push(r.top, r.top + r.height / 2, r.bottom);
        }
      }
      const ax = [cl, cl + w / 2, cl + w];
      const ay = [ct, ct + h / 2, ct + h];
      const pick = (anchors, lines) => {
        let best = null;
        for (const a of anchors) for (const line of lines) {
          const d = line - a;
          if (Math.abs(d) <= TH && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line };
        }
        return best;
      };
      const bx = pick(ax, vx), by = pick(ay, hy);
      let outLeft = cl + (bx ? bx.d : 0);
      let outTop = ct + (by ? by.d : 0);
      if (bx) this._drawGuide('v', bx.line, slide);
      if (by) this._drawGuide('h', by.line, slide);
      // Equal-spacing (distribution): if an axis didn't already edge-snap, try
      // centering the unit between its two flanking neighbors so the gaps match.
      const dist = this._distSnap(sibs, cl, ct, w, h, TH);
      if (!bx && dist.x) { outLeft = dist.x.left; this._drawSpacingX(dist.x, outLeft, outTop, w, h); }
      if (!by && dist.y) { outTop = dist.y.top; this._drawSpacingY(dist.y, outLeft, outTop, w, h); }
      return { left: outLeft, top: outTop };
    }

    // Equal-gap snap: find the nearest neighbour on each side (that shares the
    // unit's row/column) and, if the unit is close to the midpoint between
    // them, snap so the two gaps are equal — like Figma's spacing guides.
    _distSnap(sibs, cl, ct, w, h, TH) {
      const out = { x: null, y: null };
      const uT = ct, uB = ct + h, uL = cl, uR = cl + w;
      // Horizontal: the closest neighbour lying ENTIRELY on each side of the
      // unit while sharing its row (vertical overlap). Overlapping full-width
      // blocks are ignored so they don't hijack the gap.
      let L = null, R = null;
      sibs.forEach(r => {
        if (r.top >= uB || r.bottom <= uT) return;        // not on this row
        if (r.right <= uL) { if (!L || r.right > L.right) L = r; }       // fully left
        else if (r.left >= uR) { if (!R || r.left < R.left) R = r; }     // fully right
      });
      if (L && R && R.left - L.right > w) {
        const target = (L.right + R.left - w) / 2;
        if (Math.abs(cl - target) <= TH) out.x = { left: target, L, R };
      }
      // Vertical: the closest neighbour entirely above/below sharing the column.
      let T = null, B = null;
      sibs.forEach(r => {
        if (r.left >= uR || r.right <= uL) return;         // not in this column
        if (r.bottom <= uT) { if (!T || r.bottom > T.bottom) T = r; }    // fully above
        else if (r.top >= uB) { if (!B || r.top < B.top) B = r; }        // fully below
      });
      if (T && B && B.top - T.bottom > h) {
        const target = (T.bottom + B.top - h) / 2;
        if (Math.abs(ct - target) <= TH) out.y = { top: target, T, B };
      }
      return out;
    }

    // Two pink bars marking the (now equal) horizontal gaps on either side.
    _drawSpacingX(info, left, top, w, h) {
      const cy = top + h / 2;
      this._guideSeg(info.L.right, cy - 1, left - info.L.right, 2);
      this._guideSeg(left + w, cy - 1, info.R.left - (left + w), 2);
    }
    _drawSpacingY(info, left, top, w, h) {
      const cx = left + w / 2;
      this._guideSeg(cx - 1, info.T.bottom, 2, top - info.T.bottom);
      this._guideSeg(cx - 1, top + h, 2, info.B.top - (top + h));
    }

    _guideSeg(clientX, clientY, w, h) {
      const g = this.doc.createElement('div');
      g.className = 've-guide';
      g.style.left = (clientX + this.win.scrollX) + 'px';
      g.style.top = (clientY + this.win.scrollY) + 'px';
      g.style.width = Math.max(1, w) + 'px';
      g.style.height = Math.max(1, h) + 'px';
      this.doc.body.appendChild(g);
      (this._guides || (this._guides = [])).push(g);
    }

    // Elements worth aligning to: the slide's direct children and its
    // .content's children, minus the dragged unit and editor chrome.
    _snapSiblings(slide, unit) {
      const out = [];
      const collect = (parent) => {
        if (!parent) return;
        for (const c of parent.children) {
          if (c === unit || c.contains(unit)) continue;
          if (c.matches && c.matches('.ve-overlay, .ve-toolbar, .ve-insert-line, .ve-guide, .ve-palette, .ve-wandmenu, style, script')) continue;
          const r = c.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          out.push(c);
        }
      };
      collect(slide);
      collect(slide.querySelector('.content'));
      return out;
    }

    _drawGuide(kind, clientPos, slide) {
      const g = this.doc.createElement('div');
      g.className = 've-guide ' + kind;
      const sx = this.win.scrollX, sy = this.win.scrollY;
      const sr = slide
        ? slide.getBoundingClientRect()
        : { top: -sy, left: -sx, width: this.doc.body.scrollWidth, height: this.doc.body.scrollHeight };
      if (kind === 'v') {
        g.style.left = (clientPos + sx) + 'px';
        g.style.top = (sr.top + sy) + 'px';
        g.style.height = sr.height + 'px';
      } else {
        g.style.top = (clientPos + sy) + 'px';
        g.style.left = (sr.left + sx) + 'px';
        g.style.width = sr.width + 'px';
      }
      this.doc.body.appendChild(g);
      (this._guides || (this._guides = [])).push(g);
    }

    _clearGuides() {
      if (this._guides) this._guides.forEach(g => g.remove());
      this._guides = [];
    }

    // Arrow-key nudge for a selected image. Floats it on first nudge, then
    // shifts left/top. History is debounced so a burst of key presses collapses
    // into one undo step.
    _nudge(dx, dy) {
      const el = this.selected;
      if (!el) return;
      const unit = el.closest('.ve-slot') || el;
      if (!this._canFloat(unit)) return;
      if (unit.dataset.veFloat !== '1') this._floatUnit(unit, this._slideOf(unit));
      unit.style.left = Math.round((parseFloat(unit.style.left) || 0) + dx) + 'px';
      unit.style.top = Math.round((parseFloat(unit.style.top) || 0) + dy) + 'px';
      this._reposition();
      this.win.clearTimeout(this._nudgeTimer);
      this._nudgeTimer = this.win.setTimeout(() => this._pushHistory(), 400);
    }

    // Layer a floated image above/below the other floated images in its slide.
    // Z stays >= 1 so an image is never pushed behind the slide's background.
    _zorder(dir) {
      const img = this.selected;
      if (!img) return;
      const unit = img.closest('.ve-slot') || img;
      if (unit.dataset.veFloat !== '1') this._floatUnit(unit, this._slideOf(unit));
      const scope = this._slideOf(unit) || this.doc.body;
      const units = Array.from(scope.querySelectorAll('[data-ve-float="1"]'));
      const zOf = (u) => parseInt(u.style.zIndex, 10) || 1;
      if (dir === 'front') {
        const max = Math.max(1, ...units.map(zOf));
        unit.style.zIndex = String(max + 1);
      } else {
        const others = units.filter(u => u !== unit);
        const minOther = others.length ? Math.min(...others.map(zOf)) : 1;
        if (minOther <= 1) {
          // No room below: lift everyone else up one and drop this to the floor.
          others.forEach(u => { u.style.zIndex = String(zOf(u) + 1); });
          unit.style.zIndex = '1';
        } else {
          unit.style.zIndex = String(minOther - 1);
        }
      }
      this._pushHistory();
    }

    align(dir) {
      if (!this.selected) return;
      const slot = this.selected.closest('.ve-slot');
      if (slot) {
        slot.classList.remove('ve-align-left','ve-align-right');
        if (dir === 'left') slot.classList.add('ve-align-left');
        else if (dir === 'right') slot.classList.add('ve-align-right');
      }
      this._reposition();
      this._pushHistory();
    }

    deleteSelected() {
      if (!this.selected) return;
      const slot = this.selected.closest('.ve-slot') || this.selected;
      slot.remove();
      this._deselect();
      this._pushHistory();
    }

    replaceSelected(url) {
      if (!this.selected) return;
      this.selected.src = url;
      this._reposition();
      this._pushHistory();
    }

    // ---------- drag-to-insert ----------
    // Called from renderer during a panel drag. Coordinates are in iframe-document space.
    showInsertAt(docX, docY) {
      const target = this._findInsertTarget(docX, docY);
      if (!target) { this._hideInsert(); return; }
      if (!this.insertLine) {
        this.insertLine = this.doc.createElement('div');
        this.insertLine.className = 've-insert-line';
        this.doc.body.appendChild(this.insertLine);
      }
      const { el, before, replace } = target;
      const r = el.getBoundingClientRect();
      const sx = this.win.scrollX, sy = this.win.scrollY;
      if (replace) {
        // Highlight the whole placeholder — the image will take its place.
        Object.assign(this.insertLine.style, {
          left: (r.left + sx) + 'px', top: (r.top + sy) + 'px',
          width: r.width + 'px', height: r.height + 'px',
          background: 'rgba(47,109,246,.18)', border: '2px solid #2f6df6',
          borderRadius: '8px', boxShadow: 'none'
        });
      } else {
        const y = (before ? r.top : r.bottom) + sy;
        Object.assign(this.insertLine.style, {
          left: (r.left + sx) + 'px', top: (y - 1.5) + 'px',
          width: r.width + 'px', height: '3px',
          background: '#2f6df6', border: 'none', borderRadius: '2px',
          boxShadow: '0 0 6px rgba(47,109,246,.6)'
        });
      }
      this._pendingTarget = target;
    }

    _hideInsert() {
      if (this.insertLine) { this.insertLine.remove(); this.insertLine = null; }
      this._pendingTarget = null;
    }

    _findInsertTarget(docX, docY) {
      const win = this.win;
      const clientX = docX - win.scrollX;
      const clientY = docY - win.scrollY;
      let node = this.doc.elementFromPoint(clientX, clientY);
      // Dropping onto a reserved image placeholder replaces it entirely.
      if (node && node.closest) {
        const ph = node.closest('[class*="placeholder"]');
        if (ph && ph !== this.doc.body) return { el: ph, replace: true };
      }
      if (!node) {
        // Below all content — insert after last block child.
        const kids = Array.from(this.doc.body.children).filter(n => this._isBlock(n));
        const last = kids[kids.length - 1];
        return last ? { el: last, before: false } : null;
      }
      // Climb to a direct-ish block element.
      let el = node;
      while (el && el !== this.doc.body && !this._isBlock(el)) el = el.parentElement;
      if (!el || el === this.doc.body) {
        const kids = Array.from(this.doc.body.children).filter(n => this._isBlock(n));
        const last = kids[kids.length - 1];
        return last ? { el: last, before: false } : null;
      }
      const r = el.getBoundingClientRect();
      const before = clientY < r.top + r.height / 2;
      return { el, before };
    }

    _isBlock(el) {
      return el.nodeType === 1 && BLOCK_TAGS.has(el.tagName) && !el.closest('.ve-overlay, .ve-toolbar, .ve-guide');
    }

    dropInsert(url, name) {
      const t = this._pendingTarget;
      const slot = this.doc.createElement('figure');
      slot.className = 've-slot';
      const img = this.doc.createElement('img');
      img.src = url;
      if (name) img.alt = name;
      slot.appendChild(img);

      if (t && t.replace) {
        // Fill the reserved space exactly; the user can stretch from there.
        const r = t.el.getBoundingClientRect();
        img.style.width = Math.round(r.width) + 'px';
        img.style.height = Math.round(r.height) + 'px';
        slot.style.margin = '0';
        t.el.parentElement.insertBefore(slot, t.el);
        t.el.remove();
      } else if (t) {
        if (t.before) t.el.parentElement.insertBefore(slot, t.el);
        else t.el.parentElement.insertBefore(slot, t.el.nextSibling);
      } else {
        this.doc.body.appendChild(slot);
      }
      this._hideInsert();
      this._pushHistory();
      // Auto-select the new image once it loads for immediate resizing.
      img.addEventListener('load', () => this.select(img), { once: true });
      // Fallback if already cached.
      if (img.complete) this.select(img);
    }

    // Insert an image without dragging: drop it into the given slide's content
    // area (or the slide itself, or the body). Used by double-clicking a panel
    // tile — friendlier than the cross-iframe drag.
    insertImageInto(url, name, slide) {
      const container = (slide && slide.querySelector('.content')) || slide || this.doc.body;
      const slot = this.doc.createElement('figure');
      slot.className = 've-slot';
      const img = this.doc.createElement('img');
      img.src = url;
      if (name) img.alt = name;
      slot.appendChild(img);
      container.appendChild(slot);
      this._pushHistory();
      img.addEventListener('load', () => this.select(img), { once: true });
      if (img.complete) this.select(img);
      return img;
    }

    // ---------- theme kits (MiM preset + customer-brought brands) ----------
    // A "theme kit" is one managed <style id="ve-theme" data-kit="name"> in
    // <head> holding @font-face (fonts as data: URLs) + a :root palette
    // override. It survives undo/redo and is carried into save + PDF export by
    // getCleanHtml (which never strips <head>). Only one kit is active at a
    // time; MiM is just the built-in preset built on this same machinery.
    //   kit = { name, fonts:[{family,weight,style,b64,ext}], vars:{'--x':'#..'} }
    //         (or varsCss for a raw :root{} block, used by the MiM preset)
    hasBrandTheme() {
      const s = this.doc && this.doc.getElementById('ve-theme');
      return !!(s && s.dataset.kit === 'MiM');
    }
    activeThemeKit() {
      const s = this.doc && this.doc.getElementById('ve-theme');
      return s ? (s.dataset.kit || 'custom') : null;
    }

    _fontFace(f) {
      if (!f || !f.b64 || !f.family) return '';
      const ext = (f.ext || 'otf').toLowerCase();
      const fmt = ext === 'ttf' ? 'truetype' : ext === 'woff2' ? 'woff2' : ext === 'woff' ? 'woff' : 'opentype';
      const mime = ext === 'ttf' ? 'font/ttf' : ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : 'font/otf';
      return `@font-face{font-family:'${String(f.family).replace(/'/g, '')}';` +
        `font-weight:${f.weight || 400};font-style:${f.style || 'normal'};font-display:swap;` +
        `src:url(data:${mime};base64,${f.b64}) format('${fmt}');}`;
    }
    _varsToCss(vars) {
      if (!vars) return '';
      const decls = Object.keys(vars).map(k => `${k}:${vars[k]};`).join('');
      return decls ? `:root{${decls}}` : '';
    }

    applyThemeKit(kit) {
      if (!this.doc || !kit) return;
      const faces = (kit.fonts || []).map(f => this._fontFace(f)).filter(Boolean).join('\n');
      const varsCss = kit.varsCss != null ? kit.varsCss : this._varsToCss(kit.vars);
      let style = this.doc.getElementById('ve-theme');
      if (!style) { style = this.doc.createElement('style'); style.id = 've-theme'; }
      style.dataset.kit = kit.name || 'custom';
      // Append last so its :root wins over the lecture's own :root.
      style.textContent = faces + '\n' + varsCss;
      this.doc.head.appendChild(style);
      this._reflowAfterFonts();
    }
    removeThemeKit() {
      const style = this.doc && this.doc.getElementById('ve-theme');
      if (style) style.remove();
      this._reflowAfterFonts();
    }

    // MiM preset — a one-click shortcut layered on the general kit system.
    // `fonts` = [{ name:'diodrum-bold', b64:'…' }] read from src/fonts by main.
    applyBrandTheme(rawFonts) {
      const fonts = [];
      for (const f of (rawFonts || [])) {
        const spec = BRAND_FONTS[f.name];
        if (!spec || !f.b64) continue;
        for (const fam of [spec.fam, ...(FONT_ALIASES[spec.fam] || [])]) {
          fonts.push({ family: fam, weight: spec.weight, style: 'normal', b64: f.b64, ext: 'otf' });
        }
      }
      this.applyThemeKit({ name: 'MiM', fonts, varsCss: BRAND_PALETTE_CSS });
    }
    removeBrandTheme() { this.removeThemeKit(); }

    // The CSS custom properties the loaded lecture declares (name + effective
    // value). This is what a customer recolors — it works for ANY variable-based
    // template without the app knowing the variable names in advance.
    detectVars() {
      const seen = new Map();
      for (const sheet of this.doc.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
        for (const rule of rules || []) {
          if (!rule.style || !rule.selectorText) continue;
          const sel = rule.selectorText;
          if (!/:root/.test(sel) && sel !== 'html' && sel !== 'body') continue;
          for (const name of rule.style) {
            if (name.startsWith('--')) {
              const v = rule.style.getPropertyValue(name).trim();
              if (v && !seen.has(name)) seen.set(name, v);
            }
          }
        }
      }
      const root = this.win.getComputedStyle(this.doc.documentElement);
      const out = [];
      for (const [name, declared] of seen) {
        const eff = (root.getPropertyValue(name).trim()) || declared;
        out.push({ name, value: eff, declared });
      }
      return out;
    }

    // Font families the lecture references — offered as alias targets so a
    // customer can map "render this family with MY uploaded font".
    detectFontFamilies() {
      const fams = new Set();
      const add = (v) => {
        if (!v) return;
        v.split(',').forEach(part => {
          const f = part.trim().replace(/^['"]|['"]$/g, '');
          if (f && !/^(inherit|initial|unset|sans-serif|serif|monospace|system-ui|-apple-system|cursive|fantasy)$/i.test(f)) fams.add(f);
        });
      };
      for (const sheet of this.doc.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
        for (const rule of rules || []) {
          if (rule.style && rule.style.fontFamily) add(rule.style.fontFamily);
        }
      }
      this.doc.querySelectorAll('[style*="font-family"]').forEach(el => add(el.style.fontFamily));
      return [...fams].slice(0, 24);
    }

    // Swapping fonts changes text metrics; re-measure once they're ready so the
    // iframe height (and zoom fit) stays correct.
    _reflowAfterFonts() {
      this._sizeToContent();
      this._reposition();
      try {
        if (this.doc.fonts && this.doc.fonts.ready) {
          this.doc.fonts.ready.then(() => { this._sizeToContent(); this._reposition(); });
        }
      } catch (_) {}
    }

    // ---------- enrichment (auto-generated charts / diagrams / images) --------
    _isRtl() {
      return (this.doc.documentElement.lang || '').toLowerCase().startsWith('ar')
        || this.doc.documentElement.dir === 'rtl'
        || this.win.getComputedStyle(this.doc.body).direction === 'rtl';
    }

    // Everything a generator needs to stay on-brand: the lecture's palette
    // (resolved values), text direction, and a font stack that matches the deck.
    themeContext() {
      const rtl = this._isRtl();
      // Resolve --var values to concrete colors so generated SVG is self-contained.
      const root = this.win.getComputedStyle(this.doc.documentElement);
      const named = ['--purple', '--cyan', '--gold', '--pink', '--dark'];
      const resolved = named
        .map(n => root.getPropertyValue(n).trim())
        .filter(v => /^#|^rgb|^hsl/i.test(v));
      const palette = [...new Set(resolved.length ? resolved : this.themeColors())];
      const bodyFont = this.win.getComputedStyle(this.doc.body).fontFamily;
      return {
        rtl,
        palette,
        fontFamily: bodyFont || "'Diodrum Arabic','Cairo',sans-serif"
      };
    }

    // A compact per-slide summary for the AI analysis pass. Text only — no HTML.
    slidesDigest() {
      return this.slides().map((s, i) => {
        const h1 = (s.querySelector('h1') || {}).textContent || '';
        const h2 = (s.querySelector('h2') || {}).textContent || '';
        const content = s.querySelector('.content') || s;
        const text = content.textContent.replace(/\s+/g, ' ').trim().slice(0, 700);
        const placeholders = Array.from(s.querySelectorAll('[class*="placeholder"]')).map(p => ({
          text: p.textContent.replace(/\s+/g, ' ').trim().slice(0, 220),
          hasImg: !!p.querySelector('img')
        }));
        const tables = s.querySelectorAll('table').length;
        return { i, h1: h1.trim(), h2: h2.trim(), text, placeholders, tables };
      });
    }

    // Live enrichment candidates with real element references, so results can be
    // applied back to the exact spot. Placeholders = image/diagram slots; tables
    // = chart sources. A stable data-ve-id is stamped on each so the review
    // drawer can address them.
    enrichTargets() {
      const out = [];
      let n = 0;
      this.slides().forEach((s, i) => {
        s.querySelectorAll('[class*="placeholder"]').forEach(ph => {
          if (!ph.getAttribute('data-ve-id')) ph.setAttribute('data-ve-id', 've' + (++n));
          out.push({
            id: ph.getAttribute('data-ve-id'), kind: 'placeholder', el: ph,
            slideEl: s, slideIndex: i,
            text: ph.textContent.replace(/\s+/g, ' ').trim(),
            hasImg: !!ph.querySelector('img'),
            done: ph.getAttribute('data-ve-done') === '1',
            rect: { w: ph.offsetWidth || 0, h: ph.offsetHeight || 0 }
          });
        });
        s.querySelectorAll('table').forEach(tb => {
          if (tb.closest('[data-ve-figlist]')) return;   // the references table itself
          if (!tb.getAttribute('data-ve-id')) tb.setAttribute('data-ve-id', 've' + (++n));
          out.push({
            id: tb.getAttribute('data-ve-id'), kind: 'table', el: tb,
            slideEl: s, slideIndex: i,
            done: tb.getAttribute('data-ve-done') === '1'
          });
        });
      });
      return out;
    }

    // Find a live target element again from its data-ve-id (survives DOM moves).
    targetById(id) {
      return this.doc.querySelector('[data-ve-id="' + CSS.escape(id) + '"]');
    }

    // Drop a generated visual into the document. `html` is an <svg>…</svg> or an
    // <img>. It is wrapped in the same figure.ve-slot images use, so it inherits
    // drag / align / layer / delete for free, and tagged data-ve-generated.
    //   target: { mode:'replace'|'after'|'append', el?, slideEl?, kind? }
    //   extra:  { caption } — a caption makes it a NUMBERED figure («شكل N — …»)
    //           that participates in auto-renumbering and the references slide.
    insertGenerated(html, target = {}, extra = {}) {
      const tmp = this.doc.createElement('div');
      tmp.innerHTML = String(html).trim();
      const node = tmp.firstElementChild;
      if (!node) return null;
      if (node.tagName.toLowerCase() === 'svg') {
        node.style.maxWidth = '100%';
        node.style.height = 'auto';
        node.removeAttribute('width');   // let it scale to the slot
      }
      const fig = this.doc.createElement('figure');
      fig.className = 've-slot';
      fig.setAttribute('data-ve-generated', target.kind || 'visual');
      // Tie the figure back to its Studio proposal so it can be regenerated,
      // retyped or removed later (not a one-shot insert).
      if (target.propId) fig.setAttribute('data-ve-prop', target.propId);
      fig.appendChild(node);
      if (extra.caption) {
        fig.setAttribute('data-ve-figure', '');
        fig.setAttribute('data-ve-caption', extra.caption);
        const cap = this.doc.createElement('figcaption');
        fig.appendChild(cap);   // text filled by renumberFigures below
      }

      if (target.mode === 'replace' && target.el) {
        target.el.parentElement.insertBefore(fig, target.el);
        target.el.remove();
      } else if (target.mode === 'after' && target.el) {
        target.el.parentElement.insertBefore(fig, target.el.nextSibling);
      } else {
        // Append into a slide (whole-lecture "inside the slide" placement).
        // Slides are fixed-height with overflow hidden, so cap the visual and
        // let the user resize/move it rather than let it blow past the edge.
        if (target.mode === 'append') {
          const vis = fig.querySelector('img, svg');
          if (vis) vis.style.maxHeight = (target.maxHeight || 260) + 'px';
        }
        const c = (target.slideEl && target.slideEl.querySelector('.content')) || target.slideEl || this.doc.body;
        c.appendChild(fig);
      }
      this._pushHistory();
      const inner = fig.querySelector('img, svg') || node;
      if (inner.tagName === 'IMG' && !inner.complete) {
        inner.addEventListener('load', () => { this._sizeToContent(); this.select(inner); }, { once: true });
      } else {
        this._sizeToContent();
        this.select(inner);
      }
      this.onSlidesChanged && this.onSlidesChanged(null);
      return inner;
    }

    // The already-inserted figure element for a Studio proposal (or null).
    figureByProp(propId) {
      return propId ? this.doc.querySelector('figure[data-ve-prop="' + CSS.escape(propId) + '"]') : null;
    }

    // Swap an inserted figure's visual IN PLACE — keeps its position, size and
    // any drag/float the user applied. Used to regenerate / retype without
    // losing where the figure sits. Returns the new inner element.
    replaceFigureContent(propId, html, caption, kind) {
      const fig = this.figureByProp(propId);
      if (!fig) return null;
      const tmp = this.doc.createElement('div');
      tmp.innerHTML = String(html).trim();
      const node = tmp.firstElementChild;
      if (!node) return null;
      if (node.tagName.toLowerCase() === 'svg') {
        node.style.maxWidth = '100%';
        node.style.height = 'auto';
        node.removeAttribute('width');
      }
      const oldVis = fig.querySelector(':scope > img, :scope > svg');
      if (oldVis) oldVis.replaceWith(node);
      else fig.insertBefore(node, fig.firstChild);
      if (kind) fig.setAttribute('data-ve-generated', kind);   // keep source label right after a retype
      if (caption != null) this._setFigureCaptionEl(fig, caption);
      this._pushHistory();
      const inner = fig.querySelector('img, svg') || node;
      if (inner.tagName === 'IMG' && !inner.complete) {
        inner.addEventListener('load', () => { this._sizeToContent(); this.select(inner); }, { once: true });
      } else { this._sizeToContent(); this.select(inner); }
      this.onSlidesChanged && this.onSlidesChanged(null);
      return inner;
    }

    // Remove an inserted figure from the document (undo of an insert).
    removeFigure(propId) {
      const fig = this.figureByProp(propId);
      if (!fig) return false;
      if (this.selected && fig.contains(this.selected)) this._deselect();
      fig.remove();
      this._pushHistory();
      this.onSlidesChanged && this.onSlidesChanged(null);
      return true;
    }

    _setFigureCaptionEl(fig, caption) {
      if (caption) {
        fig.setAttribute('data-ve-figure', '');
        fig.setAttribute('data-ve-caption', caption);
        if (!fig.querySelector('figcaption')) fig.appendChild(this.doc.createElement('figcaption'));
      } else {
        fig.removeAttribute('data-ve-figure');
        fig.removeAttribute('data-ve-caption');
        const cap = fig.querySelector('figcaption');
        if (cap) cap.remove();
      }
    }

    // Live-edit an inserted figure's caption (renumbers «شكل N» across the deck).
    setFigureCaption(propId, caption) {
      const fig = this.figureByProp(propId);
      if (!fig) return false;
      this._setFigureCaptionEl(fig, caption);
      this._pushHistory();
      return true;
    }

    // Build a figure.ve-slot wrapper (shared by the insert paths).
    _makeFigure(html, o = {}) {
      const tmp = this.doc.createElement('div');
      tmp.innerHTML = String(html).trim();
      const node = tmp.firstElementChild;
      if (!node) return null;
      if (node.tagName.toLowerCase() === 'svg') {
        node.style.maxWidth = '100%';
        node.style.height = 'auto';
        node.removeAttribute('width');
      }
      const fig = this.doc.createElement('figure');
      fig.className = 've-slot';
      fig.setAttribute('data-ve-generated', o.kind || 'visual');
      if (o.propId) fig.setAttribute('data-ve-prop', o.propId);
      fig.appendChild(node);
      if (o.caption) {
        fig.setAttribute('data-ve-figure', '');
        fig.setAttribute('data-ve-caption', o.caption);
        fig.appendChild(this.doc.createElement('figcaption'));
      }
      return fig;
    }

    // Whole-lecture review "new slide" placement: a fresh slide holding just the
    // generated figure, inserted right after its source slide. Clones the source
    // slide's chrome (border, footer, fonts) so it's on-brand, then wipes the
    // content. Marked data-ve-propslide so it can be regenerated/removed later.
    insertGeneratedAsNewSlide(html, afterSlideEl, extra = {}) {
      const fig = this._makeFigure(html, extra);
      if (!fig) return null;
      const ref = afterSlideEl || this.slides().slice(-1)[0];
      let slide;
      if (ref) {
        slide = this._cleanClone(ref);
        slide.querySelectorAll('.content img, .content table, .ve-slot, [data-ve-figure], [data-ve-generated]').forEach(n => n.remove());
        slide.querySelectorAll('[data-ve-id], [data-ve-prop], [data-ve-done], [data-ve-propslide]').forEach(n => {
          n.removeAttribute('data-ve-id'); n.removeAttribute('data-ve-prop');
          n.removeAttribute('data-ve-done'); n.removeAttribute('data-ve-propslide');
        });
        const h2 = slide.querySelector('h2');
        if (h2 && extra.caption) h2.textContent = extra.caption;
        const content = slide.querySelector('.content') || slide;
        content.innerHTML = '';
        content.appendChild(fig);
        ref.after(slide);
      } else {
        slide = this.doc.createElement('div');
        slide.appendChild(fig);
        this.doc.body.appendChild(slide);
      }
      if (extra.propId) slide.setAttribute('data-ve-propslide', extra.propId);
      this._pushHistory();
      const inner = fig.querySelector('img, svg');
      if (inner && inner.tagName === 'IMG' && !inner.complete) {
        inner.addEventListener('load', () => { this._sizeToContent(); this.select(inner); }, { once: true });
      } else { this._sizeToContent(); if (inner) this.select(inner); }
      this.onSlidesChanged && this.onSlidesChanged(slide);
      return inner;
    }

    // The new slide created for a "new slide" extra (or null).
    generatedSlideByProp(propId) {
      return propId ? this.doc.querySelector('[data-ve-propslide="' + CSS.escape(propId) + '"]') : null;
    }

    // Anchor a whole-lecture "extra" to its SOURCE slide by element, not index —
    // so inserting/removing other slides never makes it target the wrong slide.
    // data-ve-src is a space-separated token list ([~=] matches one token).
    markSourceSlide(slideEl, propId) {
      if (!slideEl || !propId) return;
      const toks = (slideEl.getAttribute('data-ve-src') || '').split(/\s+/).filter(Boolean);
      if (!toks.includes(propId)) toks.push(propId);
      slideEl.setAttribute('data-ve-src', toks.join(' '));
    }
    sourceSlideByProp(propId) {
      return propId ? this.doc.querySelector('[data-ve-src~="' + propId + '"]') : null;
    }

    // Speaker notes — invisible per-slide text (Studio only). Never rendered
    // into the slide body, never printed/exported visibly; stored as a plain
    // attribute so it survives clone/save like any other data-ve-*.
    setSpeakerNotes(slideEl, text) {
      if (!slideEl) return;
      const t = (text || '').trim();
      if (t) slideEl.setAttribute('data-ve-notes', t);
      else slideEl.removeAttribute('data-ve-notes');
      this._pushHistory();
    }
    getSpeakerNotes(slideEl) {
      return (slideEl && slideEl.getAttribute('data-ve-notes')) || '';
    }
    removeGeneratedSlide(propId) {
      const slide = this.generatedSlideByProp(propId);
      if (!slide) return false;
      if (this.selected && slide.contains(this.selected)) this._deselect();
      slide.remove();
      this._pushHistory();
      this.onSlidesChanged && this.onSlidesChanged(null);
      return true;
    }

    // ---------- Studio ghost previews ----------
    // A ghost is a live, in-place PREVIEW of a generated visual: a real figure
    // (or a real new slide) dropped into the document exactly where an insert
    // would land — so what the user previews IS what they get. It is tagged
    // .ve-ghost so it is stripped from every history snapshot, save and export,
    // is never numbered as a «شكل», and cannot be clicked/dragged. At most one
    // ghost exists at a time. Apply performs the real insert (§pipeline.insert);
    // discard just clears the ghost. Returns the ghost element for scroll-into-view.
    //   g: { html, mode:'replace'|'after'|'append'|'newslide', el?, slideEl?,
    //        afterSlideEl?, kind?, caption?, maxHeight? }
    showGhost(g = {}) {
      this.clearGhost();
      const fig = this._makeFigure(g.html, { kind: g.kind, caption: g.caption });
      if (!fig) return null;
      // A ghost caption previews the label but must not join figure numbering.
      fig.removeAttribute('data-ve-figure');
      const cap = fig.querySelector('figcaption');
      if (cap) cap.textContent = g.caption || '';

      if (g.mode === 'newslide') {
        const ref = g.afterSlideEl || this.slides().slice(-1)[0];
        let slide;
        if (ref) {
          slide = this._cleanClone(ref);
          slide.querySelectorAll('.content img, .content table, .ve-slot, [data-ve-figure], [data-ve-generated]').forEach(n => n.remove());
          ['data-ve-id', 'data-ve-prop', 'data-ve-done', 'data-ve-propslide', 'data-ve-src'].forEach(a =>
            slide.querySelectorAll('[' + a + ']').forEach(n => n.removeAttribute(a)));
          const h2 = slide.querySelector('h2');
          if (h2 && g.caption) h2.textContent = g.caption;
          const content = slide.querySelector('.content') || slide;
          content.innerHTML = '';
          content.appendChild(fig);
          ref.after(slide);
        } else {
          slide = this.doc.createElement('div');
          slide.appendChild(fig);
          this.doc.body.appendChild(slide);
        }
        slide.classList.add('ve-ghost');   // ribbon + strip on the slide, not the inner fig
        this._ghost = slide;
      } else if (g.mode === 'after' && g.el) {
        fig.classList.add('ve-ghost');
        g.el.parentElement.insertBefore(fig, g.el.nextSibling);
        this._ghost = fig;
      } else if (g.mode === 'replace' && g.el) {
        fig.classList.add('ve-ghost');
        g.el.parentElement.insertBefore(fig, g.el);
        g.el.classList.add('ve-ghost-hidden');   // tuck the placeholder under the preview
        this._ghost = fig;
      } else {
        fig.classList.add('ve-ghost');
        const vis = fig.querySelector('img, svg');
        if (vis) vis.style.maxHeight = (g.maxHeight || 260) + 'px';
        const c = (g.slideEl && g.slideEl.querySelector('.content')) || g.slideEl || this.doc.body;
        c.appendChild(fig);
        this._ghost = fig;
      }
      this._sizeToContent();
      return this._ghost;
    }

    clearGhost() {
      let had = false;
      this.doc.querySelectorAll('.ve-ghost').forEach(n => { n.remove(); had = true; });
      this.doc.querySelectorAll('.ve-ghost-hidden').forEach(n => { n.classList.remove('ve-ghost-hidden'); had = true; });
      this._ghost = null;
      if (had) this._sizeToContent();
      return had;
    }

    // ---------- numbered figures + references slide ----------
    // «شكل N — caption» under every generated visual that carries a caption.
    // Numbering follows document order and is recomputed before every history
    // snapshot, so add/move/delete keeps the numbers correct automatically.
    figures() {
      return Array.from(this.doc.querySelectorAll('[data-ve-figure]'))
        .filter(f => !f.closest('[data-ve-figlist]') && !f.classList.contains('ve-ghost') && !f.closest('.ve-ghost'));
    }

    renumberFigures() {
      this.figures().forEach((fig, i) => {
        const cap = fig.querySelector('figcaption');
        if (!cap) return;
        const base = fig.getAttribute('data-ve-caption') ||
          cap.textContent.replace(/^\s*شكل\s+\d+\s*[—–-]\s*/, '').trim();
        cap.textContent = `شكل ${i + 1} — ${base}`;
      });
    }

    // Human label for where a generated figure came from (references table).
    _figureSource(fig) {
      const kind = fig.getAttribute('data-ve-generated');
      return {
        chart: 'رسم بياني من بيانات الدرس',
        diagram: 'مخطط مولد من نص الدرس',
        image: 'صورة مولدة بالذكاء الاصطناعي',
        equation: 'معادلة مصاغة من الدرس'
      }[kind] || 'عنصر مضاف';
    }

    // Build (or rebuild) the «قائمة الأشكال» slide at the end of the lecture:
    // one table row per numbered figure — الشكل / العنوان / الشريحة / المصدر.
    buildFiguresSlide() {
      this.renumberFigures();
      const figs = this.figures();
      const old = this.doc.querySelector('[data-ve-figlist]');
      if (!figs.length) {
        if (old) { old.remove(); this._pushHistory(); this.onSlidesChanged && this.onSlidesChanged(null); }
        return null;
      }
      const slides = this.slides().filter(s => !s.hasAttribute('data-ve-figlist'));
      const ref = slides[slides.length - 1];

      // Rows are computed against the CURRENT slide order.
      const rows = figs.map((fig, i) => {
        const slide = this._slideOf(fig);
        const slideNo = slide ? slides.indexOf(slide) + 1 : '';
        return {
          n: i + 1,
          title: fig.getAttribute('data-ve-caption') || '',
          slideNo,
          source: this._figureSource(fig)
        };
      });

      let c;
      if (ref) {
        c = this._cleanClone(ref);
        // The clone must not carry figures/ids of its own.
        c.querySelectorAll('.ve-slot, [data-ve-figure]').forEach(n => n.remove());
        c.querySelectorAll('[data-ve-id]').forEach(n => n.removeAttribute('data-ve-id'));
        const h1 = c.querySelector('h1');
        if (h1) h1.textContent = 'قائمة الأشكال';
        const h2 = c.querySelector('h2');
        if (h2) h2.textContent = 'مراجع الأشكال والرسوم التوضيحية الواردة في هذا الدرس';
        const holder = c.querySelector('.content') || c;
        holder.innerHTML = '';
        holder.appendChild(this._figuresTable(rows));
      } else {
        c = this.doc.createElement('div');
        c.innerHTML = '<h2>قائمة الأشكال</h2>';
        c.appendChild(this._figuresTable(rows));
      }
      c.setAttribute('data-ve-figlist', '1');

      if (old) old.replaceWith(c);
      else if (ref) ref.after(c);
      else this.doc.body.appendChild(c);
      this._pushHistory();
      this.onSlidesChanged && this.onSlidesChanged(c);
      return c;
    }

    _figuresTable(rows) {
      const t = this.doc.createElement('table');
      // Inherit the lecture's own table styling when present (same trick as
      // _makeTable); otherwise minimal visible borders.
      const probe = this.doc.querySelector('td, th');
      const styled = probe && this.win.getComputedStyle(probe).borderTopStyle !== 'none';
      const cell = (tag, txt) => {
        const c = this.doc.createElement(tag);
        c.textContent = txt;
        if (!styled) c.style.cssText = 'border:1px solid #999;padding:4px 10px;';
        return c;
      };
      const head = this.doc.createElement('tr');
      ['الشكل', 'العنوان', 'الشريحة', 'المصدر'].forEach(h => head.appendChild(cell('th', h)));
      t.appendChild(head);
      for (const r of rows) {
        const tr = this.doc.createElement('tr');
        tr.appendChild(cell('td', 'شكل ' + r.n));
        tr.appendChild(cell('td', r.title));
        tr.appendChild(cell('td', String(r.slideNo)));
        tr.appendChild(cell('td', r.source));
        t.appendChild(tr);
      }
      if (!styled) t.style.cssText = 'width:100%;border-collapse:collapse;';
      return t;
    }

    // ---------- export ----------
    getCleanHtml() {
      const clone = this.doc.documentElement.cloneNode(true);
      // Strip editor artifacts.
      clone.querySelectorAll('#ve-styles, .ve-overlay, .ve-toolbar, .ve-insert-line, .ve-guide').forEach(n => n.remove());
      // Studio ghost previews must never reach a saved/exported file.
      clone.querySelectorAll('.ve-ghost').forEach(n => n.remove());
      clone.querySelectorAll('.ve-ghost-hidden').forEach(n => n.classList.remove('ve-ghost-hidden'));
      clone.querySelectorAll('.ve-selected').forEach(n => n.classList.remove('ve-selected'));
      clone.querySelectorAll('[contenteditable], .ve-editing').forEach(n => {
        n.removeAttribute('contenteditable');
        n.classList.remove('ve-editing');
      });
      // Internal addressing — not needed in the export (figure metadata stays).
      clone.querySelectorAll('[data-ve-id]').forEach(n => n.removeAttribute('data-ve-id'));
      clone.querySelectorAll('[data-ve-src]').forEach(n => n.removeAttribute('data-ve-src'));
      clone.querySelectorAll('[data-ve-done]').forEach(n => n.removeAttribute('data-ve-done'));
      return '<!DOCTYPE html>\n' + clone.outerHTML;
    }
  }

  window.LectureEditor = LectureEditor;
})();
