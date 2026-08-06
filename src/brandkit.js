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

  // ---------- Arabic typography presets (011B) ----------
  // Metadata only (family names + line-height) layered on top of the SAME
  // applyThemeKit mechanism as the palette/fonts above — no new theming path.
  // Line-heights are tuned generously so tashkeel (diacritics) doesn't clip.
  const TYPO_PRESETS = [
    { id: 'cairo-tajawal', label: 'Cairo + Tajawal', heading: 'Cairo', body: 'Tajawal', lineHeight: 1.75 },
    { id: 'amiri-almarai', label: 'Amiri + Almarai', heading: 'Amiri', body: 'Almarai', lineHeight: 1.85 },
    { id: 'changa-cairo', label: 'Changa + Cairo', heading: 'Changa', body: 'Cairo', lineHeight: 1.7 },
  ];
  function varsToCss(vars) {
    const decls = Object.keys(vars || {}).map(k => `${k}:${vars[k]};`).join('');
    return decls ? `:root{${decls}}` : '';
  }
  // Role CSS only — the fonts themselves are EMBEDDED as data: faces by the
  // caller (was an @import here, which made presets online-only and tripped
  // the doctor's fonts-external rule on every deck they touched).
  function typoCss(p) {
    return `.slide h1,.slide h2,.slide h3{font-family:'${p.heading}',sans-serif;}\n` +
      `.slide .content,.slide p,.slide li{font-family:'${p.body}',sans-serif;line-height:${p.lineHeight};}`;
  }
  // Google Fonts css2 -> embedded faces (ported from web/app.js — keep in
  // spirit-sync). gstatic serves CORS *, so the woff2 binaries can be fetched
  // and inlined as data: URLs. css2 labels each block with a /* subset */
  // comment — keep arabic + latin (digits/Latin terms) to keep the file lean.
  async function fetchGoogleFontFaces(family, weights) {
    const url = 'https://fonts.googleapis.com/css2?family=' +
      encodeURIComponent(family).replace(/%20/g, '+') +
      ':wght@' + weights.join(';') + '&display=swap';
    const css = await (await fetch(url)).text();
    const wanted = [];
    const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const subset = m[1], body = m[2];
      if (subset !== 'arabic' && subset !== 'latin') continue;
      const weight = parseInt((body.match(/font-weight:\s*(\d+)/) || [])[1], 10) || 400;
      const src = (body.match(/src:\s*url\((https:[^)]+\.woff2)\)/) || [])[1];
      if (src) wanted.push({ weight, src });
    }
    if (!wanted.length) throw new Error('no usable faces for ' + family);
    const fonts = [];
    for (const f of wanted) {
      const buf = await (await fetch(f.src)).arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      fonts.push({ family, weight: f.weight, ext: 'woff2', b64: btoa(bin) });
    }
    return fonts;
  }
  function dedupeFonts(fonts) {
    const seen = new Set();
    return fonts.filter((f) => {
      const k = f.family + '|' + (f.weight || 400) + '|' + (f.style || 'normal');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  // Both preset paths pair a heading face @700 with a body face @400+700.
  async function fetchPresetFaces(heading, body) {
    const h = await fetchGoogleFontFaces(heading, [700]);
    const b = await fetchGoogleFontFaces(body, [400, 700]);
    return dedupeFonts(h.concat(b));
  }
  async function applyTypography(p) {
    const editor = getEditor();
    if (!editor) return;
    // Embed the pairing's fonts so the saved deck renders offline + in PDF.
    // Roles still apply if the fetch fails; text then falls back to system fonts.
    let faces = [];
    try {
      setStatus(`Downloading "${p.label}" fonts…`);
      faces = await fetchPresetFaces(p.heading, p.body);
    } catch (_) { faces = []; }
    // Uploaded kit fonts stay and WIN dedupe ties — a customer file beats a preset face.
    editor.applyThemeKit({ name: kit.name || editor.activeThemeKit() || 'custom', fonts: dedupeFonts((kit.fonts || []).concat(faces)), varsCss: varsToCss(kit.vars) + '\n' + typoCss(p) });
    refreshActive();
    setStatus(faces.length
      ? `Applied "${p.label}" typography — fonts embedded (offline & PDF safe).`
      : `Applied "${p.label}" roles only — fonts couldn't be downloaded (offline?); text falls back to system fonts.`);
  }

  // ---------- Theme files (.theme.json) + built-in presets (012) ----------
  // Two neutral presets (palette + font-pair, reusing the SAME typoCss/applyThemeKit
  // path as 011B) — MiM is not re-transcribed here, it reuses editor.applyBrandTheme
  // (the exact BRAND_PALETTES.MiM the ✨ button already applies).
  const NEUTRAL_PRESETS = {
    Slate: {
      vars: { '--purple': '#2B3A55', '--cyan': '#5AA9C9', '--pink': '#8AA6B8', '--gold': '#8AA6B8',
        '--dark': '#1A1A1A', '--bg-gray': '#F2F4F6', '--white': '#FFFFFF',
        '--grey-dark': '#5B6470', '--grey-mid': '#9AA5B1', '--grey-light': '#E3E7EC', '--ve-line-height': '1.75' },
      typo: { heading: 'Cairo', body: 'Tajawal', lineHeight: 1.75 },
    },
    Warm: {
      vars: { '--purple': '#7A4E2D', '--cyan': '#C97B4A', '--pink': '#E3B27B', '--gold': '#E3B27B',
        '--dark': '#241A12', '--bg-gray': '#FBF3EA', '--white': '#FFFFFF',
        '--grey-dark': '#6B5A4A', '--grey-mid': '#B39B86', '--grey-light': '#EFE2D3', '--ve-line-height': '1.8' },
      typo: { heading: 'Almarai', body: 'Cairo', lineHeight: 1.8 },
    },
  };
  async function applyMiMPreset(variant) {
    const editor = getEditor();
    if (!editor) return;
    let fonts = [];
    try { fonts = await api.getFonts(); } catch (_) { fonts = []; }
    const kitName = variant === 'MiM-print' ? 'MiM-print' : 'MiM';
    editor.applyBrandTheme(fonts, kitName); // exact BRAND_PALETTES — not retyped
    kit = { name: kitName, vars: {}, fonts: [] };
    refreshActive();
    setStatus(kitName === 'MiM-print'
      ? 'Applied MiM PRINT preset (official Pantone sheet — print-accurate).'
      : 'Applied MiM preset (screen palette).');
  }
  async function applyNeutralPreset(name) {
    const editor = getEditor();
    const p = NEUTRAL_PRESETS[name];
    if (!editor || !p) return;
    // Embed the preset's Google fonts as data: URLs so the saved deck renders
    // offline + in PDF. Colors still apply if the fetch fails.
    let faces = [];
    try {
      setStatus(`Downloading "${name}" fonts…`);
      faces = await fetchPresetFaces(p.typo.heading, p.typo.body);
    } catch (_) { faces = []; }
    editor.applyThemeKit({ name, fonts: faces, varsCss: varsToCss(p.vars) + '\n' + typoCss(p.typo) });
    kit = { name, vars: Object.assign({}, p.vars), fonts: [] };
    refreshActive();
    setStatus(faces.length
      ? `Applied "${name}" preset — fonts embedded (offline & PDF safe).`
      : `Applied "${name}" colors only — fonts couldn't be downloaded (offline?).`);
  }
  function applyBuiltinPreset(name) {
    if (name === 'MiM' || name === 'MiM-print') applyMiMPreset(name); else applyNeutralPreset(name);
  }

  // Parse the live #ve-theme <style> for @font-face rules — reflects whatever
  // is CURRENTLY applied (MiM/preset/upload) regardless of how it got there,
  // so Export always exports a byte-accurate, re-importable snapshot.
  function extractLiveFonts(cssText) {
    const fonts = [];
    const re = /@font-face\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(cssText || ''))) {
      const body = m[1];
      const fam = (body.match(/font-family:\s*'([^']+)'/) || [])[1];
      const weight = parseInt((body.match(/font-weight:\s*(\d+)/) || [])[1], 10) || 400;
      const src = body.match(/url\(data:([^;]+);base64,([^)]+)\)\s*format\('([^']+)'\)/);
      if (!fam || !src) continue;
      const fmt = src[3];
      const ext = fmt === 'truetype' ? 'ttf' : fmt === 'woff2' ? 'woff2' : fmt === 'woff' ? 'woff' : 'otf';
      fonts.push({ family: fam, weight, ext, b64: src[2] });
    }
    return fonts;
  }
  function buildLiveKit() {
    const editor = getEditor();
    const vars = {};
    editor.detectVars().forEach(v => { vars[v.name] = v.declared || v.value; });
    const style = editor.doc.getElementById('ve-theme');
    const fonts = style ? extractLiveFonts(style.textContent) : [];
    return { name: kit.name || editor.activeThemeKit() || 'Untitled', vars, fonts };
  }
  async function exportTheme() {
    const editor = getEditor();
    if (!editor) { setStatus('Open a lecture first.'); return; }
    const liveKit = buildLiveKit();
    const json = window.ThemeIO.toJson(liveKit);
    const suggested = (liveKit.name || 'theme').replace(/[^\w-]+/g, '-') + '.theme.json';
    const res = await api.saveTextFile({ content: json, suggestedName: suggested, extension: 'json', filterName: 'Theme JSON' });
    if (res && res.ok) setStatus(`Exported "${liveKit.name}" theme to ${res.filePath}.`);
  }
  async function importThemeFile() {
    const editor = getEditor();
    if (!editor) { setStatus('Open a lecture first.'); return; }
    const res = await api.openTextFile({ extension: 'json', filterName: 'Theme JSON' });
    if (!res) return;
    let parsed;
    try { parsed = window.ThemeIO.parse(res.content); }
    catch (e) { setStatus('Theme import failed: ' + e.message); return; }
    editor.applyThemeKit(parsed);
    kit = { name: parsed.name, vars: window.ThemeIO.parseVarsCss(parsed.varsCss), fonts: parsed.fonts };
    refreshActive();
    if (modal) { modal.querySelector('#kit-name').value = kit.name; renderColors(); renderFonts(); }
    setStatus(`Imported theme "${parsed.name}".`);
  }

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

          `<div class="kit-sec"><div class="kit-stitle">🅰 خطوط عربية جاهزة <span class="kit-hint">— Arabic typography presets</span></div>` +
            `<div class="kit-fams" id="kit-typo">${TYPO_PRESETS.map(p => `<button class="kit-chip" data-typo="${p.id}">${escapeHtml(p.label)}</button>`).join('')}</div>` +
          `</div>` +

          `<div class="kit-sec"><div class="kit-stitle">🧩 ملف الثيم <span class="kit-hint">— presets, export &amp; import a .theme.json</span></div>` +
            `<div class="kit-fams" id="kit-presets">` +
              `<button class="kit-chip" data-preset="MiM">✨ MiM</button>` +
              `<button class="kit-chip" data-preset="MiM-print">🖨 MiM Print</button>` +
              `<button class="kit-chip" data-preset="Slate">🩶 Slate</button>` +
              `<button class="kit-chip" data-preset="Warm">🟤 Warm</button>` +
            `</div>` +
            `<div class="kit-fams">` +
              `<button data-export-theme>⬇ تصدير الثيم</button>` +
              `<button data-import-theme>⬆ استيراد الثيم</button>` +
            `</div>` +
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

    backdrop.querySelectorAll('#kit-typo [data-typo]').forEach(btn => {
      btn.addEventListener('click', () => applyTypography(TYPO_PRESETS.find(p => p.id === btn.dataset.typo)));
    });
    backdrop.querySelectorAll('#kit-presets [data-preset]').forEach(btn => {
      btn.addEventListener('click', () => applyBuiltinPreset(btn.dataset.preset));
    });
    backdrop.querySelector('[data-export-theme]').addEventListener('click', exportTheme);
    backdrop.querySelector('[data-import-theme]').addEventListener('click', importThemeFile);

    backdrop.querySelector('#kit-name').value = kit.name || '';
    backdrop.querySelector('[data-new]').addEventListener('click', () => { kit = freshKit(getEditor()); modal.querySelector('#kit-name').value = ''; renderColors(); renderFonts(); });
    backdrop.querySelector('[data-del]').addEventListener('click', deleteSelected);
    backdrop.querySelector('[data-addfont]').addEventListener('click', addFonts);
    backdrop.querySelector('[data-apply]').addEventListener('click', () => applyNow());
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
    const audit = getEditor().themeAudit();
    if (audit) {
      const fontMsg = audit.fontPct >= 90 ? `fonts cover ${audit.fontPct}% of text`
        : audit.fontPct > 0 ? `⚠ fonts only cover ${audit.fontPct}% of text`
        : '⚠ fonts embedded but no text uses them';
      const lostN = audit.lost ? audit.lost.length : 0;
      const colorMsg = `${audit.recolored.length}/${audit.recolored.length + audit.missed.length + lostN} colors remapped`;
      const lostMsg = lostN ? ` ⚠ ${lostN} blocked by the deck's own CSS — run 🩺.` : '';
      setStatus(`Brand kit applied — ${fontMsg}, ${colorMsg}.${lostMsg}`);
    }
  }
  function liveApply() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => { getEditor().applyThemeKit(Object.assign({}, kit, { name: kit.name || 'custom' })); refreshActive(); }, 250);
  }
  function refreshActive() {
    if (window.__updateBrandBtn) window.__updateBrandBtn(); // keep the toolbar MiM toggle in sync with modal-applied kits
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
