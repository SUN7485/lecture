#!/usr/bin/env node
/**
 * recon — PDF/HTML to editable PowerPoint.
 *
 *   node src/cli.js convert <input.pdf> --out <out.pptx> [--pages 1-5] [--report r.json]
 *   node src/cli.js model   <input.pdf> [--pages 1] [--out model.json]
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { modelFromPdf } from "./model/normalize.js";
import { exportWithDelivery } from "./delivery/export.js";
import { inspectPptx, UBIQUITOUS_FONTS } from "./pptx/inspect.js";
import { refontPptx } from "./pptx/refont.js";
import { embedFonts } from "./pptx/embed.js";
import { getFontLicense } from "./fonts/license.js";
import { auditPage, summarizeCoverage } from "./model/coverage.js";
import { runDoctor, applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { buildId, releaseIdentity } from "./build-id.js";

/**
 * The source's physical page geometries, and which of them had to be fitted.
 *
 * Grouped by the PHYSICAL box (`sourceSizePt`), never by `widthPt` — the fit
 * overwrites that with the canvas size, so grouping on it reports one geometry
 * for every document.
 */
function pageGeometrySummary(model) {
  const groups = new Map();
  for (const p of model.pages) {
    const key = `${p.sourceSizePt.widthPt}x${p.sourceSizePt.heightPt}`;
    const g = groups.get(key) ?? { box: key, pages: [], scale: p.sourceFit.scale };
    g.pages.push(p.index + 1);
    groups.set(key, g);
  }
  const runs = (ns) => {
    const out = [];
    for (const n of ns) {
      const last = out[out.length - 1];
      if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
    }
    return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");
  };
  return {
    policy: model.document.pageSizePolicy,
    fittedPages: model.document.fittedPages,
    geometries: [...groups.values()].map((g) => ({ box: g.box, count: g.pages.length, scale: g.scale, pages: runs(g.pages) })),
  };
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  let input;
  let rest = args;
  if (args[0] && !args[0].startsWith("--")) {
    [input, ...rest] = args;
  }
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i]?.startsWith("--")) continue;
    // A flag followed by another flag (or nothing) is a switch, not a pair —
    // otherwise `--no-embed-fonts` swallows whatever argument comes after it.
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[rest[i].slice(2)] = true;
    else flags[rest[i].slice(2)] = next, i++;
  }
  return { command, input, flags };
}

/** "1-5" / "3" / "1,4,9" -> zero-based page indices. */
function parsePages(spec) {
  if (!spec) return undefined;
  const out = [];
  for (const part of spec.split(",")) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) for (let i = +m[1]; i <= +m[2]; i++) out.push(i - 1);
    else out.push(+part - 1);
  }
  return out;
}

const { command, input, flags } = parseArgs(process.argv.slice(2));

function printHelp() {
  console.log(`recon — Lecture Reconstruction Studio CLI
  node src/cli.js convert <input.pdf> [--out FILE] [--pages 1-5] [--report FILE] [--delivery smart|editable] [--portable [Family]]
  node src/cli.js doctor   <input.pdf> [--pages 1-5] [--no-fix]
  node src/cli.js model    <input.pdf> [--out model.json] [--pages 1]
  node src/cli.js preflight
  node src/cli.js version`);
}

if (command === "version" || command === "--version" || flags.version || flags["--version"]) {
  console.log(buildId());
  process.exit(0);
}

if (command === "help" || command === "--help" || flags.help || flags["--help"] || !command) {
  printHelp();
  process.exit(0);
}

if (command === "preflight") {
  const issues = [];
  const nodeOk = process.version.startsWith("v22") || process.version.startsWith("v24");
  if (!nodeOk) issues.push(`Node 22+ required, found ${process.version}`);
  else console.log(`  [ok] Node ${process.version}`);

  const pptx = await import("pptxgenjs").catch(() => null);
  const hasPptx = !!pptx;
  if (!hasPptx) issues.push("pptxgenjs is not installed — export will fail");
  else console.log("  [ok] pptxgenjs available");

  const mupdf = await import("mupdf").catch(() => null);
  const hasMupdf = !!mupdf;
  if (!hasMupdf) issues.push("MuPDF bindings missing — PDF extraction unavailable");
  else console.log("  [ok] MuPDF available");

  const portOk = !(await new Promise((r) => {
    const s = net.createConnection(5178, "127.0.0.1");
    s.on("connect", () => { s.end(); r(false); });
    s.on("error", () => r(true));
  }));
  if (!portOk) console.log("  [!] Port 5178 is in use — another Studio instance may be running");
  else console.log("  [ok] Port 5178 available");

  const blocking = issues.filter((i) => !i.startsWith("[!]"));
  if (blocking.length) {
    console.log("\nPreflight failed:");
    for (const i of blocking) console.log(`  - ${i}`);
    process.exit(2);
  }
  console.log("  [ok] Preflight passed");
  process.exit(0);
}

