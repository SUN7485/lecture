/**
 * Does the dropped alef come back WITHOUT parsing GSUB?
 *
 * The bug: `الا` is painted as ONE ligature glyph whose ToUnicode yields only 2
 * of its 3 characters, so `والانحراف` extracts as `ولانحراف`.
 *
 * docs/SOLUTIONS.md P1 Fix A proposes parsing the font's GSUB table (needs
 * fontkit, not installed). But there may be a cheaper route: Unicode encodes the
 * lam-alef ligatures as presentation forms U+FEF5..U+FEFC, and each one has a
 * canonical decomposition:
 *
 *     U+FEFB LAM WITH ALEF              -> 0644 0627   (ل ا)
 *     U+FEF7 LAM WITH ALEF HAMZA ABOVE  -> 0644 0623
 *     U+FEF9 LAM WITH ALEF HAMZA BELOW  -> 0644 0625
 *     U+FEF5 LAM WITH ALEF MADDA ABOVE  -> 0644 0622
 *
 * `Font.encodeCharacter(cp)` sweeps those ranges, so IF the embedded subset's
 * cmap maps a presentation form to the ligature GID, we can reverse-map the GID
 * to U+FEFB and NFKD it back into two characters. No new dependency.
 *
 * This probe answers three questions, measured, on the real corpus:
 *   Q1. How many painted glyphs does ToUnicode under-report (chars < 1 per glyph)?
 *   Q2. Do ligature GIDs resolve through the reverse map at all?
 *   Q3. If they do, does NFKD recover the missing character?
 *
 * Read-only. Prints numbers; changes nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";

const CORPUS = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done";
const ONLY = process.argv[2] ?? null; // optional single-file filter

// Lam-alef ligatures: the only Arabic presentation forms that decompose to TWO
// base letters, which is exactly the shape of our bug.
const LAM_ALEF = new Map([
  [0xfef5, "\u0644\u0622"], [0xfef6, "\u0644\u0622"],
  [0xfef7, "\u0644\u0623"], [0xfef8, "\u0644\u0623"],
  [0xfef9, "\u0644\u0625"], [0xfefa, "\u0644\u0625"],
  [0xfefb, "\u0644\u0627"], [0xfefc, "\u0644\u0627"],
]);

const RANGES = [[0x0020, 0x007e], [0x0600, 0x06ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]];

/** gid -> unicode, built by sweeping encodeCharacter. Cached per font name. */
const reverseCache = new Map();
function reverseMap(font) {
  const name = font.getName();
  if (reverseCache.has(name)) return reverseCache.get(name);
  const rev = new Map();
  for (const [lo, hi] of RANGES) {
    for (let cp = lo; cp <= hi; cp++) {
      const gid = font.encodeCharacter(cp);
      // First writer wins EXCEPT a presentation form should not lose to a base
      // letter that happens to share a GID — prefer the ligature reading.
      if (gid > 0 && (!rev.has(gid) || (LAM_ALEF.has(cp) && !LAM_ALEF.has(rev.get(gid))))) {
        rev.set(gid, cp);
      }
    }
  }
  reverseCache.set(name, rev);
  return rev;
}

function collectGlyphs(page) {
  const glyphs = [];
  const device = new mupdf.Device({
    fillText(text) {
      text.walk({
        showGlyph(font, trm, glyph, unicode) {
          glyphs.push({ gid: glyph, unicode, x: trm[4], y: trm[5], font });
        },
      });
    },
    fillPath() {}, strokePath() {}, clipPath() {}, clipStrokePath() {},
    strokeText() {}, clipText() {}, clipStrokeText() {}, ignoreText() {},
    fillShade() {}, fillImage() {}, fillImageMask() {}, clipImageMask() {},
    popClip() {}, beginMask() {}, endMask() {}, beginGroup() {}, endGroup() {},
    beginTile() { return 0; }, endTile() {}, close() {}, drop() {},
  });
  page.run(device, mupdf.Matrix.identity);
  device.close();
  return glyphs;
}

