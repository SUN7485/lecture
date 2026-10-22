/**
 * Ask the DOCUMENT how many characters a glyph normally carries.
 *
 * Two hypotheses died before this one (see probe-glyph-arity*.js):
 *
 *   - "a wide glyph is a ligature" — in every font, ZERO suspects are wider
 *     than every proven single; the widest proven single in LyonArabicTextLF-Bold
 *     is 1.511 em against 0.963 for the glyph known to carry `لي`.
 *   - "arity is a fixed property of a glyph" — that same glyph sits on 31
 *     VERBATIM blocks and 29 miss blocks, so structured text decomposes it
 *     correctly about half the time. The loss is contextual, not intrinsic.
 *
 * That second fact is the opening. If a glyph usually yields two characters and
 * sometimes one, the document itself states the expectation — count how many
 * structured-text glyphs fall inside each occurrence's ADVANCE, take the mode
 * per glyph id, and any occurrence below its own mode has lost a character.
 *
 * No ground truth, no shipped table, no font parsing: it calibrates on the
 * document being converted, so it works on fonts nothing has ever seen.
 *
 * Usage: node experiments/probe-glyph-selfarity.js [--show N]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SHOW = Number(process.argv[process.argv.indexOf("--show") + 1]) || 12;
/** Slack (pt) at each end when deciding whether a stext glyph sits in a span. */
const SPAN_EPS = 0.35;

function deviceGlyphsWithId(page) {
  const out = [];
  const device = new mupdf.Device({
    fillText(text, ctm) {
      text.walk({
        showGlyph(font, trm, glyph, unicode) {
          const em = Math.hypot(ctm[0] * trm[0] + ctm[2] * trm[1], ctm[1] * trm[0] + ctm[3] * trm[1]);
          out.push({
            x: ctm[0] * trm[4] + ctm[2] * trm[5] + ctm[4],
            y: ctm[1] * trm[4] + ctm[3] * trm[5] + ctm[5],
            glyph, unicode,
            font: font.getName().replace(/^[A-Z]{6}\+/, ""),
            advance: font.advanceGlyph(glyph) * em,
          });
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
  return out;
}

/** key -> counts of "stext glyphs inside this glyph's advance", plus outcomes. */
const arity = new Map();
const sites = [];

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);
  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p)))
      .map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const truth = slideText[align[p]];
    const page = doc.loadPage(p);
    const devs = deviceGlyphsWithId(page);
    for (const b of buildLines(extractGlyphs(page))) {
      if (!b.glyphs?.length) continue;
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got) continue;
      const verbatim = truth.includes(got);
      const x0 = Math.min(...b.glyphs.map((g) => g.x0));
      const x1 = Math.max(...b.glyphs.map((g) => g.x1));

      for (const d of devs) {
        if (Math.abs(d.y - b.y) > 1.5 || d.x < x0 - 1 || d.x > x1 + 1) continue;
        if (d.advance <= 0) continue;
        // Structured-text glyphs whose ORIGIN falls inside this glyph's advance.
        const inside = b.glyphs.filter((g) =>
          g.x0 >= d.x - SPAN_EPS && g.x0 < d.x + d.advance - SPAN_EPS).length;

        const k = `${d.font}#${d.glyph}`;
        const a = arity.get(k) ?? { counts: new Map(), font: d.font, glyph: d.glyph, verbatim: 0, miss: 0 };
        a.counts.set(inside, (a.counts.get(inside) ?? 0) + 1);
        if (verbatim) a.verbatim++; else a.miss++;
        arity.set(k, a);
        sites.push({ key: k, inside, verbatim, deck: pair.name, page: p + 1 });
      }
    }
  }
}

/** The count this glyph yields most often, and how often it falls short. */
const mode = (m) => [...m].sort((a, b) => b[1] - a[1])[0][0];

let below = 0, belowOnMiss = 0, belowOnVerbatim = 0;
for (const s of sites) {
  const a = arity.get(s.key);
  if (a.counts.size < 2) continue;              // never varies: nothing to say
  const total = [...a.counts.values()].reduce((x, y) => x + y, 0);
  if (total < 5) continue;                      // too rare to have a normal
  if (s.inside >= mode(a.counts)) continue;
  below++;
  if (s.verbatim) belowOnVerbatim++; else belowOnMiss++;
}

console.log(`device glyph occurrences examined : ${sites.length}`);
console.log(`distinct glyphs                   : ${arity.size}\n`);
console.log(`occurrences BELOW their glyph's own normal arity : ${below}`);
console.log(`  on blocks that are a MISS      : ${belowOnMiss}`);
console.log(`  on blocks that are VERBATIM    : ${belowOnVerbatim}   <- false positives`);
const precision = below ? (belowOnMiss / below) * 100 : 0;
console.log(`  precision                      : ${precision.toFixed(1)}%   (base rate ${(sites.filter((s) => !s.verbatim).length / sites.length * 100).toFixed(1)}%)\n`);

const cal = arity.get("LyonArabicTextLF-Bold#612");
if (cal) {
  console.log(`calibration glyph LyonArabicTextLF-Bold#612 (carries \`لي\`)`);
  console.log(`  stext glyphs inside its advance: ${[...cal.counts].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}x${c}`).join("  ")}`);
  console.log(`  blocks: ${cal.verbatim} verbatim / ${cal.miss} miss\n`);
}

console.log("glyphs whose arity VARIES most (n = stext glyphs inside the advance):");
const varying = [...arity.entries()]
  .filter(([, a]) => a.counts.size > 1 && [...a.counts.values()].reduce((x, y) => x + y, 0) >= 8)
  .sort((a, b) => b[1].miss - a[1].miss).slice(0, SHOW);
for (const [k, a] of varying) {
  console.log(`  ${k.padEnd(30)} ${[...a.counts].sort((x, y) => x[0] - y[0]).map(([n, c]) => `${n}x${c}`).join(" ")}`
    + `   blocks ${a.verbatim}v/${a.miss}m`);
}
