/**
 * FIXTURES — the named BLOCKS the repairs in `ligatures.js` are answerable for.
 *
 * The corpus gates answer "did the total move". They cannot answer "is the site
 * this repair was written for still repaired", because a change that fixes 5
 * blocks and breaks 5 others reads as net zero and passes. These are individual
 * blocks, asserted through the real path: `extractGlyphs` -> `buildLines` ->
 * `blockText`.
 *
 * **Blocks, not pages, and this is the whole reason the file looks like this.**
 * The first version asserted words on a PAGE, taken from the repairs' own
 * docstrings. Every one passed and none of them meant anything: `الريالات`
 * occurs in 7 blocks corpus-wide, `تماماً` in 36 and `الاستغلال` in 60, so a
 * page-level assertion is satisfied by a neighbouring correct instance while the
 * site under test is broken. The sites below were found by
 * `experiments/probe-repair-sites.js`, which reads the `recoveredBy` tag the
 * repairs write, so each one is a block a named producer demonstrably touches.
 *
 * Every fixture is an INVARIANT: it must hold in every mode, today and after
 * every future change. Two of them were TARGETs until the attribution redesign
 * landed — the sites where a font-named ligature swallows a letter — and they are
 * now simply required like the rest.
 *
 * A fixture nobody has watched fail is decoration (EVO-019), and all five of the
 * originals were watched to fail: the two interference fixtures went red on
 * demand under the old per-baseline budget (that is what the retired
 * LIG_COMPONENTS flag was for), and the three producer fixtures went red when the
 * budget was first computed on the raw stream and starved the tanween repair on
 * 199 blocks.
 *
 *   node experiments/verify-repair-fixtures.js [--show]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { findPairs } from "../src/truth/corpus.js";
import { normalize } from "../src/truth/html-slides.js";

const SHOW = process.argv.includes("--show");

/** A block is the fixture's block if its baseline and right edge both match. */
const KEY_TOL = 0.8;

/**
 * `page` is 1-based and `y`/`x1` are the block's geometry, matching the keys
 * `verbatim-set.js` prints — the identity that survives the change being
 * measured. `has` must appear in THAT block; `lacks` must not.
 */
const FIXTURES = [
  {
    deck: "Chp4-Lec23-1", page: 4, y: 123.0, x1: 666.0,
    has: "الاستغلال", producer: "ligature",
    why: "a real glyph collides with a lam-alef tail; stext emits one character for two",
  },
  {
    deck: "Chp4-Lec23-1", page: 17, y: 259.9, x1: 632.6,
    has: "شيئاً", producer: "tanween",
    why: "the alef vanished and left its tanween behind; the mark must stay AFTER the alef",
  },
  {
    deck: "Chp4-Lec23-1", page: 7, y: 244.5, x1: 572.6,
    has: "الاستغلال", producer: "collided",
    why: "a standalone alef collided with a ligature tail — the only site that survives a missing cmap",
  },
  {
    deck: "Chp1-Lec2-1(New)", page: 20, y: 93.0, x1: 658.5,
    has: "بُني", lacks: "بُيني", producer: "ligature",
    why: "INTERFERENCE: the row deficit is real, but it belongs to the beh, not to the ligature tail",
  },
  {
    deck: "Chp3-Lec19", page: 2, y: 92.3, x1: 648.7,
    has: "المدخل التشغيلي", lacks: "التشغلي", producer: "ligature",
    why: "INTERFERENCE: a zero-width insert on an occupied slot, collapsed by groupAtomicUnits, DELETES a yeh stext supplied",
  },
  {
    deck: "Chp4-Lec23-1", page: 7, y: 195.8, x1: 572.6,
    has: "التشغيلي", lacks: "التشغ لي", producer: "ligature",
    why: "the font names this glyph lam_yehar.fina.rlig: it supplies one character and owes two",
  },
  {
    deck: "Chp4-Lec23-1", page: 7, y: 298.5, x1: 572.6,
    has: "التشغيلي", lacks: "التشغلي", producer: "ligature",
    why: "the same ligature at the end of a long line",
  },
  {
    deck: "Chp1-Lec3-2(New)", page: 13, y: 134.3, x1: 658.5,
    has: "يُعدّ", lacks: "يُعّ", producer: "markedBase",
    why: "the dal under a SHADDA vanished — neither an alef nor a tanween, which is why the alef-only producer never saw it",
  },
  {
    deck: "Chp1-Lec3-2(New)", page: 1, y: 270.8, x1: 455.9,
    has: "ثوانٍ", lacks: "ثوا.", producer: "markedBase",
    why: "the noon under a kasratan vanished, and the sentence's full stop then sorted INSIDE the word",
  },
  {
    deck: "Chp1-Lec3-2(New)", page: 18, y: 285.8, x1: 638.2,
    has: "إفشالاً", lacks: "إفشاً", producer: "markedBase",
    why: "a LIGATURE under a mark loses BOTH letters at once; the word must afford two or put back neither",
  },
  {
    deck: "Chp1-Lec3-2(New)", page: 21, y: 367.5, x1: 662.1,
    has: "للأسبوع", lacks: "لألسبوع", producer: "grouping",
    why: "both ligature halves at full width, the tail on the next letter's origin: only the RIGHT EDGE tells them apart",
  },
];

const pairs = new Map(findPairs().map((p) => [p.name, p]));
const cache = new Map();

/** Every block on one page, as {y, x1, text}. */
function blocksOf(deck, page) {
  const key = `${deck} p${page}`;
  if (cache.has(key)) return cache.get(key);
  const pair = pairs.get(deck);
  if (!pair) throw new Error(`fixture names a deck that is not in the corpus: ${deck}`);
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const arity = ligatureArity(doc.asPDF());
  const out = buildLines(extractGlyphs(doc.loadPage(page - 1), arity))
    .map((b) => ({ y: b.y, x1: b.x1, text: normalize(blockText(b, blockIsRtl(b))) }));
  cache.set(key, out);
  return out;
}

let failed = 0;

for (const f of FIXTURES) {
  const site = `${f.deck} p${f.page} y=${f.y.toFixed(1)}`;
  const found = blocksOf(f.deck, f.page)
    .filter((b) => Math.abs(b.y - f.y) <= KEY_TOL && Math.abs(b.x1 - f.x1) <= KEY_TOL);

  const problems = [];
  if (found.length !== 1) {
    // Not a pass and not a soft miss: the fixture can no longer see its subject,
    // so it has stopped testing anything. That is louder than a content failure.
    problems.push(found.length ? `${found.length} blocks match this geometry` : "no block at this geometry");
  } else {
    const text = found[0].text;
    if (f.has && !text.includes(normalize(f.has))) problems.push(`missing ${JSON.stringify(f.has)}`);
    if (f.lacks && text.includes(normalize(f.lacks))) problems.push(`CONTAINS ${JSON.stringify(f.lacks)}`);
    if (SHOW) problems.push(`[${text.slice(0, 90)}]`);
  }

  const label = `${site.padEnd(30)} ${f.producer}`;
  if (!problems.length) { console.log(`  PASS  ${label}   ${f.has ?? f.lacks}`); continue; }
  failed++;
  console.log(`  FAIL  ${label}   ${problems.join(" · ")}`);
  console.log(`        ${f.why}`);
}

console.log();
console.log(failed === 0 ? "FIXTURES PASS" : `FIXTURES FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
