/**
 * Does any run hand PowerPoint a separator it will place in the wrong direction?
 *
 * WHY THIS EXISTS. A reader reported words running together and formulas
 * colliding with Arabic labels. Every one of those paragraphs scored VERBATIM —
 * the text was character-perfect and only the rendering was wrong — so
 * `delivered-set.js`, the gate this project trusts most, was blind to all of it
 * by construction. `600 ÷ 60 = 10 ساعات عمل` rendered `10ساعات عمل` on every row
 * of every worked example in the corpus and no gate said a word.
 *
 * WHY IT IS STATIC AND NOT A RENDER CHECK. The obvious instrument is to compare
 * each line's rendered ink against the source's. It was built first and it does
 * not work here: a line is one textbox and its INTERNAL layout belongs to
 * PowerPoint, so a fragment legitimately drifts — measured p90 8.7pt, p95 21.4pt
 * of extent difference on a render with no defect at all. A gate whose noise
 * floor is ten times the defect it hunts trains people to ignore it.
 *
 * The defect has an exact statement that needs no pixels. PowerPoint resolves
 * direction per RUN from its `lang`, so a separator sitting at the EDGE of a run
 * whose direction is not the paragraph's base is given the wrong direction:
 *
 *   a SPACE there is trimmed        `= 10 ساعات عمل`  ->  `= 10ساعات عمل`
 *   a DASH there joins the island   `الخطوة 1 — إجمالي` -> `الخطوة — 1 إجمالي`
 *   a lone BRACKET there reverses   `(المرجع ... المحورية).` -> `(.)المرجع ...`
 *
 * In every case the character belongs to the SENTENCE and was filed with the
 * ISLAND. `rebalanceBrackets` in src/extract/glyphs.js puts it back; this file
 * asserts the result on the finished OOXML, which is the artifact the reader
 * opens (EVO-030).
 *
 * Two things it deliberately does NOT flag, both measured:
 *   - a bracket whose PARTNER is in the same run. `(Tidy Data)` is a Latin
 *     island holding a complete pair and both halves belong to it; moving one
 *     out renders `(Tidy Data))`.
 *   - an OPERATOR. `=SUM(...)` and `$F$2` are the island's own, and every text
 *     repair in the doctor runs per run — splitting `%` off `%100` cost two
 *     delivered blocks.
 *
 *   node experiments/verify-run-edges.js <deck.pptx> [more.pptx ...]
 *   node experiments/verify-run-edges.js out/*.pptx
 *
 * Exit 1 if any run carries a misplaced edge separator.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { requireSubjects } from "./lib-gate.js";

const DECKS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SHOW = Number((process.argv.includes("--show") && process.argv[process.argv.indexOf("--show") + 1]) || 10);
if (!DECKS.length) {
  console.error("usage: node experiments/verify-run-edges.js <deck.pptx> [more.pptx ...]");
  process.exit(2);
}

/** Separators that belong to the SENTENCE: whitespace, dashes, sentence punctuation. */
const EDGE_SEP = /[\s–—،؛؟:.,?!]/;
/** Brackets, which belong to whichever side owns the pair. */
const OPEN = "([{«‹";
const CLOSE = ")]}»›";
/** A run with no letter and no digit makes no directional claim of its own. */
const NO_SCRIPT = /^[^\p{L}\p{N}]+$/u;

/** Every `ppt/slides/slideN.xml` in a .pptx, without a zip dependency. */
function slides(file) {
  const buf = fs.readFileSync(file);
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error(`${file}: not a zip`);
  const n = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const out = [];
  for (let k = 0; k < n; k++) {
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      const lho = buf.readUInt32LE(off + 42);
      const method = buf.readUInt16LE(off + 10);
      const csize = buf.readUInt32LE(off + 20);
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const raw = buf.subarray(start, start + csize);
      out.push({
        n: Number(/slide(\d+)\.xml/.exec(name)[1]),
        xml: (method === 0 ? raw : zlib.inflateRawSync(raw)).toString("utf8"),
      });
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out.sort((a, b) => a.n - b.n);
}

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * Paragraphs as {rtl, runs:[{lang, text}]}.
 *
 * The writer emits an `a:pPr` before each run rather than once per paragraph, so
 * the base direction is "does ANY pPr in this paragraph carry rtl" — reading only
 * the first one would call every paragraph LTR.
 */
function paragraphs(xml) {
  const out = [];
  for (const m of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
    const body = m[1];
    const rtl = /<a:pPr[^>]*\brtl="1"/.test(body);
    const runs = [];
    for (const r of body.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)) {
      const lang = /lang="([^"]+)"/.exec(r[1])?.[1] ?? "en-US";
      const t = /<a:t>([\s\S]*?)<\/a:t>/.exec(r[1]);
      if (t) runs.push({ lang, text: unescape(t[1]) });
    }
    if (runs.length) out.push({ rtl, runs });
  }
  return out;
}

