/**
 * IS THE MISSING CHARACTER'S IDENTITY DETERMINED, OR WOULD RECOVERING IT MEAN
 * INVENTING ARABIC?
 *
 * `characters-missing` is the largest remaining damage class in the convergence
 * benchmark — 306 regions over 50 pages and 5 decks — and it ships with
 * `fixable: false` on this reasoning, quoted from web/doctor.js:
 *
 *   "It cannot be repaired automatically — that would mean inventing Arabic"
 *
 * That is a hypothesis about the data and it has never been measured. The same
 * sentence was written about `tanween-missing-alef` and was wrong: the repair
 * turned out to be 91 of 113 with nothing broken.
 *
 * The reason to doubt it here is one line in `deviceGlyphs`: every painted glyph
 * already carries `parts`, the components the font's own CFF charset names for
 * that glyph, and its own comment says the name "gives the COMPONENTS, not just
 * how many, so a repair can state what it inserts instead of guessing it". If
 * that holds at the flagged sites, the missing characters are DETERMINED by the
 * document and nothing is being invented.
 *
 * WHAT THIS MEASURES — it prices a repair, it does not perform one:
 *
 *   determined    every glyph on this baseline decomposes, by font name or by
 *                 presentation form, and the multiset the page painted minus the
 *                 multiset the text supplied has exactly `missing` members. A
 *                 repair would know what to insert.
 *   unnamed       a glyph on the line has no name and no codepoint. The count is
 *                 provable and the identity is not.
 *   inconsistent  the difference does not have `missing` members, so this probe
 *                 disagrees with production's own deficit and must not be read
 *                 as evidence for anything at that site.
 *
 * THE CONTROL IS THE POINT (EVO-039). The same expansion runs over every
 * UNFLAGGED block, and those must come out with an empty difference. If healthy
 * lines also look like they are missing characters, the expansion is measuring
 * its own bug and every number above it is fiction.
 *
 * Usage:
 *   node experiments/probe-missing-identity.js
 *   node experiments/probe-missing-identity.js --only powerpoint-2013
 *   node experiments/probe-missing-identity.js --samples 40
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import {
  extractGlyphs, buildLines, blockText, blockIsRtl, sourceEvidence,
  EVIDENCE_BASELINE, EVIDENCE_X_MARGIN,
} from "../src/extract/glyphs.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { release } from "../src/extract/mupdf-lifetime.js";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CORPUS = JSON.parse(fs.readFileSync(path.join(HERE, "benchmark/corpus.json"), "utf8"));
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };
const only = argOf("--only", null);
const SAMPLES = Number(argOf("--samples", 25));

/**
 * THE TWO PATHS DO NOT SPEAK THE SAME ALPHABET, and comparing them raw is the
 * first thing that goes wrong here.
 *
 * The device path reports what the font actually drew — an Arabic PRESENTATION
 * FORM, `ﺎ` U+FE8E — while structured text supplies the base character `ا`
 * U+0627. Compared literally, essentially every Arabic line looks like it is
 * missing all of its letters: the control caught this at 279 of 398 blocks on
 * the first run of this probe.
 *
 * NFKC is the mapping that already exists for exactly this: it folds every
 * presentation form onto its base, and decomposes the lam-alef ligatures into
 * their two characters, which is the same answer the font's own `parts` gives.
 */
const fold = (s) => s.normalize("NFKC");

/** The characters the page painted here, as far as the font is willing to say. */
function paintedChars(dev) {
  if (dev.parts?.length) return dev.parts.flatMap((p) => [...fold(p)]);
  if (dev.unicode > 0 && dev.unicode !== 0xfffd) return [...fold(String.fromCodePoint(dev.unicode))];
  return null;            // no name, no codepoint — the identity is not available
}

/**
 * WHY THIS LINE IS FLAGGED — and three of the four answers are not damage.
 *
 * `sourceEvidence` compares what the page PAINTED against what the text CARRIES
 * and calls any surplus a lost character. That is sound only where every painted
 * glyph is supposed to survive into the text, which is true of the 28 Chrome
 * decks the rule was measured on and false of three things in this corpus:
 *
 *   tatweel      U+0640 is justification elongation. `الشـعار` and `الشعار` are
 *                the same word; the page paints the kashida and the text is
 *                right not to carry it. Inserting it back would be damage.
 *   double-strike  a drop shadow paints the line TWICE. `dropDoubleStruck`
 *                deliberately removes the second copy, and the deficit then
 *                reports the copy it just removed as missing text.
 *   space        a painted space glyph the text expresses as a gap.
 *
 * Anything left over is a real lost character.
 */
