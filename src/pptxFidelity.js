'use strict';

/*
 * Editable-PPTX fidelity gate.
 *
 * This module deliberately lives in the Electron main-process layer.  It
 * renders the HTML source with Chromium, renders the candidate PPTX with the
 * locally installed desktop PowerPoint, and retains the evidence needed to
 * explain a rejection.  It does not know how a scene graph becomes a PPTX;
 * callers inject that renderer through `renderPptx`.
 *
 * The defaults are intentionally strict. Pixel and geometry evidence decide
 * whether an editable candidate is verified; OCR is retained only as a
 * diagnostic utility outside the shipping gate.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const FIDELITY_VERSION = '1.0.0';
// Bump this whenever tools/pptx/renderer.py changes in a way that can alter
// the emitted OOXML or its pixels. Slide cache entries are never valid across
// a renderer revision.
const PPTX_RENDERER_VERSION = 'scene-v2-font-embed-2026-08-14';
const SELF_HEAL_MAX_ROUNDS = 2;
const SELF_HEAL_MAX_DEMOTIONS_PER_ROUND = 3;
const HEALABLE_RENDER_KINDS = new Set(['shape', 'shape-text', 'text', 'image', 'table', 'list', 'line']);
const TEXTUAL_RENDER_KINDS = new Set(['text', 'shape-text', 'list']);
const DEFAULT_TARGET = Object.freeze({ width: 1900, height: 1300 });
const FIDELITY_POLICIES = Object.freeze({
  STRICT: 'strict',
  EDITABLE_BEST_EFFORT: 'editable-best-effort'
});
const EVIDENCE_MODES = Object.freeze({
  FULL: 'full',
  PREVIEW: 'preview',
  NATIVE: 'native'
});
/*
 * FROZEN 2026-08-14 by mission 034. Derived from measurement, not chosen.
 *
 * Corpus: test/fixtures/calibration-deck.html — 14 slides, one feature each,
 * exported 3x through the real pipeline at pixelDelta 24. The run is exactly
 * deterministic (largest SSIM spread across the three runs: 0.000e+0), so the
 * distribution below is a property of the two rasterisers, not of sampling.
 * Raw observations: test/fixtures/calibration-baseline.json.
 *
 *   ssim       min 0.853776  median 0.966945  p95 0.991079  max 0.994562
 *   mismatch%  min 0.1878    median 1.3162    p95 3.4236    max 5.6301
 *
 * Formula (mission 034 stage 3):
 *   ssim floor  = min(observed) - 0.005 = 0.853776 - 0.005 = 0.848776 -> 0.8487
 *   pixel budget= max(observed) * 1.5   = 5.6301  * 1.5    = 8.4451  -> 8.45
 *
 * DEVIATION, stated deliberately: the mission proposed clamping these to 0.95
 * and 3.0%. Measurement says the cross-renderer floor for dense Arabic text is
 * worse than that guess — slide 13 (200+ words) scores 0.8538 / 5.63% with
 * IDENTICAL fonts and geometry proven exact to 0.75px, and the font-control
 * experiment (test/fixtures/font-control-deck.html) reproduces ~0.943 / 2.5%
 * on a plain 4-line slide. Clamping would fail known-good content on every
 * export, which is the one thing a gate must never do. Two defects found while
 * calibrating were FIXED rather than absorbed: gradient boxes were silently
 * dropped from the deck (17.89% -> 3.42% on slide 9), and an <img> with an SVG
 * source crashed the renderer.
 *
 * Tightening these is mission 036's job: embedding the deck's real fonts
 * removes the dominant remaining source of per-glyph difference.
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  ssim: 0.8487,
  pixelMismatchPercent: 8.45,
  // Raised from 8 in mission 034: 8 counts every antialiased glyph edge as a
  // mismatch, so it measures rasteriser noise rather than rendering error.
  pixelDelta: 24,
  maxDifferenceRegionWidth: 8,
  maxDifferenceRegionHeight: 8,
  maxDifferenceRegionArea: 64,
  ocrPositionTolerancePx: 2,
  // Position truth: half a rendered pixel at the 2x fidelity target.
  geometryTolerancePx: 0.75
});

const GENERIC_FONT_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'inherit', 'initial', 'unset',
  'revert', 'emoji', 'math', 'fangsong'
]);

class PptxFidelityError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PptxFidelityError';
    this.code = code;
    this.details = details;
  }
}

function fidelityError(code, message, details) {
  return new PptxFidelityError(code, message, details);
}

function asErrorInfo(error, fallbackCode = 'UNKNOWN') {
  if (!error) return { code: fallbackCode, message: 'Unknown fidelity failure.' };
  const context = error && typeof error === 'object' ? Object.fromEntries(
    Object.entries(error).filter(([key]) => !['name', 'message', 'code', 'stack', 'details'].includes(key))
  ) : undefined;
  return {
    code: error.code || fallbackCode,
    message: error.message || String(error),
    details: error.details || (context && Object.keys(context).length ? context : undefined)
  };
}

function getElectron() {
  // Requiring `electron` from a plain node process returns an executable path,
  // so defer this until an adapter actually needs Electron APIs.  This makes
  // pure unit tests possible with injected render/compare adapters.
  const electron = require('electron');
  if (!electron || typeof electron !== 'object' || !electron.BrowserWindow) {
    throw fidelityError(
      'ELECTRON_MAIN_PROCESS_REQUIRED',
      'The default fidelity adapters must run in Electron’s main process.'
    );
  }
  return electron;
}

function mergeThresholds(overrides = {}) {
  return { ...DEFAULT_THRESHOLDS, ...(overrides || {}) };
}

function normaliseFidelityPolicy(value) {
  return value === FIDELITY_POLICIES.EDITABLE_BEST_EFFORT
    ? FIDELITY_POLICIES.EDITABLE_BEST_EFFORT
    : FIDELITY_POLICIES.STRICT;
}

function normaliseEvidenceMode(value, fidelityPolicy) {
  // Strict verification is deliberately non-negotiable: it always collects
  // the complete browser/Office/OCR/pixel evidence.  Editable best-effort
  // exports instead publish as soon as native-object validation succeeds.
  if (fidelityPolicy !== FIDELITY_POLICIES.EDITABLE_BEST_EFFORT) return EVIDENCE_MODES.FULL;
  return Object.values(EVIDENCE_MODES).includes(value) ? value : EVIDENCE_MODES.FULL;
}

function normaliseTarget(input = {}) {
  const width = Number(input.width || input.widthPx || DEFAULT_TARGET.width);
  const height = Number(input.height || input.heightPx || DEFAULT_TARGET.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw fidelityError('INVALID_RENDER_SIZE', 'Fidelity render dimensions must be positive numbers.', input);
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function nowIso() {
  return new Date().toISOString();
}

function slideNo(index) {
  return String(Number(index) + 1).padStart(3, '0');
}

async function ensureDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true });
  return directory;
}

async function createWorkDirectory(explicitDirectory) {
  if (explicitDirectory) {
    const resolved = path.resolve(explicitDirectory);
    await ensureDirectory(resolved);
    return resolved;
  }
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lve-pptx-fidelity-'));
}

function safeTransientPath(workDir, name) {
  const target = path.resolve(workDir, name);
  const root = path.resolve(workDir) + path.sep;
  if (!target.startsWith(root)) {
    throw fidelityError('UNSAFE_TEMPORARY_PATH', 'Refused to create a fidelity artifact outside its work directory.', { workDir, name });
  }
  return target;
}

function cloneSceneGraph(sceneGraph) {
  // Scene graphs are JSON-shaped data from the renderer iframe. Clone before
  // any self-heal mutation so the caller's editable source is never changed.
  if (typeof structuredClone === 'function') return structuredClone(sceneGraph);
  return JSON.parse(JSON.stringify(sceneGraph));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function boundsOf(value) {
  const bounds = value?.bounds || value || {};
  const number = (short, long) => {
    const result = Number(bounds[short] ?? bounds[long] ?? 0);
    return Number.isFinite(result) ? result : 0;
  };
  return { x: number('x', 'left'), y: number('y', 'top'), w: number('w', 'width'), h: number('h', 'height') };
}

function intersectionArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function pageSizeForScene(sceneGraph) {
  const pageSize = sceneGraph?.pageSize || {};
  return {
    width: Number(pageSize.widthPx || pageSize.width || 950) || 950,
    height: Number(pageSize.heightPx || pageSize.height || 650) || 650
  };
}

function sceneRegion(region, sceneGraph, target) {
  const pageSize = pageSizeForScene(sceneGraph);
  const xScale = pageSize.width / target.width;
  const yScale = pageSize.height / target.height;
  return {
    x: Number(region?.x || 0) * xScale,
    y: Number(region?.y || 0) * yScale,
    w: Number(region?.width || region?.w || 0) * xScale,
    h: Number(region?.height || region?.h || 0) * yScale
  };
}

function nodeChildren(nodes) {
  const byParent = new Map();
  for (const node of nodes || []) {
    if (!node?.parentId) continue;
    if (!byParent.has(node.parentId)) byParent.set(node.parentId, []);
    byParent.get(node.parentId).push(node.id);
  }
  return byParent;
}

function hasSelectedAncestor(nodeId, selectedIds, byParent, nodesById) {
  let current = nodesById.get(nodeId);
  while (current?.parentId) {
    if (selectedIds.has(current.parentId)) return true;
    current = nodesById.get(current.parentId);
  }
  return false;
}

function pickHealCandidates(sceneGraph, slideIndex, visual, target, round) {
  const slide = sceneGraph?.slides?.[slideIndex];
  if (!slide || !Array.isArray(slide.nodes)) return [];
  const nodesById = new Map(slide.nodes.filter((node) => node?.id).map((node) => [node.id, node]));
  const byParent = nodeChildren(slide.nodes);
  const regions = (visual?.regions || [])
    .filter((region) => Number(region?.area) > 0 && Number(region?.width || region?.w) > 0 && Number(region?.height || region?.h) > 0)
    .slice()
    .sort((a, b) => Number(b.area || 0) - Number(a.area || 0));
  const selected = [];
  const selectedIds = new Set();
  // Round two exists specifically to protect native text until a non-text bake
  // has failed. It focuses on the largest residual region and prefers text.
  const regionsToInspect = round === 2 ? regions.slice(0, 1) : regions;
  for (const region of regionsToInspect) {
    const inScene = sceneRegion(region, sceneGraph, target);
    const regionArea = inScene.w * inScene.h;
    if (!(regionArea > 0)) continue;
    const matches = slide.nodes
      .filter((node) => node?.id && node.parentId && HEALABLE_RENDER_KINDS.has(node.renderAs))
      .filter((node) => round !== 1 || !TEXTUAL_RENDER_KINDS.has(node.renderAs))
      .filter((node) => !selectedIds.has(node.id) && !hasSelectedAncestor(node.id, selectedIds, byParent, nodesById))
      .map((node) => {
        const bounds = boundsOf(node);
        const overlap = intersectionArea(bounds, inScene);
        return { node, bounds, overlap, coverage: overlap / regionArea };
      })
      .filter((candidate) => candidate.coverage >= 0.5)
      .sort((a, b) => {
        const textRank = (candidate) => TEXTUAL_RENDER_KINDS.has(candidate.node.renderAs) ? 1 : 0;
        // First round: non-text only. Second round: text earns first choice.
        const kind = round === 2 ? textRank(a) - textRank(b) : textRank(a) - textRank(b);
        if (kind) return round === 2 ? -kind : kind;
        const area = a.bounds.w * a.bounds.h - b.bounds.w * b.bounds.h;
        if (area) return area;
        const order = Number(a.node.order || 0) - Number(b.node.order || 0);
        return order || String(a.node.id).localeCompare(String(b.node.id));
      });
    const winner = matches[0];
    if (!winner) continue;
    selected.push({
      slideIndex,
      nodeId: winner.node.id,
      region: { ...region },
      sceneRegion: inScene,
      coverage: winner.coverage,
      renderAs: winner.node.renderAs
    });
    selectedIds.add(winner.node.id);
    if (selected.length >= SELF_HEAL_MAX_DEMOTIONS_PER_ROUND) break;
  }
  return selected;
}

function demoteSceneNodes(sceneGraph, plans) {
  const scene = cloneSceneGraph(sceneGraph);
  const bySlide = new Map();
  for (const plan of plans || []) {
    if (!Number.isInteger(plan?.slideIndex) || !plan?.nodeId) continue;
    if (!bySlide.has(plan.slideIndex)) bySlide.set(plan.slideIndex, []);
    bySlide.get(plan.slideIndex).push(plan);
  }
  const requests = [];
  const demoted = [];
  for (const [slideIndex, slidePlans] of bySlide) {
    const slide = scene.slides?.[slideIndex];
    if (!slide || !Array.isArray(slide.nodes)) continue;
    const nodesById = new Map(slide.nodes.filter((node) => node?.id).map((node) => [node.id, node]));
    const children = nodeChildren(slide.nodes);
    const requestedIds = new Set(slidePlans.map((plan) => plan.nodeId));
    const selectedIds = new Set([...requestedIds].filter((id) => {
      const node = nodesById.get(id);
      return node && HEALABLE_RENDER_KINDS.has(node.renderAs) && !hasSelectedAncestor(id, requestedIds, children, nodesById);
    }));
    if (!selectedIds.size) continue;
    const descendants = new Set();
    const queue = [...selectedIds];
    while (queue.length) {
      const parentId = queue.shift();
      for (const childId of children.get(parentId) || []) {
        if (selectedIds.has(childId) || descendants.has(childId)) continue;
        descendants.add(childId);
        queue.push(childId);
      }
    }
    const planFor = new Map(slidePlans.map((plan) => [plan.nodeId, plan]));
    slide.nodes = slide.nodes
      .filter((node) => !descendants.has(node.id))
      .map((node) => {
        if (!selectedIds.has(node.id)) return node;
        const plan = planFor.get(node.id) || {};
        const baked = {
          ...node,
          renderAs: 'bake',
          text: '',
          runs: [],
          unsupported: [...(node.unsupported || []), {
            code: 'SELF_HEAL_BAKE',
            reason: `self-heal round ${plan.round || '?'} demoted this node after a visual mismatch`
          }],
          bake: { bakeId: node.id, reasons: [{ code: 'SELF_HEAL_BAKE', round: plan.round || null, regions: plan.reasons || [] }] }
        };
        delete baked.textLines;
        delete baked.table;
        delete baked.list;
        delete baked.image;
        requests.push({ bakeId: node.id, bounds: node.bounds });
        demoted.push({ slideIndex, nodeId: node.id, renderAs: node.renderAs, reasons: plan.reasons || [] });
        return baked;
      });
    const existing = new Set((slide.bakeRequests || []).map((request) => request.bakeId));
    for (const request of requests.filter((request) => request.bakeId.startsWith(`s${slideIndex}:`))) {
      if (!existing.has(request.bakeId)) {
        slide.bakeRequests = [...(slide.bakeRequests || []), request];
        existing.add(request.bakeId);
      }
    }
  }
  scene.bakeCount = (scene.slides || []).reduce((count, slide) => count + (slide.bakeRequests || []).length, 0);
  return { sceneGraph: scene, requests, demoted };
}

function hashDataUrl(value) {
  return sha256(String(value || ''));
}

const VOID_HTML_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function classValueFromTag(tag) {
  const match = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

// The scene graph intentionally omits CSS such as `outline`, so a cache key
// cannot rely on scene data alone. Fingerprint each slide's authored markup,
// plus everything outside slides (global CSS, scripts, assets) that can alter
// the render. A content edit on slide 3 therefore leaves slides 1/2 reusable,
// while a stylesheet edit correctly invalidates every slide.
function sourceFingerprintForSlide(html, slideIndex) {
  const source = String(html || '');
  const stack = [];
  const slides = [];
  const tags = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][\w:-]*\b[^>]*>/g;
  let match;
  while ((match = tags.exec(source))) {
    const tag = match[0];
    if (/^<!--|^<![^-]/.test(tag)) continue;
    const closing = /^<\//.test(tag);
    const nameMatch = /^<\/?\s*([A-Za-z][\w:-]*)/.exec(tag);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    if (closing) {
      for (let position = stack.length - 1; position >= 0; position -= 1) {
        if (stack[position].name !== name) continue;
        const [entry] = stack.splice(position, 1);
        if (entry.isSlide) slides.push({ start: entry.start, end: tags.lastIndex });
        break;
      }
      continue;
    }
    const entry = {
      name,
      start: match.index,
      isSlide: /(^|\s)slide(\s|$)/.test(classValueFromTag(tag))
    };
    if (!VOID_HTML_TAGS.has(name) && !/\/\s*>$/.test(tag)) stack.push(entry);
  }
  slides.sort((left, right) => left.start - right.start);
  const current = slides[slideIndex];
  if (!current) return sha256(source);
  let outside = '';
  let cursor = 0;
  for (const slide of slides) {
    outside += source.slice(cursor, slide.start);
    cursor = slide.end;
  }
  outside += source.slice(cursor);
  return sha256(stableStringify({
    slide: source.slice(current.start, current.end),
    outside,
    slideCount: slides.length
  }));
}

function uncacheableExternalInput(sceneGraph, html, themeCss) {
  for (const slide of sceneGraph?.slides || []) {
    for (const node of slide?.nodes || []) {
      const source = String(node?.image?.src || '').trim();
      if (source && !/^data:/i.test(source)) return 'external-image';
    }
  }
  const source = `${String(html || '')}\n${String(themeCss || '')}`;
  if (/<link\b[^>]*\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|stylesheet)\b/i.test(source)) {
    return 'external-stylesheet';
  }
  if (/<script\b[^>]*\bsrc\s*=/i.test(source)) return 'external-script';
  if (/url\(\s*(?!['"]?data:)[^)]+\)/i.test(source)) return 'external-css-asset';
  return null;
}

function slideCacheKey({ sceneGraph, slideIndex, themeCss, html, thresholds, target }) {
  const slide = sceneGraph?.slides?.[slideIndex] || {};
  const bakeIds = new Set([
    ...(slide.bakeRequests || []).map((request) => request.bakeId),
    ...(slide.nodes || []).filter((node) => node?.renderAs === 'bake').map((node) => node.id)
  ]);
  const bakeHashes = [...bakeIds].sort().reduce((result, id) => {
    result[id] = hashDataUrl(sceneGraph?.bakes?.[id]);
    return result;
  }, {});
  return sha256(stableStringify({
    rendererVersion: PPTX_RENDERER_VERSION,
    pageSize: pageSizeForScene(sceneGraph),
    target: normaliseTarget(target),
    slide: { nodes: slide.nodes || [], bakeRequests: slide.bakeRequests || [] },
    bakeHashes,
    themeCssHash: sha256(String(themeCss || '')),
    sourceFingerprint: sourceFingerprintForSlide(html, slideIndex),
    thresholds
  }));
}

async function readSlideCache(cachePath) {
  if (!cachePath) return { entries: {} };
  try {
    const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
    return parsed && typeof parsed.entries === 'object' ? parsed : { entries: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: {} };
    return { entries: {}, error: asErrorInfo(error, 'FIDELITY_CACHE_READ_FAILED') };
  }
}

async function writeSlideCache(cachePath, cache) {
  if (!cachePath) return;
  await ensureDirectory(path.dirname(cachePath));
  const temporary = `${cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(cache, null, 2), 'utf8');
  await fsp.rename(temporary, cachePath);
}

function pngBufferFromDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || ''));
  return match ? Buffer.from(match[1], 'base64') : null;
}

async function persistCachedBakes(bakes, cacheBakeDirectory) {
  const result = {};
  const entries = Object.entries(bakes || {});
  if (!entries.length) return result;
  if (!cacheBakeDirectory) throw fidelityError('FIDELITY_CACHE_BAKE_DIR_MISSING', 'A stable cache bake directory is required to cache healed bakes.');
  await ensureDirectory(cacheBakeDirectory);
  for (const [id, dataUrl] of entries) {
    const buffer = pngBufferFromDataUrl(dataUrl);
    if (!buffer) throw fidelityError('FIDELITY_CACHE_BAKE_INVALID', `Healed bake ${id} was not a PNG data URL.`);
    const hash = sha256(buffer);
    const file = `${hash}.png`;
    const destination = path.join(cacheBakeDirectory, file);
    if (!fs.existsSync(destination)) await fsp.writeFile(destination, buffer);
    result[id] = { hash, file };
  }
  return result;
}

async function loadCachedBakes(entry, cacheBakeDirectory) {
  const assets = entry?.healedBakes || {};
  const ids = Object.keys(assets);
  if (!ids.length) return {};
  if (!cacheBakeDirectory) return null;
  const bakes = {};
  for (const id of ids) {
    const asset = assets[id] || {};
    if (!/^[a-f0-9]{64}$/i.test(asset.hash || '') || asset.file !== `${asset.hash}.png`) return null;
    try {
      const buffer = await fsp.readFile(path.join(cacheBakeDirectory, asset.file));
      if (sha256(buffer) !== asset.hash) return null;
      bakes[id] = `data:image/png;base64,${buffer.toString('base64')}`;
    } catch (_) {
      return null;
    }
  }
  return bakes;
}

function visualForCache(visual) {
  if (!visual || typeof visual !== 'object') return null;
  const { heatmapPath, ...metrics } = visual;
  return cloneSceneGraph(metrics);
}

async function removeIfExists(filePath) {
  try { await fsp.unlink(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function canRemoveWorkDirectory(workDir) {
  if (!workDir) return false;
  const resolved = path.resolve(workDir);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  return resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('lve-pptx-fidelity-');
}

/**
 * Explicit disposal only.  Verification retains evidence by default so a
 * rejected export can show the source, PowerPoint render, heatmap, and report.
 */
