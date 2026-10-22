/**
 * The rendering oracle: does PowerPoint itself open every generated deck, and
 * does it open them WITHOUT the repair prompt?
 *
 * This is the claim CONTEXT.md makes ("PowerPoint opens every deck, NO REPAIR")
 * and it is the one check no amount of XML inspection can replace — a package
 * can be schema-valid and still make PowerPoint offer to repair it.
 *
 * Rendered at the project's calibrated 1400px. That is NOT cosmetic: PowerPoint's
 * Slide.Export is resolution dependent and fails outright on some slides at low
 * widths (measured: Chp1-Lec1-3(New) slide 1 fails at 700, succeeds at 1400,
 * reproducibly). Lowering this to save time reintroduces that failure.
 *
 * Usage: node experiments/verify-powerpoint.js [widthPx] [nameFilter]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { renderPptx, powerPointAvailable } from "../src/render/powerpoint.js";

const WIDTH = Number(process.argv[2] ?? 1400);
const OUT_ROOT = "out/ppt-verify";

const exe = powerPointAvailable();
if (!exe) {
  console.log("PowerPoint not found on this machine — the oracle cannot run.");
  console.log("This is a SKIP, not a pass: nothing has been verified.");
  process.exit(2);
}
console.log(`PowerPoint: ${exe}\n`);

const FILTER = process.argv[3] ?? null;
const decks = fs.readdirSync("out")
  .filter((f) => f.toLowerCase().endsWith(".pptx"))
  .filter((f) => !FILTER || f.includes(FILTER))
  .sort();
if (!decks.length) {
  console.log("No .pptx files in out/ — run the convert step first.");
  process.exit(2);
}

let failures = 0;
console.log("deck                     opened  repaired  slides  note");
console.log("-".repeat(72));

for (const deck of decks) {
  const outDir = path.join(OUT_ROOT, path.basename(deck, ".pptx"));
  let r;
  try {
    r = renderPptx(path.join("out", deck), outDir, { widthPx: WIDTH });
  } catch (e) {
    failures++;
    console.log(`${deck.padEnd(24)} ERROR   —         —       ${e.message.split("\n")[0].slice(0, 40)}`);
    continue;
  }
  // `repaired` true, or false-but-not-opened, both count as failure.
  const bad = !r.opened || r.repaired === true;
  if (bad) failures++;
  console.log(
    `${deck.padEnd(24)} ${String(r.opened).padEnd(7)} ${String(r.repaired).padEnd(9)} ` +
    `${String(r.slides?.length ?? 0).padEnd(7)} ${bad ? "*** FAIL" : r.error ? r.error.slice(0, 30) : "ok"}`
  );
}

console.log("-".repeat(72));
console.log(failures === 0
  ? `PASS: all ${decks.length} decks opened in PowerPoint with no repair.`
  : `FAIL: ${failures} of ${decks.length} decks did not open cleanly.`);
process.exit(failures === 0 ? 0 : 1);
