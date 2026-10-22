/**
 * CONVERGENCE BENCHMARK v1 — how far from done, in one number and one list.
 *
 * WHY THIS EXISTS. This project has instruments for everything and no finish
 * line. Every session found and closed a real class, and none of them could say
 * whether the product was closer to done, because nothing measured the WHOLE
 * thing end to end on documents a user would actually convert. So each session
 * ended feeling identical to the last.
 *
 * This runs THE REAL APP — `node src/cli.js convert`, spawned, not
 * reimplemented — over a FROZEN multi-producer set, renders the result in
 * PowerPoint, and scores the render against the source page. One score, one
 * ranked damage list, the same corpus every time.
 *
 *   frozen PDFs -> src/cli.js convert -> .pptx -> PowerPoint render
 *                                                       |
 *                        source page render <-- compared
 *
 * WHAT COUNTS AS DAMAGE, and this is the whole design decision. Only things a
 * reader would SEE or a downstream tool would MIS-READ. `TEXTBOX_WIDTH` is
 * deliberately excluded: 2664 of them on one deck, p50 1.78pt, and every one
 * inspected was a shaping difference of a third of a character. It stays a
 * DIAGNOSTIC SIGNAL — it led to a real numeric-reconstruction bug and must not be
 * deleted — but a signal that fires 2664 times cannot rank anything, and a list
 * it dominates hides the eight things that matter.
 *
 *   DIAGNOSTIC SIGNAL  !=  FAILURE GATE
 *
 * Usage:
 *   node experiments/benchmark/run.js                     # score, write baseline
 *   node experiments/benchmark/run.js --out after.json    # score into a file
 *   node experiments/benchmark/run.js --diff a.json b.json
 *   node experiments/benchmark/run.js --only ilovepdf-unit5
 *   node experiments/benchmark/run.js --delivery smart --out smart.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { qualityViews } from "./calibrate-delivery.js";
import { normalizeDeliveryMode } from "../../src/delivery/policy.js";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CORPUS = JSON.parse(fs.readFileSync(path.join(HERE, "corpus.json"), "utf8"));
const WORK = path.resolve(".work/benchmark");
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };

/* ---------------------------------------------------------------- diff mode */
if (process.argv.includes("--diff")) {
  const i = process.argv.indexOf("--diff");
  const A = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8"));
  const B = JSON.parse(fs.readFileSync(process.argv[i + 2], "utf8"));
  const d = (x, y) => (y - x >= 0 ? "+" : "") + (y - x).toFixed(4);
  const av = qualityViews(A), bv = qualityViews(B);
  const value = (x) => x == null ? "n/a" : x.toFixed(4);
  console.log(`\nCONVERGENCE  ${path.basename(process.argv[i + 1])} -> ${path.basename(process.argv[i + 2])}\n`);
  console.log(`  editable visual ${value(av.editableVisual)} -> ${value(bv.editableVisual)}   ${d(av.editableVisual, bv.editableVisual)}`);
  console.log(`                  ${av.editableSource} -> ${bv.editableSource}`);
  if (av.productVisual != null || bv.productVisual != null) {
    const delta = av.productVisual != null && bv.productVisual != null ? `   ${d(av.productVisual, bv.productVisual)}` : "";
    console.log(`  product visual  ${value(av.productVisual)} -> ${value(bv.productVisual)}${delta}`);
    console.log(`  editable rate   ${value(av.editablePageRate)} -> ${value(bv.editablePageRate)}`);
  } else {
    console.log(`  product visual  unavailable in legacy reports`);
  }
  console.log(`  damage regions  ${String(A.damageTotal).padStart(6)} -> ${String(B.damageTotal).padEnd(6)}  ${B.damageTotal - A.damageTotal >= 0 ? "+" : ""}${B.damageTotal - A.damageTotal}`);
  console.log(`  pages damaged   ${String(A.pagesDamaged).padStart(6)} -> ${String(B.pagesDamaged).padEnd(6)}`);
  const classes = [...new Set([...Object.keys(A.byClass), ...Object.keys(B.byClass)])];
  console.log(`\n  class                       before    after`);
  for (const c of classes.sort((x, y) => (B.byClass[y]?.regions ?? 0) - (B.byClass[x]?.regions ?? 0))) {
    const a = A.byClass[c] ?? { regions: 0, pages: 0 }, b = B.byClass[c] ?? { regions: 0, pages: 0 };
    if (a.regions === b.regions) continue;
    console.log(`  ${c.padEnd(26)} ${String(a.regions).padStart(6)}   ${String(b.regions).padStart(6)}`);
  }
  console.log(`\n  per deck visual`);
  for (const k of Object.keys(B.decks)) {
    const a = A.decks[k]?.visual, b = B.decks[k].visual;
    if (a == null || Math.abs(a - b) < 0.0005) continue;
    console.log(`  ${k.padEnd(22)} ${a.toFixed(4)} -> ${b.toFixed(4)}  ${d(a, b)}`);
  }
  process.exit(0);
}