async function disposeFidelityWorkDirectory(workDir) {
  if (!canRemoveWorkDirectory(workDir)) {
    throw fidelityError('UNSAFE_CLEANUP_TARGET', 'Refused to remove a non-fidelity work directory.', { workDir });
  }
  await fsp.rm(workDir, { recursive: true, force: true });
}

function normaliseFontName(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function firstSpecificFont(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    // A scene can retain the browser-facing CSS alias for traceability while
    // carrying the physical face name PowerPoint must resolve. Prefer that
    // native face: Office cannot consume Chromium @font-face aliases.
    value = value.powerPointFontFamily || value.resolvedFontFamily || value.family || value.fontFamily || value.name || '';
  }
  const candidates = Array.isArray(value) ? value : String(value).split(',');
  for (const candidate of candidates) {
    const cleaned = String(candidate).trim().replace(/^['"]|['"]$/g, '');
    if (cleaned && !GENERIC_FONT_FAMILIES.has(normaliseFontName(cleaned))) return cleaned;
  }
  return null;
}

function collectRequiredFonts(sceneGraph, explicitFonts) {
  const result = new Map();
  const add = (value) => {
    const font = firstSpecificFont(value);
    if (font) result.set(normaliseFontName(font), font);
  };

  if (Array.isArray(explicitFonts)) explicitFonts.forEach(add);
  if (!sceneGraph || typeof sceneGraph !== 'object') return [...result.values()];
  // The versioned scene graph's top-level list is the exact resolved native
  // face set, not a convenience hint. If present, do not recursively add CSS
  // aliases from node styles or a valid PowerPoint install would be rejected
  // for a browser-only @font-face name.
  if (Array.isArray(sceneGraph.requiredFonts) && sceneGraph.requiredFonts.length) {
    sceneGraph.requiredFonts.forEach(add);
    return [...result.values()];
  }

  const seen = new Set();
  const visit = (value, key = '') => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }
    const nativeFace = value.powerPointFontFamily || value.resolvedFontFamily;
    if (typeof nativeFace === 'string') add(nativeFace);
    for (const [childKey, child] of Object.entries(value)) {
      const lowerKey = childKey.toLowerCase();
      if (typeof child === 'string' && (
        lowerKey === 'fontfamily' || lowerKey === 'font-family' || lowerKey === 'font' ||
        lowerKey === 'ff'
      )) {
        // Browser aliases are a fallback only when this object did not state
        // a physical Office face.
        if (!nativeFace) add(child);
      } else if (child && typeof child === 'object') {
        visit(child, lowerKey);
      }
    }
  };
  visit(sceneGraph);
  return [...result.values()];
}

function sourceFontCheckEntries(sceneGraph, nativeFonts) {
  // Browser @font-face aliases can intentionally differ from the physical
  // family Office sees. Preflight uses the physical face, while the Chromium
  // check must ask for the alias actually declared by the HTML.
  const entries = new Map();
  const add = (native, browserFamily) => {
    const nativeFace = firstSpecificFont(native);
    if (!nativeFace) return;
    const browserFace = firstSpecificFont(browserFamily) || nativeFace;
    entries.set(normaliseFontName(nativeFace), { font: nativeFace, browserFamily: browserFace });
  };
  for (const descriptor of Array.isArray(sceneGraph?.requiredFonts) ? sceneGraph.requiredFonts : []) {
    if (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)) {
      add(descriptor, descriptor.browserFamily || descriptor.fontFamily || descriptor.family);
    } else {
      add(descriptor, descriptor);
    }
  }
  for (const font of nativeFonts || []) {
    if (!entries.has(normaliseFontName(font))) add(font, font);
  }
  return [...entries.values()];
}

function sceneSlideCount(sceneGraph, fallback) {
  if (sceneGraph && Array.isArray(sceneGraph.slides)) return sceneGraph.slides.length;
  return Number.isInteger(fallback) ? fallback : 0;
}