if (command === "diagnostics") {
  const out = flags.out ?? `diagnostics-${new Date().toISOString().slice(0, 10)}.zip`;
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip();
  zip.addFile("identity.json", Buffer.from(JSON.stringify(releaseIdentity(), null, 2), "utf8"));
  zip.addFile("package.json", Buffer.from(fs.readFileSync("package.json", "utf8"), "utf8"));
  zip.addFile("environment.txt", Buffer.from(`Node: ${process.version}\nPlatform: ${process.platform}\nArch: ${process.arch}\nCWD: ${process.cwd()}\n`, "utf8"));
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(out, zip.toBuffer());
  console.log(`diagnostics -> ${out}`);
  process.exit(0);
}

if (!input) {
  console.error("usage: recon <convert|doctor|model> <input.pdf> [--out FILE] [--pages 1-5] [--report FILE] [--delivery smart|editable] [--portable [Family]]");
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.error(`input not found: ${input}`);
  process.exit(1);
}

const pages = parsePages(flags.pages);
const started = Date.now();
const model = modelFromPdf(input, { pages });

if (model.pages.length > 200) {
  console.error(`This PDF has ${model.pages.length} pages, which exceeds the supported limit of 200.`);
  process.exit(1);
}
const maxObjects = Math.max(...model.pages.map((p) => p.objects.length));
if (maxObjects > 1200) {
  console.error(`One page has ${maxObjects} objects, which exceeds the supported limit of 1200.`);
  process.exit(1);
}
const importMs = Date.now() - started;
if (importMs > 60_000) {
  console.warn(`Import took ${importMs}ms, which exceeds the budget of 60s.`);
}

if (command === "doctor") {
  const audits = model.pages.map((p, i) => auditPage(p, model.rawCounts[i]));
  const result = runDoctor(model, summarizeCoverage(audits));
  console.log(`score ${result.score}/100 over ${result.objects} objects`);
  console.log(`  ${result.counts.error} error · ${result.counts.warn} warn · ${result.counts.info} info\n`);

  const groups = new Map();
  for (const f of result.findings) groups.set(f.rule, [...(groups.get(f.rule) ?? []), f]);
  for (const [rule, hits] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const f = hits[0];
    console.log(`${String(hits.length).padStart(4)}  [${f.severity}] ${rule}${f.fixable ? "" : "  (needs a human)"}`);
    for (const h of hits.slice(0, 3)) console.log(`        p${h.page + 1}  ${h.message}`);
    if (hits.length > 3) console.log(`        +${hits.length - 3} more`);
  }
  // Errors mean something is genuinely broken, not merely imperfect.
  process.exit(result.counts.error ? 3 : 0);
}

if (command === "model") {
  const out = flags.out ?? "model.json";
  fs.writeFileSync(out, JSON.stringify(model, null, 2), "utf8");
  console.log(`model -> ${out}  (${model.pages.length} pages, ${model.pages.reduce((n, p) => n + p.objects.length, 0)} objects)`);
  process.exit(0);
}

if (command !== "convert" && command !== "doctor" && command !== "model") {
  console.error(`unknown command: ${command}`);
  process.exit(1);
}

// Repair the damage the doctor can PROVE, before writing. The list is DEFAULT_REPAIRS
// in the doctor, so every verifier can apply exactly what convert applied instead
// of guessing. Everything else the doctor knows is a judgement call or a design
// change and stays opt-in. --no-fix turns them all off.
// Per rule, not a single total. A combined count printed under one rule's name
// says "9 backwards formula call(s)" about nine tanween repairs, which is a
// report that actively misinforms.
const repaired = [];
if (!flags["no-fix"]) {
  for (const rule of DEFAULT_REPAIRS) {
    const r = applyFixes(model, rule);
    if (r.applied) repaired.push({ rule, applied: r.applied });
  }
}

const out = flags.out ?? input.replace(/\.pdf$/i, ".pptx");
// Editability is the product default. Smart/source-picture fallback remains an
// explicit fidelity option and can never silently replace a page.
const deliveryMode = flags.delivery || "editable";
const { stats, fonts, coverage, delivery } = await exportWithDelivery({
  model,
  sourcePdf: path.resolve(input),
  outPath: path.resolve(out),
  mode: deliveryMode,
  allowSkipFonts: Boolean(flags["no-embed-fonts"]),
  onStage: ({ stage, detail }) => {
    if (!flags.quiet) console.log(`  [${stage}] ${detail}`);
  },
});

