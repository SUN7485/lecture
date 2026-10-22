/**
 * `ألسبوع` for `لأسبوع` — nothing was dropped, the pair is BACKWARDS.
 *
 * The delivered-miss breakdown calls this `DROPPED letter "ل"` (31 blocks),
 * because the classifier compares first divergence and a swap looks like a
 * deletion. It is not a deletion:
 *
 *   got    أ ل س ب و ع        truth  ل أ س ب و ع
 *   got    إ ل ن ت ا ج ي ة    truth  ل إ ن ت ا ج ي ة
 *
 * A lam-alef is ONE painted glyph standing for two characters, and its logical
 * order is always lam first. When the two halves are emitted alef-first and the
 * grouping pass fails to bind them, the reversal moves them independently and
 * they land the wrong way round.
 *
 * `أل` cannot simply be swapped on sight — `ألف`, `ألم`, `ألوان` are ordinary
 * words. What licenses the swap is the DEVICE: if the page painted a lam-alef
 * ligature glyph the text cannot account for, then those two characters are that
 * ligature and their order is settled by Arabic, not by guesswork.
 *
 * Usage: node experiments/probe-lamalef-swap.js [--show]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { owedOf } from "../src/extract/ligatures.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SHOW = process.argv.includes("--show");
/**
 * A HAMZATED alef followed by a lam — the reversed ligature.
 *
 * Plain `ا` is deliberately excluded: `ال` is the definite article, the most
 * common two-letter sequence in the language. Including it matched 7641 sites
 * and broke 7179 blocks, turning `التمهيد` into `لاتمهيد` on every line it
 * touched. `أل` and `إل` are rare by comparison, which is what makes them worth
 * asking the device about.
 */
const REVERSED = /([آأإ])(ل)/gu;
/** The ligature in its correct order. */
const CORRECT = /ل[اآأإ]/gu;

const RULES = {
  "swap every hamzated alef+lam on sight": (s) => s.replace(REVERSED, "$2$1"),
  "swap only when a LIGATURE is unaccounted": (s, ev) =>
    ev.ligatureLost ? s.replace(REVERSED, "$2$1") : s,
  // A line with two candidate sites and one unaccounted ligature cannot say
  // WHICH site is the ligature, and the other is usually a real word — `آلة`,
  // `إلغاء`. Requiring a single candidate removes the guess entirely.
  "  + exactly one candidate on the line": (s, ev) => {
    if (!ev.ligatureLost || (s.match(REVERSED) ?? []).length !== 1) return s;
    return s.replace(REVERSED, "$2$1");
  },
  "  + one candidate, and it starts a word": (s, ev) => {
    if (!ev.ligatureLost || (s.match(REVERSED) ?? []).length !== 1) return s;
    return s.replace(/(^|[\s(«"„-])([آأإ])(ل)/u, (m, pre, a, l) => pre + l + a);
  },
  // The deficit says how many ligatures went unaccounted. If that is exactly
  // the number of candidate sites, every site is one of them.
  "  + candidates == unaccounted ligatures": (s, ev) => {
    const n = (s.match(REVERSED) ?? []).length;
    if (!n || n !== ev.unaccounted) return s;
    return s.replace(REVERSED, "$2$1");
  },

  // THE DEFINITE ARTICLE. Every win above has the same three-character shape:
  // `اإلجراء` for `الإجراء`, `األداء` for `الأداء`. That is `ال` + a hamzated
  // alef — the article followed by a lam-alef ligature — with the ligature's two
  // halves the wrong way round. The context is what makes it safe: a bare `أل`
  // is an ordinary word fragment, but `األ` at a word start is not a word, it is
  // the article with its ligature reversed.
  "ARTICLE  ا[آأإ]ل -> ال[آأإ]  (no device evidence)": (s) =>
    s.replace(/ا([آأإ])ل/gu, "ال$1"),
  "ARTICLE  + at a word start only": (s) =>
    s.replace(/(^|[\s(«"„\-–—/])ا([آأإ])ل/gu, (m, pre, a) => `${pre}ال${a}`),
  "ARTICLE  + word start + device evidence": (s, ev) =>
    ev.ligatureLost ? s.replace(/(^|[\s(«"„\-–—/])ا([آأإ])ل/gu, (m, pre, a) => `${pre}ال${a}`) : s,

  // The same shape with a PLAIN alef: `االختناق` for `الاختناق`. Two consecutive
  // alefs are not a thing Arabic writes, so `اال` is as strong a signal as `اإل`.
  "ARTICLE  plain alef  اال -> الا": (s) => s.replace(/اال/gu, "الا"),
  "ARTICLE  all four alef forms": (s) =>
    s.replace(/ا([اآأإ])ل/gu, "ال$1"),
};

const score = new Map(Object.keys(RULES).map((k) => [k, { touched: 0, fixed: 0, broken: 0 }]));
const samples = [];

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
    const glyphs = extractGlyphs(doc.loadPage(p));

    for (const b of buildLines(glyphs)) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      REVERSED.lastIndex = 0;
      if (!got || (!REVERSED.test(got) && !/ا[اآأإ]ل/u.test(got))) { REVERSED.lastIndex = 0; continue; }
      REVERSED.lastIndex = 0;

      // Device evidence for THIS line: more lam-alef ligature glyphs painted
      // than the text contains correctly-ordered `لا` sequences.
      const x0 = Math.min(...b.glyphs.map((g) => g.x0));
      const x1 = Math.max(...b.glyphs.map((g) => g.x1));
      let ligatures = 0;
      for (const d of glyphs.deviceGlyphs) {
        if (Math.abs(d.y - b.y) > 1.5) continue;
        if (d.x < x0 - 1 || d.x > x1 + 1) continue;
        if (owedOf(d.unicode) === 2) ligatures++;
      }
      const present = (got.match(CORRECT) ?? []).length;
      const ev = { ligatureLost: ligatures > present, unaccounted: ligatures - present };

      const wasOk = truth.includes(got);
      for (const [name, fix] of Object.entries(RULES)) {
        const after = normalize(fix(got, ev));
        if (after === got) continue;
        const s = score.get(name);
        s.touched++;
        const isOk = truth.includes(after);
        if (!wasOk && isOk) s.fixed++;
        else if (wasOk && !isOk) s.broken++;
      }

      if (SHOW && ev.ligatureLost && samples.length < 14) {
        const after = normalize(RULES["  + exactly one candidate on the line"](got, ev));
        if (after !== got) {
          samples.push(`${truth.includes(after) ? "OK  " : "MISS"} ${pair.name} p${p + 1}`
            + `\n        before: ${got.slice(0, 64)}\n        after : ${after.slice(0, 64)}`);
        }
      }
    }
  }
}

console.log("rule                                        touched   fixed  broken");
for (const [name, s] of score) {
  console.log(`${name.padEnd(43)} ${String(s.touched).padStart(6)} ${String(s.fixed).padStart(7)} ${String(s.broken).padStart(7)}`);
}
if (SHOW) for (const s of samples) console.log(`\n  ${s}`);
