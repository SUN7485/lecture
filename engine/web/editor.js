/**
 * Editor — a view over the normalized model.
 *
 * The model is the document. Every edit mutates the model and re-renders; the
 * DOM is never read back as a source of truth. That is what makes the editor a
 * real preview of the export rather than a second, drifting representation.
 *
 * Coordinates are PDF points. The slide is sized in px 1:1 with points and then
 * scaled by CSS transform, so nothing has to be re-derived when you zoom.
 */

const $ = (id) => document.getElementById(id);
const PT_TO_CSS = 96 / 72;           // render a point at its true physical size
/** Smallest box a resize may produce (pt). Below this an object cannot be grabbed again. */
const MIN_SIZE = 4;

const state = {
  pdf: null,
  pdfName: null,
  model: null,
  sourceModel: null,
  sourceHash: null,
  page: 0,
  selected: null,
  zoom: 1,
  compare: false,
  overlay: false,
  undo: [],
  redo: [],
  deliveryReport: null,
  deliveryOverrides: {},
  exportJobId: null,
  sourceMode: null,
  resolvedDoctor: new Map(),
  doctorView: "active",
  checkpointRevision: 0,
};

// ---------------------------------------------------------------- helpers ---
const setStatus = (msg, cls = "") => { $("status").innerHTML = cls ? `<span class="${cls}">${msg}</span>` : msg; };
const currentPage = () => state.model?.pages[state.page];

async function saveCheckpoint() {
  if (!state.model || !state.pdf) return;
  try {
    await fetch("/api/checkpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId: state.pdf,
        model: state.model,
        sourceName: state.pdfName,
        sourceHash: state.sourceHash,
        deliveryOverrides: state.deliveryOverrides,
        revision: state.checkpointRevision,
      }),
    });
  } catch {}
}

let checkpointTimer = null;
function scheduleCheckpoint() {
  if (checkpointTimer) clearTimeout(checkpointTimer);
  checkpointTimer = setTimeout(() => { saveCheckpoint(); checkpointTimer = null; }, 2000);
}

window.addEventListener("beforeunload", () => { saveCheckpoint(); });

/**
 * Find an object anywhere in the deck, with the page it lives on.
 *
 * Every slide is on screen at once now, so a selection is not necessarily on
 * `state.page` — searching only the current page silently dropped edits to a
 * slide the user had scrolled to but not clicked into.
 */
function locate(id) {
  if (!id || !state.model) return null;
  for (let i = 0; i < state.model.pages.length; i++) {
    const obj = state.model.pages[i].objects.find((o) => o.id === id);
    if (obj) return { obj, page: state.model.pages[i], index: i };
  }
  return null;
}
const findObject = (id) => locate(id)?.obj ?? null;
/** The page index a selected object sits on, falling back to the current page. */
const pageOf = (id) => locate(id)?.index ?? state.page;
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Snapshot before a mutation so undo has something to return to. */
function invalidateDeliveryAnalysis(pageIndex = null) {
  if (!state.deliveryReport) return;
  if (pageIndex == null) state.deliveryReport = null;
  else state.deliveryReport.pages = state.deliveryReport.pages.filter((p) => p.pageIndex !== pageIndex);
  renderDeliverySurfaces();
}

function pushUndo(pageIndex = null) {
  if (!state.model) return;
  state.undo.push(clone(state.model.pages));
  if (state.undo.length > 60) state.undo.shift();
  state.redo.length = 0;
  invalidateDeliveryAnalysis(pageIndex);
  refreshHistoryButtons();
  scheduleCheckpoint();
}
function refreshHistoryButtons() {
  $("undo").disabled = !state.undo.length;
  $("redo").disabled = !state.redo.length;
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(clone(state.model.pages));
  state.model.pages = state.undo.pop();
  invalidateDeliveryAnalysis();
  render(); refreshHistoryButtons();
  if (!$("doctorPanel").hidden) checkDeck();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(clone(state.model.pages));
  state.model.pages = state.redo.pop();
  invalidateDeliveryAnalysis();
  render(); refreshHistoryButtons();
  if (!$("doctorPanel").hidden) checkDeck();
}

// ------------------------------------------------------------------ open ---
const browse = () => $("pdfFile").click();

async function responseJson(response) {
  let body = {};
  try { body = await response.json(); }
  catch {
    // A 404 that is not even JSON means the ROUTE does not exist: this page was
    // served by a Node process started before that endpoint was written. A
    // running server keeps the code it booted with and nothing in the UI says
    // so, so the honest message is the remedy, not the status code.
    // Reported as "Could not open <file>: The app returned an unreadable
    // response (404)", which named neither the cause nor the fix.
    if (response.status === 404) {
      throw new Error("this copy of the app is out of date — it is missing "
        + `"${new URL(response.url).pathname}". Close the "Studio server" window and run start-all.bat again.`);
    }
    throw new Error(`the app returned an unreadable response (${response.status}).`);
  }
  if (!response.ok || body.error) throw new Error(body.error || `request failed (${response.status}).`);
  return body;
}

async function choosePdf(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const btn = $("browse");
  btn.disabled = true;
  btn.textContent = "Opening…";
  $("chosenPdf").textContent = file.name;
  $("chosenPdf").title = file.name;
  setStatus(`Opening ${file.name}… Large lecture PDFs can take up to a minute.`);

  try {
    const upload = await responseJson(await fetch("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-file-name": encodeURIComponent(file.name) },
      body: file,
    }));
    await openPdf(upload.docId, upload.name);
  } catch (err) {
    setStatus(`Could not open ${file.name}: ${err.message}`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Choose PDF";
    // Selecting the same file again must fire `change` so a retry is possible.
    event.target.value = "";
  }
}

/**
 * Load the document's real font files.
 *
 * Setting `font-family: "Diodrum Arabic Bold"` and trusting the browser to find
 * it does NOT work: these fonts are installed per-user, which Chromium does not
 * expose to pages, so every bold run silently fell back to Segoe UI and headings
 * did not match the source. The server hands us the actual files instead.
 *
 * `document.fonts.check()` cannot verify this - it returns true for families
 * that are not really available, including invented ones. Load state is taken
 * from the FontFace promise, which is the only honest signal.
 */
const loadedFonts = new Set();
async function registerFonts(faces) {
  if (!Array.isArray(faces) || !faces.length) return;
  const pending = [];
  for (const f of faces) {
    const id = `${f.family}|${f.weight}|${f.italic ? "i" : "n"}`;
    if (loadedFonts.has(id)) continue;
    loadedFonts.add(id);
    const face = new FontFace(f.family, `url("${f.url}")`, {
      weight: String(f.weight),
      style: f.italic ? "italic" : "normal",
    });
    pending.push(face.load().then(
      (loaded) => { document.fonts.add(loaded); return null; },
      (err) => `${f.family} ${f.weight}: ${err.message || err}`
    ));
  }
  const failures = (await Promise.all(pending)).filter(Boolean);
  if (failures.length) setStatus(`Some fonts did not load: ${failures.join("; ")}`, "bad");
  render();
}

async function openPdf(docId, displayName) {
  setStatus(`Reading ${displayName} and building its editable deck…`);
  const r = await responseJson(await fetch("/api/open", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ docId }),
  }));

  state.pdf = docId;
  state.pdfName = displayName;
  state.model = r.model;
  state.sourceHash = r.sourceHash;
  // Immutable reference for "Bring from PDF". Edits mutate state.model only;
  // a source pick must never copy back an already-edited object.
  state.sourceModel = clone(r.model);
  state.coverage = r.coverage;
  registerFonts(r.fonts);
  state.page = 0;
  state.selected = null;
  state.undo.length = 0; state.redo.length = 0;
  state.deliveryReport = null;
  state.deliveryOverrides = {};
  state.exportJobId = null;
  state.sourceMode = null;
  state.resolvedDoctor.clear();
  state.doctorView = "active";

  $("empty").hidden = true;
  $("pages").hidden = false;
  $("export").disabled = false;
  $("doctor").disabled = false;
  $("addText").disabled = false;
  $("addShape").disabled = false;
  $("deliveryMode").disabled = false;
  $("sourcePanel").hidden = false;
  refreshHistoryButtons();

  const c = r.coverage;
  $("coverage").innerHTML =
    `<b class="${c.pass ? "ok" : "bad"}">${c.pass ? "zero drops" : `${c.droppedElements} dropped`}</b> · ` +
    `${c.nativeElements} native · ${c.rasterizedElements} rasterized · ${c.errors} errors`;

  renderRail();
  renderAll();
  renderInspector();
  $("workspace").scrollTop = 0;
  if (!$("doctorPanel").hidden) checkDeck();
  saveCheckpoint();
  // Repairs the server applied on the way in. Say so: text was changed before
  // the user ever saw it, and silently corrected text is still corrected text
  // they did not authorise.
  const REPAIR_LABEL = {
    "bidi-damaged-call": "backwards formula call(s)",
    "tanween-missing-alef": "dropped alef/lam-alef under a fathatan",
    "lam-alef-reversed": "reversed definite article",
  };
  const fixed = (r.repaired ?? [])
    .map((x) => `${x.applied} ${REPAIR_LABEL[x.rule] ?? x.rule}`).join(" · ");
  const fitted = state.model.document?.fittedPages ?? 0;
  setStatus(`${state.model.pages.length} slides in ${r.elapsedMs} ms.`
    + (fitted ? `  Preserved ${fitted} mixed-size page(s) without stretching.` : "")
    + (fixed ? `  Repaired on import: ${fixed}.` : ""), "ok");
}

