/**
 * Price a base-direction rule for the CITATION lines, before writing one.
 *
 * `probe-base-direction.js` puts the ceiling of all direction work at prize 72
 * against protected 5960. The prize is not a scatter: one shape dominates, a
 * bibliography entry whose Arabic gloss is parenthesised —
 *
 *   visual   140. (ةيلمعلا–جتنملا ةفوفصمل يلصلأا عجرملا).
 *   got      .)المرجع الأصلي لمصفوفة المنتج–العملية( .140
 *   want     140. (المرجع الأصلي لمصفوفة المنتج–العملية).
 *
 * `textIsRtl` counts 6 Arabic words against 1 Latin one and calls the line RTL,
 * so the whole entry comes out reversed around its own citation. `readsLeftToRight`
 * already exists for this class and catches only the entries that open with a
 * "[4]" marker.
 *
 * The evidence is the BRACKET ORDER, which is a typographic fact rather than a
 * heuristic: a bracket pair enclosing Arabic inside an RTL line is painted
 * closing-first — that is what `hasMirroredPair` detects. Painted opening-first,
 * with Latin outside and Arabic inside, the line is running left to right.
 *
 * Every candidate is evaluated on the VISUAL glyph string, because that is what
 * `blockIsRtl` passes to `textIsRtl` — a predicate scored on the logical text
 * would be answering a question production never asks (EVO-028). It is scored on
 * the logical text as well, because `textIsRtl` is SHARED with the PPTX
 * forensics, which pass the finished text: a predicate that disagrees between
 * the two makes the writer and the gate disagree about the same paragraph.
 *
 *   node experiments/probe-citation-direction.js [samples]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, withSpaces } from "../src/extract/glyphs.js";
import { modelFromPdf } from "../src/model/normalize.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SAMPLES = Number(process.argv[2] ?? 10);
const AR = /[؀-ۿݐ-ݿ]/;
const LATIN = /[A-Za-z]/;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/;

/** The bracketed spans of a text, as {inside, outside} pairs, either nesting. */
function bracketSpans(text) {
  const out = [];
  for (const [open, close] of [["(", ")"], [")", "("]]) {
    let i = text.indexOf(open);
    while (i >= 0) {
      const j = text.indexOf(close, i + 1);
      if (j < 0) break;
      out.push({ inside: text.slice(i + 1, j), outside: text.slice(0, i) + text.slice(j + 1), openFirst: open === "(" });
      i = text.indexOf(open, j + 1);
    }
  }
  return out;
}

/**
 * A parenthesised Arabic gloss inside an otherwise Latin line. `openFirst`
 * distinguishes it from the same content in an RTL line, which paints the
 * closing bracket first.
 */
const glossInLatinLine = (text, requireOpenFirst) => bracketSpans(text).some((s) =>
  (!requireOpenFirst || s.openFirst) &&
  AR.test(s.inside) && !LATIN.test(s.inside) &&
  LATIN_OR_DIGIT.test(s.outside) && !AR.test(s.outside));

const CANDIDATES = [
  ["Arabic gloss, opening-first",     (t) => glossInLatinLine(t, true)],
  ["Arabic gloss, either order",      (t) => glossInLatinLine(t, false)],
  ["...and the line ends `)` `.`",    (t) => glossInLatinLine(t, true) && /[)\]]\s*[.،؛]?\s*$/.test(t)],
  ["...and outside has a LETTER",     (t) => bracketSpans(t).some((s) => s.openFirst &&
      AR.test(s.inside) && !LATIN.test(s.inside) && LATIN.test(s.outside) && !AR.test(s.outside))],
  ["Latin allowed INSIDE the gloss",  (t) => bracketSpans(t).some((s) => s.openFirst &&
      AR.test(s.inside) && LATIN_OR_DIGIT.test(s.outside) && !AR.test(s.outside))],
  ["...plus line ends bracket+stop",  (t) => bracketSpans(t).some((s) => s.openFirst &&
      AR.test(s.inside) && LATIN_OR_DIGIT.test(s.outside) && !AR.test(s.outside)) && /[)\]]\s*[.،؛]?\s*$/.test(t)],
];

const rows = [];

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const model = modelFromPdf(pair.pdf);
  const slideText = loadSlides(pair.html).map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);

  for (let i = 0; i < doc.countPages(); i++) {
    if (align[i] < 0) continue;
    const truth = slideText[align[i]];
    for (const b of buildLines(extractGlyphs(doc.loadPage(i)))) {
      const rtl = blockIsRtl(b);
      const cur = normalize(blockText(b, rtl));
      if (!cur) continue;
      rows.push({
        deck: pair.name, page: i + 1, rtl,
        visual: withSpaces(b.glyphs).map((g) => g.c).join(""),
        cur, ltr: normalize(blockText(b, false)),
        curOk: truth.includes(cur), ltrOk: truth.includes(normalize(blockText(b, false))),
      });
    }
  }
}

console.log(`blocks ${rows.length}\n`);
console.log("Scored on the VISUAL string — what blockIsRtl actually passes to textIsRtl.");
console.log("A firing predicate forces the block LTR.\n");
console.log("signature                          fires   FIXED   BROKEN   no-change");
for (const [name, pred] of CANDIDATES) {
  let fires = 0, fixed = 0, broken = 0, neutral = 0;
  for (const r of rows) {
    if (!pred(r.visual)) continue;
    fires++;
    if (!r.curOk && r.ltrOk) fixed++;
    else if (r.curOk && !r.ltrOk) broken++;
    else neutral++;
  }
  console.log(`  ${name.padEnd(32)} ${String(fires).padStart(5)} ${String(fixed).padStart(7)} ${String(broken).padStart(8)} ${String(neutral).padStart(11)}`);
}

// textIsRtl is shared with the PPTX forensics, which pass the FINISHED text. A
// predicate that fires on the visual string and not on the logical one makes the
// writer and the gate disagree about the same paragraph.
console.log("\nAgreement between the visual and logical readings of each predicate:");
for (const [name, pred] of CANDIDATES) {
  let onlyVisual = 0, onlyLogical = 0, both = 0;
  for (const r of rows) {
    const target = r.ltrOk ? r.ltr : r.cur;      // the text the writer would emit
    const v = pred(r.visual), l = pred(target);
    if (v && l) both++; else if (v) onlyVisual++; else if (l) onlyLogical++;
  }
  console.log(`  ${name.padEnd(32)} both ${String(both).padStart(4)}   visual only ${String(onlyVisual).padStart(3)}   logical only ${String(onlyLogical).padStart(3)}`);
}

const best = CANDIDATES[0][1];
const firing = rows.filter((r) => best(r.visual));
console.log(`\n--- ${Math.min(SAMPLES, firing.length)} of ${firing.length} blocks matched by "${CANDIDATES[0][0]}" ---`);
for (const r of firing.slice(0, SAMPLES)) {
  const verdict = !r.curOk && r.ltrOk ? "FIXED" : r.curOk && !r.ltrOk ? "BROKEN" : "no change";
  console.log(`${r.deck} p${r.page}  rtl=${r.rtl}  ${verdict}`);
  console.log(`  got  ${r.cur.slice(0, 90)}`);
  console.log(`  ltr  ${r.ltr.slice(0, 90)}`);
}
