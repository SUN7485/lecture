import * as fs from "node:fs";
import * as path from "node:path";
import { writePptx } from "../pptx/write.js";
import { embedFontsOrFail } from "../pptx/embed.js";
import { inspectPptx } from "../pptx/inspect.js";
import { auditPage, summarizeCoverage } from "../model/coverage.js";
import { coveredByUbiquitous } from "../fonts/coverage.js";
import { renderPptx, powerPointAvailable } from "../render/powerpoint.js";
import { comparePage } from "../render/compare.js";
import { runDoctor } from "../../web/doctor.js";
import { measureDeck } from "../../experiments/delivery/measure.js";
import { sourcePagePng } from "./raster.js";
import {
  DEFAULT_DELIVERY_THRESHOLDS,
  decidePage,
  measurementReasons,
  normalizeDeliveryMode,
  flatteningImproves,
} from "./policy.js";

const STAGES = ["candidate", "powerpoint-analysis", "fallback-build", "final-verification", "font-embedding", "done"];

const progressOf = (stage) => Math.round((STAGES.indexOf(stage) / (STAGES.length - 1)) * 100);

function fitFor(page) {
  const f = page.sourceFit;
  if (!f?.fitted) return null;
  return { xPt: f.x, yPt: f.y, canvasWPt: page.widthPt };
}

function addReason(map, pageIndex, reason) {
  const list = map.get(pageIndex) ?? [];
  list.push(reason);
  map.set(pageIndex, list);
}

function damagingFontReasons(page) {
  const bad = new Set();
  for (const obj of page.objects) {
    if (obj.type !== "text") continue;
    for (const run of obj.runs ?? []) {
      if (!run.fontSubstituted) continue;
      if (coveredByUbiquitous(run.text ?? "").covered !== true) {
        bad.add(run.fontRequested || run.fontFamily || "unknown font");
      }
    }
  }
  return bad.size ? [{ code: "font-damaging", fonts: [...bad] }] : [];
}

function totals(pages) {
  const count = (result) => pages.filter((p) => p.result === result).length;
  return {
    editable: count("editable"),
    sourceRaster: count("source-raster"),
    fallbackRaster: count("fallback-raster"),
    flattened: pages.filter((p) => p.result !== "editable").length,
    pages: pages.length,
  };
}

/**
 * Build the user-facing deck and its page-level delivery report.
 * The editable model is never mutated; fallback decisions exist only here.
 */