// ---------------------------------------------------------------- render ---
function renderRail() {
  const rail = $("rail");
  rail.innerHTML = "";
  state.model.pages.forEach((p, i) => {
    const b = document.createElement("button");
    b.className = "thumb" + (i === state.page ? " active" : "");
    b.dataset.page = String(i);
    // A cheap structural thumbnail: object boxes only. Rendering real text at
    // 60px tall would be unreadable anyway, and this makes layout differences
    // between slides obvious at a glance.
    const marks = p.objects.slice(0, 60).map((o) => {
      const l = (o.bbox.x / p.widthPt) * 100, t = (o.bbox.y / p.heightPt) * 100;
      const w = (o.bbox.w / p.widthPt) * 100, h = (o.bbox.h / p.heightPt) * 100;
      const c = o.type === "text" ? "#cfcfd8" : (o.fill ? "#" + o.fill : "#e6e6ec");
      return `<i style="left:${l}%;top:${t}%;width:${Math.max(w, .6)}%;height:${Math.max(h, 1.4)}%;background:${c}"></i>`;
    }).join("");
    const texts = p.objects.filter((o) => o.type === "text").length;
    b.innerHTML =
      `<span class="thumbtop"><span class="n">${i + 1}</span>` +
      `<span class="ct">${texts}T · ${p.objects.length - texts}S</span></span>` +
      `<span class="deliverybadge ${deliveryState(i)}" data-delivery-badge="${i}">${deliveryLabel(i)}</span>` +
      `<span class="mini">${marks}</span>`;
    b.onclick = () => { state.selected = null; goToPage(i, { scroll: true }); };
    rail.appendChild(b);
  });
}

/** Mark one rail thumb active and keep it in view without yanking the page. */
function highlightRail() {
  for (const b of $("rail").children) {
    const on = Number(b.dataset.page) === state.page;
    b.classList.toggle("active", on);
    if (on) b.scrollIntoView({ block: "nearest" });
  }
  for (const p of $("pages").children) {
    p.classList.toggle("current", Number(p.dataset.page) === state.page);
  }
}

/** Build the DOM for every slide once. Cheap: a whole deck is ~900 nodes. */
function renderAll() {
  const host = $("pages");
  host.innerHTML = "";
  state.model.pages.forEach((page, i) => {
    const wrap = document.createElement("div");
    wrap.className = "slidepage";
    wrap.dataset.page = String(i);
    wrap.innerHTML =
      `<div class="pagehead"><span class="pagenum">${i + 1}</span>` +
      `<span class="pagelabel">of ${state.model.pages.length}</span>` +
      `<span class="deliverybadge ${deliveryState(i)}" data-delivery-badge="${i}">${deliveryLabel(i)}</span>` +
      `<select class="deliveryoverride" aria-label="Delivery override for page ${i + 1}">` +
      `<option value="">Automatic</option><option value="force-editable">Force editable</option>` +
      `<option value="keep-fidelity">Keep fidelity</option></select></div>` +
      `<div class="slidewrap"><div class="sourcepane" data-source-page="${i}">` +
      `<img class="source" alt="Source page ${i + 1}" loading="lazy">` +
      `<div class="sourcecapture" aria-label="Source page ${i + 1} selection surface"></div></div>` +
      `<div class="slide" data-page="${i}"></div></div>`;
    host.appendChild(wrap);
    const override = wrap.querySelector(".deliveryoverride");
    override.value = state.deliveryOverrides[page.index] ?? "";
    override.onchange = () => {
      if (override.value) state.deliveryOverrides[page.index] = override.value;
      else delete state.deliveryOverrides[page.index];
      invalidateDeliveryAnalysis(page.index);
    };
    paintPage(i);
  });
  applyView();
  highlightRail();
}

function deliveryPage(i) {
  return state.deliveryReport?.pages?.find((p) => p.pageIndex === state.model.pages[i]?.index) ?? null;
}

function deliveryState(i) {
  const p = deliveryPage(i);
  return p?.result ?? "pending";
}

function deliveryLabel(i) {
  const p = deliveryPage(i);
  if (!p) return "needs analysis";
  return {
    editable: "editable",
    "source-raster": "source image",
    "fallback-raster": "fidelity fallback",
  }[p.result] ?? p.result;
}

function renderExportSummary() {
  const panel = $("exportPanel");
  const d = state.deliveryReport;
  if (!d) { panel.hidden = true; panel.innerHTML = ""; return; }
  panel.hidden = false;
  const t = d.totals;
  const unsafe = d.pages.filter((p) => p.unsafeOverride).length;
  panel.innerHTML = `<h2>Last export · ${escapeHtml(d.mode)}</h2>` +
    `<div class="exporttotals">` +
    `<div class="exporttotal"><b>${t.editable}</b>editable</div>` +
    `<div class="exporttotal"><b>${t.sourceRaster}</b>source image</div>` +
    `<div class="exporttotal"><b>${t.fallbackRaster}</b>fallback</div></div>` +
    `<div class="exportnote">${t.flattened
      ? `Flattened pages verified at ink IoU ≥ ${Number(d.thresholds.flattenedInkIou).toFixed(2)}.`
      : "No page was replaced by a fidelity image."}` +
    (unsafe ? ` ${unsafe} unsafe editable override(s) were honored and reported.` : "") + `</div>`;
}

function renderDeliverySurfaces() {
  if (!state.model) return;
  for (let i = 0; i < state.model.pages.length; i++) {
    for (const badge of document.querySelectorAll(`[data-delivery-badge="${i}"]`)) {
      badge.className = `deliverybadge ${deliveryState(i)}`;
      badge.textContent = deliveryLabel(i);
    }
  }
  renderExportSummary();
}

/** Repaint ONE slide's objects. Used on every edit, so it must stay narrow. */
function paintPage(i) {
  const page = state.model.pages[i];
  const slide = $("pages").querySelector(`.slide[data-page="${i}"]`);
  if (!page || !slide) return;
  slide.style.background = page.background ? "#" + page.background : "#fff";
  slide.innerHTML = "";
  // Objects arrive in paint order, so DOM order reproduces z-order directly.
  for (const obj of page.objects) slide.appendChild(renderObject(obj));
}

/**
 * Geometry, view mode and source images for every slide.
 *
 * Separated from painting because zoom and Compare change none of the object
 * DOM, and repainting 900 nodes to toggle a class is how a scroll view starts
 * feeling slow.
 */