/** Is this edge character a separator that belongs to the sentence? */
function badEdge(run, side, neighbour) {
  const ch = side === "lead" ? run.text[0] : run.text[run.text.length - 1];
  if (!ch) return null;
  if (EDGE_SEP.test(ch)) {
    // With a neighbour in the base direction, the separator should have been
    // pushed into it; with none, it should have become a run of its own.
    return neighbour ? "a sentence separator PowerPoint will misplace" : null;
  }
  const idx = side === "lead" ? OPEN.indexOf(ch) : CLOSE.indexOf(ch);
  if (idx < 0) return null;
  // A bracket whose partner is in this same run belongs to the island with it.
  const partner = side === "lead" ? CLOSE[idx] : OPEN[idx];
  if (run.text.slice(1).includes(partner) || run.text.slice(0, -1).includes(partner)) return null;
  return "a lone bracket that belongs to the sentence, not to the island";
}

let totalDecks = 0, totalBad = 0, totalRuns = 0;
const rows = [];

for (const deck of DECKS) {
  if (!deck.toLowerCase().endsWith(".pptx")) continue;
  totalDecks++;
  let bad = 0, runs = 0;
  for (const { n, xml } of slides(deck)) {
    for (const p of paragraphs(xml)) {
      const nonBase = p.rtl ? "Latn" : "Arab";
      for (let i = 0; i < p.runs.length; i++) {
        const r = p.runs[i];
        const script = /^ar/i.test(r.lang) ? "Arab" : "Latn";
        runs++;
        if (script !== nonBase) continue;
        if (NO_SCRIPT.test(r.text)) continue;     // a separator run is the fix, not the defect
        // Only a BASE-direction neighbour makes this edge a direction boundary.
        // Two adjacent Latin runs that differ only in size or colour are not a
        // boundary at all, and a space between them is safe — flagging those was
        // this gate over-firing on its own first draft.
        const at = (k) => {
          const nb = p.runs[k];
          if (!nb) return null;
          return (/^ar/i.test(nb.lang) ? "Arab" : "Latn") === nonBase ? undefined : nb;
        };
        for (const [side, neighbour] of [["lead", at(i - 1)], ["tail", at(i + 1)]]) {
          if (neighbour === undefined && p.runs[side === "lead" ? i - 1 : i + 1]) continue;
          const why = badEdge(r, side, neighbour);
          if (!why) continue;
          bad++;
          rows.push({ deck: path.basename(deck), slide: n, side, why, text: r.text });
        }
      }
    }
  }
  totalBad += bad;
  totalRuns += runs;
  console.log(`${path.basename(deck).padEnd(26)} ${String(runs).padStart(6)} runs  ${bad ? `${String(bad).padStart(4)} MISPLACED` : "   0  ok"}`);
}

if (rows.length) {
  console.log("");
  for (const r of rows.slice(0, SHOW)) {
    console.log(`  ${r.deck} slide ${r.slide}  ${r.side} — ${r.why}`);
    console.log(`     run: ${JSON.stringify(r.text.slice(0, 70))}`);
  }
  if (rows.length > SHOW) console.log(`  … and ${rows.length - SHOW} more`);
}

// A .pdf argument passes the argv guard above, matches no deck, and used to
// print "0 decks · 0 runs · GATE PASS". That happened, and was quoted as proof.
requireSubjects(totalDecks, "decks", "this gate reads .pptx packages, not PDFs.");
console.log("=".repeat(78));
console.log(`  ${totalDecks} decks · ${totalRuns} runs · ${totalBad} misplaced edge separators`);
console.log(totalBad
  ? "\n  GATE FAIL: PowerPoint will render these on the wrong side of their run."
  : "\n  GATE PASS: every edge separator sits in the run whose direction it needs.");
process.exit(totalBad ? 1 : 0);
