/*
 * AI service — runs in the MAIN process only (never the renderer), so API keys
 * from config.json / env vars stay out of the page and out of git.
 *
 *   chat()          → GLM-5.2 (or any OpenAI-compatible model) for text + SVG.
 *   generateImage() → Gemini / Imagen for conceptual photos.
 *   status()        → which providers are configured, for the UI.
 *
 * Uses Node's global fetch (Electron 31 → Node 20). No third-party deps so it
 * can be unit-tested with `node src/enrich/ai.js --selftest`.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---- config: config.json next to package.json, with env-var overrides -------
let _config = null;
function loadConfig() {
  if (_config) return _config;
  let file = {};
  try {
    const p = path.join(__dirname, '..', '..', 'config.json');
    file = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { /* no config.json — env vars or unconfigured */ }
  const nv = file.nvidia || {};
  const gm = file.gemini || {};
  _config = {
    nvidia: {
      apiKey: process.env.NVIDIA_API_KEY || nv.apiKey || '',
      baseUrl: (process.env.NVIDIA_BASE_URL || nv.baseUrl || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
      textModel: process.env.NVIDIA_TEXT_MODEL || nv.textModel || 'z-ai/glm-5.2',
      // Optional faster model for the heavy multi-slide passes (suggest/review).
      // GLM-5.2 is a slow reasoner; a quick instruct model is much better here.
      // Empty → falls back to textModel.
      reviewModel: process.env.NVIDIA_REVIEW_MODEL || nv.reviewModel || ''
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || gm.apiKey || '',
      baseUrl: (process.env.GEMINI_BASE_URL || gm.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
      imageModel: process.env.GEMINI_IMAGE_MODEL || gm.imageModel || 'imagen-3.0-generate-002'
    }
  };
  return _config;
}
function reloadConfig() { _config = null; return loadConfig(); }

function configPath() { return path.join(__dirname, '..', '..', 'config.json'); }
function readRawConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) { return {}; }
}

// What the Settings page shows/edits. Returns the file's own values (editable)
// plus whether an env var is currently overriding each key.
function getSettings() {
  const raw = readRawConfig();
  const c = loadConfig();
  return {
    nvidia: {
      apiKey: (raw.nvidia && raw.nvidia.apiKey) || '',
      baseUrl: c.nvidia.baseUrl,
      textModel: c.nvidia.textModel
    },
    gemini: {
      apiKey: (raw.gemini && raw.gemini.apiKey) || '',
      baseUrl: c.gemini.baseUrl,
      imageModel: c.gemini.imageModel
    },
    envOverride: { text: !!process.env.NVIDIA_API_KEY, image: !!process.env.GEMINI_API_KEY },
    status: status()
  };
}

// Merge + persist to config.json, then hot-reload so new keys take effect now.
function writeConfig(next) {
  const cur = readRawConfig();
  const merged = {
    nvidia: Object.assign({}, cur.nvidia, next && next.nvidia),
    gemini: Object.assign({}, cur.gemini, next && next.gemini)
  };
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8');
  reloadConfig();
  return { ok: true, status: status() };
}

function status() {
  const c = loadConfig();
  const fake = !!process.env.LVE_FAKE_AI;
  return {
    text: fake || !!c.nvidia.apiKey,
    image: fake || !!c.gemini.apiKey,
    textModel: c.nvidia.textModel,
    reviewModel: c.nvidia.reviewModel || c.nvidia.textModel,
    imageModel: c.gemini.imageModel
  };
}

// ---- fetch with timeout -----------------------------------------------------
async function fetchJSON(url, opts, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) {
      const msg = (json && (json.error?.message || json.message)) || text || ('HTTP ' + res.status);
      return { ok: false, error: `${res.status}: ${String(msg).slice(0, 400)}` };
    }
    return { ok: true, json };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timed out' : String(err.message || err) };
  } finally {
    clearTimeout(t);
  }
}