function applyView() {
  const k = state.zoom * PT_TO_CSS;
  const mode = state.overlay ? " overlay" : state.compare ? " compare" : "";
  const showSource = state.compare || state.overlay;

  state.model.pages.forEach((page, i) => {
    const host = $("pages").querySelector(`.slidepage[data-page="${i}"]`);
    if (!host) return;
    host.querySelector(".slidewrap").className = "slidewrap" + mode;
    const sourcePane = host.querySelector(".sourcepane");
    sourcePane.classList.toggle("picking", state.sourceMode === "pick" && state.compare);
    sourcePane.classList.toggle("capturing", state.sourceMode === "capture" && state.compare);

    const slide = host.querySelector(".slide");
    slide.style.width = page.widthPt + "px";
    slide.style.height = page.heightPt + "px";
    slide.style.transform = `scale(${k})`;
    // Grips counter-scale by this so they stay a constant size at any zoom.
    slide.style.setProperty("--gk", String(k));
    slide.style.marginRight = `${page.widthPt * (k - 1)}px`;
    slide.style.marginBottom = `${page.heightPt * (k - 1)}px`;

    const img = host.querySelector(".source");
    if (showSource) {
      // Assigned only when a source view is on, and `loading="lazy"` keeps the
      // 27 page renders off the wire until they scroll near the viewport.
      const want = `/api/page-image?docId=${encodeURIComponent(state.pdf)}&page=${i}&w=1400`;
      if (img.getAttribute("src") !== want) img.setAttribute("src", want);
      img.style.width = page.widthPt * k + "px";
      img.style.height = page.heightPt * k + "px";
      img.style.objectFit = "contain";
      sourcePane.style.width = page.widthPt * k + "px";
      sourcePane.style.height = page.heightPt * k + "px";
    }
  });

  $("zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
  $("sourcePick").classList.toggle("on", state.sourceMode === "pick");
  $("sourcePick").setAttribute("aria-pressed", String(state.sourceMode === "pick"));
  $("sourceCapture").classList.toggle("on", state.sourceMode === "capture");
  $("sourceCapture").setAttribute("aria-pressed", String(state.sourceMode === "capture"));
}

/** Full refresh: geometry, every surface, the inspector. Used sparingly. */
function render() {
  if (!state.model) return;
  $("deleteObj").disabled = !state.selected;
  applyView();
  state.model.pages.forEach((_, i) => paintPage(i));
  renderInspector();
}

/** Refresh only what an edit on one page can have changed. */
function renderCurrent(pageIndex = state.page) {
  $("deleteObj").disabled = !state.selected;
  paintPage(pageIndex);
}

/** Make a page current; optionally bring it into view. */
function goToPage(i, { scroll = false } = {}) {
  if (!state.model) return;
  state.page = Math.max(0, Math.min(i, state.model.pages.length - 1));
  highlightRail();
  if (!scroll) return;
  const el = $("pages").querySelector(`.slidepage[data-page="${state.page}"]`);
  if (!el) return;
  // Instant, not smooth. Jumping from slide 1 to slide 27 is 18,000px, and
  // animating that is several seconds of scenery — thumbnail rails in every
  // presentation tool cut straight there. Positioned by arithmetic rather than
  // scrollIntoView so the slide lands just under the sticky header instead of
  // level with it.
  const ws = $("workspace");
  const top = el.getBoundingClientRect().top - $("pages").getBoundingClientRect().top;
  railFollowSuspended = true;
  ws.scrollTop = Math.max(0, top - 8);
  // The scroll this triggers would otherwise race the spy; one tick is enough
  // because the jump is instant.
  clearTimeout(goToPage._t);
  goToPage._t = setTimeout(() => { railFollowSuspended = false; }, 120);
}

/**
 * Scroll spy: whichever slide owns the top of the viewport is the current one.
 *
 * Drives the rail highlight, the arrow keys and where a new object lands, so
 * scrolling to a slide and pressing "add text" puts it on the slide you are
 * looking at rather than the one you last clicked.
 */
let railFollowSuspended = false;
function syncPageFromScroll() {
  if (!state.model || railFollowSuspended) return;
  const ws = $("workspace").getBoundingClientRect();
  let best = state.page, bestDist = Infinity;
  for (const el of $("pages").children) {
    const r = el.getBoundingClientRect();
    // Nearest top edge to the viewport top, counting a slide already scrolled
    // past as its distance below rather than above.
    const d = Math.abs(r.top - ws.top - 12);
    if (d < bestDist) { bestDist = d; best = Number(el.dataset.page); }
  }
  if (best !== state.page) { state.page = best; highlightRail(); }
}

function renderObject(obj) {
  const el = document.createElement("div");
  el.className = "obj " + obj.type + (obj.id === state.selected ? " sel" : "");
  el.dataset.id = obj.id;
  el.style.left = obj.bbox.x + "px";
  el.style.top = obj.bbox.y + "px";
  el.style.width = obj.bbox.w + "px";
  el.style.height = obj.bbox.h + "px";

  if (obj.type === "shape") {
    if (obj.fill) el.style.background = "#" + obj.fill;
    if (obj.stroke) el.style.border = `${Math.max(obj.strokeWidth, 0.4)}px solid #${obj.stroke}`;
    if (obj.shapeType === "roundRect") el.style.borderRadius = (obj.cornerRadiusPt || 3) + "px";
    if (obj.shapeType === "ellipse") el.style.borderRadius = "50%";
    if (obj.opacity != null && obj.opacity < 1) el.style.opacity = obj.opacity;
  }

  // Eight resize grips on the selection. They live inside the object so they
  // travel with it, and carry their compass direction for the drag maths.
  if (obj.id === state.selected) {
    for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const h = document.createElement("div");
      h.className = "grip grip-" + dir;
      h.dataset.handle = dir;
      el.appendChild(h);
    }
  }

  if (obj.type === "image") {
    if (obj.ref) {
      // The real picture, resolved from the cache by content hash. This used to
      // be a grey checkerboard, which on an image-heavy deck reads as a page
      // full of blank white boxes sitting on top of the text.
      el.style.backgroundImage = `url("/api/object-image?ref=${encodeURIComponent(obj.ref)}")`;
      el.style.backgroundSize = "100% 100%";
      el.style.backgroundRepeat = "no-repeat";
      if (obj.opacity != null && obj.opacity < 1) el.style.opacity = obj.opacity;
    } else {
      // No pixels behind it. Say that, loudly — a neutral placeholder here is
      // indistinguishable from a white rectangle the source actually drew.
      el.style.background = "repeating-linear-gradient(45deg,#fdeaea 0 6px,#f8d4d4 6px 12px)";
      el.style.border = "1px dashed #c66";
      el.title = obj.decodeError
        ? `image could not be decoded — ${obj.decodeError}`
        : "image has no pixels";
    }
  }

  if (obj.type === "text") {
    el.dataset.align = obj.alignment;
    el.style.direction = obj.paragraphDirection;
    el.style.textAlign = obj.alignment;
    const appendRuns = (inner, runs) => {
      for (const run of runs) {
        const s = document.createElement("span");
        s.textContent = run.text;
        s.style.fontFamily = `"${run.fontFamily}", "Segoe UI", sans-serif`;
        s.style.fontSize = run.fontSizePt + "px";
        s.style.color = "#" + run.color;
        if (run.bold) s.style.fontWeight = "700";
        if (run.italic) s.style.fontStyle = "italic";
        inner.appendChild(s);
      }
    };

    const useTableSegments = obj.tableSegments?.length && obj.text === obj.tableSourceText;
    if (useTableSegments) {
      el.style.display = "block";
      for (const segment of obj.tableSegments) {
        const inner = document.createElement("div");
        inner.style.position = "absolute";
        inner.style.left = (segment.bbox.x - obj.bbox.x) + "px";
        inner.style.top = (segment.bbox.y - obj.bbox.y) + "px";
        inner.style.width = segment.bbox.w + "px";
        inner.style.height = segment.bbox.h + "px";
        inner.style.display = "flex";
        inner.style.alignItems = "center";
        inner.style.justifyContent = segment.alignment === "right" ? "flex-end"
          : segment.alignment === "left" ? "flex-start" : "center";
        inner.style.direction = segment.paragraphDirection;
        inner.style.textAlign = segment.alignment;
        inner.style.overflow = "hidden";
        inner.style.pointerEvents = "none";
        appendRuns(inner, segment.runs);
        el.appendChild(inner);
      }
    } else {
      const inner = document.createElement("div");
      inner.style.width = "100%";
      inner.style.direction = obj.paragraphDirection;
      inner.style.textAlign = obj.alignment;
      appendRuns(inner, obj.runs);
      el.appendChild(inner);
    }
  }

  return el;
}