const ms = Date.now() - started;

const report = {
  input,
  output: out,
  coverage,
  schemaVersion: model.schemaVersion,
  pagesConverted: model.pages.length,
  sourcePageCount: model.document.pageCount,
  slideSizePt: { w: model.pages[0].widthPt, h: model.pages[0].heightPt },
  // A PowerPoint presentation has ONE slide size and a PDF need not. When the
  // source carries several page geometries the odd ones are uniformly scaled and
  // centred, which is faithful and looks like damage — a 118-page merged lecture
  // whose pages 64-94 are square was reported as "31 slides are broken" when the
  // deck was correct. Silence is what made that expensive, so it is reported.
  pageGeometry: pageGeometrySummary(model),
  build: releaseIdentity(),
  ...stats,
  fonts,
  delivery,
  elapsedMs: ms,
};

if (flags.report) fs.writeFileSync(flags.report, JSON.stringify(report, null, 2), "utf8");

console.log(`converted ${report.pagesConverted}/${report.sourcePageCount} pages in ${ms} ms`);
console.log(`  slide size : ${report.slideSizePt.w} x ${report.slideSizePt.h} pt`);
if (report.pageGeometry.fittedPages) {
  const g = report.pageGeometry;
  console.log(`  PAGE SIZES : the source has ${g.geometries.length} page geometries and a deck has ONE slide size,`);
  console.log(`               so ${g.fittedPages} page(s) are scaled uniformly and centred — side bands are expected:`);
  for (const x of g.geometries) {
    const how = x.scale === 1 ? "native" : `fitted at ${(x.scale * 100).toFixed(1)}%`;
    console.log(`                 ${String(x.count).padStart(4)} page(s)  ${x.box.padEnd(18)} ${how.padEnd(18)} pages ${x.pages}`);
  }
}
console.log(`  textboxes  : ${stats.textboxes}   runs: ${stats.runs}   shapes: ${stats.shapes}   split at field boxes: ${stats.splitBlocks}`);
console.log(`  tables     : ${model.pages.reduce((n, p) => n + (p.tables?.length ?? 0), 0)}`);
console.log(`  delivery   : ${delivery.mode} · ${delivery.totals.editable} editable · ${delivery.totals.sourceRaster} source-raster · ${delivery.totals.fallbackRaster} fallback-raster`);
console.log(`  elements   : ${coverage.nativeElements} native · ${coverage.rasterizedElements} intentionally rasterized · ${coverage.droppedElements} dropped · ${coverage.errors} errors`);
const REPAIR_LABEL = {
  "bidi-damaged-call": "backwards formula call(s) — =NAME() had come out as )(NAME=",
  "tanween-missing-alef": "dropped alef/lam-alef restored under its fathatan",
  "lam-alef-reversed": "reversed definite article(s) put back in order",
};
for (const r of repaired) console.log(`  repaired   : ${r.applied} ${REPAIR_LABEL[r.rule] ?? r.rule}`);
console.log(
  fonts.ok
    ? `  fonts      : embedded ${fonts.embedded.map((f) => f.typeface).join(", ")}`
    : `  fonts      : NOT EMBEDDED (${fonts.reason}) — this deck only renders where its fonts are installed`
);