// Offline canned responses for LVE_FAKE_AI=1 — lets every AI flow run keyless.
// Sniffs the prompt to return the shape each caller expects.
function fakeChat({ system = '', user = '' }) {
  if (/one diagram spec/i.test(system)) {
    return { ok: true, text: JSON.stringify({
      layout: 'flow', title: 'مخطط تجريبي',
      nodes: [{ label: 'خطوة أولى', sub: 'تفصيل' }, { label: 'خطوة ثانية' }, { label: 'خطوة ثالثة' }]
    }) };
  }
  if (/review a few slides/i.test(system)) return { ok: true, text: '[]' };
  let ids = [];
  try { const m = user.match(/\[[\s\S]*\]/); if (m) ids = JSON.parse(m[0]).map(o => o.id); } catch (_) {}
  const arr = (ids.length ? ids : [0]).map(id => ({
    id, type: 'diagram', why: 'توضيح تجريبي (LVE_FAKE_AI)', caption: 'شكل تجريبي',
    diagram: { layout: 'flow', title: 'تجريبي', nodes: [{ label: 'مفهوم ١' }, { label: 'مفهوم ٢' }, { label: 'مفهوم ٣' }] }
  }));
  return { ok: true, text: JSON.stringify(arr) };
}

// ---- text / SVG via OpenAI-compatible chat completions ----------------------
// { system, user, temperature, maxTokens, timeoutMs } → { ok, text } | { ok:false, error }
async function chat({ system, user, temperature = 0.4, maxTokens = 4096, timeoutMs = 120000, fast = false } = {}) {
  if (process.env.LVE_FAKE_AI) return fakeChat({ system, user });
  const c = loadConfig();
  if (!c.nvidia.apiKey) return { ok: false, error: 'No NVIDIA/text API key configured.' };
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user || '' });
  // Heavy multi-slide passes may use a faster model if one is configured.
  const model = (fast && c.nvidia.reviewModel) ? c.nvidia.reviewModel : c.nvidia.textModel;

  const r = await fetchJSON(c.nvidia.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + c.nvidia.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      top_p: 1,
      max_tokens: maxTokens,
      stream: false
    })
  }, timeoutMs);
  if (!r.ok) return r;
  const text = r.json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') return { ok: false, error: 'Empty response from model.' };
  return { ok: true, text };
}

// ---- image via Gemini / Imagen ---------------------------------------------
// Supports both the Imagen `:predict` endpoint (imagen-*) and the Gemini
// image-generation `:generateContent` endpoint (gemini-*-image). Returns a
// data: URL so the renderer can drop it straight into an <img>.
async function generateImage({ prompt, aspectRatio = '16:9' } = {}) {
  if (process.env.LVE_FAKE_AI) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">' +
      '<rect width="100%" height="100%" fill="#413258"/>' +
      '<text x="50%" y="50%" fill="#fff" font-size="34" text-anchor="middle" dominant-baseline="middle">FAKE IMAGE</text></svg>';
    return { ok: true, dataUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg) };
  }
  const c = loadConfig();
  if (!c.gemini.apiKey) return { ok: false, error: 'No Gemini image API key configured.' };
  const model = c.gemini.imageModel;
  const key = encodeURIComponent(c.gemini.apiKey);

  if (/^imagen/i.test(model)) {
    const url = `${c.gemini.baseUrl}/models/${model}:predict?key=${key}`;
    const r = await fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio, personGeneration: 'allow_adult' }
      })
    });
    if (!r.ok) return r;
    const pred = r.json?.predictions?.[0];
    const b64 = pred?.bytesBase64Encoded || pred?.image?.imageBytes;
    const mime = pred?.mimeType || 'image/png';
    if (!b64) return { ok: false, error: 'Imagen returned no image bytes.' };
    return { ok: true, dataUrl: `data:${mime};base64,${b64}` };
  }

  // Gemini native image model (e.g. gemini-*-image): inline image parts.
  const url = `${c.gemini.baseUrl}/models/${model}:generateContent?key=${key}`;
  const r = await fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio }
      }
    })
  });
  if (!r.ok) return r;
  const parts = r.json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData || p.inline_data);
  const inline = img && (img.inlineData || img.inline_data);
  if (!inline?.data) return { ok: false, error: 'Gemini returned no image.' };
  return { ok: true, dataUrl: `data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}` };
}

module.exports = { chat, generateImage, status, loadConfig, reloadConfig, getSettings, writeConfig };

// ---- tiny self-test: `node src/enrich/ai.js --selftest` ---------------------
if (require.main === module && process.argv.includes('--selftest')) {
  (async () => {
    console.log('config:', JSON.stringify(status(), null, 2));
    const r = await chat({ user: 'Reply with exactly: PONG', maxTokens: 20, temperature: 0 });
    console.log('chat →', r.ok ? JSON.stringify(r.text) : 'ERROR ' + r.error);
  })();
}