// ------------------------------------------------------------- inspector ---
function renderInspector() {
  const body = $("inspectorBody");
  const obj = findObject(state.selected);
  $("inspectorHint").hidden = !!obj;
  body.hidden = !obj;
  if (!obj) return;

  const rows = [];
  rows.push(`<div class="grp"><h3>${obj.type}${obj.shapeType ? " · " + obj.shapeType : ""}</h3>
    <div class="meta">${obj.id}</div>
    ${obj.inTable ? `<div class="meta">in a ${obj.inTable.rows}×${obj.inTable.cols} table</div>` : ""}
    <div class="meta">z-index ${obj.zIndex} · ${obj.reconstructionStrategy}</div></div>`);

  rows.push(`<div class="grp"><h3>Geometry (pt)</h3>
    ${numRow("x", obj.bbox.x)}${numRow("y", obj.bbox.y)}
    ${numRow("w", obj.bbox.w)}${numRow("h", obj.bbox.h)}</div>`);

  if (obj.type === "text") {
    const r0 = obj.runs[0] ?? {};
    rows.push(`<div class="grp"><h3>Text</h3>
      <textarea id="f_text" spellcheck="false">${escapeHtml(obj.text)}</textarea>
      <div class="row"><label>Dir</label>
        <select id="f_direction">
          <option value="rtl"${obj.paragraphDirection === "rtl" ? " selected" : ""}>rtl</option>
          <option value="ltr"${obj.paragraphDirection === "ltr" ? " selected" : ""}>ltr</option>
        </select></div>
      <div class="row"><label>Align</label>
        <select id="f_alignment">
          ${["right", "left", "center"].map((a) => `<option value="${a}"${obj.alignment === a ? " selected" : ""}>${a}</option>`).join("")}
        </select></div>
      <div class="row"><label>Size</label><input id="f_size" type="number" step="0.5" value="${r0.fontSizePt ?? 12}"></div>
      <div class="row"><label>Colour</label><input id="f_color" type="color" value="#${r0.color ?? "000000"}"></div>
      <div class="row"><label>Font</label><input id="f_font" type="text" value="${r0.fontFamily ?? ""}"></div>
      ${obj.runs.some((r) => r.fontSubstituted) ? `<div class="meta"><span class="badge">font substituted</span></div>` : ""}
      <div class="meta">${obj.runs.length} run(s)</div>
    </div>`);
  }

  if (obj.type === "shape") {
    rows.push(`<div class="grp"><h3>Style</h3>
      <div class="row"><label>Fill</label><input id="f_fill" type="color" value="#${obj.fill ?? "FFFFFF"}"${obj.fill ? "" : " disabled"}></div>
      <div class="row"><label>Stroke</label><input id="f_stroke" type="color" value="#${obj.stroke ?? "000000"}"${obj.stroke ? "" : " disabled"}></div>
      ${obj.stroke ? numRow("strokeWidth", obj.strokeWidth, "f_strokeWidth", 0.25) : ""}
      ${obj.shapeType === "roundRect" ? numRow("radius", obj.cornerRadiusPt, "f_radius", 0.5) : ""}
      <div class="row"><label>Opacity</label><input id="f_opacity" type="number" min="0" max="1" step="0.05" value="${obj.opacity ?? 1}"></div>
    </div>`);
  }

  body.innerHTML = rows.join("");
  wireInspector(obj);
}

const numRow = (label, value, id = "f_" + label, step = 0.5) =>
  `<div class="row"><label>${label}</label><input id="${id}" type="number" step="${step}" value="${value}"></div>`;

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function wireInspector(obj) {
  const bind = (id, apply) => {
    const el = $(id);
    if (!el) return;
    el.onchange = () => {
      pushUndo(); apply(el.value); render();
      if (!$("doctorPanel").hidden) checkDeck();
    };
  };

  const setBox = (key, value) => {
    obj.bbox[key] = +value;
    if (obj.type === "text") { delete obj.tableSegments; delete obj.tableSourceText; }
  };
  bind("f_x", (v) => setBox("x", v));
  bind("f_y", (v) => setBox("y", v));
  bind("f_w", (v) => setBox("w", v));
  bind("f_h", (v) => setBox("h", v));

  if (obj.type === "text") {
    const allRuns = () => [
      ...(obj.runs ?? []),
      ...(obj.tableSegments ?? []).flatMap((segment) => segment.runs ?? []),
    ];
    bind("f_text", (v) => applyEditedText(obj, v));
    bind("f_direction", (v) => {
      obj.paragraphDirection = v;
      for (const segment of obj.tableSegments ?? []) segment.paragraphDirection = v;
    });
    bind("f_alignment", (v) => {
      obj.alignment = v;
      for (const segment of obj.tableSegments ?? []) segment.alignment = v;
    });
    bind("f_size", (v) => allRuns().forEach((r) => (r.fontSizePt = +v)));
    bind("f_color", (v) => allRuns().forEach((r) => (r.color = v.replace("#", "").toUpperCase())));
    // Changing the face invalidates everything the server decided ABOUT that
    // face, so the verdict goes with it rather than being reported about a font
    // that is no longer there.
    bind("f_font", (v) => allRuns().forEach((r) => { r.fontFamily = v; forgetResolution(r); }));
  }

  if (obj.type === "shape") {
    bind("f_fill", (v) => (obj.fill = v.replace("#", "").toUpperCase()));
    bind("f_stroke", (v) => (obj.stroke = v.replace("#", "").toUpperCase()));
    bind("f_strokeWidth", (v) => (obj.strokeWidth = +v));
    bind("f_radius", (v) => (obj.cornerRadiusPt = +v));
    bind("f_opacity", (v) => (obj.opacity = Math.max(0, Math.min(1, +v))));
  }
}

/**
 * Rebuild an object's runs after its text is edited.
 *
 * Collapsing everything onto runs[0] loses per-script styling, and that is not
 * merely cosmetic: the PPTX gate requires every Arabic run to name a
 * complex-script font, so handing Arabic text a Latin run's font produces a
 * deck that fails its own verification. Mixed lines are the norm here —
 * "(Microsoft Excel 365)" inside an Arabic sentence is two runs by design.
 *
 * The edited text is re-split on SCRIPT, the same axis extraction used, and each
 * segment inherits the style of the original run with that script. Styling that
 * varied WITHIN a script (a bold clause in a sentence) still cannot be
 * recovered — nothing in the new text says where it was — so that is reported
 * rather than guessed.
 */
function runsForEditedText(obj, text) {
  const scriptOf = (ch) =>
    /[؀-ۿݐ-ݿ]/.test(ch) ? "Arab" : /[A-Za-z0-9À-ɏ]/.test(ch) ? "Latn" : null;

  const fallback = obj.runs?.[0] ??
    { fontFamily: "Diodrum Arabic", fontSizePt: 12, color: "000000", script: "Arab", bold: false, italic: false };

  // Neutrals (spaces, punctuation, brackets) carry no script and simply continue
  // whatever run they are in, exactly as blockRuns does during extraction.
  const segs = [];
  for (const ch of text) {
    const s = scriptOf(ch);
    const last = segs[segs.length - 1];
    if (last && (s === null || last.script === null || last.script === s)) {
      last.text += ch;
      if (last.script === null) last.script = s;
    } else {
      segs.push({ script: s, text: ch });
    }
  }

  return segs.filter((s) => s.text.length).map((s) => {
    const script = s.script ?? fallback.script;
    const src = obj.runs?.find((r) => r.script === script) ?? fallback;
    const { text: _drop, ...style } = src;
    return { ...style, script, text: s.text };
  });
}

/** Apply edited text to an object, preserving what can honestly be preserved. */
function applyEditedText(obj, text) {
  const before = obj.runs?.length ?? 0;
  obj.text = text;
  obj.runs = runsForEditedText(obj, text);
  delete obj.tableSegments;
  delete obj.tableSourceText;
  obj.edited = true;
  // The missing-character verdict describes what the EXTRACTOR produced from
  // this line. Once a human has retyped it, that verdict is about text nobody
  // is looking at any more, and re-deriving it needs the device glyph walk that
  // only the server can do — so it is dropped rather than asserted stale, the
  // same discipline forgetResolution follows for fonts.
  obj.charactersMissing = null;
  // Say so when styling really was lost, instead of letting it vanish quietly.
  if (before > obj.runs.length) {
    setStatus(`Edited. ${before} runs became ${obj.runs.length} — styling that varied within one script could not be preserved.`, "");
  } else {
    setStatus("Edited. Ctrl+Z to undo.", "ok");
  }
}

// --------------------------------------------------- adding and deleting ---

