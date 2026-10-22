/**
 * "Is this deck safe to send to someone else?" — one answer, every gate.
 *
 *   node src/ship.js <source.pdf> <deck.pptx>
 *
 * Exit 0 = send it. Exit 1 = do not.
 *
 * This exists because the checks that matter live in four different places and
 * a deck that fails ONE of them is the deck that embarrasses you in front of a
 * class. It proves what it can and says plainly what it could not prove — a
 * check that was skipped is never reported as a check that passed.
 *
 * What it CANNOT tell you, stated here so the exit code is not read as more than
 * it is: whether the Arabic is faithful to the source. Text accuracy is measured
 * against ground-truth HTML by experiments/categorize-misses.js, not from the
 * deck alone. This answers "will it open and render correctly elsewhere", plus
 * the defects the doctor can actually name.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { modelFromPdf } from "./model/normalize.js";
import { auditPage, summarizeCoverage } from "./model/coverage.js";
import { inspectPptx, summarize } from "./pptx/inspect.js";
import { coveredByUbiquitous } from "./fonts/coverage.js";
import { DAMAGED_CALL, BROKEN_CHARS, STRANDED_FATHATAN, REVERSED_ARTICLE } from "../web/doctor.js";
import { renderPptx, powerPointAvailable } from "./render/powerpoint.js";

const [pdf, pptx] = process.argv.slice(2);
if (!pdf || !pptx) {
  console.error("usage: node src/ship.js <source.pdf> <deck.pptx>");
  process.exit(2);
}
for (const f of [pdf, pptx]) {
  if (!fs.existsSync(f)) { console.error(`not found: ${f}`); process.exit(2); }
}

const checks = [];
const add = (name, state, detail) => checks.push({ name, state, detail });

const model = modelFromPdf(pdf);

// ---- everything reconstructed -------------------------------------------
const coverage = summarizeCoverage(model.pages.map((p, i) => auditPage(p, model.rawCounts[i])));
add("every source element reconstructed", coverage.pass ? "pass" : "fail",
  `${coverage.nativeElements} native, ${coverage.rasterizedElements} intentionally rasterized, `
  + `${coverage.droppedElements} dropped, ${coverage.errors} errors`);

// ---- the package itself ---------------------------------------------------
const report = await inspectPptx(pptx);
// The image gate needs to know what the model MEANT to deliver, or it compares
// against zero and passes on a deck that shipped no pictures at all.
const deliverable = model.pages.flatMap((p) =>
  p.objects.filter((o) => o.type === "image" && o.ref && o.reconstructionStrategy !== "degenerate"));
const slideArea = model.pages[0].widthPt * model.pages[0].heightPt;
// Whether a font that does not travel actually DAMAGES the deck depends on the
// characters it sets, so read every typeface`s text against real cmap tables and
// let the gate decide from that rather than from the font`s name.
const fontPortability = Object.fromEntries(
  Object.entries(report.fontText ?? {}).map(([face, text]) => [face, coveredByUbiquitous(text)]));

const { gates, warnings } = summarize(report, {
  fontPortability,
  slideSizePt: { w: model.pages[0].widthPt, h: model.pages[0].heightPt },
  imagesIntended: new Set(deliverable.map((o) => o.ref)).size,
  sourceMaxCoverage: Math.max(0, ...deliverable.map((o) => (o.bbox.w * o.bbox.h) / slideArea)),
});
// `null` from a gate is "this document has nothing for it to judge" — distinct
// from `skip`, which means the check could not be RUN and is therefore not a
// pass. An inapplicable gate does not block the verdict, but it is still printed.
for (const [name, ok] of gates)
  add(name, ok === null ? "na" : ok ? "pass" : "fail", ok === null ? "nothing in this deck to judge" : "");

// ---- text the doctor can name as broken, read OUT OF THE DECK --------------
// Judge the artifact, not a fresh extraction of the PDF. Running the doctor over
// a re-extracted model reports the raw extraction defects even when `convert`
// already repaired them on the way out — the check then fails a deck that is
// actually clean, which is the fastest way to teach someone to ignore it.
// The patterns are imported from the doctor so the two cannot drift apart.
const deckText = report.slides.flatMap((s) => s.texts);
const damaged = deckText.filter((t) => DAMAGED_CALL.test(t.trim()));
add("no backwards formula calls", damaged.length ? "fail" : "pass",
  damaged.length ? `${damaged.length}: ${[...new Set(damaged)].slice(0, 4).join(", ")}` : "");

const corrupt = deckText.filter((t) => BROKEN_CHARS.test(t));
add("no corrupted characters", corrupt.length ? "fail" : "pass",
  corrupt.length ? `${corrupt.length} run(s) carry presentation forms, U+FFFD or mojibake` : "");

// A fathatan with no alef beside it is a dropped letter, and `convert` repairs
// the ones it can prove. What is left in the DECK is what the reader will see.
const stranded = deckText.filter((t) => STRANDED_FATHATAN.test(t));
add("no fathatan left without its alef", stranded.length ? "fail" : "pass",
  stranded.length ? `${stranded.length}: ${[...new Set(stranded.map((t) => t.match(STRANDED_FATHATAN)[0]))].slice(0, 4).join(", ")}` : "");

// `اإلجراء` for `الإجراء` — reads as a real word, which is exactly why it needs
// a machine to catch it on the way out.
const reversed = deckText.filter((t) => REVERSED_ARTICLE.test(t));
add("no reversed definite article", reversed.length ? "fail" : "pass",
  reversed.length ? `${reversed.length}: ${[...new Set(reversed.map((t) => t.match(REVERSED_ARTICLE)[0]))].slice(0, 4).join(", ")}` : "");

// ---- PowerPoint's own opinion ---------------------------------------------
// Skipped is NOT passed. PowerPoint is single-instance: if the user has a deck
// open, automation cannot drive it, and that must read as "unknown".
if (!powerPointAvailable()) {
  add("PowerPoint opens it without repair", "skip", "PowerPoint is not installed here");
} else {
  const dir = path.join(path.dirname(path.resolve(pptx)), ".ship-render");
  try {
    const r = renderPptx(pptx, dir, { widthPx: 1400 });
    if (!r.opened) throw new Error(r.error ?? "did not open");
    add("PowerPoint opens it without repair", r.repaired ? "fail" : "pass", `${r.slides.length} slides`);
  } catch (err) {
    const busy = /0x80048240|HRESULT/i.test(err.message);
    add("PowerPoint opens it without repair", "skip",
      busy ? "PowerPoint is busy — close the presentation you have open and re-run" : err.message.slice(0, 120));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- verdict ---------------------------------------------------------------
const failed = checks.filter((c) => c.state === "fail");
const skipped = checks.filter((c) => c.state === "skip");

console.log(`SHIP CHECK — ${path.basename(pptx)}`);
console.log("=".repeat(70));
for (const c of checks) {
  const tag = { pass: "[ ok ]", fail: "[FAIL]", skip: "[ ?? ]", na: "[ n/a ]" }[c.state];
  console.log(`  ${tag} ${c.name.padEnd(42)} ${c.detail}`);
}
console.log("=".repeat(70));

if (failed.length) {
  console.log(`  DO NOT SEND — ${failed.length} check(s) failed:`);
  for (const c of failed) console.log(`     - ${c.name}`);
  process.exit(1);
}
if (skipped.length) {
  console.log(`  ${skipped.length} check(s) could not run — this is NOT a pass:`);
  for (const c of skipped) console.log(`     - ${c.name}: ${c.detail}`);
  process.exit(1);
}
// A portability warning is not a failure: the deck renders correctly, in a
// substituted face. It is printed loudly and named, so it can never pass unseen.
if (warnings?.length) {
  console.log("  " + warnings.length + " portability warning(s):");
  for (const w of warnings) console.log("     - " + w);
}
const na = checks.filter((c) => c.state === "na");
if (na.length) {
  console.log(`  ${na.length} check(s) had nothing to judge in this deck:`);
  for (const c of na) console.log(`     - ${c.name}`);
}
console.log(warnings?.length
  ? "  SAFE TO SEND — every applicable check passed, with " + warnings.length + " portability warning(s) above."
  : "  SAFE TO SEND — every applicable check passed.");
console.log("  Note: this proves the deck opens and renders elsewhere. It does NOT");
console.log("  prove the Arabic matches the source; run experiments/categorize-misses.js");
console.log("  for that, and read the deck once yourself.");
process.exit(0);