/** Characters MuPDF's structured-text path produces for a page. */
function stextChars(page) {
  const json = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON());
  let n = 0;
  for (const block of json.blocks ?? []) {
    for (const line of block.lines ?? []) n += [...(line.text ?? "")].length;
  }
  return n;
}

const files = fs.readdirSync(CORPUS)
  .filter((f) => f.toLowerCase().endsWith(".pdf"))
  .filter((f) => !ONLY || f.includes(ONLY));

let totGlyphs = 0, totStext = 0, totLigGid = 0, totResolved = 0, totRecovered = 0;
const samples = [];
const unresolvedGids = new Map(); // gid -> count, for glyphs we cannot name at all

for (const file of files) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(path.join(CORPUS, file)), "application/pdf");
  const pages = doc.countPages();
  let fGlyphs = 0, fStext = 0, fLig = 0, fRec = 0;

  for (let p = 0; p < pages; p++) {
    const page = doc.loadPage(p);
    const glyphs = collectGlyphs(page);
    fGlyphs += glyphs.length;
    fStext += stextChars(page);

    for (const g of glyphs) {
      const rev = reverseMap(g.font);
      const cp = rev.get(g.gid);

      if (cp === undefined) {
        // Painted, but no codepoint in the whole sweep maps to this GID.
        // These are the GSUB-only ligatures — unreachable without the font tables.
        const key = `${g.font.getName().replace(/^[A-Z]+\+/, "")}#${g.gid}`;
        unresolvedGids.set(key, (unresolvedGids.get(key) ?? 0) + 1);
        continue;
      }

      if (!LAM_ALEF.has(cp)) continue;

      // This GID IS a lam-alef ligature according to the font's own cmap.
      fLig++; totLigGid++; totResolved++;
      const decomposed = LAM_ALEF.get(cp);
      const fromToUnicode = g.unicode > 0 ? String.fromCodePoint(g.unicode) : "";

      // Recovery happens when ToUnicode gave us FEWER characters than the
      // ligature actually represents.
      if ([...fromToUnicode].length < [...decomposed].length) {
        fRec++; totRecovered++;
        if (samples.length < 12) {
          samples.push({
            file, page: p, gid: g.gid,
            font: g.font.getName().replace(/^[A-Z]+\+/, ""),
            toUnicode: fromToUnicode || "(none)",
            revCp: "U+" + cp.toString(16).toUpperCase(),
            decomposed,
            x: g.x.toFixed(1), y: g.y.toFixed(1),
          });
        }
      }
    }
  }

  totGlyphs += fGlyphs; totStext += fStext;
  console.log(
    `${file.padEnd(24)} pages ${String(pages).padStart(3)}  ` +
    `glyphs ${String(fGlyphs).padStart(6)}  stext ${String(fStext).padStart(6)}  ` +
    `lam-alef GIDs ${String(fLig).padStart(4)}  recoverable ${String(fRec).padStart(4)}`
  );
}

console.log("\n================ TOTALS ================");
console.log(`painted glyphs (device)      ${totGlyphs}`);
console.log(`characters (structured text) ${totStext}`);
console.log(`glyphs whose GID resolves to a lam-alef ligature: ${totLigGid}`);
console.log(`  ...of which ToUnicode under-reported (RECOVERABLE): ${totRecovered}`);

console.log(`\nGIDs that resolve to NOTHING in the sweep: ${unresolvedGids.size} distinct`);
const worst = [...unresolvedGids.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [k, n] of worst) console.log(`  ${k.padEnd(34)} x${n}`);

if (samples.length) {
  console.log("\n---- RECOVERY SAMPLES ----");
  console.log("  font                       gid   toUnicode -> reverse   decomposes to");
  for (const s of samples) {
    console.log(
      `  ${s.font.padEnd(26)} ${String(s.gid).padStart(4)}  ` +
      `${JSON.stringify(s.toUnicode).padEnd(10)} -> ${s.revCp.padEnd(8)} ${JSON.stringify(s.decomposed)}`
    );
  }
} else {
  console.log("\nNo recoverable ligatures found via the cmap route.");
  console.log("=> the presentation-form shortcut does NOT work here; GSUB (Fix A) is required.");
}