/**
 * Put a new object on the current slide, on top.
 *
 * zIndex is paint order from extraction, so "above everything" is max + 1 rather
 * than an arbitrary large number - keeping the same scale means the exporter and
 * the editor still agree about stacking.
 */
function addObject(type) {
  const page = currentPage();
  if (!page) return;
  pushUndo();

  const zTop = page.objects.reduce((n, o) => Math.max(n, o.zIndex ?? 0), 0) + 1;
  // Ids from extraction look like p0_text_003; a distinct prefix makes an added
  // object obvious in the model and cannot collide with an extracted one.
  const id = `p${state.page}_new_${type}_${Date.now().toString(36)}`;
  const w = type === "text" ? 200 : 120;
  const h = type === "text" ? 28 : 80;
  const bbox = {
    x: +((page.widthPt - w) / 2).toFixed(2),
    y: +((page.heightPt - h) / 2).toFixed(2),
    w, h,
  };

  // A new object is born ON-BRAND. Hardcoded #DDDDDD/#444444/"Diodrum Arabic"
  // were colours and a face this document may never use, so every added object
  // arrived as identity drift the doctor then had to complain about. The
  // document's own identity is the only defensible default here.
  const id0 = state.model.identity;
  const body = id0?.faces?.find((f) => !f.bold) ?? id0?.faces?.[0];
  // Fall back WITHIN the identity, never to a hardcoded grey. Measured: this
  // deck stroke-fills nothing at all, so `strokes` is empty and a #444444
  // default made every newly added shape an off-palette finding the moment it
  // appeared. A category the document does not use is answered by one it does.
  const first = (...lists) => lists.find((l) => l?.[0]?.value)?.[0]?.value;
  const inkColor = first(id0?.textColors, id0?.fills) ?? "000000";
  const fillColor = first(id0?.fills, id0?.backgrounds) ?? "DDDDDD";
  const strokeColor = first(id0?.strokes, id0?.textColors, id0?.fills) ?? "444444";

  const obj = type === "text"
    ? {
        id, type: "text", bbox, zIndex: zTop, edited: true,
        text: "نص جديد",
        sourceStreamDirection: "rtl", paragraphDirection: "rtl", alignment: "right",
        runs: [{
          text: "نص جديد",
          fontFamily: body?.family ?? "Diodrum Arabic",
          fontSizePt: 14, color: inkColor, script: "Arab",
          bold: Boolean(body?.bold), italic: Boolean(body?.italic),
        }],
      }
    : {
        id, type: "shape", bbox, zIndex: zTop, edited: true,
        shapeType: "rect", fill: fillColor, stroke: strokeColor, strokeWidth: 1, opacity: 1,
      };

  page.objects.push(obj);
  state.selected = id;
  renderCurrent(state.page); renderInspector(); refreshHistoryButtons();
  if (!$("doctorPanel").hidden) checkDeck();
  setStatus(`Added a ${type} on slide ${state.page + 1}. Ctrl+Z to undo.`, "ok");
}

function deleteSelected() {
  const found = locate(state.selected);
  if (!found) return setStatus("Select an object first.");
  pushUndo();
  found.page.objects = found.page.objects.filter((o) => o.id !== found.obj.id);
  state.selected = null;
  renderCurrent(found.index); renderInspector(); refreshHistoryButtons();
  if (!$("doctorPanel").hidden) checkDeck();
  setStatus("Deleted. Ctrl+Z to undo.", "ok");
}

// ------------------------------------------------- selection and dragging ---
let drag = null;

// Delegated from the scroll container: there is no longer a single slide
// element, and re-binding per page on every repaint would leak listeners.
$("pages").addEventListener("pointerdown", (e) => {
  const surface = e.target.closest(".slide");
  if (!surface) return;
  const pageIndex = Number(surface.dataset.page);
  const previous = state.page;
  // Clicking into a slide makes it current, so the inspector, Delete and the
  // add buttons all act on the slide you actually touched.
  state.page = pageIndex;

  const el = e.target.closest(".obj");
  if (!el) {
    const had = state.selected;
    state.selected = null;
    if (had) { renderCurrent(pageOf(had)); renderInspector(); }
    if (previous !== pageIndex) highlightRail();
    renderCurrent(pageIndex);
    return;
  }

  const wasOn = state.selected ? pageOf(state.selected) : null;
  state.selected = el.dataset.id;
  const obj = findObject(state.selected);
  if (!obj) return;

  const k = state.zoom * PT_TO_CSS;
  const handle = e.target.dataset?.handle ?? null;
  drag = {
    id: obj.id, page: pageIndex, startX: e.clientX, startY: e.clientY,
    ox: obj.bbox.x, oy: obj.bbox.y, ow: obj.bbox.w, oh: obj.bbox.h,
    k, moved: false, handle,
  };
  // A grip must not also start a move, and must not bubble into selection churn.
  if (handle) e.stopPropagation();
  el.setPointerCapture?.(e.pointerId);
  if (wasOn != null && wasOn !== pageIndex) renderCurrent(wasOn);
  if (previous !== pageIndex) highlightRail();
  renderCurrent(pageIndex);
  renderInspector();
});

window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = (e.clientX - drag.startX) / drag.k;
  const dy = (e.clientY - drag.startY) / drag.k;
  if (!drag.moved && Math.hypot(dx, dy) < 1.5) return;      // ignore click jitter
  if (!drag.moved) { pushUndo(); drag.moved = true; }
  const obj = findObject(drag.id);
  if (!obj) return;
  if (drag.handle) {
    // Resize from the grabbed edge. A west or north grip moves the origin as
    // well as the size, and MIN_SIZE stops a box being dragged inside-out into
    // negative dimensions the exporter cannot represent.
    let { ox: x, oy: y, ow: w, oh: h } = drag;
    if (drag.handle.includes("e")) w = drag.ow + dx;
    if (drag.handle.includes("s")) h = drag.oh + dy;
    if (drag.handle.includes("w")) { x = drag.ox + dx; w = drag.ow - dx; }
    if (drag.handle.includes("n")) { y = drag.oy + dy; h = drag.oh - dy; }
    if (w < MIN_SIZE) { if (drag.handle.includes("w")) x = drag.ox + drag.ow - MIN_SIZE; w = MIN_SIZE; }
    if (h < MIN_SIZE) { if (drag.handle.includes("n")) y = drag.oy + drag.oh - MIN_SIZE; h = MIN_SIZE; }
    obj.bbox.x = +x.toFixed(2);
    obj.bbox.y = +y.toFixed(2);
    obj.bbox.w = +w.toFixed(2);
    obj.bbox.h = +h.toFixed(2);
  } else {
    obj.bbox.x = +(drag.ox + dx).toFixed(2);
    obj.bbox.y = +(drag.oy + dy).toFixed(2);
  }
  // Only the dragged object's own slide is repainted. A full render here would
  // rebuild every slide in the deck on every pointer move.
  renderCurrent(drag.page);
  renderInspector();
});

window.addEventListener("pointerup", () => {
  if (drag?.moved) {
    setStatus(drag.handle ? "Resized. Ctrl+Z to undo." : "Moved. Ctrl+Z to undo.");
    if (!$("doctorPanel").hidden) checkDeck();
  }
  drag = null;
});

// Double-click a text object to edit it in place.
$("pages").addEventListener("dblclick", (e) => {
  const el = e.target.closest(".obj.text");
  if (!el) return;
  const obj = findObject(el.dataset.id);
  if (!obj) return;
  el.contentEditable = "true";
  el.classList.add("editing");
  el.focus();
  document.execCommand?.("selectAll", false, null);

  const finish = () => {
    el.contentEditable = "false";
    el.classList.remove("editing");
    const next = el.innerText.replace(/ /g, " ").trim();
    if (next && next !== obj.text) {
      pushUndo();
      applyEditedText(obj, next);
    }
    render();
    if (!$("doctorPanel").hidden) checkDeck();
  };
  el.addEventListener("blur", finish, { once: true });
});

// ----------------------------------------------------------------- export ---
/**
 * Export, then actually HAND THE USER THE FILE.
 *
 * The button used to write the deck into the project's out/ folder and print a
 * server path in the status bar. Nothing downloaded, nothing opened — reported
 * as "the export button isn't working", and fairly: a button labelled Export
 * that produces no file you can reach has not exported anything from where the
 * user is sitting. The deck is still written to out/ (the CLI and the
 * verification scripts read it from there) and is now also delivered to the
 * browser.
 */
