/**
 * How often does one run's source x-extent swallow another run on the same line?
 *
 * WHY. On the 118-page Unit Five deck, `verify-segments.js` failed on p77 with two
 * segments of one line at IDENTICAL coordinates. The cause is one run:
 *
 *   run4  x 220.65..344.24   "VAM*"     <- 123.59pt for four characters
 *   run0  x 226.71..232.14   "Z"        <- inside it
 *   run2  x 265.54..290.42   "MODI"     <- inside it
 *
 * `blockRuns` takes a run's extent as min/max over its glyphs, and bidi had placed
 * the neutral `*` at x 222.92 — beside the Arabic at the far LEFT of the line —
 * while its logical neighbours `VAM` sit at x 323.81..344.24 on the far RIGHT.
 * One stray neutral therefore inflates the run by 100pt. The comment above that
 * line says the error "is a single glyph and never decides a split"; this is the
 * fixture that falsifies it.
 *
 * Before designing a rule, price the class. The test needs NO glyph-level data and
 * re-derives nothing (EVO-033): a run whose [srcX, srcX+srcW] strictly CONTAINS
 * another run's span, on the same line, is the pathology by definition — read
 * straight off the model the writer consumes.
 *
 * Usage:
 *   node experiments/probe-run-extents.js --corpus
 *   node experiments/probe-run-extents.js <file.pdf> [more.pdf ...]
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { findPairs } from "../src/truth/corpus.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FILES = process.argv.includes("--corpus") ? findPairs().map((p) => p.pdf) : args;
const SHOW = Number((process.argv.includes("--show") && process.argv[process.argv.indexOf("--show") + 1]) || 12);

if (!FILES.length) {
  console.error("usage: probe-run-extents.js --corpus | <file.pdf> ...");
  process.exit(1);
}

/** Is `inner` strictly inside `outer`? Both are [x0, x1] in points. */
const contains = (outer, inner) =>
  outer[0] <= inner[0] && outer[1] >= inner[1] && (outer[1] - outer[0]) > (inner[1] - inner[0]);

/**
 * Containment ALONE over-counts, badly — the first run of this probe reported 109
 * corpus blocks and the samples showed why: `"UC = (FC ÷ Q) + VC"` spanning 103pt
 * for 18 characters is a perfectly ordinary Latin formula island that happens to
 * enclose a small neutral run bidi placed inside it. That is interleaving, not
 * damage.
 *
 * The pathology is width PER CHARACTER. No glyph can occupy much more than one
 * em horizontally, so a run whose span divided by its character count exceeds its
 * own font size is claiming space its text cannot fill:
 *
 *   "VAM*"                4 chars over 123.59pt = 30.9pt/char at ~14pt  ratio 2.2   <- damage
 *   "UC = (FC ÷ Q) + VC"  18 chars over 103.2pt =  5.7pt/char at ~12pt  ratio 0.48  <- normal
 *
 * 1.2 sits far above every plausible typesetting (wide tracking, small caps) and
 * far below the failure, so the threshold is not doing delicate work.
 */
const MAX_PT_PER_EM = 1.2;
const overwide = (run, span) => {
  const chars = Math.max(1, [...(run.text ?? "")].length);
  const size = run.fontSizePt || 0;
  if (!size) return false;
  return ((span[1] - span[0]) / chars) / size > MAX_PT_PER_EM;
};

let totalBlocks = 0, totalRuns = 0, badBlocks = 0, badRuns = 0;
const samples = [];
const perFile = [];

for (const file of FILES) {
  const short = String(file).split(/[\\/]/).pop().replace(/\.pdf$/i, "");
  let model;
  try { model = modelFromPdf(file); }
  catch (e) { console.log(`${short}  FAILED: ${e.message}`); continue; }

  let fBlocks = 0, fBad = 0, fBadRuns = 0;
  for (const [pi, page] of model.pages.entries()) {
    for (const o of page.objects) {
      if (o.type !== "text" || !o.runs || o.runs.length < 2) continue;
      const spans = o.runs.map((r) => (r.srcX == null ? null : [r.srcX, r.srcX + (r.srcW ?? 0)]));
      if (spans.some((s) => s === null)) continue;
      totalBlocks++; fBlocks++; totalRuns += o.runs.length;

      const offenders = [];
      for (let i = 0; i < spans.length; i++) {
        // A run that contains a DIFFERENT run entirely has an extent it cannot
        // have earned from its own characters.
        const swallowed = spans.filter((s, j) => j !== i && contains(spans[i], s)).length;
        if (swallowed && overwide(o.runs[i], spans[i])) offenders.push([i, swallowed]);
      }
      if (!offenders.length) continue;
      badBlocks++; fBad++; badRuns += offenders.length; fBadRuns += offenders.length;
      if (samples.length < SHOW) {
        const [i] = offenders[0];
        samples.push({
          file: short, page: pi + 1,
          text: o.runs.map((r) => r.text).join(""),
          run: o.runs[i].text,
          span: spans[i],
          swallows: offenders[0][1],
        });
      }
    }
  }
  perFile.push([short, fBlocks, fBad, fBadRuns]);
}

console.log("\nfile                                     blocks   bad   badRuns");
for (const [n, b, bad, br] of perFile)
  console.log(`${n.slice(0, 38).padEnd(40)} ${String(b).padStart(6)} ${String(bad).padStart(5)} ${String(br).padStart(9)}`);

console.log(`\nsamples (up to ${SHOW}):`);
for (const s of samples) {
  console.log(`  ${s.file} p${s.page}  run ${JSON.stringify(s.run)} spans ${s.span[0].toFixed(2)}..${s.span[1].toFixed(2)} and swallows ${s.swallows} run(s)`);
  console.log(`     line: ${JSON.stringify(s.text)}`);
}

console.log("\n" + "=".repeat(72));
console.log(`  ${totalBlocks} multi-run blocks · ${totalRuns} runs`);
console.log(`  ${badBlocks} blocks carry a run that swallows another · ${badRuns} such runs`);
console.log(`  ${totalBlocks ? ((badBlocks / totalBlocks) * 100).toFixed(3) : "0"}% of multi-run blocks`);
