/**
 * One row per PDF PRODUCER: what survives conversion, and what does not.
 *
 * WHY. Every accuracy number this project has ever published describes 28 Chrome
 * prints of one HTML template. The producer sweep of 2026-08-19 found that the
 * defects living outside that monoculture are not in extraction at all — they are
 * in DELIVERY: colour conversion, font portability, XML validity, gate logic. Two
 * producers could not be converted at all until that sweep, and one of them failed
 * on a single control character on one page of 288.
 *
 * This is the sweep as a repeatable command, so a new producer can be priced in one
 * run rather than by hand. It reports what it MEASURED and marks what it could not
 * measure — text accuracy is unavailable for every producer except Chrome, which is
 * the whole reason the synthetic ground-truth factory is the next piece of work.
 *
 * Usage: node experiments/producer-matrix.js <file.pdf> [more.pdf ...]
 *        node experiments/producer-matrix.js --json <file.pdf> ...
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as mupdf from "mupdf";
import { modelFromPdf } from "../src/model/normalize.js";
import { writePptx } from "../src/pptx/write.js";
import { deliverPptxAtomically } from "../src/pptx/embed.js";
import { inspectPptx, summarize, UBIQUITOUS_FONTS } from "../src/pptx/inspect.js";
import { coveredByUbiquitous } from "../src/fonts/coverage.js";
import { auditPage, summarizeCoverage } from "../src/model/coverage.js";
import { release } from "../src/extract/mupdf-lifetime.js";
import { requireSubjects } from "./lib-gate.js";

/** A font that travels, or ships everywhere, cannot be a portability problem. */
const embeddedOrUbiquitous = (face, report) =>
  face.startsWith("+") ||
  (report.embeddedFonts ?? []).includes(face) ||
  UBIQUITOUS_FONTS.has(face.toLowerCase());

const AS_JSON = process.argv.includes("--json");
const FILES = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const OUT = path.resolve("out/matrix");

/** Producer, page count and the colorspaces the page actually paints in. */
function sourceFacts(file) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(file), "application/pdf");
  const pages = doc.countPages();
  const producer = doc.getMetaData?.("info:Producer") || "(none)";
  const spaces = new Map();
  let textChars = 0;
  // A sample is enough to characterise a producer and keeps a 288-page document
  // from costing a minute; every page of the first ten, then every tenth.
  const sample = [...Array(pages).keys()].filter((i) => i < 10 || i % 10 === 0);
  for (const i of sample) {
    const page = doc.loadPage(i);
    const dev = new mupdf.Device({
      fillPath(p, e, c, cs) { note(cs); release(p, cs); },
      strokePath(p, s, c, cs) { note(cs); release(p, s, cs); },
      fillText(t, c, cs) { note(cs); release(t, cs); },
    });
    function note(cs) {
      let n = "(none)";
      try { n = `${cs?.getName?.() ?? "?"}/${cs?.getNumberOfComponents?.() ?? "?"}`; } catch { /* released */ }
      spaces.set(n, (spaces.get(n) ?? 0) + 1);
    }
    try { page.run(dev, mupdf.Matrix.identity); } finally { release(dev); }
    const st = page.toStructuredText("preserve-whitespace");
    try { textChars += st.asText().replace(/\s/g, "").length; } finally { release(st); }
  }
  return { pages, producer, spaces, textChars, sampled: sample.length };
}

/** Does PowerPoint open the package without repairing it? */
function powerPointOpens(pptx) {
  const ps = path.join(OUT, "_open.ps1");
  fs.writeFileSync(ps, String.raw`
$ErrorActionPreference='Stop'
try {
  try { $app=[Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application'); $made=$false }
  catch { $app=New-Object -ComObject PowerPoint.Application; $made=$true }
  $app.DisplayAlerts = 1
  $p=$app.Presentations.Open($args[0],$true,$false,$false)
  Write-Output "OK $($p.Slides.Count)"
  $p.Close(); if ($made) { $app.Quit() }
} catch { Write-Output "FAIL $($_.Exception.Message)"; try { if ($made -and $app) { $app.Quit() } } catch {} }
`, "utf8");
  try {
    const out = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps, path.resolve(pptx)],
      { encoding: "utf8", timeout: 300000, windowsHide: true });
    return out.trim().split("\n").pop().trim();
  } catch (e) { return `FAIL ${String(e.message).slice(0, 60)}`; }
}

