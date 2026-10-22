/** Evidence-gated local commercial-engine adapter. Never imported by the editor. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import { convertWithVendor } from "./engines.js";
import { plateauStatus, smokeVerdict, VENDOR_ORDER } from "./criteria.js";
import { inspectPptx } from "../../src/pptx/inspect.js";
import { renderPptx } from "../../src/render/powerpoint.js";
import { comparePage } from "../../src/render/compare.js";

const value = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const historyPaths = (value("--history", "experiments/benchmark/baseline.json,.work/benchmark-current-full.json"))
  .split(",").filter(Boolean);
const reports = historyPaths.filter(fs.existsSync).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const plateau = plateauStatus(reports);

if (process.argv.includes("--status")) {
  console.log(JSON.stringify({ plateau, history: historyPaths }, null, 2));
  process.exit(plateau.fired ? 0 : 1);
}
if (!plateau.fired) {
  console.error(`VENDOR TOURNAMENT DEFERRED: ${plateau.reason}`);
  for (const [i, turn] of plateau.turns.entries()) {
    console.error(`  turn ${i + 1}: gain ${(turn.gain * 100).toFixed(2)} points · damage ${turn.damage} · ${turn.qualifies ? "qualifies" : "still converging"}`);
  }
  process.exit(3);
}

const engine = value("--engine");
const input = value("--input");
const output = value("--out");
if (!VENDOR_ORDER.includes(engine) || !input || !output) {
  console.error("usage: node experiments/vendors/run.js --engine aspose|apryse|foxit --input file.pdf --out file.pptx --history a.json,b.json,c.json [--evaluation]");
  process.exit(2);
}

const started = Date.now();
convertWithVendor(engine, input, output, { evaluation: process.argv.includes("--evaluation") });
const renderDir = `${output}.render`;
const rendered = renderPptx(output, renderDir, { widthPx: 1400, timeoutMs: 1800000 });
const inspected = await inspectPptx(output);
const pngs = fs.readdirSync(renderDir).filter((f) => /^slide-\d+\.png$/.test(f)).sort();
const doc = mupdf.Document.openDocument(fs.readFileSync(input), "application/pdf");
let visual = 0;
for (let i = 0; i < Math.min(pngs.length, doc.countPages()); i++) {
  visual += comparePage(input, i, path.join(renderDir, pngs[i])).best.iou;
}
let sourceText = "";
for (let i = 0; i < doc.countPages(); i++) sourceText += doc.loadPage(i).toStructuredText().asText();
doc.destroy?.();
const nativeText = inspected.slides.flatMap((s) => s.texts).join("");
const chars = (s) => [...s].filter((c) => !/\s/u.test(c)).length;
const disguisedRasterSlides = inspected.slides.filter(
  (s) => s.texts.join("").trim() === "" && s.pictures.some((p) => p.coverage >= 0.95)).length;
const metrics = {
  engine,
  opened: rendered.opened,
  repaired: rendered.repaired,
  visual: pngs.length ? visual / pngs.length : 0,
  nativeTextRate: chars(sourceText) ? Math.min(1, chars(nativeText) / chars(sourceText)) : 1,
  disguisedRasterSlides,
  arabicAccuracy: Number(value("--arabic-accuracy", "NaN")),
  elapsedMs: Date.now() - started,
};
const baseline = {
  visual: Number(value("--baseline-visual", reports.at(-1)?.visual ?? 0)),
  arabicAccuracy: Number(value("--baseline-arabic-accuracy", "NaN")),
};
const verdict = smokeVerdict(metrics, baseline);
const report = { metrics, baseline, verdict };
const reportPath = value("--report", `${output}.vendor.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
process.exit(verdict.pass ? 0 : 1);