async function exportPptx() {
  if (!state.model) return;
  const btn = $("export");
  btn.disabled = true;
  setStatus("Starting local export analysis…");
  const name = (state.pdfName || "deck").replace(/\.pdf$/i, "");
  try {
    const started = await responseJson(await fetch("/api/exports", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: state.model,
        docId: state.pdf,
        name,
        delivery: $("deliveryMode").value,
        overrides: state.deliveryOverrides,
      }),
    }));
    state.exportJobId = started.jobId;

    let job = started;
    while (job.status === "queued" || job.status === "running") {
      setStatus(`${escapeHtml(job.detail || job.stage)} · ${job.progress}%`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      job = await responseJson(await fetch(`/api/exports/${encodeURIComponent(started.jobId)}`));
    }
    if (job.status !== "done" || !job.result) {
      throw new Error(job.error || "the export job failed without a result");
    }
    const r = job.result;
    state.deliveryReport = r.delivery;
    renderDeliverySurfaces();

    const href = `/api/download?name=${encodeURIComponent(r.fileName)}`;
    const a = document.createElement("a");
    a.href = href;
    a.download = r.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // The click above happens AFTER an await, so it no longer carries the user
    // gesture and a browser set to block automatic downloads will drop it
    // silently — which is exactly the failure being fixed. The status bar keeps
    // a real link the user can click themselves, so the deck is always reachable.
    // Whether the fonts travelled with the deck decides whether it survives
    // leaving this machine, so it is reported on the same line as the export —
    // never silently.
    // The deck is now re-pointed at faces that ship with Windows and Office, so
    // "did the fonts embed" is no longer the question that decides whether it
    // survives leaving this machine — "does it name anything the reader lacks"
    // is, and the answer is no. Say WHICH typefaces changed: a silent substitution
    // reads as damage to whoever opens the file expecting the source's type.
    const swaps = r.portable?.swaps ?? [];
    const fontNote = swaps.length
      ? `fonts made portable — ${swaps.map((s) => `${escapeHtml(s.from)} → ${escapeHtml(s.to)}`).join(", ")}` +
        ` · opens on any Windows/Office machine, in a substituted typeface`
      : `fonts already portable · opens on any Windows/Office machine`;
    const uncovered = r.portable?.uncovered ?? [];
    const fontWarn = uncovered.length
      ? ` · <b>WARNING</b>: nothing that ships everywhere can draw ${uncovered.map(escapeHtml).join(", ")} — the reader may see boxes`
      : "";

    setStatus(
      `Exported ${r.slides} slides · ${r.delivery.totals.editable} editable · ` +
      `${r.delivery.totals.flattened} fidelity image · ${fontNote}${fontWarn} · ` +
      `<a id="dl" href="${href}" download="${escapeHtml(r.fileName)}">download ${escapeHtml(r.fileName)}</a>` +
      ` · also saved to ${escapeHtml(r.file)}`, uncovered.length ? "warn" : "ok");
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, "bad");
  } finally {
    state.exportJobId = null;
    btn.disabled = false;
  }
}

// ------------------------------------------------------- bring from source ---
function setSourceMode(mode) {
  state.sourceMode = state.sourceMode === mode ? null : mode;
  if (state.sourceMode) {
    state.compare = true;
    state.overlay = false;
    $("compare").classList.add("on");
    $("overlay").classList.remove("on");
    const instruction = state.sourceMode === "pick"
      ? "Click text or an image on the left PDF page to restore it into the editable slide."
      : "Drag a box on the left PDF page; that exact area will be inserted as an image.";
    $("sourceHelp").textContent = instruction;
    setStatus(instruction);
  } else {
    $("sourceHelp").textContent = "Pick extracted content, or capture any PDF area exactly.";
  }
  applyView();
}

/** Map a pointer on an object-fit:contain source image to both PDF fractions and slide points. */
function sourcePoint(pane, event) {
  const img = pane.querySelector(".source");
  if (!img?.naturalWidth || !img?.naturalHeight) return null;
  const paneRect = pane.getBoundingClientRect();
  const imgRect = img.getBoundingClientRect();
  const fit = Math.min(imgRect.width / img.naturalWidth, imgRect.height / img.naturalHeight);
  const contentW = img.naturalWidth * fit, contentH = img.naturalHeight * fit;
  const left = imgRect.left + (imgRect.width - contentW) / 2;
  const top = imgRect.top + (imgRect.height - contentH) / 2;
  if (event.clientX < left || event.clientX > left + contentW || event.clientY < top || event.clientY > top + contentH) return null;
  const px = Math.max(0, Math.min(contentW, event.clientX - left));
  const py = Math.max(0, Math.min(contentH, event.clientY - top));
  const pageIndex = Number(pane.dataset.sourcePage);
  const page = state.model.pages[pageIndex];
  return {
    pageIndex,
    nx: px / contentW, ny: py / contentH,
    paneX: event.clientX - paneRect.left, paneY: event.clientY - paneRect.top,
    slideX: (left - paneRect.left + px) / (state.zoom * PT_TO_CSS),
    slideY: (top - paneRect.top + py) / (state.zoom * PT_TO_CSS),
    page,
  };
}

function pickSourceObject(point) {
  const sourcePage = state.sourceModel?.pages?.[point.pageIndex];
  const page = state.model?.pages?.[point.pageIndex];
  if (!sourcePage || !page) return;
  const hit = [...sourcePage.objects]
    .filter((o) => (o.type === "text" || o.type === "image")
      && point.slideX >= o.bbox.x && point.slideX <= o.bbox.x + o.bbox.w
      && point.slideY >= o.bbox.y && point.slideY <= o.bbox.y + o.bbox.h)
    .sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0))[0];
  if (!hit) {
    setStatus("No extracted text or image was found there. Use Capture area for drawn text, charts, or grouped artwork.");
    return;
  }

  pushUndo(point.pageIndex);
  const restored = clone(hit);
  const at = page.objects.findIndex((o) => o.id === restored.id);
  if (at >= 0) page.objects[at] = restored;
  else page.objects.push(restored);
  state.page = point.pageIndex;
  state.selected = restored.id;
  renderCurrent(point.pageIndex);
  renderInspector();
  if (!$("doctorPanel").hidden) checkDeck();
  setStatus(`${restored.type === "text" ? "Text" : "Image"} restored from PDF on slide ${point.pageIndex + 1}. Ctrl+Z to undo.`, "ok");
}

let sourceDrag = null;

$("pages").addEventListener("pointerdown", (event) => {
  const surface = event.target.closest(".sourcecapture");
  if (!surface || !state.sourceMode) return;
  const pane = surface.closest(".sourcepane");
  const point = sourcePoint(pane, event);
  if (!point) return setStatus("Start inside the visible PDF page.");
  event.preventDefault();
  if (state.sourceMode === "pick") return pickSourceObject(point);

  const selection = document.createElement("div");
  selection.className = "source-selection";
  surface.appendChild(selection);
  sourceDrag = { pane, surface, selection, start: point, end: point, pointerId: event.pointerId };
  surface.setPointerCapture?.(event.pointerId);
});

$("pages").addEventListener("pointermove", (event) => {
  if (!sourceDrag || event.pointerId !== sourceDrag.pointerId) return;
  const point = sourcePoint(sourceDrag.pane, event);
  if (!point) return;
  sourceDrag.end = point;
  const left = Math.min(sourceDrag.start.paneX, point.paneX);
  const top = Math.min(sourceDrag.start.paneY, point.paneY);
  sourceDrag.selection.style.cssText = `left:${left}px;top:${top}px;width:${Math.abs(point.paneX - sourceDrag.start.paneX)}px;height:${Math.abs(point.paneY - sourceDrag.start.paneY)}px`;
});