/* --------------------------------------------------------------- score mode */
// Keep diff mode able to read historical artifacts even when the conversion
// runtime is unavailable; only a real score run needs these heavy modules.
const mupdf = await import("mupdf");
const { renderPptx } = await import("../../src/render/powerpoint.js");
const { comparePage } = await import("../../src/render/compare.js");
const { inspectPptx, summarize } = await import("../../src/pptx/inspect.js");
const { measureDeck } = await import("../delivery/measure.js");
const { modelFromPdf } = await import("../../src/model/normalize.js");
const { applyFixes, DEFAULT_REPAIRS, runDoctor } = await import("../../web/doctor.js");

/**
 * THE CORPUS IS SCORED ON THE EDITABLE CANDIDATE, AND THAT IS THE SCORE’S MEANING.
 *
 * Raster fallback raises VISUAL by replacing exactly the pages the converter
 * cannot fix, so a benchmark that quietly allowed it could not tell a better
 * converter from a more willing one. `--delivery smart` exists to exercise the
 * fallback path end to end on real documents — the one thing unit tests cannot
 * prove — and the mode is written into the output so a smart run and an editable
 * run can never be `--diff`ed as though they measured the same thing.
 */
const deliveryMode = normalizeDeliveryMode(argOf("--delivery", "editable"));

const only = argOf("--only", null);
const decks = CORPUS.decks.filter((d) => !only || d.id === only);
fs.mkdirSync(WORK, { recursive: true });

/** A visible overlap, not two neighbours touching. Scaled by the type. */
const OVERLAP_EM = 0.35;
/** A page this far from its source has something wrong nothing else named. */
const VISUAL_LOW = 0.70;

const damage = [];          // { cls, deck, page, detail }
const perDeck = {};
let pagesTotal = 0, pagesSuccessfullyScored = 0, inkSum = 0;

