/*
 * settings.js — API-key settings page (renderer). Lets the user paste their
 * NVIDIA (GLM) and Gemini keys from the UI instead of hand-editing config.json.
 * Keys are written to config.json in the MAIN process and hot-reloaded.
 */
(function () {
  'use strict';
  const api = window.api;
  let modal = null;

  async function open() {
    let s;
    try { s = await api.settingsGet(); } catch (_) { s = null; }
    s = s || { nvidia: {}, gemini: {}, envOverride: {}, status: {} };
    render(s);
  }

  function close() { if (modal) { modal.remove(); modal = null; } }

  function field(id, label, value, opts = {}) {
    const type = opts.password ? 'password' : 'text';
    const reveal = opts.password
      ? `<button type="button" class="set-reveal" data-for="${id}" title="Show / hide">👁</button>` : '';
    return `<label class="set-row"><span class="set-label">${label}</span>` +
      `<span class="set-inputwrap"><input id="${id}" type="${type}" value="${escapeAttr(value || '')}" ` +
      `placeholder="${escapeAttr(opts.placeholder || '')}" spellcheck="false" autocomplete="off">${reveal}</span></label>`;
  }

  function render(s) {
    close();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      `<div class="modal set-modal">` +
        `<div class="modal-head">⚙️ Settings — API keys</div>` +
        `<div class="modal-body">` +
          `<p class="set-intro">Keys are stored locally in <code>config.json</code> (never committed to git). ` +
          `Charts work with no keys; diagrams need NVIDIA; photos need Gemini.</p>` +

          `<div class="set-group"><div class="set-gtitle">🟣 NVIDIA — text &amp; diagrams (GLM)</div>` +
            field('set-nv-key', 'API key', s.nvidia.apiKey, { password: true, placeholder: 'nvapi-…' }) +
            field('set-nv-model', 'Model', s.nvidia.textModel, { placeholder: 'z-ai/glm-5.2' }) +
            field('set-nv-url', 'Base URL', s.nvidia.baseUrl, { placeholder: 'https://integrate.api.nvidia.com/v1' }) +
            (s.envOverride && s.envOverride.text ? `<p class="set-warn">⚠ An env var NVIDIA_API_KEY is overriding this key.</p>` : '') +
          `</div>` +

          `<div class="set-group"><div class="set-gtitle">🔵 Gemini — photo generation</div>` +
            field('set-gm-key', 'API key', s.gemini.apiKey, { password: true, placeholder: 'AIza…' }) +
            field('set-gm-model', 'Image model', s.gemini.imageModel, { placeholder: 'imagen-3.0-generate-002' }) +
            field('set-gm-url', 'Base URL', s.gemini.baseUrl, { placeholder: 'https://generativelanguage.googleapis.com/v1beta' }) +
            (s.envOverride && s.envOverride.image ? `<p class="set-warn">⚠ An env var GEMINI_API_KEY is overriding this key.</p>` : '') +
          `</div>` +

          `<div class="set-status" id="set-status"></div>` +
        `</div>` +
        `<div class="modal-foot">` +
          `<button data-cancel>Close</button>` +
          `<button class="primary" data-save>Save keys</button>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(backdrop);
    modal = backdrop;
    renderStatus(s.status);

    backdrop.querySelectorAll('.set-reveal').forEach(b => b.addEventListener('click', () => {
      const inp = backdrop.querySelector('#' + b.dataset.for);
      inp.type = inp.type === 'password' ? 'text' : 'password';
    }));
    const cancel = () => close();
    backdrop.querySelector('[data-cancel]').addEventListener('click', cancel);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cancel(); });
    backdrop.querySelector('[data-save]').addEventListener('click', save);
  }

  async function save() {
    const val = (id) => (modal.querySelector('#' + id).value || '').trim();
    const payload = {
      nvidia: { apiKey: val('set-nv-key'), textModel: val('set-nv-model'), baseUrl: val('set-nv-url') },
      gemini: { apiKey: val('set-gm-key'), imageModel: val('set-gm-model'), baseUrl: val('set-gm-url') }
    };
    const btn = modal.querySelector('[data-save]');
    btn.disabled = true; btn.textContent = 'Saving…';
    let res;
    try { res = await api.settingsSave(payload); } catch (e) { res = { ok: false, error: String(e) }; }
    btn.disabled = false; btn.textContent = 'Save keys';
    if (res && res.ok) {
      renderStatus(res.status);
      const st = modal.querySelector('#set-status');
      if (st) st.insertAdjacentHTML('beforeend', ' <b style="color:#16a34a">Saved ✓</b>');
    } else {
      const st = modal.querySelector('#set-status');
      if (st) st.innerHTML = `<span style="color:#c0392b">Save failed: ${escapeHtml((res && res.error) || 'unknown')}</span>`;
    }
  }

  function renderStatus(status) {
    const el = modal && modal.querySelector('#set-status');
    if (!el || !status) return;
    const dot = (ok) => ok ? '🟢' : '⚪';
    el.innerHTML = `Status: ${dot(status.text)} diagrams &nbsp; ${dot(status.image)} photos &nbsp; 🟢 charts`;
  }

  function escapeAttr(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function escapeHtml(s) { return escapeAttr(s); }

  window.Settings = { open, close };
})();
