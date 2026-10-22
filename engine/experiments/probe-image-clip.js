/**
 * How much of each placed image actually survives the clip stack?
 *
 * `fillImage` emits the rectangle the unit square maps to, which is the WHOLE
 * picture — not the part the page lets you see. A producer that places a large
 * photo and clips it to a small frame therefore ships an oversized picture, and
 * on the InDesign brand guide p13 that turned four photo cards into seven with
 * one running off the slide.
 *
 * This prices the fix before it changes anything: it reads the `visibleBbox`
 * the extractor now records and reports how many images WOULD move, so the
 * corpus can veto the change before it exists.
 *
 * Usage:
 *   node experiments/probe-image-clip.js <file.pdf> [more.pdf ...]
 *   node experiments/probe-image-clip.js --corpus [--decks N]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractVectors } from "../src/extract/vectors.js";
import { findPairs } from "../src/truth/corpus.js";
import { release } from "../src/extract/mupdf-lifetime.js";

const args = process.argv.slice(2);
const LIMIT = Number((args.includes("--decks") && args[args.indexOf("--decks") + 1]) || 6);
const FILES = args.includes("--corpus")
  ? findPairs().slice(0, LIMIT).map((p) => p.pdf)
  : args.filter((a) => !a.startsWith("--"));

if (!FILES.length) {
  console.error("usage: node experiments/probe-image-clip.js <file.pdf> ... | --corpus [--decks N]");
  process.exit(1);
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : "0.0").padStart(5) + "%";
let gTotal = 0, gCropped = 0, gVanished = 0, gUnappliable = 0;

console.log("deck                                images  cropped  vanished  unappliable  worst shrink");
console.log("-".repeat(94));

for (const file of FILES) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(file), "application/pdf");
  let total = 0, cropped = 0, vanished = 0, unappliable = 0, worst = 1, worstAt = "";
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    let out;
    try { out = extractVectors(page); } finally { release(page); }
    for (const im of out.images ?? []) {
      total++;
      if (im.clipUnappliable) { unappliable++; continue; }
      if (!("visibleBbox" in im)) continue;
      if (im.visibleBbox === null) { vanished++; continue; }
      cropped++;
      // How much of the placed area survives. 0.02 means 98% of it was clip.
      const survives = (im.visibleBbox.w * im.visibleBbox.h) / Math.max(1e-6, im.bbox.w * im.bbox.h);
      if (survives < worst) { worst = survives; worstAt = `p${i + 1}`; }
    }
  }
  gTotal += total; gCropped += cropped; gVanished += vanished; gUnappliable += unappliable;
  const name = file.split(/[\\/]/).pop().replace(/\.pdf$/i, "");
  console.log(
    name.slice(0, 34).padEnd(35),
    String(total).padStart(6), String(cropped).padStart(8), String(vanished).padStart(9),
    String(unappliable).padStart(12),
    cropped ? `   ${(worst * 100).toFixed(1)}% survives ${worstAt}` : ""
  );
}

console.log("-".repeat(94));
console.log(`${gTotal} images · ${gCropped} cropped (${pct(gCropped, gTotal)}) · ` +
            `${gVanished} fully clipped away · ${gUnappliable} rotated/skewed (left alone)`);
if (!gCropped && !gVanished) console.log("\nNo image here is clipped: this change is INERT on these documents.");
