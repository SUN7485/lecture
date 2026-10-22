import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const CANDIDATE_THRESHOLDS = [0.70, 0.75, 0.80, 0.85];

export function qualityViews(report) {
  const explicitEditable = report?.editableQuality?.candidateVisual;
  // A report that names a non-editable delivery mode did not measure editable
  // quality, and `report.visual` is the DELIVERED deck — flattened pages and
  // all. Falling back to it here would relabel a raster score as the editable
  // one, which is the single thing these two views exist to keep apart. Reports
  // written before `--delivery` existed carry no mode and keep the old fallback.
  const mode = report?.deliveryMode;
  const editableUnavailable = mode != null && mode !== "editable" && !Number.isFinite(explicitEditable);
  const legacyEditable = editableUnavailable ? null : report?.visual;
  return {
    editableVisual: Number.isFinite(explicitEditable) ? explicitEditable : legacyEditable,
    editableSource: Number.isFinite(explicitEditable) ? "explicit editableQuality"
      : editableUnavailable ? `not measured under delivery ${mode}` : "legacy visual",
    productVisual: Number.isFinite(report?.productQuality?.finalVisual)
      ? report.productQuality.finalVisual
      : null,
    editablePageRate: Number.isFinite(report?.productQuality?.editablePageRate)
      ? report.productQuality.editablePageRate
      : null,
  };
}

export function collectPageScores(report) {
  if (!report || typeof report !== "object" || !report.decks || typeof report.decks !== "object") {
    throw new Error("Report has no deck data.");
  }

  const scores = [];
  for (const [deckId, deck] of Object.entries(report.decks)) {
    if (deck.converted === false) {
      throw new Error(`Deck ${deckId} was not converted; its page-score distribution is incomplete.`);
    }
    if (!Array.isArray(deck.pageScores)) {
      throw new Error(`Report lacks per-page scores for deck ${deckId}; rerun the benchmark with page-score persistence.`);
    }
    if (!Number.isInteger(deck.pagesCompared) || deck.pageScores.length !== deck.pagesCompared) {
      throw new Error(`Deck ${deckId} has ${deck.pageScores.length} page score(s) but pagesCompared=${deck.pagesCompared}.`);
    }

    const pages = new Set();
    for (const record of deck.pageScores) {
      if (!Number.isInteger(record?.page) || record.page < 1 || pages.has(record.page)) {
        throw new Error(`Deck ${deckId} has an invalid or duplicate one-based page number.`);
      }
      pages.add(record.page);
      if (!Object.hasOwn(record, "compareFailure")) {
        throw new Error(`Deck ${deckId} page ${record.page} lacks a compareFailure field.`);
      }
      if (record.compareFailure != null) {
        throw new Error(`Deck ${deckId} page ${record.page} comparison failed: ${record.compareFailure}`);
      }
      if (!Number.isFinite(record.candidateInkIou) || record.candidateInkIou < 0 || record.candidateInkIou > 1 ||
          !Number.isFinite(record.missingPct) || record.missingPct < 0 ||
          !Number.isFinite(record.extraPct) || record.extraPct < 0 ||
          !Number.isFinite(record.bestDy)) {
        throw new Error(`Deck ${deckId} page ${record.page} has incomplete comparison metrics.`);
      }
      scores.push({ deck: deckId, ...record });
    }
    if (Number.isInteger(deck.pages) && deck.pageScores.length !== deck.pages) {
      throw new Error(`Deck ${deckId} has scores for ${deck.pageScores.length} of ${deck.pages} page(s).`);
    }
  }

  if (!scores.length) throw new Error("Report contains no comparable page scores.");
  const declared = report.editableQuality?.pagesScored;
  if (Number.isFinite(declared) && declared !== scores.length) {
    throw new Error(`Report has ${scores.length} page score(s) but editableQuality.pagesScored=${declared}.`);
  }
  return scores;
}

export function quantile(sortedValues, q) {
  if (!sortedValues.length) throw new Error("Cannot calculate a quantile of an empty sample.");
  if (q < 0 || q > 1) throw new Error("Quantile must be between 0 and 1.");
  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

export function buildCalibration(report) {
  const records = collectPageScores(report);
  const values = records.map((record) => record.candidateInkIou).sort((a, b) => a - b);
  const histogram = Array.from({ length: 20 }, (_, index) => {
    const min = index / 20, max = (index + 1) / 20;
    return {
      min,
      max,
      count: values.filter((value) => value >= min && (index === 19 ? value <= max : value < max)).length,
    };
  });
  return {
    pages: values.length,
    quantiles: Object.fromEntries([0, 0.10, 0.25, 0.50, 0.75, 0.90, 1]
      .map((q) => [String(q), quantile(values, q)])),
    histogram,
    thresholds: CANDIDATE_THRESHOLDS.map((threshold) => ({
      threshold,
      flattened: values.filter((value) => value < threshold).length,
      editable: values.filter((value) => value >= threshold).length,
    })),
  };
}

export function formatCalibration(calibration) {
  const lines = [`DELIVERY CALIBRATION — ${calibration.pages} editable candidate page(s)`, "", "QUANTILES"];
  for (const [q, value] of Object.entries(calibration.quantiles).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    lines.push(`  p${String(Math.round(Number(q) * 100)).padStart(3, "0")}  ${value.toFixed(4)}`);
  }
  lines.push("", "HISTOGRAM");
  for (const bin of calibration.histogram) {
    const close = bin.max === 1 ? "]" : ")";
    lines.push(`  [${bin.min.toFixed(2)}, ${bin.max.toFixed(2)}${close}  ${String(bin.count).padStart(4)}`);
  }
  lines.push("", "CANDIDATE THRESHOLDS (flattened = score < threshold)", "  threshold  flattened  editable");
  for (const row of calibration.thresholds) {
    lines.push(`     ${row.threshold.toFixed(2)}       ${String(row.flattened).padStart(4)}      ${String(row.editable).padStart(4)}`);
  }
  return lines.join("\n");
}

function main(args) {
  if (args.length !== 1) {
    console.error("Usage: node experiments/benchmark/calibrate-delivery.js <report.json>");
    process.exitCode = 2;
    return;
  }
  try {
    const reportPath = path.resolve(args[0]);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    console.log(formatCalibration(buildCalibration(report)));
  } catch (error) {
    console.error(`Calibration refused: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2));
