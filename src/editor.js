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
  `;

  const BLOCK_TAGS = new Set(['P','DIV','H1','H2','H3','H4','H5','H6','UL','OL','LI','SECTION','ARTICLE','TABLE','BLOCKQUOTE','PRE','FIGURE','HR','IMG']);

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
      clone.querySelectorAll('.ve-selected').forEach(n => n.classList.remove('ve-selected'));
      clone.querySelectorAll('[contenteditable], .ve-editing').forEach(n => {
        n.removeAttribute('contenteditable');
        n.classList.remove('ve-editing');
      });
      return clone.innerHTML;
    }
    _pushHistory() {
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
      if (e.target.closest('.ve-toolbar, .ve-handle, .ve-overlay, .ve-palette')) return;
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
        !el.matches('.ve-overlay, .ve-toolbar, .ve-insert-line, .ve-palette, .ve-guide') &&
        el.offsetHeight > 150 && el.offsetWidth > 200);
    }

    _cleanClone(el) {
      const c = el.cloneNode(true);
      c.querySelectorAll('.ve-selected').forEach(n => n.classList.remove('ve-selected'));
      c.querySelectorAll('.ve-editing').forEach(n => n.classList.remove('ve-editing'));
      c.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
      c.querySelectorAll('.ve-overlay, .ve-toolbar, .ve-insert-line, .ve-palette, .ve-guide').forEach(n => n.remove());
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
      if (slide) {
        const sr = slide.getBoundingClientRect();
        vx.push(sr.left, sr.left + sr.width / 2, sr.right);
        hy.push(sr.top, sr.top + sr.height / 2, sr.bottom);
        for (const sib of this._snapSiblings(slide, unit)) {
          const r = sib.getBoundingClientRect();
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
      if (bx) this._drawGuide('v', bx.line, slide);
      if (by) this._drawGuide('h', by.line, slide);
      return { left: cl + (bx ? bx.d : 0), top: ct + (by ? by.d : 0) };
    }

    // Elements worth aligning to: the slide's direct children and its
    // .content's children, minus the dragged unit and editor chrome.
    _snapSiblings(slide, unit) {
      const out = [];
      const collect = (parent) => {
        if (!parent) return;
        for (const c of parent.children) {
          if (c === unit || c.contains(unit)) continue;
          if (c.matches && c.matches('.ve-overlay, .ve-toolbar, .ve-insert-line, .ve-guide, .ve-palette, style, script')) continue;
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

    // ---------- export ----------
    getCleanHtml() {
      const clone = this.doc.documentElement.cloneNode(true);
      // Strip editor artifacts.
      clone.querySelectorAll('#ve-styles, .ve-overlay, .ve-toolbar, .ve-insert-line, .ve-guide').forEach(n => n.remove());
      clone.querySelectorAll('.ve-selected').forEach(n => n.classList.remove('ve-selected'));
      clone.querySelectorAll('[contenteditable], .ve-editing').forEach(n => {
        n.removeAttribute('contenteditable');
        n.classList.remove('ve-editing');
      });
      return '<!DOCTYPE html>\n' + clone.outerHTML;
    }
  }

  window.LectureEditor = LectureEditor;
})();