$("pages").addEventListener("pointerup", async (event) => {
  if (!sourceDrag || event.pointerId !== sourceDrag.pointerId) return;
  const drag = sourceDrag;
  sourceDrag = null;
  drag.selection.remove();
  const a = drag.start, b = drag.end;
  const bbox = {
    x: +Math.min(a.slideX, b.slideX).toFixed(2), y: +Math.min(a.slideY, b.slideY).toFixed(2),
    w: +Math.abs(b.slideX - a.slideX).toFixed(2), h: +Math.abs(b.slideY - a.slideY).toFixed(2),
  };
  if (bbox.w < 3 || bbox.h < 3) return setStatus("Drag a larger area of the PDF page to capture it.");

  setStatus("Capturing the selected PDF area…");
  try {
    const cropped = await responseJson(await fetch("/api/source-crop", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId: state.pdf, page: a.pageIndex,
        x: Math.min(a.nx, b.nx), y: Math.min(a.ny, b.ny),
        w: Math.abs(b.nx - a.nx), h: Math.abs(b.ny - a.ny),
      }),
    }));
    const page = state.model.pages[a.pageIndex];
    pushUndo(a.pageIndex);
    const obj = {
      id: `source-capture-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      type: "image", bbox, zIndex: Math.max(0, ...page.objects.map((o) => o.zIndex ?? 0)) + 1,
      ref: cropped.ref, pixels: cropped.pixels, format: "png", opacity: 1, edited: true,
      provenance: { sourceType: "user-source-capture" },
    };
    page.objects.push(obj);
    state.page = a.pageIndex;
    state.selected = obj.id;
    renderCurrent(a.pageIndex);
    renderInspector();
    if (!$("doctorPanel").hidden) checkDeck();
    setStatus(`PDF area added as an image on slide ${a.pageIndex + 1}. Ctrl+Z to undo.`, "ok");
  } catch (error) {
    setStatus(`Could not capture that PDF area: ${error.message}`, "bad");
  }
});

// ----------------------------------------------------------------- doctor ---
import { runDoctor, applyFixes, triageFindings, identityReport, forgetResolution, RULES } from "/doctor.js";

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/**
 * The identity block: did the brand survive the conversion?
 *
 * Rendered above the findings and never inside them. "Is this still the same
 * deck visually" is a question about the document, and a deck-level answer buried
 * among forty per-object warnings is an answer nobody reads.
 */
function renderIdentity() {
  const box = $("docIdentity");
  const id = identityReport(state.model);
  if (!id.available) { box.hidden = true; return; }
  box.hidden = false;

  const drift = [];
  if (id.offColor) drift.push(`${id.offColor} off-palette colour${id.offColor > 1 ? "s" : ""}`);
  if (id.offFace) drift.push(`${id.offFace} off-brand face${id.offFace > 1 ? "s" : ""}`);
  if (id.substituted) drift.push(`${id.substituted} substituted font${id.substituted > 1 ? "s" : ""}`);
  if (id.approxWeight) drift.push(`${id.approxWeight} approximated weight${id.approxWeight > 1 ? "s" : ""}`);

  // "approximated" is not a defect of the deck — the palette and the faces all
  // came through, and only a font FILE is missing on this machine. Saying
  // "drifted" for it sends the user looking for an edit nobody made.
  const label = { intact: "intact", approximated: "font missing", drifted: "drifted" }[id.state];

  box.innerHTML = `
    <div class="idhead">
      <span>Identity <small>${id.palette.length} colours · ${id.faces.length} faces</small></span>
      <span class="idstate ${id.state === "drifted" ? "off" : "ok"}">${label}</span>
    </div>
    <details class="iddetails">
      <summary>Palette and fonts from the PDF</summary>
      <div class="swatches">${id.palette.map((c) => `<i style="background:#${c}" title="#${c}"></i>`).join("")}</div>
      <div class="idfaces">${id.faces.map(escapeHtml).join(" · ")}</div>
      ${drift.length ? `<div class="idwarn">${escapeHtml(drift.join(" · "))}</div>` : ""}
      ${id.missingFonts.map((f) => `<div class="idwarn">${escapeHtml(f.label)} — ${f.count} run(s). Install the real cut to match the source exactly.</div>`).join("")}
    </details>
  `;
}

function findingKey(finding) {
  const obj = state.model.pages[finding.page]?.objects?.find((o) => o.id === finding.objectId) ?? null;
  // The object snapshot is part of the acknowledgement. If the user edits it
  // later, the new finding gets a new key and returns to Active automatically.
  return JSON.stringify([finding.rule, finding.page, finding.objectId ?? null, finding.message, obj]);
}

function findingCounts(findings) {
  return findings.reduce((counts, f) => ({ ...counts, [f.severity]: counts[f.severity] + 1 }),
    { error: 0, warn: 0, info: 0 });
}

function inspectFinding(finding) {
  state.selected = finding.objectId ?? null;
  if (!finding.fixable && !state.compare && !state.overlay) {
    state.compare = true;
    $("compare").classList.add("on");
    applyView();
  }
  paintPage(finding.page);
  goToPage(finding.page, { scroll: true });
  renderInspector();
}

function renderDoctorList(result, active, resolved) {
  const list = $("docList");
  const viewingDone = state.doctorView === "done";
  const findings = viewingDone ? resolved : active;
  if (!findings.length) {
    list.innerHTML = `<div class="docclean">${viewingDone
      ? "Nothing is marked done in this review."
      : result.clean
        ? "This deck is clean. Re-check after edits to keep it that way."
        : "No active findings. Marked-done items remain available in the Done tab."}</div>`;
    return;
  }

  if (viewingDone) {
    list.innerHTML = findings.map((f, i) => `<div class="card resolved">
      <h4>${escapeHtml(f.title)} <span class="cnt">p${f.page + 1}</span></h4>
      <div class="resolved-note">Acknowledged for the current state of this object. Editing it makes the finding active again.</div>
      <ul class="hits"><li>
        <button class="finding-main" data-resolved-inspect="${i}"><b>p${f.page + 1}</b><span>${escapeHtml(f.message)}</span></button>
        <button class="finding-reopen" data-reopen="${i}">Reopen</button>
      </li></ul></div>`).join("");
    list.querySelectorAll("[data-resolved-inspect]").forEach((b) => { b.onclick = () => inspectFinding(findings[+b.dataset.resolvedInspect]); });
    list.querySelectorAll("[data-reopen]").forEach((b) => {
      b.onclick = () => {
        const finding = findings[+b.dataset.reopen];
        state.resolvedDoctor.delete(findingKey(finding));
        checkDeck();
        setStatus("Finding reopened and returned to Active.");
      };
    });
    return;
  }

  const indexed = active.map((finding, index) => ({ finding, index }));
  const groups = new Map();
  for (const item of indexed) {
    if (!groups.has(item.finding.rule)) groups.set(item.finding.rule, []);
    groups.get(item.finding.rule).push(item);
  }
  const order = { error: 0, warn: 1, info: 2 };
  list.innerHTML = [...groups.entries()]
    .sort((a, b) => order[a[1][0].finding.severity] - order[b[1][0].finding.severity] || b[1].length - a[1].length)
    .map(([ruleId, items]) => {
      const f = items[0].finding;
      const rule = RULE_BY_ID.get(ruleId) ?? {};
      const hits = items.map(({ finding: h, index }) => `<li>
        <button class="finding-main" data-inspect="${index}"><b>p${h.page + 1}</b><span>${escapeHtml(h.message)}</span></button>
        <button class="finding-done" data-done="${index}" title="Acknowledge this finding for the current object state">Done</button>
      </li>`).join("");
      const action = f.fixable
        ? `<button class="btn" data-fix="${escapeHtml(ruleId)}">Fix ${items.length}${rule.changesDesign ? " (changes design)" : ""}</button>`
        : `<span class="manual">Inspect, fix it yourself, then mark that line Done.</span>`;
      return `<div class="card ${f.severity}">
        <h4><span class="severity-label">${escapeHtml(f.severity)}</span>${escapeHtml(f.title)} <span class="cnt">${items.length}</span></h4>
        <div class="why">${escapeHtml(f.why ?? "")}</div>
        <ul class="hits">${hits}</ul>${action}
      </div>`;
    }).join("");

  list.querySelectorAll("[data-inspect]").forEach((b) => { b.onclick = () => inspectFinding(active[+b.dataset.inspect]); });
  list.querySelectorAll("[data-done]").forEach((b) => {
    b.onclick = () => {
      const finding = active[+b.dataset.done];
      state.resolvedDoctor.set(findingKey(finding), finding);
      checkDeck();
      setStatus("Finding marked Done for this object state. It will return if the object changes.", "ok");
    };
  });
  list.querySelectorAll("button[data-fix]").forEach((b) => {
    b.onclick = () => {
      pushUndo();
      const r = applyFixes(state.model, b.dataset.fix, { includeDesign: true });
      render(); checkDeck();
      const left = r.after.findings.filter((f) => f.rule === b.dataset.fix).length;
      setStatus(
        `Fixed ${r.applied} in ${r.passes} pass(es)${left ? `, ${left} still open` : ""} · score now ${r.after.score}. Ctrl+Z to undo.`,
        left ? "" : "ok");
    };
  });
}

function checkDeck() {
  if (!state.model) return;
  const result = runDoctor(state.model, state.coverage);
  state.doctor = result;

  const keysNow = new Set(result.findings.map(findingKey));
  for (const key of state.resolvedDoctor.keys()) if (!keysNow.has(key)) state.resolvedDoctor.delete(key);
  const active = result.findings.filter((f) => !state.resolvedDoctor.has(findingKey(f)));
  const resolved = result.findings.filter((f) => state.resolvedDoctor.has(findingKey(f)));
  const counts = findingCounts(active);
  state.doctorActiveResult = { ...result, findings: active, counts, clean: active.length === 0 };

  const pill = $("docScore");
  pill.hidden = false;
  pill.textContent = result.score;
  $("docScoreBig").textContent = result.score;
  $("docSub").innerHTML = result.clean
    ? `<span class="ok">measured clean</span> · ${result.objects} objects checked`
    : `${counts.error} error · ${counts.warn} warn · ${counts.info} info` +
      `${resolved.length ? ` · <b>${resolved.length} done</b>` : ""} · measured over ${result.objects} objects`;

  $("docActiveCount").textContent = active.length;
  $("docDoneCount").textContent = resolved.length;
  $("docActiveTab").classList.toggle("active", state.doctorView === "active");
  $("docDoneTab").classList.toggle("active", state.doctorView === "done");
  $("docActiveTab").setAttribute("aria-selected", String(state.doctorView === "active"));
  $("docDoneTab").setAttribute("aria-selected", String(state.doctorView === "done"));

  renderIdentity();
  refreshFixAll(state.doctorActiveResult);
  renderDoctorList(result, active, resolved);
}

/**
 * Label the button with what it will ACTUALLY do, and say what it will not.
 *
 * "Fix all defects" is a promise the button cannot keep — most findings on a
 * real deck are design changes behind the checkbox, or need a human — and a
 * button that fixes 5 of 14 while claiming "all" is what made this read as
 * broken. The count comes from the same triage the fixer uses, so the label and
 * the behaviour cannot drift apart.
 */
function refreshFixAll(result) {
  const includeDesign = $("docDesign").checked;
  const t = triageFindings(result.findings, { includeDesign });
  const btn = $("docFixAll");

  btn.disabled = t.now === 0;
  btn.textContent = t.now === 0 ? "Nothing to auto-fix" : `Fix ${t.now} defect${t.now > 1 ? "s" : ""}`;

  const notes = [];
  if (!includeDesign && t.design) notes.push(`${t.design} design change${t.design > 1 ? "s" : ""} (tick the box)`);
  if (t.manual) notes.push(`${t.manual} need${t.manual > 1 ? "" : "s"} your decision`);
  $("docRemaining").textContent = notes.length ? `Not included: ${notes.join(" · ")}.` : "";
}

function openDoctor() {
  $("doctorPanel").hidden = false;
  checkDeck();
}

$("doctor").onclick = () => {
  const p = $("doctorPanel");
  p.hidden ? openDoctor() : (p.hidden = true);
};
$("docClose").onclick = () => { $("doctorPanel").hidden = true; };
$("docRecheck").onclick = () => {
  checkDeck();
  setStatus("Doctor re-checked the current deck state.", "ok");
};
$("docActiveTab").onclick = () => { state.doctorView = "active"; checkDeck(); };
$("docDoneTab").onclick = () => { state.doctorView = "done"; checkDeck(); };
// Ticking the box changes what "fix all" means, so the button must re-label
// before it is pressed, not explain itself afterwards.
$("docDesign").onchange = () => { if (state.doctorActiveResult) refreshFixAll(state.doctorActiveResult); };
$("docFixAll").onclick = () => {
  pushUndo();
  const includeDesign = $("docDesign").checked;
  const r = applyFixes(state.model, null, { includeDesign });
  render(); checkDeck();

  // Always account for what is LEFT. Reporting only the number repaired is what
  // made this look broken: it fixed 5, left 9 on screen, and said nothing about
  // them. Repairs can also expose new findings — a zero-size box that gains area
  // can start overlapping — which is why the fixer re-scans and why the
  // remainder is read after the loop rather than assumed.
  const { total, design, manual } = r.remaining;
  const notes = [];
  if (design && !includeDesign) notes.push(`${design} design change(s) — tick “include design changes”`);
  if (manual) notes.push(`${manual} need your decision — click one to inspect it`);
  const tail = total ? ` · ${total} left: ${notes.join("; ") || "nothing more can be repaired automatically"}` : " · deck is clean";

  if (r.applied > 0) {
    setStatus(`Fixed ${r.applied} in ${r.passes} pass(es) · score now ${r.after.score}${tail}. Ctrl+Z to undo.`, total ? "" : "ok");
  } else {
    setStatus(`Nothing to apply${tail}.`, total ? "" : "ok");
  }
};

// ------------------------------------------------------------------ wiring ---
(async () => {
  try {
    const h = await responseJson(await fetch("/api/health"));
    if (h?.identity?.buildId) $("buildId").textContent = h.identity.buildId;
  } catch {}
})();
$("browse").onclick = browse;
$("browseEmpty").onclick = browse;
$("pdfFile").onchange = choosePdf;
$("export").onclick = exportPptx;
$("deliveryMode").onchange = () => invalidateDeliveryAnalysis();
$("undo").onclick = undo;
$("redo").onclick = redo;
$("addText").onclick = () => addObject("text");
$("addShape").onclick = () => addObject("shape");
$("deleteObj").onclick = deleteSelected;
$("sourcePick").onclick = () => setSourceMode("pick");
$("sourceCapture").onclick = () => setSourceMode("capture");
// Zoom and the source views change geometry and classes only, never the object
// DOM, so they never repaint a slide's contents.
$("zoomIn").onclick = () => { state.zoom = Math.min(4, state.zoom * 1.25); applyView(); };
$("zoomOut").onclick = () => { state.zoom = Math.max(0.25, state.zoom / 1.25); applyView(); };
$("compare").onclick = () => {
  state.compare = !state.compare; state.overlay = false;
  if (!state.compare) state.sourceMode = null;
  $("compare").classList.toggle("on", state.compare);
  $("overlay").classList.remove("on");
  applyView();
};
$("overlay").onclick = () => {
  state.overlay = !state.overlay; state.compare = false; state.sourceMode = null;
  $("overlay").classList.toggle("on", state.overlay);
  $("compare").classList.remove("on");
  applyView();
};

// Throttled on a timer rather than requestAnimationFrame. rAF is the usual
// advice for scroll handlers, but it does not fire at all while a tab is not
// compositing, which makes the behaviour both wrong in a background tab and
// impossible to verify without a visible window. Updating a highlight ~15x a
// second needs no frame sync.
$("workspace").addEventListener("scroll", () => {
  if (syncPageFromScroll._q) return;
  syncPageFromScroll._q = setTimeout(() => {
    syncPageFromScroll._q = 0;
    syncPageFromScroll();
  }, 60);
}, { passive: true });

window.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (typing) return;
  // Up/Down and Left/Right both step slides: the deck reads as a vertical
  // document now, and PageUp/PageDown are what a reader reaches for.
  const back = e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp";
  const fwd = e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown";
  if (back || fwd) {
    const had = state.selected;
    state.selected = null;
    if (had) { renderCurrent(pageOf(had)); renderInspector(); }
    e.preventDefault();
    goToPage(state.page + (fwd ? 1 : -1), { scroll: true });
    return;
  }
  if (e.key === "Escape" && state.selected) {
    const on = pageOf(state.selected);
    state.selected = null;
    renderCurrent(on); renderInspector();
  }
  // `typing` above already excludes inputs and in-place text editing, so Delete
  // here can only mean the selected object on the slide.
  if ((e.key === "Delete" || e.key === "Backspace") && state.selected) { e.preventDefault(); deleteSelected(); }
});