function sceneTextForSlide(sceneGraph, index) {
  const slide = sceneGraph?.slides?.[index];
  if (!slide) return '';
  if (typeof slide.expectedDomText === 'string') return slide.expectedDomText;
  if (typeof slide.expectedText === 'string') return slide.expectedText;
  if (Array.isArray(slide.expectedText)) {
    return slide.expectedText
      .map((entry) => typeof entry === 'string' ? entry : entry?.text)
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (typeof slide.plainText === 'string') return slide.plainText;
  if (typeof slide.text === 'string') return slide.text;
  const pieces = [];
  const seen = new Set();
  const walk = (value, key = '') => {
    if (value == null || seen.has(value)) return;
    if (typeof value === 'string') {
      if (/^(text|plaintext|content|value|html)$/i.test(key)) pieces.push(stripHtml(value));
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else Object.entries(value).forEach(([childKey, child]) => walk(child, childKey));
  };
  walk(slide);
  return pieces.filter(Boolean).join(' ');
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function injectBaseHref(html, baseDir) {
  if (!baseDir || /<base\s/i.test(html)) return html;
  const href = pathToFileURL(path.resolve(baseDir) + path.sep).href.replace(/"/g, '%22');
  const base = `<base href="${href}">`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => head + base);
  return `<!doctype html><head>${base}</head>${html}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, code, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(fidelityError(code, message, { timeoutMs })), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function parseLastJson(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch (_) { /* keep looking */ }
  }
  throw fidelityError('INVALID_RENDERER_RESPONSE', 'The PowerPoint renderer did not return a JSON result.', { stdout });
}

function spawnText(command, args, options = {}) {
  const { timeoutMs = 30000, cwd, windowsHide = true, input } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) {}
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(fidelityError('PROCESS_TIMEOUT', `${path.basename(command)} timed out.`, { command, args, timeoutMs, signal, stdout, stderr }));
      } else {
        resolve({ code, signal, stdout, stderr });
      }
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

async function findPowerPointExecutable() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(process.env.ProgramFiles || '', 'Microsoft Office', 'root', 'Office16', 'POWERPNT.EXE'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft Office', 'root', 'Office16', 'POWERPNT.EXE'),
    path.join(process.env.ProgramFiles || '', 'Microsoft Office', 'Office16', 'POWERPNT.EXE'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft Office', 'Office16', 'POWERPNT.EXE')
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$keys = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\POWERPNT.EXE', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\POWERPNT.EXE')",
    'foreach ($key in $keys) { if (Test-Path $key) { $v = (Get-ItemProperty -LiteralPath $key).\'(default)\'; if ($v) { [Console]::Out.Write($v); exit 0 } } }',
    'exit 1'
  ].join('; ');
  try {
    const result = await spawnText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 10000 });
    const located = result.stdout.trim().replace(/^"|"$/g, '');
    return result.code === 0 && located && fs.existsSync(located) ? located : null;
  } catch (_) {
    return null;
  }
}

let installedFontsPromise = null;

async function listInstalledFontFamilies(options = {}) {
  // Font provisioning can happen while the Electron main process is already
  // running. Export preflight is a gate, not a startup capability check, so it
  // must be able to see fonts that Windows has just registered.
  if (options.refresh) installedFontsPromise = null;
  if (installedFontsPromise) return installedFontsPromise;
  installedFontsPromise = (async () => {
    if (process.platform !== 'win32') return [];
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Drawing',
      '$fonts = New-Object System.Drawing.Text.InstalledFontCollection',
      '$names = @($fonts.Families | ForEach-Object { $_.Name } | Sort-Object -Unique)',
      '[Console]::Out.Write(($names | ConvertTo-Json -Compress))'
    ].join('; ');
    const result = await spawnText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30000 });
    if (result.code !== 0) {
      throw fidelityError('FONT_ENUMERATION_FAILED', result.stderr || 'Windows font enumeration failed.');
    }
    const parsed = JSON.parse(result.stdout || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(String);
  })();
  try {
    return await installedFontsPromise;
  } catch (error) {
    installedFontsPromise = null;
    throw error;
  }
}

async function preflightDesktopPowerPoint(options = {}) {
  const requiredFonts = collectRequiredFonts(options.sceneGraph, options.requiredFonts);
  if (process.platform !== 'win32') {
    return {
      ok: false,
      stage: 'preflight',
      powerpoint: { ok: false, error: 'Desktop PowerPoint verification is supported only on Windows.' },
      requiredFonts,
      missingFonts: requiredFonts,
      errors: [{ code: 'WINDOWS_POWERPOINT_REQUIRED', message: 'Desktop PowerPoint is required for verified PPTX export.' }]
    };
  }

  const errors = [];
  const powerpointPath = options.powerpointPath || await findPowerPointExecutable();
  if (!powerpointPath) {
    errors.push({ code: 'POWERPOINT_MISSING', message: 'Microsoft PowerPoint desktop is not installed or registered.' });
  }

  let installedFonts = [];
  try {
    // Re-enumerate on every real preflight. This avoids holding a stale
    // "missing font" result after a user installs the required typeface.
    installedFonts = options.installedFonts || await listInstalledFontFamilies({ refresh: true });
  } catch (error) {
    errors.push(asErrorInfo(error, 'FONT_ENUMERATION_FAILED'));
  }
  const installedByName = new Set(installedFonts.map(normaliseFontName));
  const missingFonts = requiredFonts.filter((font) => !installedByName.has(normaliseFontName(font)));
  for (const font of missingFonts) {
    errors.push({ code: 'REQUIRED_FONT_MISSING', message: `Required font is not installed: ${font}`, font });
  }

  return {
    ok: errors.length === 0,
    stage: 'preflight',
    powerpoint: { ok: Boolean(powerpointPath), path: powerpointPath || null },
    requiredFonts,
    installedFonts,
    missingFonts,
    errors
  };
}

function sourceRenderScript(selector, index, target, requiredFonts, captureTextLayout) {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const index = ${Number(index)};
    const target = ${JSON.stringify(target)};
    const requiredFonts = ${JSON.stringify(requiredFonts || [])};
    const captureTextLayout = ${Boolean(captureTextLayout)};
    const slides = Array.from(document.querySelectorAll(selector));
    if (!slides[index]) throw new Error('Slide ' + (index + 1) + ' is not present.');
    // renderHtmlSlides invokes this script once per slide in the same hidden
    // BrowserWindow. Restore the original inline state before choosing the
    // next slide; otherwise rendering slide 1 leaves every later slide
    // display:none and slide 2 falsely has zero bounds.
    const originalStyles = window.__lveFidelityOriginalSlideStyles || new Map();
    if (!window.__lveFidelityOriginalSlideStyles) {
      window.__lveFidelityOriginalSlideStyles = originalStyles;
      slides.forEach((candidate) => originalStyles.set(candidate, candidate.getAttribute('style')));
    }
    slides.forEach((candidate) => {
      const original = originalStyles.get(candidate);
      if (original == null) candidate.removeAttribute('style');
      else candidate.setAttribute('style', original);
    });
    const slide = slides[index];
    slides.forEach((candidate, candidateIndex) => {
      // Keep the selected slide's own display mode. A cover may be an inline
      // flex container; forcing it to block creates a source reference that
      // no longer matches the browser-measured scene graph and falsely blames
      // the native PPTX renderer for a layout change made by the verifier.
      if (candidateIndex !== index) candidate.style.setProperty('display', 'none', 'important');
      if (candidateIndex === index) {
        candidate.style.setProperty('position', 'absolute', 'important');
        candidate.style.setProperty('left', '0px', 'important');
        candidate.style.setProperty('top', '0px', 'important');
        candidate.style.setProperty('margin', '0px', 'important');
        candidate.style.setProperty('transform', 'none', 'important');
        candidate.style.setProperty('transform-origin', '0 0', 'important');
        candidate.style.setProperty('zoom', '1', 'important');
      }
    });
    document.documentElement.style.setProperty('margin', '0', 'important');
    document.documentElement.style.setProperty('padding', '0', 'important');
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    document.body.style.setProperty('margin', '0', 'important');
    document.body.style.setProperty('padding', '0', 'important');
    document.body.style.setProperty('overflow', 'hidden', 'important');
    document.body.style.setProperty('background', '#fff', 'important');
    const before = slide.getBoundingClientRect();
    if (!before.width || !before.height) throw new Error('Slide has no measurable bounds.');
    const directLayout = (scale) => Array.from(slide.children).map((child) => {
      const rect = child.getBoundingClientRect();
      return {
        x: (rect.left - before.left) / scale,
        y: (rect.top - before.top) / scale,
        width: rect.width / scale,
        height: rect.height / scale
      };
    });
    const sourceLayout = directLayout(1);
    const scaleX = target.width / before.width;
    const scaleY = target.height / before.height;
    if (Math.abs(scaleX - scaleY) > 0.002) {
      throw new Error('Slide aspect ratio does not match the requested fidelity render size.');
    }
    // CSS zoom participates in flex layout. It changed space-between gaps on
    // the nested cover after extraction, producing a reference image that did
    // not match the measured scene. A compositor transform scales the already
    // laid-out 950x650 slide to the required physical bitmap without reflow.
    slide.style.setProperty('transform', 'scale(' + scaleX + ')', 'important');
    const bounds = slide.getBoundingClientRect();
    const renderedLayout = directLayout(scaleX);
    const layoutDelta = sourceLayout.reduce((largest, item, itemIndex) => {
      const rendered = renderedLayout[itemIndex];
      if (!rendered) return Number.POSITIVE_INFINITY;
      return Math.max(largest,
        Math.abs(item.x - rendered.x), Math.abs(item.y - rendered.y),
        Math.abs(item.width - rendered.width), Math.abs(item.height - rendered.height));
    }, 0);
    const fontChecks = requiredFonts.map((entry) => {
      const font = entry && typeof entry === 'object' ? entry.font : entry;
      const browserFamily = entry && typeof entry === 'object'
        ? (entry.browserFamily || entry.font || entry.family)
        : entry;
      return {
        font: String(font || ''),
        browserFamily: String(browserFamily || ''),
        loaded: !document.fonts || document.fonts.check('16px "' + String(browserFamily || '').replace(/"/g, '\\"') + '"', 'Abc مرحبا')
      };
    });
    const normaliseText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const textLayout = !captureTextLayout ? null : Array.from(slide.querySelectorAll('*'))
      .filter((element) => Array.from(element.childNodes).some((node) =>
        node.nodeType === Node.TEXT_NODE && normaliseText(node.nodeValue)))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          text: normaliseText(element.textContent),
          bounds: {
            x: (rect.left - bounds.left) / scaleX,
            y: (rect.top - bounds.top) / scaleY,
            w: rect.width / scaleX,
            h: rect.height / scaleY
          }
        };
      });
    return {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      sourceBounds: { width: before.width, height: before.height },
      display: getComputedStyle(slide).display,
      sourceLayout,
      renderedLayout,
      layoutDelta,
      domText: (slide.innerText || slide.textContent || '').replace(/\\s+/g, ' ').trim(),
      fontChecks,
      textLayout
    };
  })()`;
}

function sourceRenderGeometry(options) {
  const html = options.html;
  if (typeof html !== 'string' || !html.trim()) {
    throw fidelityError('SOURCE_HTML_REQUIRED', 'Source HTML is required for the fidelity render.');
  }
  const target = normaliseTarget(options.target);
  const captureTarget = normaliseTarget(options.sourceSize || options.sceneGraph?.pageSize || target);
  const captureRatio = captureTarget.width / captureTarget.height;
  const targetRatio = target.width / target.height;
  if (Math.abs(captureRatio - targetRatio) > 0.002) {
    throw fidelityError(
      'SOURCE_RENDER_ASPECT_MISMATCH',
      `The source slide canvas ${captureTarget.width}x${captureTarget.height} does not match the fidelity target ${target.width}x${target.height}.`,
      { captureTarget, target }
    );
  }
  return { target, captureTarget };
}

/**
 * Open the hidden Chromium window every source-side capture shares: the
 * per-slide reference renders and the element crops that back scene bakes.
 * The caller owns the returned window and must destroy it.
 */
async function openSourceRenderWindow(options, target, captureTarget, outputDir) {
  const sourcePath = safeTransientPath(outputDir, '__source.html');
  await fsp.writeFile(sourcePath, injectBaseHref(options.html, options.baseDir), 'utf8');

  const { BrowserWindow } = getElectron();
  const window = new BrowserWindow({
    // Keep the native host window at the slide's natural CSS canvas. The
    // virtual DevTools viewport below supplies the fidelity bitmap canvas.
    width: captureTarget.width,
    height: captureTarget.height,
    show: false,
    useContentSize: true,
    // The native host is deliberately small; the virtual viewport below is
    // independent of the active Windows work area.
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });
  try {
    await withTimeout(window.loadFile(sourcePath), options.loadTimeoutMs || 30000, 'SOURCE_RENDER_TIMEOUT', 'Chromium timed out loading the source HTML.');
    try {
      window.webContents.debugger.attach('1.3');
      await withTimeout(
        window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: target.width,
          height: target.height,
          deviceScaleFactor: 1,
          mobile: false,
          screenWidth: target.width,
          screenHeight: target.height
        }),
        options.readyTimeoutMs || 30000,
        'SOURCE_RENDER_TIMEOUT',
        'Chromium timed out creating the fidelity render viewport.'
      );
    } catch (error) {
      throw fidelityError(
        'SOURCE_RENDER_EMULATION_FAILED',
        'Chromium could not create the required source-render viewport.',
        { target, error: asErrorInfo(error, 'SOURCE_RENDER_EMULATION_FAILED') }
      );
    }
    await withTimeout(window.webContents.executeJavaScript(`(async () => {
      try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (_) {}
      await Promise.all(Array.from(document.images || []).map((image) => image.complete ? null : new Promise((resolve) => { image.onload = image.onerror = resolve; })));
      await new Promise((resolve) => setTimeout(resolve, 150));
      return true;
    })()`, true), options.readyTimeoutMs || 30000, 'SOURCE_RENDER_TIMEOUT', 'Chromium timed out waiting for fonts or images.');
    return { window, sourcePath };
  } catch (error) {
    if (window.webContents?.debugger?.isAttached()) {
      try { window.webContents.debugger.detach(); } catch (_) {}
    }
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

async function renderHtmlSlides(options = {}) {
  const { target, captureTarget } = sourceRenderGeometry(options);
  const selector = options.slideSelector || '.slide';
  const expectedSlideCount = Number.isInteger(options.expectedSlideCount) ? options.expectedSlideCount : undefined;
  const requiredFonts = options.requiredFonts || [];
  const outputDir = await ensureDirectory(options.outputDir);
  const { nativeImage } = getElectron();
  let window = null;
  let sourcePath = null;
  try {
    ({ window, sourcePath } = await openSourceRenderWindow(options, target, captureTarget, outputDir));

    const count = await window.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(selector)}).length`, true);
    if (!count) throw fidelityError('SOURCE_SLIDES_MISSING', `No slides matched ${selector}.`);
    if (expectedSlideCount != null && count !== expectedSlideCount) {
      throw fidelityError('SOURCE_SLIDE_COUNT_MISMATCH', `Expected ${expectedSlideCount} source slides, found ${count}.`, { expectedSlideCount, actualSlideCount: count });
    }

    const slides = [];
    for (let index = 0; index < count; index += 1) {
      let metadata;
      try {
        metadata = await window.webContents.executeJavaScript(
          sourceRenderScript(selector, index, target, requiredFonts, options.captureTextLayout), true);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        const code = /aspect ratio/i.test(message) ? 'SOURCE_SLIDE_ASPECT_MISMATCH' : 'SOURCE_SLIDE_RENDER_FAILED';
        throw fidelityError(code, `Slide ${index + 1}: ${message}`, { slideIndex: index });
      }
      await delay(30);
      const screenshot = await withTimeout(
        window.webContents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          clip: { x: 0, y: 0, width: target.width, height: target.height, scale: 1 },
          captureBeyondViewport: true,
          fromSurface: true
        }),
        options.captureTimeoutMs || 30000,
        'SOURCE_RENDER_TIMEOUT',
        `Chromium timed out capturing source slide ${index + 1}.`
      );
      const image = nativeImage.createFromBuffer(Buffer.from(screenshot.data, 'base64'));
      const size = image.getSize();
      if (size.width !== target.width || size.height !== target.height) {
        throw fidelityError(
          'SOURCE_RENDER_SIZE_MISMATCH',
          `Chromium captured ${size.width}x${size.height}, not the required fidelity target ${target.width}x${target.height}.`,
          { captureSize: size, captureTarget, target }
        );
      }
      const imagePath = path.join(outputDir, `source-slide-${slideNo(index)}.png`);
      await fsp.writeFile(imagePath, image.toPNG());
      slides.push({
        index,
        path: imagePath,
        ...metadata,
        captureBounds: metadata.bounds,
        bounds: { x: 0, y: 0, width: target.width, height: target.height },
        captureSize: size,
        renderSize: target
      });
    }
    return { ok: true, target, slides, sourceHtmlPath: sourcePath };
  } finally {
    if (window?.webContents?.debugger?.isAttached()) {
      try { window.webContents.debugger.detach(); } catch (_) {}
    }
    if (window && !window.isDestroyed()) window.destroy();
  }
}

// A bakeId is `s<slideIndex>:<childPath>`, where the path is the chain of
// child indexes from the slide element down to the node (see serializeForPptx).
function parseBakeId(bakeId) {
  const match = /^s(\d+):(.*)$/.exec(String(bakeId || ''));
  if (!match) return null;
  return { slideIndex: Number(match[1]), path: match[2] };
}

function bakeCaptureScript(selector, slideIndex, path) {
  return `(() => {
    const slides = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const slide = slides[${Number(slideIndex)}];
    if (!slide) throw new Error('Slide ${Number(slideIndex) + 1} is not present.');
    const node = ${JSON.stringify(String(path))}.split('.')
      .reduce((element, index) => element && element.children[Number(index)], slide);
    if (!node) throw new Error('Bake node path ${String(path)} did not resolve.');
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()`;
}

/**
 * Capture one PNG per scene bake request by cropping the live, already
 * slide-isolated page — the same Chromium that produces the reference render,
 * so a bake can never disagree with the image it is measured against.
 *
 * The slide is transform-scaled to the fidelity target (1900x1300 = 2x the
 * 950x650 canvas) before cropping, so a scale:1 clip already yields a 2x
 * bitmap of the node's CSS bounds.
 */
async function captureBakes(options = {}) {
  const requests = options.requests || [];
  if (!requests.length) return { ok: true, bakes: {}, files: {}, captured: 0, deduplicated: 0 };
  const { target, captureTarget } = sourceRenderGeometry(options);
  const selector = options.slideSelector || '.slide';
  const outputDir = await ensureDirectory(options.outputDir || path.join(options.workDir, 'bakes'));
  const { nativeImage } = getElectron();

  const bySlide = new Map();
  for (const request of requests) {
    const parsed = parseBakeId(request.bakeId);
    if (!parsed) throw fidelityError('BAKE_ID_INVALID', `Bake id ${request.bakeId} is not addressable.`, { request });
    if (!bySlide.has(parsed.slideIndex)) bySlide.set(parsed.slideIndex, []);
    bySlide.get(parsed.slideIndex).push({ ...request, ...parsed });
  }

  let window = null;
  const bakes = {};
  const files = {};
  const byHash = new Map();
  let captured = 0, deduplicated = 0;
  try {
    ({ window } = await openSourceRenderWindow(options, target, captureTarget, outputDir));
    for (const slideIndex of Array.from(bySlide.keys()).sort((a, b) => a - b)) {
      // Reuse the reference renderer's isolation so the node sits in the same
      // place, at the same scale, as it does in the image we compare against.
      await window.webContents.executeJavaScript(sourceRenderScript(selector, slideIndex, target, [], false), true);
      await delay(30);
      for (const request of bySlide.get(slideIndex)) {
        const rect = await window.webContents.executeJavaScript(
          bakeCaptureScript(selector, slideIndex, request.path), true);
        if (!(rect.width > 0) || !(rect.height > 0)) {
          throw fidelityError('BAKE_BOUNDS_EMPTY', `Bake ${request.bakeId} has no measurable bounds.`, { rect, request });
        }
        const screenshot = await withTimeout(
          window.webContents.debugger.sendCommand('Page.captureScreenshot', {
            format: 'png',
            clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
            captureBeyondViewport: true,
            fromSurface: true
          }),
          options.captureTimeoutMs || 30000,
          'BAKE_CAPTURE_TIMEOUT',
          `Chromium timed out capturing bake ${request.bakeId}.`
        );
        const buffer = nativeImage.createFromBuffer(Buffer.from(screenshot.data, 'base64')).toPNG();
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        if (byHash.has(hash)) {
          deduplicated += 1;
        } else {
          const imagePath = path.join(outputDir, `bake-${hash.slice(0, 16)}.png`);
          await fsp.writeFile(imagePath, buffer);
          byHash.set(hash, { imagePath, dataUrl: `data:image/png;base64,${buffer.toString('base64')}` });
          captured += 1;
        }
        const entry = byHash.get(hash);
        bakes[request.bakeId] = entry.dataUrl;
        files[request.bakeId] = entry.imagePath;
      }
    }
    return { ok: true, bakes, files, captured, deduplicated, requested: requests.length };
  } finally {
    if (window?.webContents?.debugger?.isAttached()) {
      try { window.webContents.debugger.detach(); } catch (_) {}
    }
    if (window && !window.isDestroyed()) window.destroy();
  }
}

function numericSlideSort(a, b) {
  const numberOf = (value) => {
    const match = String(value).match(/(\d+)(?!.*\d)/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  return numberOf(a) - numberOf(b) || String(a).localeCompare(String(b));
}

async function readPowerPointPid(pidFile) {
  try {
    const text = await fsp.readFile(pidFile, 'utf8');
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

async function stopOwnedPowerPoint(pidFile) {
  const pid = await readPowerPointPid(pidFile);
  if (!pid || process.platform !== 'win32') return { attempted: false, pid: pid || null };
  try {
    // The PID is written by our renderer script only after it creates the COM
    // application; taskkill is therefore limited to the PowerPoint instance
    // created for this fidelity attempt, never an arbitrary user instance.
    await spawnText('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15000 });
    return { attempted: true, pid, stopped: true };
  } catch (error) {
    return { attempted: true, pid, stopped: false, error: asErrorInfo(error, 'POWERPOINT_CLEANUP_FAILED') };
  }
}

function defaultPowerPointRendererPath() {
  const appRoot = process.resourcesPath && /app\.asar/i.test(__dirname)
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
  return path.join(appRoot, 'tools', 'pptx', 'render-preview.ps1');
}

/**
 * Renders a PPTX with desktop PowerPoint.  The PowerShell helper owns the COM
 * instance and emits its PID into `powerpoint.pid`; on a Node-side timeout we
 * terminate only that recorded process tree.
 */
async function renderPptxWithPowerPoint(options = {}) {
  if (process.platform !== 'win32') {
    throw fidelityError('WINDOWS_POWERPOINT_REQUIRED', 'PowerPoint fidelity rendering is available only on Windows.');
  }
  const pptxPath = path.resolve(options.pptxPath || '');
  if (!pptxPath || !fs.existsSync(pptxPath)) {
    throw fidelityError('PPTX_CANDIDATE_MISSING', 'The temporary editable PPTX to render does not exist.', { pptxPath: options.pptxPath });
  }
  const target = normaliseTarget(options.target);
  const outputDir = await ensureDirectory(options.outputDir);
  const rendererPath = options.rendererPath || defaultPowerPointRendererPath();
  if (!fs.existsSync(rendererPath)) {
    throw fidelityError('POWERPOINT_RENDERER_MISSING', 'The PowerPoint renderer script is missing.', { rendererPath });
  }
  const pidFile = safeTransientPath(outputDir, 'powerpoint.pid');
  await removeIfExists(pidFile);
  const timeoutMs = Number(options.timeoutMs || 120000);

  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', rendererPath,
      '-PptxPath', pptxPath,
      '-OutputDir', outputDir,
      '-Width', String(target.width),
      '-Height', String(target.height),
      '-PowerPointPidFile', pidFile
    ];
    let child;
    try {
      // Every argument above is an absolute path, so this process has no use
      // for the caller's working directory — and inheriting it is harmful:
      // desktop PowerPoint resolves some of its cache folders relative to cwd,
      // which littered the user's project root with 34 junk directories named
      // from uninitialised bytes (each holding an empty `Microsoft` folder)
      // during the mission 033/034 corpus runs. Render from the temp dir.
      child = spawn('powershell.exe', args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: os.tmpdir()
      });
    } catch (error) {
      reject(fidelityError('POWERPOINT_RENDER_START_FAILED', error.message, { cause: error }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutTriggered = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      timeoutTriggered = true;
      try { child.kill(); } catch (_) {}
      stopOwnedPowerPoint(pidFile).then((cleanup) => finish(() => {
        reject(fidelityError(
          'POWERPOINT_RENDER_TIMEOUT',
          `Desktop PowerPoint did not render the PPTX within ${timeoutMs}ms.`,
          { timeoutMs, pptxPath, cleanup, stdout, stderr }
        ));
      }));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(() => {
      reject(fidelityError('POWERPOINT_RENDER_START_FAILED', error.message, { cause: error }));
    }));
    child.on('close', async (code, signal) => {
      if (timeoutTriggered) return;
      finish(async () => {
        try {
          let response = null;
          try { response = parseLastJson(stdout); } catch (parseError) {
            if (code === 0) throw parseError;
          }
          if (code !== 0 || !response || !response.ok) {
            const details = { code, signal, stdout, stderr, response };
            throw fidelityError(
              response?.stage === 'timeout' ? 'POWERPOINT_RENDER_TIMEOUT' : 'POWERPOINT_RENDER_FAILED',
              response?.error || stderr || `PowerPoint renderer exited with code ${code}.`,
              details
            );
          }
          const paths = (response.images || []).map(String).sort(numericSlideSort);
          if (!paths.length) throw fidelityError('POWERPOINT_NO_SLIDES', 'PowerPoint did not produce any PNG slide renders.', { response });
          for (const imagePath of paths) {
            if (!fs.existsSync(imagePath)) {
              throw fidelityError('POWERPOINT_RENDER_ARTIFACT_MISSING', 'PowerPoint reported a render artifact that does not exist.', { imagePath });
            }
            const size = await getPngSize(imagePath);
            if (size.width !== target.width || size.height !== target.height) {
              throw fidelityError(
                'POWERPOINT_RENDER_SIZE_MISMATCH',
                `PowerPoint rendered ${path.basename(imagePath)} at ${size.width}×${size.height}, expected ${target.width}×${target.height}.`,
                { imagePath, actual: size, expected: target }
              );
            }
          }
          await removeIfExists(pidFile);
          resolve({ ok: true, target, slides: paths.map((imagePath, index) => ({ index, path: imagePath })), response });
        } catch (error) {
          const cleanup = await stopOwnedPowerPoint(pidFile);
          reject(error instanceof PptxFidelityError
            ? error
            : fidelityError('POWERPOINT_RENDER_FAILED', error.message || String(error), { stdout, stderr, cleanup }));
        }
      });
    });
  });
}

function parsePngSize(buffer, filePath) {
  const signature = '89504e470d0a1a0a';
  if (!buffer || buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== signature) {
    throw fidelityError('INVALID_PNG', 'Expected a PNG render artifact.', { filePath });
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function getPngSize(filePath) {
  return parsePngSize(await fsp.readFile(filePath), filePath);
}

function decodePng(filePath) {
  const { nativeImage } = getElectron();
  const image = nativeImage.createFromPath(filePath);
  if (!image || image.isEmpty()) throw fidelityError('INVALID_PNG', 'Electron could not decode a PNG render artifact.', { filePath });
  const size = image.getSize();
  return { width: size.width, height: size.height, data: Buffer.from(image.toBitmap()) };
}

function encodePng(bitmap, width, height) {
  const { nativeImage } = getElectron();
  // Electron's main-process API takes the bitmap buffer as its first argument
  // and dimensions separately. Passing a renderer-style `{data, size}` object
  // throws "Insufficient number of arguments" and used to hide the real visual
  // comparison behind a heatmap-write error.
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG();
}

function luma(data, offset) {
  // Electron exposes BGRA bitmaps from nativeImage.toBitmap().
  return data[offset] * 0.114 + data[offset + 1] * 0.587 + data[offset + 2] * 0.299;
}

function calculateWindowedSsim(a, b, width, height, blockSize = 8) {
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let sum = 0;
  let blocks = 0;
  for (let top = 0; top < height; top += blockSize) {
    const bottom = Math.min(height, top + blockSize);
    for (let left = 0; left < width; left += blockSize) {
      const right = Math.min(width, left + blockSize);
      const pixels = (right - left) * (bottom - top);
      let sumA = 0;
      let sumB = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * width + x) * 4;
          sumA += luma(a, offset);
          sumB += luma(b, offset);
        }
      }
      const meanA = sumA / pixels;
      const meanB = sumB / pixels;
      let varianceA = 0;
      let varianceB = 0;
      let covariance = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * width + x) * 4;
          const deltaA = luma(a, offset) - meanA;
          const deltaB = luma(b, offset) - meanB;
          varianceA += deltaA * deltaA;
          varianceB += deltaB * deltaB;
          covariance += deltaA * deltaB;
        }
      }
      const divisor = Math.max(1, pixels - 1);
      varianceA /= divisor;
      varianceB /= divisor;
      covariance /= divisor;
      const score = ((2 * meanA * meanB + c1) * (2 * covariance + c2)) /
        ((meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2));
      sum += Number.isFinite(score) ? score : 0;
      blocks += 1;
    }
  }
  return blocks ? sum / blocks : 0;
}

function findDifferenceRegions(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const regions = [];
  let maxWidth = 0;
  let maxHeight = 0;
  let maxArea = 0;
  const neighbours = [-1, 0, 1];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let area = 0;
    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const dy of neighbours) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (const dx of neighbours) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    const region = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area };
    maxWidth = Math.max(maxWidth, region.width);
    maxHeight = Math.max(maxHeight, region.height);
    maxArea = Math.max(maxArea, area);
    regions.push(region);
  }
  // Self-healing consumes these regions. Retaining the first 50 connected
  // components made a large real mismatch disappear behind glyph speckles;
  // keep the most consequential regions instead.
  regions.sort((a, b) => b.area - a.area || b.width * b.height - a.width * a.height);
  return { regions: regions.slice(0, 50), maxWidth, maxHeight, maxArea };
}

async function compareSlideVisual(options = {}) {
  const thresholds = mergeThresholds(options.thresholds);
  const source = decodePng(options.sourcePath);
  const powerPoint = decodePng(options.powerPointPath);
  if (source.width !== powerPoint.width || source.height !== powerPoint.height) {
    return {
      ok: false,
      error: { code: 'VISUAL_RENDER_SIZE_MISMATCH', message: 'Source and PowerPoint renders have different dimensions.', source: sourceSize(source), powerPoint: sourceSize(powerPoint) }
    };
  }
  const width = source.width;
  const height = source.height;
  const pixels = width * height;
  const mask = new Uint8Array(pixels);
  const heatmap = Buffer.alloc(pixels * 4);
  let mismatchPixels = 0;
  let maxDelta = 0;
  for (let pixel = 0, offset = 0; pixel < pixels; pixel += 1, offset += 4) {
    const delta = Math.max(
      Math.abs(source.data[offset] - powerPoint.data[offset]),
      Math.abs(source.data[offset + 1] - powerPoint.data[offset + 1]),
      Math.abs(source.data[offset + 2] - powerPoint.data[offset + 2]),
      Math.abs(source.data[offset + 3] - powerPoint.data[offset + 3])
    );
    maxDelta = Math.max(maxDelta, delta);
    const changed = delta > thresholds.pixelDelta;
    if (changed) {
      mask[pixel] = 1;
      mismatchPixels += 1;
      // Strong red on a dim source backdrop.  The buffer is BGRA.
      heatmap[offset] = 0;
      heatmap[offset + 1] = 0;
      heatmap[offset + 2] = 255;
      heatmap[offset + 3] = 255;
    } else {
      heatmap[offset] = Math.round(source.data[offset] * 0.22);
      heatmap[offset + 1] = Math.round(source.data[offset + 1] * 0.22);
      heatmap[offset + 2] = Math.round(source.data[offset + 2] * 0.22);
      heatmap[offset + 3] = 255;
    }
  }
  const mismatchPercent = (mismatchPixels / pixels) * 100;
  const ssim = calculateWindowedSsim(source.data, powerPoint.data, width, height);
  const regionSummary = findDifferenceRegions(mask, width, height);
  const heatmapPath = options.heatmapPath;
  if (heatmapPath) {
    await ensureDirectory(path.dirname(heatmapPath));
    await fsp.writeFile(heatmapPath, encodePng(heatmap, width, height));
  }
  const errors = [];
  if (ssim < thresholds.ssim) errors.push({ code: 'SSIM_BELOW_THRESHOLD', message: `SSIM ${ssim.toFixed(7)} is below ${thresholds.ssim}.` });
  if (mismatchPercent > thresholds.pixelMismatchPercent) {
    errors.push({ code: 'PIXEL_MISMATCH_ABOVE_THRESHOLD', message: `Pixel mismatch ${mismatchPercent.toFixed(5)}% exceeds ${thresholds.pixelMismatchPercent}%.` });
  }
  // ADVISORY since mission 034: a whole line of Arabic text rasterised twice
  // always produces one large connected region, so this can never separate a
  // real regression from antialiasing. SSIM + the pixel budget decide the
  // verdict; the regions stay in the report because mission 035's self-heal
  // uses them to target which nodes to demote.
  const regionAdvisory = (regionSummary.maxWidth > thresholds.maxDifferenceRegionWidth ||
      regionSummary.maxHeight > thresholds.maxDifferenceRegionHeight ||
      regionSummary.maxArea > thresholds.maxDifferenceRegionArea)
    ? {
      code: 'DIFFERENCE_REGION_TOO_LARGE',
      message: `Largest difference region is ${regionSummary.maxWidth}×${regionSummary.maxHeight} (${regionSummary.maxArea}px), advisory limit ${thresholds.maxDifferenceRegionWidth}×${thresholds.maxDifferenceRegionHeight} (${thresholds.maxDifferenceRegionArea}px).`
    }
    : null;
  return {
    ok: errors.length === 0,
    ssim,
    mismatchPixels,
    mismatchPercent,
    maxDelta,
    regions: regionSummary.regions,
    maxDifferenceRegion: { width: regionSummary.maxWidth, height: regionSummary.maxHeight, area: regionSummary.maxArea },
    heatmapPath: heatmapPath || null,
    thresholds,
    errors,
    advisories: regionAdvisory ? [regionAdvisory] : []
  };
}

function sourceSize(image) {
  return { width: image.width, height: image.height };
}

function countMatches(text, expression) {
  const matches = String(text || '').match(expression);
  return matches ? matches.length : 0;
}

function xmlBlocks(xml, expression) {
  return String(xml || '').match(expression) || [];
}

function slidePartNumber(partName) {
  const match = String(partName).match(/slide(\d+)\.xml$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function emuSlideSize(presentationXml) {
  const match = String(presentationXml || '').match(/<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function fullSlidePictureCount(xml, slideSize) {
  if (!slideSize) return 0;
  const pictures = xmlBlocks(xml, /<p:pic\b[\s\S]*?<\/p:pic>/gi);
  return pictures.filter((picture) => {
    const offset = picture.match(/<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i);
    const extent = picture.match(/<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i);
    if (!extent) return false;
    const x = offset ? Number(offset[1]) : 0;
    const y = offset ? Number(offset[2]) : 0;
    const width = Number(extent[1]);
    const height = Number(extent[2]);
    // Office libraries regularly round slide geometry by a few hundred EMU.
    // Treat one CSS pixel (9,525 EMU) as full-slide geometry tolerance rather
    // than allowing a screenshot-only deck to evade the audit on rounding.
    const tolerance = 9525;
    return Math.abs(x) <= tolerance && Math.abs(y) <= tolerance &&
      Math.abs(width - slideSize.width) <= tolerance && Math.abs(height - slideSize.height) <= tolerance;
  }).length;
}

function deriveNativeExpectations(sceneGraph, index) {
  const slide = sceneGraph?.slides?.[index];
  const expected = { text: 0, table: 0, shape: 0, image: 0, minNative: 1 };
  if (!slide) return expected;
  // V1 scene graphs already contain one record per visual DOM descendant.
  // Count those records directly so nested table/cell metadata cannot inflate
  // expectations by being traversed a second time as generic objects.
  if (Array.isArray(slide.nodes)) {
    for (const node of slide.nodes) {
      const type = String(node?.renderAs || node?.type || '').toLowerCase();
      if (['text', 'shape-text', 'list'].includes(type)) expected.text += 1;
      if (type === 'table') expected.table += 1;
      if (['slide', 'shape', 'shape-text', 'line'].includes(type)) expected.shape += 1;
      if (type === 'image') expected.image += 1;
    }
    expected.minNative = Math.max(1, expected.text + expected.table + expected.shape ? 1 : 0);
    return expected;
  }
  const seen = new Set();
  const visit = (value, key = '') => {
    if (value == null || seen.has(value)) return;
    if (typeof value === 'string') return;
    if (typeof value !== 'object') return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }
    const type = String(value.renderAs || value.type || value.kind || key || '').toLowerCase();
    if (['text', 'shape-text', 'paragraph', 'list', 'html', 'title', 'subtitle', 'footer', 'richtext'].includes(type)) expected.text += 1;
    if (['table', 'grid'].includes(type)) expected.table += 1;
    if (['slide', 'shape', 'shape-text', 'rect', 'rectangle', 'line', 'border', 'background'].includes(type)) expected.shape += 1;
    if (['image', 'picture', 'figure'].includes(type)) expected.image += 1;
    Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(slide);

  // Legacy serializer compatibility while the new versioned scene graph is
  // being introduced.  It still produces meaningful strict expectations.
  if (slide.h1) expected.text += 1;
  if (slide.h2) expected.text += 1;
  for (const field of ['footerLeft', 'footerRight', 'footerSite']) if (slide[field]) expected.text += 1;
  for (const item of slide.content || []) {
    const type = String(item.type || '').toLowerCase();
    if (type === 'table') expected.table += 1;
    else if (type === 'image' || type === 'figure') expected.image += 1;
    else expected.text += 1;
  }
  expected.minNative = Math.max(1, expected.text + expected.table + expected.shape ? 1 : 0);
  return expected;
}

/**
 * Verifies that a candidate contains actual slide parts and native PowerPoint
 * text/table/shape objects.  A single full-slide image cannot satisfy a slide
 * which the scene graph says contains text/table/shape nodes.
 */
async function auditPptxStructure(options = {}) {
  const pptxPath = options.pptxPath;
  if (!pptxPath || !fs.existsSync(pptxPath)) {
    throw fidelityError('PPTX_CANDIDATE_MISSING', 'Cannot audit a missing PPTX candidate.', { pptxPath });
  }
  let JSZip;
  try { JSZip = require('jszip'); } catch (error) {
    throw fidelityError('PPTX_AUDIT_DEPENDENCY_MISSING', 'JSZip is required to audit PPTX XML.', { cause: error.message });
  }
  const zip = await JSZip.loadAsync(await fsp.readFile(pptxPath));
  const parts = Object.keys(zip.files)
    .filter((part) => /^ppt\/slides\/slide\d+\.xml$/i.test(part))
    .sort((a, b) => slidePartNumber(a) - slidePartNumber(b));
  const expectedSlideCount = Number.isInteger(options.expectedSlideCount)
    ? options.expectedSlideCount
    : sceneSlideCount(options.sceneGraph);
  const errors = [];
  if (expectedSlideCount && parts.length !== expectedSlideCount) {
    errors.push({
      code: 'PPTX_SLIDE_PART_COUNT_MISMATCH',
      message: `PPTX has ${parts.length} slide XML parts, expected ${expectedSlideCount}.`,
      expectedSlideCount,
      actualSlideCount: parts.length
    });
  }
  const presentationXml = zip.file('ppt/presentation.xml')
    ? await zip.file('ppt/presentation.xml').async('string')
    : '';
  const slideSize = emuSlideSize(presentationXml);
  const slides = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const xml = await zip.file(part).async('string');
    const textShapeBlocks = xmlBlocks(xml, /<p:sp\b[\s\S]*?<\/p:sp>/gi)
      .filter((block) => /<p:txBody\b/i.test(block));
    const simpleShapeBlocks = xmlBlocks(xml, /<p:sp\b[\s\S]*?<\/p:sp>/gi);
    const tableCount = countMatches(xml, /<a:tbl\b/gi);
    const pictureCount = countMatches(xml, /<p:pic\b/gi);
    const textRunCount = countMatches(xml, /<a:t(?:\s[^>]*)?>/gi);
    const expected = deriveNativeExpectations(options.sceneGraph, index);
    const fullSlidePictures = fullSlidePictureCount(xml, slideSize);
    const nativeObjectCount = textShapeBlocks.length + tableCount + Math.max(0, simpleShapeBlocks.length - textShapeBlocks.length);
    const slideErrors = [];
    if (nativeObjectCount < expected.minNative) {
      slideErrors.push({ code: 'PPTX_NATIVE_OBJECTS_MISSING', message: 'Slide has no native PowerPoint text, table, or shape objects.' });
    }
    if (expected.text > 0 && textRunCount === 0) {
      slideErrors.push({ code: 'PPTX_NATIVE_TEXT_MISSING', message: 'Scene graph expects text, but the slide XML contains no native text runs.' });
    }
    if (expected.table > 0 && tableCount < expected.table) {
      slideErrors.push({ code: 'PPTX_NATIVE_TABLE_MISSING', message: `Scene graph expects ${expected.table} native table(s), found ${tableCount}.` });
    }
    if (fullSlidePictures > 0 && nativeObjectCount < Math.max(1, expected.text > 0 || expected.table > 0 || expected.shape > 0 ? 1 : 0)) {
      slideErrors.push({ code: 'PPTX_FULL_SLIDE_SCREENSHOT', message: 'A full-slide image is present without the native objects required by the scene graph.' });
    }
    slides.push({
      index,
      part,
      textShapeCount: textShapeBlocks.length,
      textRunCount,
      tableCount,
      pictureCount,
      fullSlidePictureCount: fullSlidePictures,
      nativeObjectCount,
      expected,
      ok: slideErrors.length === 0,
      errors: slideErrors
    });
    errors.push(...slideErrors.map((error) => ({ ...error, slideIndex: index })));
  }
  return {
    ok: errors.length === 0,
    expectedSlideCount,
    actualSlideCount: parts.length,
    slideSize,
    slides,
    errors
  };
}

function normaliseOcrToken(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u200E\u200F\u202A-\u202E]/g, '')
    // OCR word boxes commonly retain adjacent parentheses, colons, and
    // punctuation while DOM tokenisation intentionally does not. Compare the
    // same linguistic token stream on both sides without discarding any
    // letters or digits.
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim()
    .toLocaleLowerCase();
}

function tokeniseText(value) {
  return String(value || '').normalize('NFC').match(/[\p{L}\p{N}]+/gu) || [];
}

function ocrTokens(value) {
  if (Array.isArray(value?.tokens)) return value.tokens.map((token) => ({
    text: String(token.text ?? token.word ?? ''),
    x: Number(token.x ?? token.left ?? 0),
    y: Number(token.y ?? token.top ?? 0),
    w: Number(token.w ?? token.width ?? 0),
    h: Number(token.h ?? token.height ?? 0)
  }));
  return tokeniseText(value?.text).map((text) => ({ text, x: NaN, y: NaN, w: NaN, h: NaN }));
}

function sameTokenOrder(expected, actual) {
  if (expected.length !== actual.length) return false;
  return expected.every((token, index) => normaliseOcrToken(token) === normaliseOcrToken(actual[index]));
}

function compareOcrResult(result, options = {}) {
  if (!result || result.ok === false) {
    return {
      ok: false,
      expectedDomTextMatch: false,
      rtlTokenOrderMatch: false,
      wordPositionsMatch: false,
      errors: [result?.error || { code: 'OCR_FAILED', message: 'OCR did not return a successful result.' }]
    };
  }
  // Adapters used in unit tests may return the three contract booleans
  // directly.  Production adapters should return `source` and `powerPoint`
  // OCR objects with `text` and token rectangles.
  if ('expectedDomTextMatch' in result || 'rtlTokenOrderMatch' in result || 'wordPositionsMatch' in result) {
    const expectedDomTextMatch = result.expectedDomTextMatch !== false;
    const rtlTokenOrderMatch = result.rtlTokenOrderMatch !== false;
    const wordPositionsMatch = result.wordPositionsMatch !== false;
    const errors = [];
    if (!expectedDomTextMatch) errors.push({ code: 'OCR_DOM_TEXT_MISMATCH', message: 'OCR source text does not match expected DOM text.' });
    if (!rtlTokenOrderMatch) errors.push({ code: 'OCR_RTL_TOKEN_ORDER_MISMATCH', message: 'Arabic/English OCR token order differs between source and PowerPoint.' });
    if (!wordPositionsMatch) errors.push({ code: 'OCR_WORD_POSITION_MISMATCH', message: 'OCR word positions differ between source and PowerPoint.' });
    return { ok: errors.length === 0, expectedDomTextMatch, rtlTokenOrderMatch, wordPositionsMatch, errors, raw: result };
  }

  const expectedTokens = tokeniseText(options.expectedDomText);
  const sourceTokens = ocrTokens(result.source);
  const powerPointTokens = ocrTokens(result.powerPoint || result.pptx);
  const expectedDomTextMatch = sameTokenOrder(expectedTokens, sourceTokens.map((token) => token.text));
  const rtlTokenOrderMatch = sameTokenOrder(sourceTokens.map((token) => token.text), powerPointTokens.map((token) => token.text));
  let wordPositionsMatch = rtlTokenOrderMatch;
  const tolerance = Number(options.positionTolerancePx ?? DEFAULT_THRESHOLDS.ocrPositionTolerancePx);
  if (wordPositionsMatch) {
    for (let index = 0; index < sourceTokens.length; index += 1) {
      const source = sourceTokens[index];
      const powerPoint = powerPointTokens[index];
      if (![source.x, source.y, source.w, source.h, powerPoint.x, powerPoint.y, powerPoint.w, powerPoint.h].every(Number.isFinite)) {
        wordPositionsMatch = false;
        break;
      }
      if (Math.abs(source.x - powerPoint.x) > tolerance || Math.abs(source.y - powerPoint.y) > tolerance ||
          Math.abs(source.w - powerPoint.w) > tolerance || Math.abs(source.h - powerPoint.h) > tolerance) {
        wordPositionsMatch = false;
        break;
      }
    }
  }
  const errors = [];
  if (!expectedDomTextMatch) errors.push({ code: 'OCR_DOM_TEXT_MISMATCH', message: 'Source OCR token stream does not match the expected DOM text.' });
  if (!rtlTokenOrderMatch) errors.push({ code: 'OCR_RTL_TOKEN_ORDER_MISMATCH', message: 'PowerPoint OCR token order does not match the source render.' });
  if (!wordPositionsMatch) errors.push({ code: 'OCR_WORD_POSITION_MISMATCH', message: `OCR word positions differ by more than ${tolerance}px.` });
  return {
    ok: errors.length === 0,
    expectedDomTextMatch,
    rtlTokenOrderMatch,
    wordPositionsMatch,
    expectedTokenCount: expectedTokens.length,
    sourceTokenCount: sourceTokens.length,
    powerPointTokenCount: powerPointTokens.length,
    errors,
    raw: result
  };
}

async function runOcrForSlide(ocr, input) {
  if (typeof ocr !== 'function') {
    return {
      ok: false,
      error: {
        code: 'OCR_ENGINE_UNAVAILABLE',
        message: 'A bundled Arabic + English OCR adapter is required for verified PPTX export.'
      }
    };
  }
  try {
    return await ocr({ ...input, languages: ['ara', 'eng'] });
  } catch (error) {
    return { ok: false, error: asErrorInfo(error, 'OCR_FAILED') };
  }
}

async function atomicCommitVerifiedPptx(options = {}) {
  const { tempPptxPath, destinationPath, report } = options;
  if (!report || report.ok !== true) {
    throw fidelityError('UNVERIFIED_EXPORT', 'Refused to replace the selected PPTX because fidelity verification did not pass.');
  }
  if (!tempPptxPath || !destinationPath) {
    throw fidelityError('EXPORT_PATH_REQUIRED', 'Both temporary and destination PPTX paths are required for atomic commit.');
  }
  const source = path.resolve(tempPptxPath);
  const destination = path.resolve(destinationPath);
  if (source === destination) {
    throw fidelityError('UNSAFE_EXPORT_PATH', 'Verified temporary PPTX and selected destination must be different paths.');
  }
  if (!fs.existsSync(source)) {
    throw fidelityError('PPTX_CANDIDATE_MISSING', 'The verified temporary PPTX no longer exists.', { tempPptxPath: source });
  }
  await ensureDirectory(path.dirname(destination));
  try {
    // Node maps rename to MoveFileEx(MOVEFILE_REPLACE_EXISTING) on Windows.
    // No destination write is attempted before every fidelity gate has passed.
    await fsp.rename(source, destination);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      // rename cannot cross volumes (app on D:, user saves to C: or a USB
      // stick). Copy onto the destination's volume first, then rename there:
      // the replace itself stays atomic, so a failed copy never leaves a
      // half-written deck where the user's file was.
      await commitAcrossVolumes(source, destination);
      return destination;
    }
    throw fidelityError(
      'ATOMIC_REPLACE_FAILED',
      `Could not atomically replace the selected PPTX: ${error.message}`,
      { tempPptxPath: source, destinationPath: destination, cause: error.code }
    );
  }
  return destination;
}

async function commitAcrossVolumes(source, destination) {
  const staged = path.join(path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.partial`);
  try {
    await fsp.copyFile(source, staged);
    await fsp.rename(staged, destination);
  } catch (error) {
    await fsp.rm(staged, { force: true }).catch(() => {});
    throw fidelityError(
      'ATOMIC_REPLACE_FAILED',
      `Could not replace the selected PPTX across volumes: ${error.message}`,
      { tempPptxPath: source, destinationPath: destination, cause: error.code }
    );
  }
  // The deck is safely in place; a leftover candidate is only clutter.
  await fsp.rm(source, { force: true }).catch(() => {});
}

function makeInitialReport({ workDir, target, expectedSlideCount, requiredFonts, destinationPath, sceneGraph, fidelityPolicy, evidenceMode }) {
  return {
    format: 'lve.pptx-fidelity-report',
    schemaVersion: 1,
    fidelityVersion: FIDELITY_VERSION,
    startedAt: nowIso(),
    finishedAt: null,
    ok: false,
    verified: false,
    fidelityPolicy,
    evidenceMode,
    stage: 'initializing',
    target,
    expectedSlideCount,
    requiredFonts,
    destinationPath: destinationPath ? path.resolve(destinationPath) : null,
    artifacts: {
      workDir,
      sourceDirectory: path.join(workDir, 'source'),
      powerPointDirectory: path.join(workDir, 'powerpoint'),
      heatmapDirectory: path.join(workDir, 'heatmaps'),
      candidatePptxPath: path.join(workDir, 'candidate.pptx'),
      reportPath: path.join(workDir, 'fidelity-report.json')
    },
    preflight: null,
    fontEmbedding: null,
    source: null,
    powerPoint: null,
    structural: null,
    slides: Array.from({ length: expectedSlideCount || 0 }, (_, index) => ({
      index,
      slideNumber: index + 1,
      sourceRender: null,
      powerPointRender: null,
      expectedDomText: sceneTextForSlide(sceneGraph, index),
      heatmap: null,
      ocr: null,
      visual: null,
      structural: null,
      cached: false,
      visualAttempts: [],
      selfHeal: null,
      healed: null,
      bakedByHeal: 0,
      failures: [],
      warnings: []
    })),
    failures: [],
    warnings: [],
    cleanup: []
  };
}

function recordIssue(report, bucket, stage, error, extra = {}) {
  const info = asErrorInfo(error, 'FIDELITY_CHECK_FAILED');
  const context = error && typeof error === 'object' && !(error instanceof Error) ? error : {};
  const issue = { ...context, stage, ...info, ...extra };
  if (issue.slideIndex == null && Number.isInteger(info.details?.slideIndex)) issue.slideIndex = info.details.slideIndex;
  report[bucket].push(issue);
  const indices = [];
  if (Number.isInteger(issue.slideIndex)) indices.push(issue.slideIndex);
  if (Array.isArray(issue.slideIndexes)) indices.push(...issue.slideIndexes.filter(Number.isInteger));
  for (const index of new Set(indices)) {
    if (!report.slides[index]) {
      report.slides[index] = {
        index,
        slideNumber: index + 1,
        sourceRender: null,
        powerPointRender: null,
        expectedDomText: '',
        heatmap: null,
        ocr: null,
        visual: null,
        structural: null,
        cached: false,
        visualAttempts: [],
        selfHeal: null,
        healed: null,
        bakedByHeal: 0,
        failures: [],
        warnings: []
      };
    }
    report.slides[index][bucket].push(issue);
  }
  if (bucket === 'failures' && (report.stage === 'initializing' || report.stage === 'passed' || report.stage === 'passed-with-warnings')) report.stage = stage;
  return issue;
}

function recordFailure(report, stage, error, extra = {}) {
  return recordIssue(report, 'failures', stage, error, extra);
}

function recordWarning(report, stage, error, extra = {}) {
  return recordIssue(report, 'warnings', stage, error, extra);
}

async function writeReport(report) {
  report.finishedAt = nowIso();
  await ensureDirectory(path.dirname(report.artifacts.reportPath));
  await fsp.writeFile(report.artifacts.reportPath, JSON.stringify(report, null, 2), 'utf8');
  return report.artifacts.reportPath;
}

function failureResponse(report) {
  report.ok = false;
  if (report.stage === 'initializing') report.stage = report.failures[0]?.stage || 'unknown';
  const first = report.failures[0];
  return {
    ok: false,
    stage: report.stage,
    report,
    reportPath: report.artifacts.reportPath,
    error: first ? `${first.code}: ${first.message}` : 'Fidelity verification failed.'
  };
}

function normaliseSlideRenders(value, kind) {
  if (!value) return [];
  const slides = Array.isArray(value) ? value : value.slides;
  if (!Array.isArray(slides)) throw fidelityError(`${kind.toUpperCase()}_RENDER_INVALID`, `${kind} renderer returned no slide artifacts.`);
  return slides.map((slide, index) => typeof slide === 'string'
    ? { index, path: slide }
    : { index: Number.isInteger(slide.index) ? slide.index : index, ...slide });
}

function assertRenderCount(kind, slides, expectedSlideCount) {
  if (expectedSlideCount && slides.length !== expectedSlideCount) {
    throw fidelityError(
      `${kind.toUpperCase()}_SLIDE_COUNT_MISMATCH`,
      `${kind} renderer produced ${slides.length} slides, expected ${expectedSlideCount}.`,
      { expectedSlideCount, actualSlideCount: slides.length }
    );
  }
}

async function defaultPptxBuilder() {
  throw fidelityError('PPTX_RENDERER_REQUIRED', 'A native scene-graph-to-PPTX renderer must be supplied to the fidelity service.');
}

async function cleanupTransientArtifacts(input) {
  const report = input?.report || input;
  if (!report?.artifacts) return;
  const candidates = [
    report.source?.sourceHtmlPath,
    path.join(report.artifacts.powerPointDirectory, 'powerpoint.pid')
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await removeIfExists(candidate);
      report.cleanup.push({ path: candidate, ok: true });
    } catch (error) {
      report.cleanup.push({ path: candidate, ok: false, error: asErrorInfo(error, 'CLEANUP_FAILED') });
    }
  }
}

/**
 * Verify a fresh editable PPTX and atomically publish it only on a completely
 * green fidelity report.
 *
 * `renderPptx` receives `{sceneGraph, html, themeCss, baseDir, outputPath,
 * workDir}` and must write a *temporary* native-object PPTX to `outputPath`.
 * The `adapters` object is intentionally injectable for deterministic tests:
 *
 *   preflight(input) -> report
 *   renderHtml(input) -> {slides:[{index,path,domText,fontChecks?}]}
 *   renderPptx(input) -> {ok?, filePath?}
 *   renderPowerPoint(input) -> {slides:[{index,path}]}
 *   ocr(input) -> {source, powerPoint} or the three contract booleans
 *   compare(input) -> visual comparison report
 *   audit(input) -> structural audit report
 *   cleanup(input) -> optional cleanup hook
 */
async function verifyAndExport(options = {}) {
  const fidelityPolicy = normaliseFidelityPolicy(options.fidelityPolicy);
  const evidenceMode = normaliseEvidenceMode(options.evidenceMode, fidelityPolicy);
  const target = normaliseTarget({ width: options.sourceWidth, height: options.sourceHeight, ...options.target });
  // Keep the source graph immutable. Every baked fallback below is applied to
  // this private export copy, never to the editor-owned graph passed in.
  const originalSceneGraph = cloneSceneGraph(options.sceneGraph);
  let activeSceneGraph = cloneSceneGraph(options.sceneGraph);
  const expectedSlideCount = Number.isInteger(options.expectedSlideCount)
    ? options.expectedSlideCount
    : sceneSlideCount(originalSceneGraph);
  const requiredFonts = collectRequiredFonts(originalSceneGraph, options.requiredFonts);
  const workDir = await createWorkDirectory(options.workDir);
  const report = makeInitialReport({
    workDir,
    target,
    expectedSlideCount,
    requiredFonts,
    destinationPath: options.destinationPath,
    sceneGraph: originalSceneGraph,
    fidelityPolicy,
    evidenceMode
  });
  // A verified export runs for a minute on a long deck. Rather than thread a
  // progress callback through ten stages, observe the one field they all
  // already write: `report.stage`. Enumerable so JSON.stringify still emits it.
  const onStage = typeof options.onStage === 'function' ? options.onStage : null;
  if (onStage) {
    let stageValue = report.stage;
    Object.defineProperty(report, 'stage', {
      get: () => stageValue,
      set: (value) => {
        stageValue = value;
        try { onStage(value, report); } catch (_) { /* progress must never break an export */ }
      },
      enumerable: true,
      configurable: true
    });
  }

  const adapters = options.adapters || {};
  const preflight = adapters.preflight || options.preflight || preflightDesktopPowerPoint;
  const renderHtml = adapters.renderHtml || options.renderHtml || renderHtmlSlides;
  const renderPptx = adapters.renderPptx || options.renderPptx || defaultPptxBuilder;
  const renderPowerPoint = adapters.renderPowerPoint || options.renderPowerPoint || renderPptxWithPowerPoint;
  const compare = adapters.compare || options.compare || compareSlideVisual;
  const audit = adapters.audit || options.audit || auditPptxStructure;
  const auditGeometry = adapters.auditGeometry || options.auditGeometry || null;
  const captureHealBakes = adapters.captureBakes || options.captureBakes || captureBakes;
  const cleanup = adapters.cleanup || options.cleanup || cleanupTransientArtifacts;
  const thresholds = mergeThresholds(options.thresholds);
  const candidatePptxPath = path.resolve(options.tempPptxPath || report.artifacts.candidatePptxPath);
  report.artifacts.candidatePptxPath = candidatePptxPath;
  const cacheDisabledReason = uncacheableExternalInput(originalSceneGraph, options.html, options.themeCss || originalSceneGraph?.themeCss || '');
  const cacheEnabled = evidenceMode === EVIDENCE_MODES.FULL && Boolean(options.destinationPath) &&
    Boolean(options.cachePath) && options.noCache !== true && process.env.LVE_NO_CACHE !== '1' && !cacheDisabledReason;
  const cacheKeys = new Map(Array.from({ length: expectedSlideCount || 0 }, (_, index) => [
    index,
    slideCacheKey({
      sceneGraph: originalSceneGraph,
      slideIndex: index,
      themeCss: options.themeCss || originalSceneGraph?.themeCss || '',
      html: options.html,
      thresholds,
      target
    })
  ]));
  let cache = { schemaVersion: 1, entries: {} };
  const cachedIndexes = new Set();
  report.cache = {
    enabled: cacheEnabled,
    path: cacheEnabled ? path.resolve(options.cachePath) : null,
    disabledReason: cacheEnabled ? null : (cacheDisabledReason ||
      (options.noCache === true || process.env.LVE_NO_CACHE === '1' ? 'disabled-by-override' : null)),
    hitCount: 0,
    missCount: expectedSlideCount || 0,
    allHit: false
  };
  let sourceSlides = [];
  let powerPointSlides = [];
  const fontEmbeddingWarningKeys = new Set();

  /**
   * Per-slide verdict, so a reader can tell the three states apart:
   *   verified   — compared against PowerPoint's own render and within budget
   *   failed     — compared, and outside budget
   *   unverified — not compared (no PowerPoint, or a native-only export)
   */
  const assignVerdicts = () => {
    const issuesFor = (index) => [...report.failures, ...report.warnings]
      .filter((issue) => issue.slideIndex === index &&
        ['visual', 'geometry', 'structural', 'font-render'].includes(issue.stage));
    report.slideVerdicts = report.slides.map((slide) => {
      const metrics = slide.visual;
      const compared = Number.isFinite(metrics?.ssim) && Number.isFinite(metrics?.mismatchPercent);
      const issues = issuesFor(slide.index);
      const reasons = issues.map((issue) => issue.code);
      const failedWithoutMetrics = metrics?.ok === false || issues.some((issue) =>
        ['visual', 'geometry', 'structural'].includes(issue.stage));
      const verdict = slide.cached && !reasons.length ? 'verified'
        : (failedWithoutMetrics ? 'failed' : (!compared ? 'unverified' : (reasons.length ? 'failed' : 'verified')));
      return {
        slide: slide.slideNumber ?? slide.index + 1,
        verdict,
        ssim: compared ? metrics.ssim : null,
        mismatchPercent: compared ? metrics.mismatchPercent : null,
        reasons,
        cached: Boolean(slide.cached),
        healed: slide.healed || null,
        bakedByHeal: Number(slide.bakedByHeal || 0)
      };
    });
    const verdicts = report.slideVerdicts.map((entry) => entry.verdict);
    report.verificationState = verdicts.some((verdict) => verdict === 'failed') ? 'partial'
      : (verdicts.length && verdicts.every((verdict) => verdict === 'verified') ? 'verified' : 'unverified');
    report.verifiedSlideCount = verdicts.filter((verdict) => verdict === 'verified').length;
    report.failedSlideCount = verdicts.filter((verdict) => verdict === 'failed').length;
    report.unverifiedSlideCount = verdicts.filter((verdict) => verdict === 'unverified').length;
  };

  const finalise = async () => {
    report.ok = report.failures.length === 0;
    assignVerdicts();
    report.verified = report.ok && report.verificationState === 'verified';
    report.stage = report.ok
      ? (report.verified ? 'passed' : 'passed-with-warnings')
      : report.stage;
    try {
      await cleanup({ report, workDir, success: report.ok });
    } catch (error) {
      // Cleanup runs after all quality gates.  Keep it visible in the report,
      // but do not retroactively invalidate a PPTX that was already atomically
      // committed after a fully green fidelity result.
      report.cleanup.push({ ok: false, error: asErrorInfo(error, 'CLEANUP_FAILED') });
    }
    await writeReport(report);
    return report.ok
      ? {
        ok: true,
        verified: report.verified,
        fidelityPolicy,
        stage: report.stage,
        report,
        reportPath: report.artifacts.reportPath,
        filePath: report.filePath || null
      }
      : failureResponse(report);
  };

  const recordVisualAttempt = (slideReport, round, visual, error) => {
    const attempt = {
      round,
      sourceRender: slideReport.sourceRender || null,
      powerPointRender: slideReport.powerPointRender || null,
      visual: visual ? visualForCache(visual) : null
    };
    if (visual?.heatmapPath) attempt.heatmap = visual.heatmapPath;
    if (error) attempt.error = asErrorInfo(error, 'VISUAL_COMPARISON_FAILED');
    slideReport.visualAttempts.push(attempt);
  };

  const visualErrors = (visual) => {
    if (!visual) return [{ code: 'VISUAL_MISMATCH', message: 'Visual comparison returned no result.' }];
    if (Array.isArray(visual.errors) && visual.errors.length) return visual.errors;
    if (visual.error) return [visual.error];
    return [{ code: 'VISUAL_MISMATCH', message: 'Visual comparison failed.' }];
  };

  const renderCandidate = async (attempt) => {
    report.stage = 'pptx-render';
    // A caller can supply a pre-built candidate only for the first pass. A
    // healed export necessarily rebuilds it from the cloned scene graph.
    if (!options.tempPptxPath || attempt > 0) {
      await removeIfExists(candidatePptxPath);
      const pptxResult = await renderPptx({
        sceneGraph: activeSceneGraph,
        html: options.html,
        themeCss: options.themeCss || activeSceneGraph?.themeCss || '',
        baseDir: options.baseDir || '',
        outputPath: candidatePptxPath,
        workDir
      });
      if (pptxResult?.ok === false) {
        throw fidelityError('PPTX_RENDER_FAILED', pptxResult.error || 'Native PPTX rendering failed.', { pptxResult });
      }
      if (pptxResult?.fontEmbedding) {
        report.fontEmbedding = pptxResult.fontEmbedding;
        for (const skipped of pptxResult.fontEmbedding.skipped || []) {
          const key = JSON.stringify([
            skipped.typeface || '',
            skipped.slot || '',
            skipped.sourceFamily || '',
            skipped.reason || ''
          ]);
          if (fontEmbeddingWarningKeys.has(key)) continue;
          fontEmbeddingWarningKeys.add(key);
          recordWarning(report, 'font-embed', {
            code: 'FONT_EMBED_SKIPPED',
            message: `Font ${skipped.typeface || skipped.sourceFamily || 'face'} was not embedded: ${skipped.reason || 'unknown reason'}.`,
            details: skipped
          });
        }
      }
      const emitted = pptxResult?.filePath || pptxResult?.path;
      if (emitted && path.resolve(emitted) !== candidatePptxPath && fs.existsSync(emitted)) {
        await fsp.copyFile(emitted, candidatePptxPath);
      }
    }
    if (!fs.existsSync(candidatePptxPath)) {
      throw fidelityError('PPTX_CANDIDATE_MISSING', 'Native PPTX renderer did not create its requested temporary output.', { candidatePptxPath });
    }
  };

  const renderCandidateInPowerPoint = async (round) => {
    report.stage = 'powerpoint-render';
    const outputDir = path.join(report.artifacts.powerPointDirectory, `round-${round}`);
    const powerPointResult = await renderPowerPoint({
      pptxPath: candidatePptxPath,
      outputDir,
      target,
      timeoutMs: options.powerPointTimeoutMs,
      rendererPath: options.powerPointRendererPath,
      expectedSlideCount
    });
    powerPointSlides = normaliseSlideRenders(powerPointResult, 'PowerPoint');
    assertRenderCount('PowerPoint', powerPointSlides, expectedSlideCount);
    report.powerPoint = { ...powerPointResult, outputDir, round, slides: powerPointSlides };
  };

  const attachRenderPaths = () => {
    const renderedSlideCount = evidenceMode === EVIDENCE_MODES.FULL
      ? Math.min(sourceSlides.length, powerPointSlides.length)
      : powerPointSlides.length;
    for (let index = 0; index < renderedSlideCount; index += 1) {
      const slideReport = report.slides[index] || {
        index,
        slideNumber: index + 1,
        failures: [],
        warnings: [],
        cached: false,
        visualAttempts: [],
        selfHeal: null,
        healed: null,
        bakedByHeal: 0
      };
      slideReport.sourceRender = sourceSlides[index]?.path || null;
      slideReport.powerPointRender = powerPointSlides[index]?.path || null;
      slideReport.expectedDomText = slideReport.expectedDomText || sceneTextForSlide(originalSceneGraph, index) || sourceSlides[index]?.domText || '';
      slideReport.heatmap = slideReport.heatmap || null;
      slideReport.ocr = slideReport.ocr || null;
      slideReport.visual = slideReport.visual || null;
      slideReport.structural = slideReport.structural || null;
      if (!report.slides[index]) report.slides[index] = slideReport;
    }
  };

  const compareOneSlide = async (slideIndex, round) => {
    const slideReport = report.slides[slideIndex];
    try {
      const visual = await compare({
        sourcePath: slideReport.sourceRender,
        powerPointPath: slideReport.powerPointRender,
        heatmapPath: path.join(report.artifacts.heatmapDirectory, `round-${round}`, `heatmap-slide-${slideNo(slideIndex)}.png`),
        thresholds,
        slideIndex
      });
      const normalised = visual && typeof visual === 'object'
        ? visual
        : { ok: false, errors: [{ code: 'VISUAL_COMPARISON_INVALID', message: 'Visual comparison returned no report.' }] };
      slideReport.visual = normalised;
      slideReport.heatmap = normalised.heatmapPath || null;
      recordVisualAttempt(slideReport, round, normalised);
      return normalised;
    } catch (error) {
      const visual = { ok: false, errors: [asErrorInfo(error, 'VISUAL_COMPARISON_FAILED')], regions: [] };
      slideReport.visual = visual;
      slideReport.heatmap = null;
      recordVisualAttempt(slideReport, round, visual, error);
      return visual;
    }
  };

  const restoreCachedSlides = async () => {
    if (!cacheEnabled) return;
    cache = await readSlideCache(options.cachePath);
    if (cache.error) recordWarning(report, 'cache', cache.error);
    for (let index = 0; index < expectedSlideCount; index += 1) {
      const key = cacheKeys.get(index);
      const entry = cache.entries?.[key];
      if (!entry || entry.verdict !== 'verified' || !entry.visual || entry.visual.ok === false) continue;
      const hydratedBakes = await loadCachedBakes(entry, options.cacheBakeDirectory);
      if (hydratedBakes === null) continue;
      const healedDemotions = Array.isArray(entry.healedDemotions)
        ? entry.healedDemotions
          .filter((plan) => plan && plan.nodeId)
          .map((plan) => ({ ...plan, slideIndex: index }))
        : [];
      let candidateScene = activeSceneGraph;
      if (healedDemotions.length) {
        const demoted = demoteSceneNodes(activeSceneGraph, healedDemotions);
        if (demoted.demoted.length !== healedDemotions.length || healedDemotions.some((plan) => !hydratedBakes[plan.nodeId])) continue;
        candidateScene = demoted.sceneGraph;
      }
      activeSceneGraph = {
        ...candidateScene,
        bakes: { ...(candidateScene.bakes || {}), ...hydratedBakes }
      };
      const slideReport = report.slides[index];
      slideReport.cached = true;
      slideReport.visual = { ...cloneSceneGraph(entry.visual), ok: true, cached: true };
      slideReport.healed = entry.healed ? cloneSceneGraph(entry.healed) : null;
      slideReport.selfHeal = entry.selfHeal ? cloneSceneGraph(entry.selfHeal) : null;
      slideReport.bakedByHeal = Number(entry.bakedByHeal || healedDemotions.length || 0);
      cachedIndexes.add(index);
    }
    report.cache.hitCount = cachedIndexes.size;
    report.cache.missCount = Math.max(0, expectedSlideCount - cachedIndexes.size);
    report.cache.allHit = cachedIndexes.size === expectedSlideCount;
  };

  const selfHealVisualMismatches = async (initialFailures) => {
    let failedIndexes = [...initialFailures];
    for (let round = 1; round <= SELF_HEAL_MAX_ROUNDS && failedIndexes.length; round += 1) {
      const plans = failedIndexes.flatMap((slideIndex) => {
        const slideReport = report.slides[slideIndex];
        return pickHealCandidates(activeSceneGraph, slideIndex, slideReport.visual, target, round).map((candidate) => ({
          ...candidate,
          round,
          reasons: [{
            code: 'VISUAL_DIFFERENCE_REGION',
            region: candidate.region,
            coverage: candidate.coverage,
            renderAs: candidate.renderAs
          }]
        }));
      });
      if (!plans.length) continue;
      const demotion = demoteSceneNodes(activeSceneGraph, plans);
      if (!demotion.demoted.length) continue;
      const priorSceneGraph = activeSceneGraph;
      const priorPowerPoint = report.powerPoint ? cloneSceneGraph(report.powerPoint) : null;
      const priorPowerPointSlides = powerPointSlides;
      const priorEvidence = report.slides.map((slide) => ({
        sourceRender: slide.sourceRender,
        powerPointRender: slide.powerPointRender,
        heatmap: slide.heatmap,
        visual: slide.visual ? cloneSceneGraph(slide.visual) : null
      }));
      const backupPptxPath = safeTransientPath(workDir, `candidate-before-self-heal-round-${round}.pptx`);
      if (fs.existsSync(candidatePptxPath)) await fsp.copyFile(candidatePptxPath, backupPptxPath);
      try {
        const captured = await captureHealBakes({
          html: options.html,
          baseDir: options.baseDir || '',
          sceneGraph: activeSceneGraph,
          sourceSize: activeSceneGraph?.pageSize,
          target,
          requests: demotion.requests,
          workDir,
          outputDir: path.join(workDir, 'bakes', `round-${round}`),
          slideSelector: options.slideSelector
        });
        if (!captured?.bakes || demotion.demoted.some((entry) => !captured.bakes[entry.nodeId])) {
          throw fidelityError('SELF_HEAL_BAKE_CAPTURE_FAILED', 'Self-heal did not capture every requested bake.', { round, demoted: demotion.demoted, captured });
        }
        activeSceneGraph = {
          ...demotion.sceneGraph,
          bakes: { ...(demotion.sceneGraph.bakes || {}), ...captured.bakes }
        };
        await renderCandidate(round);
        await renderCandidateInPowerPoint(round);
        attachRenderPaths();
        const retried = new Set(failedIndexes);
        const retryVisuals = [];
        for (const slideIndex of retried) retryVisuals.push(await compareOneSlide(slideIndex, round));
        if (retryVisuals.some((visual) => (visual.errors || []).some((error) =>
          ['VISUAL_COMPARISON_FAILED', 'VISUAL_COMPARISON_INVALID'].includes(error.code)))) {
          throw fidelityError('SELF_HEAL_VISUAL_RETRY_FAILED', 'Self-heal could not collect visual evidence for its retry.', { round });
        }

        const demotedBySlide = new Map();
        for (const entry of demotion.demoted) {
          if (!demotedBySlide.has(entry.slideIndex)) demotedBySlide.set(entry.slideIndex, []);
          demotedBySlide.get(entry.slideIndex).push(entry);
        }
        for (const [slideIndex, entries] of [...demotedBySlide.entries()]
          .sort(([left], [right]) => left - right)) {
          entries.sort((left, right) => String(left.nodeId).localeCompare(String(right.nodeId)));
          const slideReport = report.slides[slideIndex];
          slideReport.selfHeal = slideReport.selfHeal || {
            initialVerdict: 'failed',
            initialVisual: visualForCache(priorEvidence[slideIndex]?.visual),
            rounds: [],
            attempts: []
          };
          slideReport.selfHeal.rounds.push({
            round,
            demotedNodeIds: entries.map((entry) => entry.nodeId),
            reasons: entries.flatMap((entry) => entry.reasons || []),
            demotions: entries.map((entry) => ({ nodeId: entry.nodeId, round, reasons: entry.reasons || [] }))
          });
          slideReport.bakedByHeal += entries.length;
        }
        await removeIfExists(backupPptxPath);
        failedIndexes = [...retried].filter((slideIndex) => report.slides[slideIndex]?.visual?.ok === false);
      } catch (error) {
        activeSceneGraph = priorSceneGraph;
        report.powerPoint = priorPowerPoint;
        powerPointSlides = priorPowerPointSlides;
        for (const [index, evidence] of priorEvidence.entries()) {
          Object.assign(report.slides[index], evidence);
        }
        try {
          if (fs.existsSync(backupPptxPath)) await fsp.copyFile(backupPptxPath, candidatePptxPath);
        } catch (restoreError) {
          throw fidelityError('SELF_HEAL_ROLLBACK_FAILED', 'Self-heal failed and the last known-good candidate could not be restored.', {
            round,
            error: asErrorInfo(error, 'SELF_HEAL_ATTEMPT_FAILED'),
            restore: asErrorInfo(restoreError, 'SELF_HEAL_ROLLBACK_FAILED')
          });
        } finally {
          await removeIfExists(backupPptxPath);
        }
        const info = asErrorInfo(error, 'SELF_HEAL_ATTEMPT_FAILED');
        const affectedSlides = [...new Set(demotion.demoted.map((entry) => entry.slideIndex))];
        for (const slideIndex of affectedSlides) {
          const slideReport = report.slides[slideIndex];
          slideReport.selfHeal = slideReport.selfHeal || {
            initialVerdict: 'failed',
            initialVisual: visualForCache(priorEvidence[slideIndex]?.visual),
            rounds: [],
            attempts: []
          };
          slideReport.selfHeal.attempts = slideReport.selfHeal.attempts || [];
          slideReport.selfHeal.attempts.push({
            round,
            status: 'aborted',
            demotedNodeIds: demotion.demoted.filter((entry) => entry.slideIndex === slideIndex).map((entry) => entry.nodeId),
            error: info
          });
        }
        recordWarning(report, 'self-heal', {
          code: 'SELF_HEAL_ATTEMPT_FAILED',
          message: `Self-heal round ${round} was abandoned; the original native candidate was retained.`,
          details: info
        }, { slideIndexes: affectedSlides });
        break;
      }
    }
    for (const slideReport of report.slides) {
      if (!slideReport.selfHeal || slideReport.visual?.ok === false) continue;
      const allRounds = slideReport.selfHeal.rounds || [];
      const finalRound = allRounds[allRounds.length - 1];
      slideReport.healed = {
        round: finalRound?.round || 0,
        demotedNodeIds: allRounds.flatMap((entry) => entry.demotedNodeIds || []),
        reasons: allRounds.flatMap((entry) => entry.reasons || [])
      };
    }
  };

  const recordFinalVisualIssues = () => {
    for (const slideReport of report.slides) {
      if (slideReport.cached || slideReport.visual?.ok !== false) continue;
      for (const error of visualErrors(slideReport.visual)) {
        (fidelityPolicy === FIDELITY_POLICIES.EDITABLE_BEST_EFFORT ? recordWarning : recordFailure)(
          report, 'visual', error, { slideIndex: slideReport.index });
      }
    }
  };

  const persistCachedSlides = async () => {
    if (!cacheEnabled || report.failures.length) return;
    assignVerdicts();
    const nextCache = { ...cache, schemaVersion: 1, entries: { ...(cache.entries || {}) } };
    for (const slideReport of report.slides) {
      const verdict = report.slideVerdicts.find((entry) => entry.slide === slideReport.slideNumber);
      if (!verdict || verdict.verdict !== 'verified') continue;
      const healedDemotions = (slideReport.selfHeal?.rounds || []).flatMap((round) =>
        (round.demotions || []).map((demotion) => ({
          nodeId: demotion.nodeId,
          round: demotion.round,
          reasons: cloneSceneGraph(demotion.reasons || [])
        }))
      );
      const healedBakeInputs = healedDemotions.reduce((result, demotion) => {
        const bake = activeSceneGraph?.bakes?.[demotion.nodeId];
        if (bake) result[demotion.nodeId] = bake;
        return result;
      }, {});
      const healedBakes = await persistCachedBakes(healedBakeInputs, options.cacheBakeDirectory);
      nextCache.entries[cacheKeys.get(slideReport.index)] = {
        schemaVersion: 1,
        verdict: 'verified',
        visual: visualForCache(slideReport.visual),
        healed: slideReport.healed ? cloneSceneGraph(slideReport.healed) : null,
        selfHeal: slideReport.selfHeal ? cloneSceneGraph(slideReport.selfHeal) : null,
        bakedByHeal: Number(slideReport.bakedByHeal || 0),
        healedDemotions,
        healedBakes,
        savedAt: nowIso()
      };
    }
    await writeSlideCache(options.cachePath, nextCache);
    cache = nextCache;
  };

  try {
    report.stage = 'scene-validation';
    const sceneErrors = Array.isArray(options.sceneGraph?.errors) ? options.sceneGraph.errors : [];
    if (sceneErrors.length) {
      for (const sceneError of sceneErrors) {
        recordFailure(report, 'scene-validation', {
          code: sceneError.code || 'UNSUPPORTED_SCENE_FEATURE',
          message: sceneError.message || `Unsupported scene feature${sceneError.property ? `: ${sceneError.property}` : ''}.`,
          // Scene extraction labels slides for humans as 1-based `slide`;
          // reports store array indexes. Preserve an explicit slideIndex when
          // supplied, otherwise translate the human-facing value once.
          slideIndex: Number.isInteger(sceneError.slideIndex)
            ? sceneError.slideIndex
            : (Number.isInteger(sceneError.slide) ? Math.max(0, sceneError.slide - 1) : undefined),
          nodeId: sceneError.nodeId || sceneError.node,
          property: sceneError.property,
          details: sceneError
        });
      }
      return await finalise();
    }

    report.stage = 'preflight';
    report.preflight = await preflight({
      sceneGraph: originalSceneGraph,
      requiredFonts,
      themeCss: options.themeCss || originalSceneGraph?.themeCss || '',
      powerpointPath: options.powerpointPath,
      installedFonts: options.installedFonts
    });
    for (const candidate of report.preflight?.embeddedFontCandidates || []) {
      recordWarning(report, 'font-embed', {
        code: 'FONT_EMBED_LOCAL_FACE_MISSING',
        message: `Local Office does not have ${candidate.requiredFace}, so this export relies on the embedded ${candidate.themeFamily} theme face.`,
        details: candidate
      });
    }
    if (!report.preflight?.ok) {
      const errors = report.preflight?.errors?.length ? report.preflight.errors : [{ code: 'PREFLIGHT_FAILED', message: 'PowerPoint/font preflight failed.' }];
      errors.forEach((error) => recordFailure(report, 'preflight', error,
        error.code === 'REQUIRED_FONT_MISSING' ? { slideIndexes: report.slides.map((slide) => slide.index) } : {}));
      return await finalise();
    }

    await restoreCachedSlides();
    if (evidenceMode === EVIDENCE_MODES.FULL && !report.cache.allHit) {
      report.stage = 'source-render';
      const sourceResult = await renderHtml({
        html: options.html,
        baseDir: options.baseDir,
        outputDir: report.artifacts.sourceDirectory,
        target,
        sourceSize: originalSceneGraph?.pageSize,
        sceneGraph: originalSceneGraph,
        expectedSlideCount,
        requiredFonts: sourceFontCheckEntries(originalSceneGraph, requiredFonts),
        slideSelector: options.slideSelector,
        loadTimeoutMs: options.sourceLoadTimeoutMs,
        readyTimeoutMs: options.sourceReadyTimeoutMs
      });
      sourceSlides = normaliseSlideRenders(sourceResult, 'source');
      assertRenderCount('source', sourceSlides, expectedSlideCount);
      report.source = { ...sourceResult, slides: sourceSlides };
      for (const slide of sourceSlides) {
        const failedFont = (slide.fontChecks || []).find((check) => check.loaded === false);
        if (failedFont) {
          // A face the browser cannot resolve is a fidelity note, not a veto:
          // the scene's resolved family (e.g. "Lyon Arabic Text") only exists
          // while a theme kit registers it, so a deck without the kit renders
          // by fallback and must still export. Strict mode still refuses.
          (fidelityPolicy === FIDELITY_POLICIES.EDITABLE_BEST_EFFORT ? recordWarning : recordFailure)(
            report, 'font-render', {
              code: 'SOURCE_FONT_NOT_RENDERED',
              message: `Chromium could not render required font ${failedFont.font}; the reference render used a fallback face.`,
              details: failedFont
            }, { slideIndex: slide.index });
        }
      }
      if (report.failures.length) return await finalise();
    }

    await renderCandidate(0);

    if (evidenceMode !== EVIDENCE_MODES.NATIVE && !report.cache.allHit) {
    await renderCandidateInPowerPoint(0);
    attachRenderPaths();
    if (evidenceMode === EVIDENCE_MODES.FULL && sourceSlides.length !== powerPointSlides.length) {
      recordFailure(report, 'powerpoint-render', {
        code: 'RENDER_PAIR_COUNT_MISMATCH',
        message: `Source has ${sourceSlides.length} slides but PowerPoint has ${powerPointSlides.length}.`
      });
    }

    // Full evidence is intentionally an explicit diagnostic operation. A
    // preview needs PowerPoint images, but no slow pixel loop. Do not record a
    // first-pass mismatch yet: a successful bounded repair resolves it.
    if (evidenceMode === EVIDENCE_MODES.FULL) {
      report.stage = report.failures.length ? report.failures[0].stage : 'visual';
      const failedIndexes = [];
      for (const slideReport of report.slides) {
        if (slideReport.cached) continue;
        const visual = await compareOneSlide(slideReport.index, 0);
        if (visual.ok === false) failedIndexes.push(slideReport.index);
      }
      await selfHealVisualMismatches(failedIndexes);
      recordFinalVisualIssues();
    }
    }
    // "We did not check" is a STATE, not a warning. Before mission 034 every
    // native export shipped a FIDELITY_EVIDENCE_DEFERRED warning that the UI
    // counted like a defect, so "unverified" and "checked and found problems"
    // shared one number. They are now separate: warnings[] only ever holds
    // things that were actually checked and found wanting.

    // Position truth, independent of any renderer: re-open the candidate and
    // assert every emitted shape sits where the browser measured it. Needs no
    // PowerPoint, so it runs in every evidence mode — and a mismatch is always
    // a real failure, because it means the renderer wrote wrong coordinates.
    report.stage = report.failures.length ? report.failures[0].stage : 'geometry';
    if (auditGeometry) {
      try {
        report.geometry = await auditGeometry({
          pptxPath: candidatePptxPath,
          sceneGraph: activeSceneGraph,
          tolerancePx: thresholds.geometryTolerancePx
        });
        for (const mismatch of report.geometry?.mismatches || []) {
          const idMatch = /^s(\d+):/.exec(String(mismatch.id || ''));
          const slideIndex = Number.isInteger(mismatch.slideIndex)
            ? mismatch.slideIndex
            : (idMatch ? Number(idMatch[1]) : undefined);
          recordFailure(report, 'geometry', {
            code: mismatch.code || 'SHAPE_GEOMETRY_MISMATCH',
            message: mismatch.message || `Shape ${mismatch.id} is ${mismatch.worstPx}px from its measured bounds.`,
            details: mismatch
          }, Number.isInteger(slideIndex) ? { slideIndex } : {});
        }
      } catch (error) {
        recordFailure(report, 'geometry', asErrorInfo(error, 'GEOMETRY_AUDIT_FAILED'));
      }
    }

    report.stage = report.failures.length ? report.failures[0].stage : 'structural';
    try {
      report.structural = await audit({
        pptxPath: candidatePptxPath,
        sceneGraph: activeSceneGraph,
        expectedSlideCount
      });
      for (const structuralSlide of report.structural.slides || []) {
        if (report.slides[structuralSlide.index]) report.slides[structuralSlide.index].structural = structuralSlide;
      }
      if (!report.structural.ok) {
        for (const error of report.structural.errors || [{ code: 'PPTX_STRUCTURE_INVALID', message: 'PPTX structural audit failed.' }]) {
          recordFailure(report, 'structural', error, error.slideIndex == null ? {} : { slideIndex: error.slideIndex });
        }
      }
    } catch (error) {
      recordFailure(report, 'structural', error);
    }

    if (report.failures.length) return await finalise();

    try {
      await persistCachedSlides();
    } catch (error) {
      // Cache health must never veto an otherwise verified editable export.
      recordWarning(report, 'cache', asErrorInfo(error, 'FIDELITY_CACHE_WRITE_FAILED'));
    }

    report.stage = 'commit';
    // Atomic commit still requires a valid native-object candidate and all
    // hard gates above. In editable best-effort mode, OCR and pixel-diff
    // differences are documented warnings rather than an export veto.
    report.ok = true;
    if (options.destinationPath) {
      try {
        const destinationPath = await atomicCommitVerifiedPptx({ tempPptxPath: candidatePptxPath, destinationPath: options.destinationPath, report });
        report.filePath = destinationPath;
      } catch (error) {
        recordFailure(report, 'commit', error);
        return await finalise();
      }
    } else {
      report.filePath = candidatePptxPath;
    }
    return await finalise();
  } catch (error) {
    recordFailure(report, report.stage || 'unknown', error);
    return await finalise();
  }
}

module.exports = {
  FIDELITY_VERSION,
  FIDELITY_POLICIES,
  EVIDENCE_MODES,
  DEFAULT_TARGET,
  DEFAULT_THRESHOLDS,
  PptxFidelityError,
  collectRequiredFonts,
  preflightDesktopPowerPoint,
  renderHtmlSlides,
  captureBakes,
  renderPptxWithPowerPoint,
  compareSlideVisual,
  auditPptxStructure,
  compareOcrResult,
  atomicCommitVerifiedPptx,
  disposeFidelityWorkDirectory,
  verifyAndExport
};
