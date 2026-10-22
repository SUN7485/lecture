/** Page-level delivery policy. Kept pure so the safety decision is testable. */

export const DELIVERY_MODES = new Set(["smart", "editable", "flattened"]);

export const DEFAULT_DELIVERY_THRESHOLDS = Object.freeze({
  // Calibrated on 294 editable PowerPoint renders: 0.80 would replace 81
  // pages, including a drop-shadow-heavy deck whose mean is 0.7997. The
  // existing measured damage boundary at 0.70 isolates the 41 genuinely low
  // pages and keeps optional Smart mode conservative.
  inkIou: 0.70,
  flattenedInkIou: 0.97,
  overlapEm: 0.35,
  // HOW MUCH BETTER A PICTURE HAS TO BE BEFORE IT IS WORTH LOSING THE TEXT.
  //
  // Being under `inkIou` says the editable page is poor. It does NOT say a
  // picture would be better, and MEASURED over the frozen corpus it often is
  // not: `camscanner-scan` is image-only, its editable delivery already carries
  // the source pictures natively at full resolution, and replacing each page
  // with a 1400px re-raster scored 92.65% against 97.31% — the fallback did
  // 4.66 points of damage on precisely the documents it was written for.
  // `word-arabic` lost 2.97 and `acrobat-pdfmaker` 2.52 the same way.
  //
  // So flattening must EARN the page. 0.02 sits an order of magnitude above the
  // render noise this metric carries (repeat runs of one deck move ~0.003) and
  // far below a real rescue: the pages that genuinely need a picture gain tens
  // of points, not hundredths.
  flattenGain: 0.02,
});

export function normalizeDeliveryMode(value) {
  // Editability is the product default. Raster replacement is an explicit
  // fidelity option, never a silent consequence of omitting this argument.
  const mode = String(value || "editable").toLowerCase();
  if (!DELIVERY_MODES.has(mode)) {
    throw new Error(`invalid delivery mode ${JSON.stringify(value)}; expected smart, editable, or flattened`);
  }
  return mode;
}

/**
 * Did flattening this page actually make it better?
 *
 * The reasons that PROPOSE a picture — a low ink IoU, an overlap, off-slide ink
 * — are all statements about the editable page being bad. None of them is a
 * statement about the picture being good, and the two are not the same claim.
 * This is the second one, measured on the delivered artifact.
 *
 * A page with no candidate score cannot be compared, and there the picture is
 * the only option left rather than the better one — say so with its own reason
 * rather than quietly counting it as an improvement.
 */
export function flatteningImproves(candidateScore, flattenedScore, gain = DEFAULT_DELIVERY_THRESHOLDS.flattenGain) {
  if (!Number.isFinite(candidateScore)) return { improves: true, code: "flatten-uncompared" };
  if (!Number.isFinite(flattenedScore)) return { improves: false, code: "flatten-unmeasurable" };
  const delta = flattenedScore - candidateScore;
  return delta >= gain
    ? { improves: true, code: "flatten-improves", delta, candidateScore, flattenedScore }
    : { improves: false, code: "flatten-not-an-improvement", delta, candidateScore, flattenedScore };
}

/** A page made only from source pictures has no editable semantics to recover. */
export function hasEditableSemantics(page) {
  return page.objects.some((o) =>
    (o.type === "text" && Boolean(o.text)) ||
    (o.type === "shape" && o.reconstructionStrategy !== "unsupported"));
}

/** PowerPoint-rendered layout failures, using the benchmark's existing 0.35em rule. */
export function measurementReasons(measuredSlide, slideSize, overlapEm = DEFAULT_DELIVERY_THRESHOLDS.overlapEm) {
  if (!measuredSlide) return [];
  const reasons = [];
  const texts = measuredSlide.shapes.filter(
    (s) => s.hasText && s.boundL != null && s.boundW > 0 && s.boundH > 0);

  const offSlide = texts.filter((s) =>
    s.boundL < -1 || s.boundT < -1 ||
    s.boundL + s.boundW > slideSize.w + 1 ||
    s.boundT + s.boundH > slideSize.h + 1);
  if (offSlide.length) {
    reasons.push({ code: "off-slide-ink", count: offSlide.length });
  }

  let overlaps = 0;
  for (let a = 0; a < texts.length; a++) {
    for (let b = a + 1; b < texts.length; b++) {
      const A = texts[a], B = texts[b];
      const ox = Math.min(A.boundL + A.boundW, B.boundL + B.boundW) - Math.max(A.boundL, B.boundL);
      const oy = Math.min(A.boundT + A.boundH, B.boundT + B.boundH) - Math.max(A.boundT, B.boundT);
      const em = Math.max(6, Math.min(A.fontSize ?? 12, B.fontSize ?? 12));
      if (ox > overlapEm * em && oy > overlapEm * em) overlaps++;
    }
  }
  if (overlaps) reasons.push({ code: "object-overlap", count: overlaps });
  return reasons;
}

/**
 * Decide what one page delivers. Reasons are retained even when Force editable
 * overrides them: an override is informed degradation, not a rewritten verdict.
 */
export function decidePage({
  page,
  mode,
  override = null,
  powerPoint = true,
  candidateOpened = true,
  candidateRepaired = false,
  score = null,
  hardReasons = [],
  thresholds = DEFAULT_DELIVERY_THRESHOLDS,
}) {
  const normalized = normalizeDeliveryMode(mode);
  const sourceRaster = !hasEditableSemantics(page);
  const overrideState = override === "force-editable" || override === "keep-fidelity" ? override : null;
  const reasons = [...hardReasons];

  if (sourceRaster) {
    return { result: "source-raster", score, reasons: [{ code: "source-has-no-editable-semantics" }, ...reasons], overrideState };
  }
  if (normalized === "flattened" || overrideState === "keep-fidelity") {
    const code = overrideState === "keep-fidelity" ? "user-keep-fidelity" : "delivery-flattened";
    return { result: "fallback-raster", score, reasons: [{ code }, ...reasons], overrideState };
  }
  if (normalized === "editable") {
    return { result: "editable", score, reasons, overrideState, verification: powerPoint ? "available" : "unavailable" };
  }

  if (!powerPoint) reasons.unshift({ code: "powerpoint-unavailable" });
  else if (!candidateOpened) reasons.unshift({ code: "candidate-open-failed" });
  else if (candidateRepaired) reasons.unshift({ code: "candidate-required-repair" });
  else if (score == null) reasons.unshift({ code: "candidate-score-unavailable" });
  else if (score < thresholds.inkIou) reasons.unshift({ code: "ink-iou-low", value: score, threshold: thresholds.inkIou });

  if (overrideState === "force-editable") {
    return { result: "editable", score, reasons, overrideState, unsafeOverride: reasons.length > 0 };
  }
  return { result: reasons.length ? "fallback-raster" : "editable", score, reasons, overrideState };
}