// `--portable` re-points every run at a face that ships with Windows and Office
// and drops the embedded-font parts, so the deck has no font dependency at all.
// This exists because embedding CANNOT close the gap for the corpus fonts: they
// are fsType 4, which forbids loading into an editable document, so PowerPoint
// refuses them and the reader gets whatever their own machine substitutes. See
// src/pptx/refont.js for the measurement.
// `--portable` re-points every run at a face that ships with Windows and Office
// and drops the embedded-font parts, so the deck has no font dependency at all.
//
// `--portable <Family>` is the FIDELITY tier: a family the reader still will not
// have, but which its own fsType permits us to embed for editing, so it travels
// inside the package instead of being substituted. It only rescues runs that
// were going to be downgraded anyway — a font that already ships everywhere is
// left alone. `refont.js` refuses any family whose licence does not allow it,
// which is the whole difference between this and what shipped before.
const preferFamilies = typeof flags.portable === "string" ? [flags.portable] : [];
if (preferFamilies.length) {
  // Field result, not a theory. Two fonts on opposite sides of the licence
  // question both came back as tofu from the same reader, so the embed is the
  // variable that failed, and this flag makes the deck depend on it. Say so
  // BEFORE the work, every time — a flag whose known failure is recorded only
  // in a file nobody opens mid-task is a trap with documentation.
  console.log(`  NOTE       : --portable ${preferFamilies.join(", ")} makes this deck DEPEND on font embedding.`);
  console.log(`               Measured 2026-08-25: one reader saw boxes from an embedded fsType-0`);
  console.log(`               font and correct text from plain --portable. Test before you send it.`);
}
if (flags.portable) {
  const swap = await refontPptx(out, out, { prefer: preferFamilies });
  for (const r of swap.preferRefused) {
    console.log(`  REFUSED    : ${r.family} cannot be the preferred face — ${r.why}`);
  }
  console.log(`  portable   : ${swap.rewritten} font slot(s) re-pointed` +
    (swap.prefer.length ? ` (preferring ${swap.prefer.join(", ")})` : " at faces that ship everywhere"));
  for (const [from, rec] of [...swap.swaps.entries()].sort((a, b) => b[1].slots - a[1].slots)) {
    console.log(`                 ${String(rec.slots).padStart(6)}  ${from} -> ${rec.to}  (${rec.reason})`);
  }
  if (swap.charsetFixed) console.log(`                 ${swap.charsetFixed} charset value(s) corrected — see DOCS.md`);
  if (swap.droppedFontParts) console.log(`                 dropped ${swap.droppedFontParts} embedded font part(s)`);
  if (swap.uncovered.length) {
    console.log(`  WARNING    : no ubiquitous face can draw ${swap.uncovered.join(", ")} — left as-is, the reader may see boxes`);
  }

  // The preferred face does NOT ship with Windows, so the deck is only correct
  // if it actually travels. Re-embed after the rewrite (the rewrite dropped the
  // old, licence-restricted parts), and refuse to claim success if it did not.
  if (swap.prefer.length) {
    const emb = await embedFonts(out);
    const got = emb.embedded.map((f) => f.typeface);
    const missing = swap.prefer.filter((f) => !got.includes(f));
    console.log(`  embedded   : ${got.join(", ") || "(nothing)"}` +
      `  (+${(((emb.bytesAfter - emb.bytesBefore) / 1024) | 0)} KB)`);
    if (missing.length) {
      console.error(`  FAILED     : ${missing.join(", ")} is named by the deck and did NOT embed` +
        `${emb.reason ? ` (${emb.reason})` : ""} — the reader would see a substitute.`);
      console.error(`               Re-run with plain --portable for a deck that needs no embedding.`);
      process.exit(2);
    }
  }
}

// "Embedded these" is not the same claim as "every font travels", and the gap
// between them is invisible: a face the resolver could not match is NAMED by the
// deck and carried by nothing, so the deck renders in a substitute wherever it
// goes. `summarize()` has always been able to see this; nothing on the shipping
// path asked it. Measured on an InDesign document whose Lyon subset names lack
// the `LF` infix every installed Lyon family carries — 459 Arabic runs named a
// family that exists nowhere, and the run reported success.
//
// AND BEING EMBEDDED IS NOT THE SAME CLAIM AS TRAVELLING. A font whose licence
// forbids embedding into an editable document is refused by PowerPoint at the
// reader's end, so it belongs in this list too — leaving it out is what let four
// fsType-4 families setting 91% of a deck's runs ship as "fonts: embedded".
const embeddedAndPermitted = fonts.embedded.filter((f) => getFontLicense(f.typeface).editable === true);
const refusedEmbeds = fonts.embedded.filter((f) => getFontLicense(f.typeface).editable !== true);
if (refusedEmbeds.length) {
  console.log(`  LICENCE    : ${refusedEmbeds.map((f) => f.typeface).join(", ")}`);
  console.log(`               fsType forbids loading these into an EDITABLE document, so PowerPoint`);
  console.log(`               refuses them at the reader's end however we package them.`);
  // Telling someone to re-run with a flag they already passed is the report
  // lying about its own state, and a stale line like that is what sends the
  // next session down a road that is already closed.
  console.log(flags.portable
    ? `               Already removed from this deck by --portable above.`
    : `               Re-run with --portable to drop them for faces that ship everywhere.`);
}
const orphans = (await inspectPptx(out)).usedFonts.filter(
  (t) => !t.startsWith("+") &&
         !embeddedAndPermitted.some((f) => f.typeface === t) &&
         !UBIQUITOUS_FONTS.has(t.toLowerCase())
);
if (orphans.length) {
  console.log(`  NOT TRAVELLING : ${orphans.join(", ")}`);
  console.log(`               these are named by the deck and carried by nothing — it renders`);
  console.log(`               in a substitute on any machine without them installed`);
}

console.log(`  output     : ${out}`);
if (!coverage.pass && delivery.mode === "editable") {
  console.error("COVERAGE FAILED — editable delivery dropped source elements");
  process.exit(2);
}
