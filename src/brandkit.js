/*
 * brandkit.js — customer-brought brand identity (renderer).
 *
 * Generalizes the one-click MiM theme so ANY customer can bring their own:
 *   • Palette — the app detects the CSS variables the loaded lecture declares
 *     (editor.detectVars()) and lets the user recolor each. Works for any
 *     variable-based template without knowing the names in advance.
 *   • Fonts  — the user uploads font files and names each family. Naming a font
 *     with a family the lecture already uses (editor.detectFontFamilies())
 *     re-skins the whole deck via @font-face aliasing — no lecture edits.
 *
 * A kit = { name, vars:{'--x':'#..'}, fonts:[{family,weight,style,ext,b64}] }.
 * Kits are saved in userData (main process) so a brand is set up once and
 * one-click applied to any lecture. Applying a kit runs through the same
 * editor.applyThemeKit() that powers MiM, so it exports to PDF self-contained.
 */
(function () {
  'use strict';
  const api = window.api;
  let modal = null;
  let kit = { name: '', vars: {}, fonts: [] };  // the kit being edited
  let savedKits = [];
  let lastFontFamilyInput = null;
  let applyTimer = null;

  const getEditor = () => window.__editor;
  const setStatus = (m) => { const el = document.querySelector('#status'); if (el) el.textContent = m; };

  async function open() {
    const editor = getEditor();
    if (!editor) { setStatus('Open a lecture first.'); return; }
    try { savedKits = ((await api.brandKitsGet()) || {}).kits || []; } catch (_) { savedKits = []; }
    // Seed a fresh kit from the lecture's own detected palette.
    kit = freshKit(editor);
    render();
  }
  function close() { if (modal) { modal.remove(); modal = null; } clearTimeout(applyTimer); }

  function freshKit(editor) {
    const vars = {};
    editor.detectVars().forEach(v => { vars[v.name] = v.value; });
    return { name: '', vars, fonts: [] };
  }

  function render() {
    close();
    const editor = getEditor();
    const detectedFams = editor.detectFontFamilies();

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      `<div class="modal kit-modal">` +
        `<div class="modal-head">🎨 Brand Kit ${editor.activeThemeKit() ? `<span class="kit-active">active: ${escapeHtml(editor.activeThemeKit())}</span>` : ''}</div>` +
        `<div class="modal-body">` +
          `<div class="kit-bar">` +
            `<label>Load kit <select id="kit-select"></select></label>` +
            `<button data-new title="Start a new kit from this lecture's colors">＋ New</button>` +
            `<button data-del class="danger-outline" title="Delete the selected saved kit">🗑</button>` +
          `</div>` +

          `<div class="kit-sec"><div class="kit-stitle">🎨 Colors <span class="kit-hint">— from this lecture's own variables</span></div>` +
            `<div class="kit-colors" id="kit-colors"></div></div>` +

          `<div class="kit-sec"><div class="kit-stitle">🔤 Fonts <span class="kit-hint">— upload, then name each to match a lecture font</span></div>` +
            `<div class="kit-fonts" id="kit-fonts"></div>` +
            `<button data-addfont>＋ Upload fonts…</button>` +
            (detectedFams.length ? `<div class="kit-fams" id="kit-fams"><span class="kit-hint">Lecture fonts (click to alias the last font):</span></div>` : '') +
          `</div>` +
        `</div>` +
        `<div class="modal-foot kit-foot">` +
          `<input id="kit-name" placeholder="Kit name (e.g. Acme Corp)" spellcheck="false">` +
          `<span class="spacer"></span>` +
          `<button data-revert>Revert</button>` +
          `<button data-apply>Apply</button>` +
          `<button class="primary" data-save>Save &amp; Apply</button>` +
          `<button data-close>Close</button>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(backdrop);
    modal = backdrop;

    renderKitSelect();
    renderColors();
    renderFonts();
    if (detectedFams.length) {
      const box = backdrop.querySelector('#kit-fams');
      detectedFams.forEach(f => {
        const chip = document.createElement('button');
        chip.className = 'kit-chip'; chip.textContent = f; chip.title = 'Use "' + f + '" as the family name of the last font';
        chip.addEventListener('click', () => aliasLastFont(f));
        box.appendChild(chip);
      });
    }

    backdrop.querySelector('#kit-name').value = kit.name || '';
    backdrop.querySelector('[data-new]').addEventListener('click', () => { kit = freshKit(getEditor()); modal.querySelector('#kit-name').value = ''; renderColors(); renderFonts(); });
    backdrop.querySelector('[data-del]').addEventListener('click', deleteSelected);
    backdrop.querySelector('[data-addfont]').addEventListener('click', addFonts);
    backdrop.querySelector('[data-apply]').addEventListener('click', () => { applyNow(); setStatus('Brand kit applied.'); });
    backdrop.querySelector('[data-revert]').addEventListener('click', () => { getEditor().removeThemeKit(); setStatus('Reverted to the lecture\'s original theme.'); refreshActive(); });
    backdrop.querySelector('[data-save]').addEventListener('click', saveKit);
    backdrop.querySelector('[data-close]').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  }

  function renderKitSelect() {
    const sel = modal.querySelector('#kit-select');
    sel.innerHTML = `<option value="">— saved kits —</option>` +
      savedKits.map(k => `<option value="${escapeAttr(k.name)}">${escapeHtml(k.name)}</option>`).join('');
    sel.value = kit.name && savedKits.some(k => k.name === kit.name) ? kit.name : '';
    sel.addEventListener('change', () => {
      const found = savedKits.find(k => k.name === sel.value);
      if (found) {
        kit = JSON.parse(JSON.stringify(found));
        modal.querySelector('#kit-name').value = kit.name;
        renderColors(); renderFonts();
      }
    });
  }

  function renderColors() {
    const box = modal.querySelector('#kit-colors');
    const names = Object.keys(kit.vars);
    if (!names.length) { box.innerHTML = `<p class="kit-hint">This lecture declares no CSS color variables — colors can't be recolored automatically.</p>`; return; }
    box.innerHTML = '';
    names.forEach(name => {
      const row = document.createElement('div');
      row.className = 'kit-color';
      const hex = toHex(kit.vars[name]);
      row.innerHTML =
        `<input type="color" value="${hex}" data-var="${escapeAttr(name)}">` +
        `<span class="kit-varname">${escapeHtml(name)}</span>` +
        `<input type="text" class="kit-hexin" value="${escapeAttr(kit.vars[name])}" data-varhex="${escapeAttr(name)}" spellcheck="false">`;
      const picker = row.querySelector('input[type=color]');
      const hexin = row.querySelector('.kit-hexin');
      picker.addEventListener('input', () => { kit.vars[name] = picker.value; hexin.value = picker.value; liveApply(); });
      hexin.addEventListener('change', () => { kit.vars[name] = hexin.value.trim(); const h = toHex(hexin.value); if (h) picker.value = h; liveApply(); });
      box.appendChild(row);
    });
  }

  function renderFonts() {
    const box = modal.querySelector('#kit-fonts');
    if (!kit.fonts.length) { box.innerHTML = `<p class="kit-hint">No fonts uploaded. Charts, diagrams and text will use the lecture's current fonts.</p>`; return; }
    box.innerHTML = '';
    kit.fonts.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'kit-font';
      row.innerHTML =
        `<span class="kit-file" title="${escapeAttr(f.fileName || '')}">${escapeHtml(f.fileName || f.family)}</span>` +
        `<input type="text" class="kit-fam" value="${escapeAttr(f.family)}" placeholder="Family name" spellcheck="false">` +
        `<select class="kit-weight">${[100,200,300,400,500,600,700,800,900].map(w => `<option value="${w}"${+f.weight === w ? ' selected' : ''}>${w}</option>`).join('')}</select>` +
        `<button class="kit-fdel danger-outline" title="Remove">×</button>`;
      const fam = row.querySelector('.kit-fam');
      fam.addEventListener('focus', () => { lastFontFamilyInput = { i, el: fam }; });
      fam.addEventListener('change', () => { kit.fonts[i].family = fam.value.trim(); });
      row.querySelector('.kit-weight').addEventListener('change', (e) => { kit.fonts[i].weight = +e.target.value; });
      row.querySelector('.kit-fdel').addEventListener('click', () => { kit.fonts.splice(i, 1); renderFonts(); });
      box.appendChild(row);
    });
  }

  async function addFonts() {
    let picked;
    try { picked = await api.pickFonts(); } catch (_) { picked = []; }
    if (!picked || !picked.length) return;
    picked.forEach(f => kit.fonts.push(f));
    renderFonts();
    setStatus(`Added ${picked.length} font file(s). Name each to match a lecture font, then Apply.`);
  }

  function aliasLastFont(family) {
    if (!kit.fonts.length) { setStatus('Upload a font first, then click a lecture font to alias it.'); return; }
    const idx = lastFontFamilyInput ? lastFontFamilyInput.i : kit.fonts.length - 1;
    kit.fonts[idx].family = family;
    renderFonts();
    setStatus(`"${kit.fonts[idx].fileName || 'font'}" will now render the lecture's "${family}".`);
  }

  function collectName() {
    const n = (modal.querySelector('#kit-name').value || '').trim();
    kit.name = n;
    return n;
  }

  function applyNow() {
    kit.name = kit.name || (modal.querySelector('#kit-name').value || '').trim() || 'custom';
    getEditor().applyThemeKit(kit);
    refreshActive();
  }
  function liveApply() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => { getEditor().applyThemeKit(Object.assign({}, kit, { name: kit.name || 'custom' })); refreshActive(); }, 250);
  }
  function refreshActive() {
    const head = modal && modal.querySelector('.modal-head');
    if (!head) return;
    const active = getEditor().activeThemeKit();
    head.innerHTML = `🎨 Brand Kit ${active ? `<span class="kit-active">active: ${escapeHtml(active)}</span>` : ''}`;
  }

  async function saveKit() {
    const name = collectName();
    if (!name) { setStatus('Give the kit a name first.'); modal.querySelector('#kit-name').focus(); return; }
    applyNow();
    let res;
    try { res = await api.brandKitsSave(kit); } catch (e) { res = { ok: false, error: String(e) }; }
    if (res && res.ok) {
      const i = savedKits.findIndex(k => k.name === name);
      if (i >= 0) savedKits[i] = JSON.parse(JSON.stringify(kit)); else savedKits.push(JSON.parse(JSON.stringify(kit)));
      renderKitSelect();
      setStatus(`Saved brand kit "${name}" and applied it.`);
    } else {
      setStatus('Save failed: ' + ((res && res.error) || 'unknown'));
    }
  }

  async function deleteSelected() {
    const sel = modal.querySelector('#kit-select');
    const name = sel.value;
    if (!name) { setStatus('Pick a saved kit to delete.'); return; }
    try { await api.brandKitsDelete(name); } catch (_) {}
    savedKits = savedKits.filter(k => k.name !== name);
    renderKitSelect();
    setStatus(`Deleted brand kit "${name}".`);
  }

  // --- helpers ---
  function toHex(c) {
    c = (c || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map(x => x + x).join('');
    const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) return '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('');
    return '#000000';
  }
  function escapeAttr(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function escapeHtml(s) { return escapeAttr(s); }

  window.BrandKit = { open, close };
})();
