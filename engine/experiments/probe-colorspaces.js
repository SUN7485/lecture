/**
 * How many components does a colour actually have, and what does `toHex` do to it?
 *
 * `toHex` in BOTH `src/model/normalize.js` and `src/extract/vectors.js` opens
 * with the same sentence: "MuPDF colours are float triples". They are not. MuPDF
 * hands a device callback one component per COLORSPACE component — DeviceGray is
 * 1, DeviceRGB is 3, DeviceCMYK is 4 — and the corpus never revealed it because
 * 28 Chrome prints of one HTML template are DeviceRGB from end to end.
 *
 * Two different failures come out of that, and only one of them is loud:
 *
 *   1 component   `[0.75]` -> "BF", a TWO-character string. pptxgenjs refuses it
 *                 with a console warning and substitutes 000000, so a white
 *                 DeviceGray fill shipsBLACK.
 *   4 components  `.slice(0, 3)` takes C, M, Y, drops K, and prints them as if
 *                 they were R, G, B. That is a valid 6-character hex, so NOTHING
 *                 warns: cyan shipsred, and CMYK white ships black.
 *
 * This prints the arity histogram per file plus the count of colours whose hex
 * is not 6 characters, which is the part a gate can assert on.
 *
 * Usage: node experiments/probe-colorspaces.js <file.pdf> [more.pdf ...]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { release } from "../src/extract/mupdf-lifetime.js";

/** The shipped conversion, copied verbatim so the probe measures the real one. */
const shippedToHex = (color) =>
  (Array.isArray(color) ? color.slice(0, 3) : [0, 0, 0])
    .map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

function tally(map, key) { map.set(key, (map.get(key) ?? 0) + 1); }

function probe(file) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(file), "application/pdf");
  const pages = doc.countPages();

  const deviceArity = new Map();   // "DeviceGray/1" -> count
  const stextArity = new Map();    // 1|3|4|"not-an-array" -> count
  const badHex = new Map();        // "BF" -> count
  const samples = new Map();       // "DeviceGray/1" -> first colour seen

  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);

    // The DEVICE path, where a colorspace is available at every paint site.
    const note = (colorspace, color) => {
      let name = "(none)", n = -1;
      try { name = colorspace?.getName?.() ?? "(none)"; } catch { /* released */ }
      try { n = colorspace?.getNumberOfComponents?.() ?? -1; } catch { /* released */ }
      const key = `${name}/${n}comp`;
      tally(deviceArity, key);
      if (!samples.has(key)) samples.set(key, JSON.stringify(color));
      const hex = shippedToHex(color);
      if (hex.length !== 6) tally(badHex, hex);
    };

    // The callbacks MUST be wrapped in `mupdf.Device`. Handing `page.run` a plain
    // object throws, and the first version of this probe swallowed that throw and
    // printed "device: (none)" — an instrument reporting its own blind spot as an
    // absence, which is exactly what EVO-039 exists to stop. Failures are loud now.
    const dev = new mupdf.Device({
      fillPath(path, evenOdd, ctm, colorspace, color) { note(colorspace, color); release(path, colorspace); },
      strokePath(path, stroke, ctm, colorspace, color) { note(colorspace, color); release(path, stroke, colorspace); },
      fillText(text, ctm, colorspace, color) { note(colorspace, color); release(text, colorspace); },
      strokeText(text, stroke, ctm, colorspace, color) { note(colorspace, color); release(text, stroke, colorspace); },
      fillImageMask(image, ctm, colorspace, color) { note(colorspace, color); release(image, colorspace); },
    });
    try { page.run(dev, mupdf.Matrix.identity); }
    finally { release(dev); }

    // The STRUCTURED TEXT path, which carries no colorspace at all — so whatever
    // arity it uses here is the only thing `normalize.js` will ever see.
    const stext = page.toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces");
    try {
      stext.walk({
        onChar(c, origin, font, size, quad, color) {
          try {
            const k = Array.isArray(color) ? `${color.length}comp` : `${typeof color}`;
            tally(stextArity, k);
            if (!samples.has(`stext/${k}`)) samples.set(`stext/${k}`, JSON.stringify(color));
            const hex = shippedToHex(color);
            if (hex.length !== 6) tally(badHex, `text:${hex}`);
          } finally { release(font); }
        },
      });
    } finally { release(stext); }
  }

  return { pages, deviceArity, stextArity, badHex, samples };
}

let totalBad = 0;
for (const f of process.argv.slice(2)) {
  const short = f.split(/[\\/]/).pop();
  let r;
  try { r = probe(f); } catch (e) { console.log(`\n${short}\n  FAILED: ${e.message}`); continue; }

  const bad = [...r.badHex.values()].reduce((a, b) => a + b, 0);
  totalBad += bad;
  console.log(`\n${short}  (${r.pages} pages)`);
  console.log(`  device : ${[...r.deviceArity].map(([k, v]) => `${k} x${v}`).join("  ") || "(none)"}`);
  console.log(`  stext  : ${[...r.stextArity].map(([k, v]) => `${k} x${v}`).join("  ") || "(none)"}`);
  if (bad) console.log(`  BAD HEX: ${bad} colours -> ${[...r.badHex].map(([k, v]) => `"${k}" x${v}`).join("  ")}`);
  for (const [k, v] of r.samples) if (k.includes("1comp") || k.includes("4comp")) console.log(`  sample ${k}: ${v}`);
}
console.log(`\nTOTAL colours that do not produce a 6-character hex: ${totalBad}`);