export async function exportWithDelivery({
  model,
  sourcePdf,
  outPath,
  mode = "editable",
  overrides = {},
  thresholds = DEFAULT_DELIVERY_THRESHOLDS,
  allowSkipFonts = false,
  onStage = () => {},
}) {
  const deliveryMode = normalizeDeliveryMode(mode);
  if (!model?.pages?.length) throw new Error("cannot export an empty model");
  if (!sourcePdf || !fs.existsSync(sourcePdf)) throw new Error("source PDF is unavailable for delivery verification");

  const finalPath = path.resolve(outPath);
  // Keep the verified temporary package on the output volume. Windows cannot
  // atomically rename from the system temp directory on C: into a project on
  // D: (`EXDEV`), which made a successful export fail at the final step.
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(path.dirname(finalPath), ".pptx-delivery-"));
  const candidatePath = path.join(scratch, "candidate.pptx");
  const candidateRender = path.join(scratch, "candidate-render");
  const finalRaw = path.join(scratch, "final.pptx");
  const finalRender = path.join(scratch, "final-render");
  const rasterDir = path.join(scratch, "source-pages");
  fs.mkdirSync(rasterDir, { recursive: true });

  const stage = (name, detail = "") => onStage({ stage: name, progress: progressOf(name), detail });

  try {
    stage("candidate", "Writing editable candidate");
    const candidateStats = await writePptx(model, candidatePath);

    const audits = model.pages.map((p, i) => auditPage(p, model.rawCounts?.[i] ?? {
      glyphCount: 0, vectorCount: 0, imageCount: 0, shadeCount: 0, backgroundCount: 0,
    }));
    const coverage = summarizeCoverage(audits);
    const hardReasons = new Map();
    for (const audit of audits) {
      for (const issue of audit.issues.filter((x) => x.severity === "error")) {
        addReason(hardReasons, audit.page, { code: "coverage-error", rule: issue.rule, message: issue.message });
      }
    }
    const doctor = runDoctor(model, coverage);
    for (const finding of doctor.findings ?? doctor) {
      if (finding.severity === "error" && finding.page != null) {
        addReason(hardReasons, finding.page, { code: "doctor-error", rule: finding.rule, message: finding.message });
      }
    }
    for (const page of model.pages) {
      for (const reason of damagingFontReasons(page)) addReason(hardReasons, page.index, reason);
    }

    const ppAvailable = Boolean(powerPointAvailable());
    let candidateOpened = false;
    let candidateRepaired = null;
    let analysisError = null;
    let candidateAttempted = false;
    const scores = new Map();
    let measured = null;

    stage("powerpoint-analysis", deliveryMode === "smart"
      ? (ppAvailable ? "Rendering candidate through PowerPoint" : "PowerPoint unavailable; safe fallback required")
      : "Editable delivery selected; raster fallback analysis is optional and was not run");
    if (ppAvailable && deliveryMode === "smart") {
      candidateAttempted = true;
      try {
        const rendered = renderPptx(candidatePath, candidateRender, { widthPx: 1400, timeoutMs: 1800000 });
        candidateOpened = Boolean(rendered.opened);
        candidateRepaired = rendered.repaired;
        if (!candidateOpened) analysisError = rendered.error || "PowerPoint did not open the candidate";
        if (candidateOpened) {
          const pngs = fs.readdirSync(candidateRender).filter((f) => /^slide-\d+\.png$/.test(f)).sort();
          for (let i = 0; i < model.pages.length; i++) {
            const page = model.pages[i];
            const png = pngs[i] ? path.join(candidateRender, pngs[i]) : null;
            if (!png) continue;
            const compared = comparePage(sourcePdf, page.index, png, { fit: fitFor(page) });
            scores.set(page.index, {
              inkIou: compared.best.iou,
              missingPct: compared.best.missingPct,
              extraPct: compared.best.extraPct,
              dy: compared.best.dy,
            });
          }
          measured = measureDeck(candidatePath, { timeoutMs: 1800000 });
          if (measured.ok) {
            for (let i = 0; i < model.pages.length; i++) {
              for (const reason of measurementReasons(
                measured.slides[i], { w: measured.slideW, h: measured.slideH }, thresholds.overlapEm)) {
                addReason(hardReasons, model.pages[i].index, reason);
              }
            }
          } else {
            analysisError = measured.error || "PowerPoint measurement failed";
            for (const page of model.pages) addReason(hardReasons, page.index, { code: "powerpoint-measurement-failed" });
          }
        }
      } catch (err) {
        analysisError = String(err?.message || err);
        candidateOpened = false;
      }
    }

    const pages = model.pages.map((page) => {
      const score = scores.get(page.index) ?? null;
      const decision = decidePage({
        page,
        mode: deliveryMode,
        override: overrides[page.index] ?? overrides[String(page.index)] ?? null,
        powerPoint: ppAvailable,
        candidateOpened,
        candidateRepaired: Boolean(candidateRepaired),
        score: score?.inkIou ?? null,
        hardReasons: hardReasons.get(page.index) ?? [],
        thresholds,
      });
      return { page: page.index + 1, pageIndex: page.index, ...decision, candidate: score };
    });

    // Explicit editable mode preserves the current all-editable product, but a
    // PowerPoint oracle that is present and rejects it is a failed export, not an
    // "unavailable" verification. Smart mode can recover by flattening instead.
    if (deliveryMode === "editable" && candidateAttempted && !candidateOpened) {
      throw new Error(`PowerPoint could not verify the editable candidate: ${analysisError || "open failed"}`);
    }

    stage("fallback-build", "Building final mixed deck");
    const pageDelivery = new Map();
    // `source-raster` in editable mode describes what the PDF inherently was;
    // keep the candidate's native image object instead of replacing the page.
    // Only explicitly selected fidelity modes may install a full-page fallback.
    const proposed = pages.filter((p) =>
      p.result === "fallback-raster" || (p.result === "source-raster" && deliveryMode !== "editable"));
    for (const delivered of proposed) {
      const page = model.pages.find((p) => p.index === delivered.pageIndex);
      const imagePath = path.join(rasterDir, `page-${String(delivered.page).padStart(4, "0")}.png`);
      sourcePagePng(sourcePdf, page, imagePath, { widthPx: 1400 });
      pageDelivery.set(page.index, { imagePath });
    }

    /**
     * A PICTURE HAS TO EARN THE PAGE — measured on the delivered slide, not
     * inferred from the editable one being poor.
     *
     * Everything above only established that the editable page is bad. Whether a
     * picture is BETTER is a different question, and on three of ten corpus decks
     * the honest answer was no: replacing an image-only page with a 1400px
     * re-raster cost `camscanner-scan` 4.66 points against its own native
     * delivery. So the proposed set is built once as a TRIAL, rendered, and
     * scored the same way the candidate was; only the pages that actually gain
     * keep their picture, and the rest go back to being editable with the reason
     * recorded rather than silently reverted.
     *
     * The trial deck is always discarded. Reusing it as the final artifact when
     * nothing reverts would save a pass and make the delivered file depend on
     * which branch ran; the deck that ships is built once, by the same path,
     * whatever the measurement decided.
     */
    if (deliveryMode === "smart" && ppAvailable && pageDelivery.size) {
      stage("fallback-analysis", "Measuring whether flattening improves each page");
      const trialPath = `${finalRaw}.trial.pptx`;
      const trialRender = `${finalRender}-trial`;
      await writePptx(model, trialPath, { pageDelivery });
      const rendered = renderPptx(trialPath, trialRender, { widthPx: 1400, timeoutMs: 1800000 });
      const trialPngs = rendered.opened
        ? fs.readdirSync(trialRender).filter((f) => /^slide-\d+\.png$/.test(f)).sort()
        : [];

      for (const delivered of proposed) {
        // AN EXPLICIT CHOICE IS NOT A MEASUREMENT TO BE SECOND-GUESSED. This gate
        // exists to stop SMART from flattening a page automatically when that
        // makes it worse. A reader who asked for fidelity on this page, or ran
        // `--delivery flattened`, has already decided; overruling them with an
        // ink score would make the override a suggestion.
        if (delivered.overrideState === "keep-fidelity") continue;
        const i = model.pages.findIndex((p) => p.index === delivered.pageIndex);
        const png = trialPngs[i] ? path.join(trialRender, trialPngs[i]) : null;
        const flattenedScore = png
          ? comparePage(sourcePdf, model.pages[i].index, png, { fit: fitFor(model.pages[i]) }).best.iou
          : null;
        delivered.flattenedCandidate = flattenedScore;
        const verdict = flatteningImproves(delivered.candidate?.inkIou ?? null, flattenedScore, thresholds.flattenGain);
        delivered.flattenVerdict = verdict;
        if (verdict.improves) continue;
        // Keep every reason that proposed the picture: the page is still poor,
        // it is simply not improved by rasterising it, and hiding that would
        // turn a declared degradation into an invisible one.
        delivered.reasons = [...(delivered.reasons ?? []), verdict];
        if (delivered.result === "fallback-raster") delivered.result = "editable";
        pageDelivery.delete(delivered.pageIndex);
      }
      fs.rmSync(trialPath, { force: true });
      fs.rmSync(trialRender, { force: true, recursive: true });
    }

    let stats;
    if (pageDelivery.size === 0) {
      // The candidate already is the requested all-editable artifact. Reuse it
      // instead of writing the same deck twice (important for 294-page runs).
      fs.renameSync(candidatePath, finalRaw);
      stats = candidateStats;
    } else {
      stats = await writePptx(model, finalRaw, { pageDelivery });
    }

    stage("final-verification", "Verifying delivered fallback pages");
    const hasFlattened = pageDelivery.size > 0;
    let finalOracle = hasFlattened ? "source-image" : "not-run";
    let finalOpened = null;
    let finalRepaired = null;
    let finalPngs = [];
    if (ppAvailable && hasFlattened) {
      const rendered = renderPptx(finalRaw, finalRender, { widthPx: 1400, timeoutMs: 1800000 });
      finalOpened = Boolean(rendered.opened);
      finalRepaired = rendered.repaired;
      if (!finalOpened || finalRepaired) {
        throw new Error(`final deck failed PowerPoint verification${rendered.error ? `: ${rendered.error}` : ""}`);
      }
      finalOracle = "powerpoint";
      finalPngs = fs.readdirSync(finalRender).filter((f) => /^slide-\d+\.png$/.test(f)).sort();
    }

    const finalInspection = await inspectPptx(finalRaw);
    for (let i = 0; i < pages.length; i++) {
      const delivered = pages[i];
      if (!pageDelivery.has(delivered.pageIndex)) continue;
      const slide = finalInspection.slides[i];
      if (!slide || slide.textboxes !== 0 || slide.pictures.length !== 1 || slide.maxCoverage < 0.99) {
        throw new Error(`flattened page ${delivered.page} is not exactly one full-slide image`);
      }
      const page = model.pages[i];
      // The threshold applies to the actual full-page asset stored in the
      // package. PowerPoint's PNG exporter thickens antialiased strokes even
      // when the picture is unchanged (measured: zero missing and zero extra
      // ink, but raw Jaccard 0.80 because the mask has more edge pixels). Gate
      // the asset at the promised 0.97 and record the PowerPoint comparison
      // separately so renderer damage remains visible instead of redefining the
      // benchmark metric or pretending the second rasterization is identical.
      const assetCompared = comparePage(
        sourcePdf, page.index, pageDelivery.get(page.index).imagePath, { fit: fitFor(page) });
      delivered.finalScore = assetCompared.best.iou;
      delivered.assetInkIou = assetCompared.best.iou;
      if (delivered.finalScore < thresholds.flattenedInkIou) {
        throw new Error(
          `flattened page ${delivered.page} scored ${delivered.finalScore.toFixed(4)} below ${thresholds.flattenedInkIou.toFixed(2)}`);
      }
      if (ppAvailable) {
        const renderedCompared = comparePage(
          sourcePdf, page.index, path.join(finalRender, finalPngs[i]), { fit: fitFor(page) });
        delivered.powerPointInkIou = renderedCompared.best.iou;
        delivered.powerPointMissingPct = renderedCompared.best.missingPct;
        delivered.powerPointExtraPct = renderedCompared.best.extraPct;
        // MISSING INK IS THE GUARD. EXTRA INK CANNOT BE WHAT IT CLAIMED TO CATCH.
        //
        // This slide has already been asserted, six lines above, to hold exactly
        // one picture, zero text boxes, and coverage of at least 0.99 — and the
        // asset itself has just been gated at 0.97 against the source. On a slide
        // of that shape, crop, displacement and substitution all show up as
        // MISSING ink, and there is nothing present that could contribute
        // invented content. Surplus ink can only be the second rasterization's
        // thicker antialiased edge.
        //
        // MEASURED, and this is why the flat 3% could not stay. `ilovepdf-unit5`
        // p66 is one of the 31 pages the deck's three physical geometries force
        // to ~65% scale. Converted ALONE, where no scaling happens, it reports
        // `assetInkIou 1.0000` — a pixel-exact raster — and 1.93% extra. Inside
        // the full deck the identical asset reports 3.01% and the export threw,
        // because a downscaled picture carries more edge per unit of ink. The
        // page was perfect; the tolerance was measuring PowerPoint's resampler.
        //
        // So the throw keeps the half that can detect damage, and the surplus is
        // recorded rather than deleted — a diagnostic signal, not a failure gate.
        if (renderedCompared.best.missingPct > 0.03) {
          throw new Error(
            `PowerPoint altered flattened page ${delivered.page}: `
            + `${(renderedCompared.best.missingPct * 100).toFixed(2)}% missing, `
            + `${(renderedCompared.best.extraPct * 100).toFixed(2)}% extra ink`);
        }
      }
    }

    stage("font-embedding", "Embedding fonts used by editable pages");
    const fonts = await embedFontsOrFail(finalRaw, { allowSkip: allowSkipFonts, displayPath: finalPath, timeoutMs: 1800000 });
    fs.rmSync(finalPath, { force: true });
    fs.renameSync(finalRaw, finalPath);

    const delivery = {
      mode: deliveryMode,
      thresholds,
      verification: {
        candidate: candidateAttempted ? (candidateOpened ? "powerpoint" : "failed")
          : (ppAvailable ? "not-run" : "unavailable"),
        final: finalOracle,
        candidateOpened,
        candidateRepaired,
        finalOpened,
        finalRepaired,
        analysisError,
      },
      pages,
      totals: totals(pages),
    };
    stage("done", "Export ready");
    return { stats, candidateStats, fonts, coverage, delivery };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