for (const deck of decks) {
  const t0 = Date.now();
  const modeDir = path.join(WORK, deliveryMode);
  fs.mkdirSync(modeDir, { recursive: true });
  const pptx = path.join(modeDir, `${deck.id}.pptx`);
  const reportPath = path.join(modeDir, `${deck.id}.report.json`);
  const renderDir = path.join(modeDir, `${deck.id}-render`);
  const add = (cls, page, detail) => damage.push({ cls, deck: deck.id, page, detail });

   // A failed conversion must leave NOTHING behind, or the next stage reads the
   // PREVIOUS mode's package and reports it as this one's. Measured 2026-08-22:
   // the flattened leg failed on two decks and the gauntlet inspected smart's
   // artifacts for both, printing "forensics pass  roundtrip ok".
   fs.rmSync(pptx, { force: true });
   fs.rmSync(reportPath, { force: true });
   fs.rmSync(renderDir, { recursive: true, force: true });

   // ---- THE REAL APP, spawned. Not a reimplementation of it. -----------------
   let convertOk = true, report = null;
  try {
    execFileSync(process.execPath, ["src/cli.js", "convert", deck.path, "--out", pptx, "--report", reportPath, "--delivery", deliveryMode],
      { encoding: "utf8", timeout: 1800000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (e) {
    convertOk = false;
    add("CONVERT_FAILED", null, String(e.message ?? e).split("\n")[0].slice(0, 160));
  }

  const d = perDeck[deck.id] = {
    pages: deck.pages,
    producer: deck.producer,
    visual: 0,
    converted: convertOk,
    pagesCompared: 0,
    pageScores: [],
  };
  if (!convertOk) { pagesTotal += deck.pages; continue; }

  // ---- what the app itself says it lost -------------------------------------
  // `errors` is a COUNT and `detail` is the list — the ledger's own shape.
  for (const x of (report.coverage?.detail ?? []).filter((v) => v.severity === "error")) {
    add("COVERAGE_ERROR", x.page ?? null, String(x.message ?? JSON.stringify(x)).slice(0, 120));
  }
  // What the app actually DELIVERED on this deck: how many pages stayed
  // editable and how many were replaced by a picture. Without it the product
  // view below can only assert that nothing was flattened.
  d.deliveryTotals = report.delivery?.totals ?? null;
  d.deliveryElements = report.coverage ? {
    native: report.coverage.nativeElements ?? 0,
    rasterized: report.coverage.rasterizedElements ?? 0,
    dropped: report.coverage.droppedElements ?? 0,
  } : null;
  d.nativeShapes = report.shapes ?? 0;
  d.images = report.images ?? 0;
  if (report.imagesDropped) add("IMAGE_DROPPED", null, `${report.imagesDropped} image(s) reached the model and not the package`);
  if (report.shapesUnsupported) add("VECTOR_UNSUPPORTED", null, `${report.shapesUnsupported} path(s) no PowerPoint primitive can hold`);

  // ---- fonts: only the ones that DAMAGE what a reader sees -------------------
  const insp = await inspectPptx(pptx);
  const sum = summarize(insp, {});
  d.embeddedFonts = insp.embeddedFonts.length;
  const damaging = (sum.lines.find((l) => l.includes("damaging")) ?? "").split(":").pop().trim();
  if (damaging && damaging !== "none") add("FONT_DAMAGING", null, damaging.slice(0, 120));

  // ---- text the doctor can PROVE is wrong -----------------------------------
  // Only the high-precision rules. `characters-missing` is 100% precision over
  // 10206 blocks; the judgement-call rules are not damage and are not counted.
  try {
    const model = modelFromPdf(deck.path);
    for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);
    const HIGH_PRECISION = ["characters-missing", "broken-characters", "dropped-alef"];
    const doc = runDoctor(model, report.coverage);
    for (const f of (doc.findings ?? doc) ) {
      if (!HIGH_PRECISION.includes(f.rule)) continue;
      add("TEXT_DAMAGED", f.page ?? null, `${f.rule}: ${String(f.message ?? "").slice(0, 90)}`);
    }
  } catch (e) {
    add("DOCTOR_FAILED", null, String(e.message).slice(0, 120));
  }

  // ---- render, and compare every page against its own source page -----------
  let rendered = false;
  try { renderPptx(pptx, renderDir, { widthPx: 1400, timeoutMs: 1800000 }); rendered = true; }
  catch (e) { add("RENDER_FAILED", null, String(e.message).split("\n")[0].slice(0, 160)); }

  if (rendered) {
    const srcDoc = mupdf.Document.openDocument(fs.readFileSync(deck.path), "application/pdf");
    const canvas = insp.slideSizePt;
    const pngs = fs.readdirSync(renderDir).filter((f) => /^slide-\d+\.png$/.test(f)).sort();
    let sum2 = 0, n = 0;
    for (let i = 0; i < Math.min(pngs.length, srcDoc.countPages()); i++) {
      d.pagesCompared++;
      const png = path.join(renderDir, pngs[i]);
      try {
        // The fit is a property of the PAGE, so a document with several page
        // geometries is compared where its content actually is — without this a
        // correct fitted slide scores ~0.35 and dominates the ranking.
        const box = srcDoc.loadPage(i).getBounds();
        const srcW = box[2] - box[0], srcH = box[3] - box[1];
        const scale = Math.min(canvas.w / srcW, canvas.h / srcH);
        const fitted = Math.abs(scale - 1) > 0.0001 ||
          Math.abs((canvas.w - srcW * scale) / 2) > 0.05 || Math.abs((canvas.h - srcH * scale) / 2) > 0.05;
        const r = comparePage(deck.path, i, png, {
          fit: fitted ? { xPt: (canvas.w - srcW * scale) / 2, yPt: (canvas.h - srcH * scale) / 2, canvasWPt: canvas.w } : null,
        });
        // `comparePage` returns {raw, best}; `best` allows a one-pixel vertical
        // search, which is what compare-deck reads. Reading a top-level `iou`
        // that does not exist silently scored every page 0.000 — an instrument
        // reporting a perfect zero is never the system, it is the reader.
        const best = r.best ?? r.raw;
        const iou = Math.max(0, Math.min(1, best?.iou ?? 0));
        d.pageScores.push({
          page: i + 1,
          candidateInkIou: iou,
          missingPct: best?.missingPct ?? null,
          extraPct: best?.extraPct ?? null,
          bestDy: best?.dy ?? 0,
          compareFailure: null,
        });
        sum2 += iou; n++;
        if (iou < VISUAL_LOW) add("VISUAL_LOW", i + 1, `ink IoU ${iou.toFixed(3)} against its own source page`);
      } catch (e) {
        const reason = String(e.message ?? e).slice(0, 100);
        d.pageScores.push({
          page: i + 1,
          candidateInkIou: null,
          missingPct: null,
          extraPct: null,
          bestDy: null,
          compareFailure: reason,
        });
        add("COMPARE_FAILED", i + 1, reason);
      }
    }
    d.visual = n ? sum2 / n : 0;
    inkSum += sum2; pagesTotal += n; pagesSuccessfullyScored += n;

    // ---- what PowerPoint itself did with the boxes -------------------------
    try {
      const m = measureDeck(pptx);
      if (m.ok) {
        for (const [si, slide] of m.slides.entries()) {
          const texts = slide.shapes.filter((s) => s.hasText && s.boundL != null && s.boundW > 0 && s.boundH > 0);
          for (const s of texts) {
            if (s.boundL < -1 || s.boundT < -1 ||
                s.boundL + s.boundW > m.slideW + 1 || s.boundT + s.boundH > m.slideH + 1) {
              add("OFF_SLIDE", si + 1, `${JSON.stringify(String(s.text).slice(0, 24))} ink leaves the slide`);
            }
          }
          for (let a = 0; a < texts.length; a++) for (let b = a + 1; b < texts.length; b++) {
            const A = texts[a], B = texts[b];
            const ox = Math.min(A.boundL + A.boundW, B.boundL + B.boundW) - Math.max(A.boundL, B.boundL);
            const oy = Math.min(A.boundT + A.boundH, B.boundT + B.boundH) - Math.max(A.boundT, B.boundT);
            const em = Math.max(6, Math.min(A.fontSize ?? 12, B.fontSize ?? 12));
            // BOTH axes must exceed a third of an em. Two correctly adjacent
            // neighbours touch by shaping drift, and counting that produced 50
            // "overlaps" on a deck where the fix had just made the text MORE
            // faithful. Real collision is deep in both directions.
            if (ox > OVERLAP_EM * em && oy > OVERLAP_EM * em) {
              add("OBJECT_OVERLAP", si + 1,
                `${ox.toFixed(1)}x${oy.toFixed(1)}pt ${JSON.stringify(String(A.text).slice(0, 16))} / ${JSON.stringify(String(B.text).slice(0, 16))}`);
            }
          }
        }
      } else add("MEASURE_FAILED", null, String(m.error).slice(0, 120));
    } catch (e) { add("MEASURE_FAILED", null, String(e.message).slice(0, 120)); }
  }
  if (d.pageScores.length !== d.pagesCompared) {
    throw new Error(`${deck.id}: pageScores count does not match pagesCompared`);
  }
  d.elapsedMs = Date.now() - t0;
  if (convertOk && fs.existsSync(pptx)) {
    d.artifactHash = crypto.createHash("sha256").update(fs.readFileSync(pptx)).digest("hex");
  }
  console.log(`  ${deck.id.padEnd(22)} visual ${d.visual.toFixed(4)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

/* ------------------------------------------------------------------ report */
const byClass = {};
for (const x of damage) {
  const k = byClass[x.cls] ??= { regions: 0, pages: new Set(), decks: new Set(), samples: [] };
  k.regions++;
  if (x.page != null) k.pages.add(`${x.deck}:${x.page}`);
  k.decks.add(x.deck);
  if (k.samples.length < 3) k.samples.push(`${x.deck}${x.page ? ` p${x.page}` : ""} — ${x.detail}`);
}
const out = {
  ran: new Date().toISOString().slice(0, 19),
  corpusFrozen: CORPUS.frozen,
  deliveryMode,
  complete: true,
  decksScored: decks.length,
  pagesScored: pagesTotal,
  visual: pagesTotal ? inkSum / pagesTotal : 0,
  damageTotal: damage.length,
  pagesDamaged: new Set(damage.filter((x) => x.page != null).map((x) => `${x.deck}:${x.page}`)).size,
  byClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) =>
    [k, { regions: v.regions, pages: v.pages.size, decks: v.decks.size, samples: v.samples }])),
  decks: perDeck,
};
/**
 * THE TWO VIEWS, AND THE ONLY THING THAT KEEPS THEM HONEST IS THE MODE.
 *
 * The deck this run rendered is whatever `--delivery` produced. In `editable`
 * that IS the editable candidate and the score means core converter quality. In
 * `smart` it contains flattened pages — MEASURED, `powerpoint-2013` delivers 7
 * editable pages and 34 pictures and scores 96.77% against 51.66% editable —
 * and reporting that as editable quality would be exactly the raster-gaming the
 * two views exist to prevent. So a non-editable run does not get to fill in the
 * editable view at all; it says it did not measure it.
 */
const delivered = Object.values(perDeck).reduce((acc, d) => {
  if (!d.deliveryTotals) return acc;
  acc.known = true;
  acc.editable += d.deliveryTotals.editable ?? 0;
  acc.sourceRaster += d.deliveryTotals.sourceRaster ?? 0;
  acc.fallbackRaster += d.deliveryTotals.fallbackRaster ?? 0;
  acc.pages += d.deliveryTotals.pages ?? 0;
  return acc;
}, { known: false, editable: 0, sourceRaster: 0, fallbackRaster: 0, pages: 0 });
const flattenedPages = delivered.sourceRaster + delivered.fallbackRaster;
const finalVisual = pagesSuccessfullyScored ? inkSum / pagesSuccessfullyScored : 0;

out.editableQuality = deliveryMode === "editable"
  ? {
      basis: "editable-candidate-powerpoint-render",
      candidateVisual: finalVisual,
      pagesScored: pagesSuccessfullyScored,
      damage: { regions: out.damageTotal, pages: out.pagesDamaged, byClass: out.byClass },
    }
  : {
      basis: `not-measured-under-delivery-${deliveryMode}`,
      candidateVisual: null,
      pagesScored: pagesSuccessfullyScored,
      damage: { regions: out.damageTotal, pages: out.pagesDamaged, byClass: out.byClass },
    };
out.productQuality = {
  basis: `delivered-${deliveryMode}-powerpoint-render`,
  finalVisual,
  pagesScored: pagesSuccessfullyScored,
  // Null rather than a guess when no deck reported its delivery, so "we did not
  // ask" can never be read as "nothing was flattened".
  editablePages: delivered.known ? delivered.editable : null,
  editablePageRate: delivered.known && delivered.pages ? delivered.editable / delivered.pages : null,
  fallbackPages: delivered.known ? flattenedPages : null,
  sourceRasterPages: delivered.known ? delivered.sourceRaster : null,
  fallbackApplied: delivered.known ? flattenedPages > 0 : null,
};

console.log(`\n${"=".repeat(78)}`);
console.log(`CONVERGENCE BENCHMARK v1 — ${out.decksScored} producers · ${out.pagesScored} pages compared`);
console.log(`${"=".repeat(78)}`);
console.log(`  VISUAL          ${(out.visual * 100).toFixed(2)}%   mean ink IoU, source page vs PowerPoint render`);
console.log(`  DAMAGE          ${out.damageTotal} region(s) over ${out.pagesDamaged} page(s)`);
console.log(`\nTOP REMAINING DAMAGE`);
const ranked = Object.entries(out.byClass).sort((a, b) => b[1].regions - a[1].regions);
for (const [i, [cls, v]] of ranked.entries()) {
  console.log(`${String(i + 1).padStart(2)}. ${cls.padEnd(20)} ${String(v.regions).padStart(5)} region(s)  ${String(v.pages).padStart(4)} page(s)  ${v.decks} deck(s)`);
  for (const s of v.samples) console.log(`      ${s}`);
}
console.log(`\nPER DECK`);
console.log(`  deck                   pages   visual   converted`);
for (const [k, v] of Object.entries(perDeck)) {
  console.log(`  ${k.padEnd(22)} ${String(v.pages).padStart(5)}   ${(v.visual * 100).toFixed(2).padStart(6)}%   ${v.converted ? "yes" : "NO"}`);
}

const outFile = argOf("--out", path.join(HERE, "baseline.json"));
fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf8");
console.log(`\nwrote ${outFile}`);