const isTatweel = (c) => c === "ـ";
const isSpace = (c) => /\s/u.test(c);
/** The same predicate `sourceEvidence` uses, so both sides exclude one set. */
const isPaintOnlyChar = (c) => isTatweel(c) || isSpace(c);

function causeOf(diff, ev, supplied) {
  if (!diff.length) return "none";
  // An exact second copy: the page owes twice what the line supplies and the
  // surplus IS the line. Checked as a multiset so paint order cannot matter.
  if (ev.owed >= 2 * ev.supplied && diff.length === supplied.length &&
      surplus(diff, supplied).length === 0) return "double-strike";
  if (diff.every(isTatweel)) return "tatweel";
  if (diff.every(isSpace)) return "space";
  if (diff.every((c) => isTatweel(c) || isSpace(c))) return "tatweel+space";
  return "real";
}

/** Multiset difference: the members of `a` that `b` cannot account for. */
function surplus(a, b) {
  const have = new Map();
  for (const c of b) have.set(c, (have.get(c) ?? 0) + 1);
  const out = [];
  for (const c of a) {
    const n = have.get(c) ?? 0;
    if (n > 0) have.set(c, n - 1); else out.push(c);
  }
  return out;
}

const tally = {
  blocks: 0, flagged: 0,
  determined: 0, unnamed: 0, inconsistent: 0,
  charsDetermined: 0, charsFlagged: 0,
  controlBlocks: 0, controlDirty: 0,
};
const samples = [];
const byDeck = new Map();
/** What the missing characters actually ARE. The buckets cannot say this. */
const missingHist = new Map();
/** WHY each flag fired. This is the number that decides whether to repair. */
const causes = new Map();
const realSites = [];

for (const deck of CORPUS.decks.filter((d) => !only || d.id === only)) {
  if (!fs.existsSync(deck.path)) { console.error(`SKIP ${deck.id} — not on disk`); continue; }
  const doc = mupdf.Document.openDocument(fs.readFileSync(deck.path), "application/pdf");
  let arity = null;
  try { arity = ligatureArity(doc.asPDF?.()); } catch { /* not openable twice */ }
  const deckStat = { flagged: 0, determined: 0, unnamed: 0, inconsistent: 0, causes: new Map() };
  byDeck.set(deck.id, deckStat);

  for (let index = 0; index < doc.countPages(); index++) {
    const page = doc.loadPage(index);
    try {
      const glyphs = extractGlyphs(page, arity);
      const blocks = buildLines(glyphs);
      // Production's own call, argument for argument. A probe that omits the
      // shadow list measures the behaviour production no longer has (EVO-033).
      const evidence = sourceEvidence(blocks, glyphs.deviceGlyphs, (b) => blockText(b, blockIsRtl(b)),
        glyphs.shadowRowGlyphs);
      const devs = glyphs.deviceGlyphs ?? [];

      for (const b of blocks) {
        if (!b.glyphs?.length) continue;
        tally.blocks++;

        // The SAME window production uses, from production's own constants.
        const x0 = Math.min(...b.glyphs.map((g) => g.x0));
        const x1 = Math.max(...b.glyphs.map((g) => g.x1));
        const onLine = devs.filter((d) =>
          Math.abs(d.y - b.y) <= EVIDENCE_BASELINE &&
          d.x >= x0 - EVIDENCE_X_MARGIN && d.x <= x1 + EVIDENCE_X_MARGIN);

        // Mirror production: it no longer charges a line for a painted kashida
        // or space, so neither side of this comparison may count one either.
        const expanded = onLine.map(paintedChars);
        const anyUnnamed = expanded.some((e) => e === null);
        const painted = expanded.filter(Boolean).flat().filter((c) => !isPaintOnlyChar(c));
        const supplied = b.glyphs.flatMap((g) => [...fold(g.c ?? "")]).filter((c) => !isPaintOnlyChar(c));
        const diff = surplus(painted, supplied);

        const ev = evidence.get(b);
        if (!ev?.missing) {
          // CONTROL: a line production does not flag must not look damaged here.
          tally.controlBlocks++;
          if (diff.length) tally.controlDirty++;
          continue;
        }

        tally.flagged++; deckStat.flagged++;
        tally.charsFlagged += ev.missing;
        let verdict;
        if (anyUnnamed) verdict = "unnamed";
        else if (diff.length !== ev.missing) verdict = "inconsistent";
        else verdict = "determined";
        tally[verdict]++; deckStat[verdict]++;
        if (verdict === "determined") {
          tally.charsDetermined += ev.missing;
          for (const c of diff) missingHist.set(c, (missingHist.get(c) ?? 0) + 1);
        }

        const cause = verdict === "determined" ? causeOf(diff, ev, supplied) : verdict;
        causes.set(cause, (causes.get(cause) ?? 0) + 1);
        const dc = deckStat.causes;
        dc.set(cause, (dc.get(cause) ?? 0) + 1);
        if (cause === "real" && realSites.length < 30) {
          realSites.push({
            deck: deck.id, page: index + 1,
            got: blockText(b, blockIsRtl(b)).slice(0, 56),
            diff: diff.join(""), missing: ev.missing,
          });
        }

        if (samples.length < SAMPLES) {
          samples.push({
            deck: deck.id, page: index + 1, verdict,
            got: blockText(b, blockIsRtl(b)).slice(0, 60),
            owed: ev.owed, supplied: ev.supplied, missing: ev.missing,
            diff: diff.join(""),
            fromFont: onLine.filter((d) => d.fromFont).length,
            onLine: onLine.length,
          });
        }
      }
    } finally { release(page); }
  }
  release(doc);
  console.error(`  ${deck.id.padEnd(22)} flagged ${String(deckStat.flagged).padStart(4)}`);
}

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : "n/a");