async function row(file) {
  const name = path.basename(file).replace(/\.pdf$/i, "").slice(0, 30);
  const r = { file: name, ok: false };
  try {
    const src = sourceFacts(file);
    Object.assign(r, {
      producer: src.producer.slice(0, 30),
      pages: src.pages,
      colorspaces: [...src.spaces].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(" "),
      // "born-digital" vs "outlined or scanned" is the single most useful split:
      // a document with no structured text has no Unicode to recover, and no
      // amount of extraction work can change that.
      textClass: src.textChars === 0 ? "NO TEXT (outlined or scanned)" : "structured text",
      textChars: src.textChars,
    });

    const model = modelFromPdf(file);
    const out = path.join(OUT, `${name}.pptx`);
    const { stats, fonts } = await deliverPptxAtomically(out, (p) => writePptx(model, p));
    const cov = summarizeCoverage(model.pages.map((p, i) => auditPage(p, model.rawCounts[i])));

    const report = await inspectPptx(out);
    const portability = Object.fromEntries(
      Object.entries(report.fontText ?? {}).map(([f, t]) => [f, coveredByUbiquitous(t)]));
    const sum = summarize(report, { fontPortability: portability });
    const fontGate = sum.gates.find(([n]) => /font travels/.test(n))[1];

    Object.assign(r, {
      ok: true,
      textboxes: stats.textboxes, runs: stats.runs, shapes: stats.shapes,
      images: stats.images, tables: model.pages.reduce((n, p) => n + (p.tables?.length ?? 0), 0),
      coverage: `${cov.nativeElements} native / ${cov.rasterizedElements} raster / ${cov.droppedElements} dropped / ${cov.errors} err`,
      embedded: (fonts.embedded ?? []).map((e) => e.typeface ?? e).join(", ") || "none",
      warnings: sum.warnings.length,
      fontGate: fontGate === false ? "HARD FAIL" : fontGate === null ? "n/a" : "pass",
      // Only fonts that do NOT travel can be a portability problem. Reporting
      // coverage for every typeface listed `Symbol` as uncoverable on a Distiller
      // deck — true (no other ubiquitous face carries its glyphs) and irrelevant,
      // because Symbol ships everywhere and is never an orphan. The column has to
      // ask the same question the gate asks or it invents defects.
      uncoverable: Object.entries(portability)
        .filter(([f, c]) => !c.covered && !embeddedOrUbiquitous(f, report))
        .map(([f]) => f).join(", ") || "none",
      powerpoint: powerPointOpens(out),
    });
  } catch (e) {
    r.error = String(e.message).split("\n")[0].slice(0, 150);
  }
  return r;
}

fs.mkdirSync(OUT, { recursive: true });
requireSubjects(FILES.length, "PDFs", "usage: producer-matrix.js <file.pdf> [more.pdf ...]");

const rows = [];
for (const f of FILES) {
  process.stderr.write(`  ${path.basename(f)} ... `);
  const r = await row(f);
  process.stderr.write(`${r.ok ? "ok" : "FAILED"}\n`);
  rows.push(r);
}

if (AS_JSON) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }

for (const r of rows) {
  console.log(`\n=== ${r.file}`);
  console.log(`  producer     ${r.producer ?? "?"}   pages ${r.pages ?? "?"}`);
  console.log(`  text         ${r.textClass ?? "?"}  (${r.textChars ?? 0} chars sampled)`);
  console.log(`  colorspaces  ${r.colorspaces ?? "?"}`);
  if (!r.ok) { console.log(`  RESULT       FAILED: ${r.error}`); continue; }
  console.log(`  content      ${r.textboxes} textboxes · ${r.runs} runs · ${r.shapes} shapes · ${r.images} images · ${r.tables} tables`);
  console.log(`  coverage     ${r.coverage}`);
  console.log(`  fonts        embedded: ${r.embedded}`);
  console.log(`               gate: ${r.fontGate} · ${r.warnings} portability warning(s) · uncoverable: ${r.uncoverable}`);
  console.log(`  PowerPoint   ${r.powerpoint}`);
}
console.log(`\n${rows.length} producers · ${rows.filter((r) => r.ok).length} converted · ${rows.filter((r) => !r.ok).length} failed`);