console.log(`\nCHARACTERS-MISSING — IS THE IDENTITY DETERMINED?\n`);
console.log(`  blocks examined       ${tally.blocks}`);
console.log(`  flagged by production ${tally.flagged}`);
console.log(`  characters owed       ${tally.charsFlagged}\n`);
console.log(`  determined   ${String(tally.determined).padStart(5)}   ${pct(tally.determined, tally.flagged).padStart(6)}   ${tally.charsDetermined} characters`);
console.log(`  unnamed      ${String(tally.unnamed).padStart(5)}   ${pct(tally.unnamed, tally.flagged).padStart(6)}`);
console.log(`  inconsistent ${String(tally.inconsistent).padStart(5)}   ${pct(tally.inconsistent, tally.flagged).padStart(6)}`);

console.log(`\n  CONTROL — unflagged blocks whose expansion still shows a surplus`);
console.log(`  ${tally.controlDirty} of ${tally.controlBlocks}  (${pct(tally.controlDirty, tally.controlBlocks)})`);
console.log(`  A non-trivial number here invalidates every line above it.`);

console.log(`\n  per deck`);
for (const [id, s] of byDeck) {
  if (!s.flagged) continue;
  console.log(`  ${id.padEnd(22)} flagged ${String(s.flagged).padStart(4)}   determined ${String(s.determined).padStart(4)}   unnamed ${String(s.unnamed).padStart(4)}   inconsistent ${String(s.inconsistent).padStart(4)}`);
}

console.log(`\n  WHAT IS ACTUALLY MISSING — the character, not the count`);
const hist = [...missingHist.entries()].sort((a, b) => b[1] - a[1]);
const histTotal = hist.reduce((n, [, c]) => n + c, 0);
for (const [c, n] of hist.slice(0, 12)) {
  const cp = `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  console.log(`  ${JSON.stringify(c).padEnd(6)} ${cp.padEnd(8)} ${String(n).padStart(5)}   ${pct(n, histTotal)}`);
}

console.log(`\n  SITES — read these, do not trust the buckets (EVO-035)`);
for (const s of samples) {
  console.log(`  ${s.deck} p${s.page} [${s.verdict}] owed ${s.owed} supplied ${s.supplied} missing ${s.missing} fromFont ${s.fromFont}/${s.onLine}`);
  console.log(`     got  ${JSON.stringify(s.got)}`);
  console.log(`     diff ${JSON.stringify(s.diff)}`);
}

console.log("\n  WHY EACH FLAG FIRED — the question the class name cannot answer");
const causeRows = [...causes.entries()].sort((a, b) => b[1] - a[1]);
for (const [c, n] of causeRows) {
  console.log("  " + c.padEnd(16) + String(n).padStart(5) + "   " + pct(n, tally.flagged).padStart(6));
}
const benign = causeRows.filter(([c]) => c !== "real").reduce((n, [, v]) => n + v, 0);
console.log("  ".padEnd(2) + "-".repeat(40));
console.log("  not damage      " + String(benign).padStart(5) + "   " + pct(benign, tally.flagged).padStart(6));
console.log("  real loss       " + String(causes.get("real") ?? 0).padStart(5) + "   " + pct(causes.get("real") ?? 0, tally.flagged).padStart(6));

console.log("\n  per deck, by cause");
for (const [id, s2] of byDeck) {
  if (!s2.flagged) continue;
  const parts = [...s2.causes.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => c + " " + n).join("  ");
  console.log("  " + id.padEnd(22) + parts);
}

console.log("\n  THE REAL ONES — every site the three benign causes do not explain");
for (const s3 of realSites) {
  console.log("  " + s3.deck + " p" + s3.page + "  missing " + s3.missing + "  diff " + JSON.stringify(s3.diff));
  console.log("     " + JSON.stringify(s3.got));
}
