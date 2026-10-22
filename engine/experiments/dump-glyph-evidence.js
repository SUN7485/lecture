/**
 * The compact per-glyph evidence for ONE site, device beside structured text.
 *
 * This is the instrument to reach for when a repair regresses a block. Every
 * regression in this family has been diagnosed by putting the two streams side by
 * side at one x, and every one that was diagnosed any other way was diagnosed
 * wrongly — the `ي` bucket was read off a dump that "reads correctly" for a whole
 * session, because the word had two yehs and the dump was glanced at instead of
 * counted (KNOWN_ISSUES, the retraction).
 *
 * So this COUNTS. It prints the characters structured text attributes to each
 * device glyph by advance span, and the deficit that follows, rather than leaving
 * the reader to eyeball a sorted list.
 *
 *   node experiments/dump-glyph-evidence.js Chp1-Lec2-1(New) 20 --y 93
 *   node experiments/dump-glyph-evidence.js Chp3-Lec19 2 --y 92.3 --x 480,560
 *
 * `page` is 1-based. `--y` picks the baseline band (default: every baseline).
 * `--x` narrows to an x window. `--band` widens the y tolerance (default 8pt,
 * which is deliberately generous: structured text puts a mark-carrying base on
 * its MARK's baseline, 7.6pt off the line, and a tight band is exactly how the
 * shipped repairs come to invent a deficit).
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, stextGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { deviceGlyphs, proposeLigatures, proposeTanweenAlef, proposeCollidedAlef } from "../src/extract/ligatures.js";
import { resolveProposals } from "../src/extract/resolve.js";
import { attributePage } from "../src/extract/attribute.js";
import { isCombiningMark } from "../src/extract/bidi.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { findPairs } from "../src/truth/corpus.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const [deckArg, pageArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!deckArg || !pageArg) {
  console.error("usage: node experiments/dump-glyph-evidence.js <deck> <page1based> [--y N] [--x a,b] [--band N]");
  process.exit(2);
}
const PAGE = Number(pageArg) - 1;
const Y = arg("y", null) == null ? null : Number(arg("y"));
const BAND = Number(arg("band", 8));
const XWIN = arg("x", null)?.split(",").map(Number) ?? null;

const pair = findPairs().find((p) => p.name === deckArg);
if (!pair) { console.error(`no such deck: ${deckArg}`); process.exit(2); }

const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
const arity = ligatureArity(doc.asPDF());
const page = doc.loadPage(PAGE);
const devs = deviceGlyphs(page, arity);
// TWO views of structured text, and keeping them apart is the point of this file.
// `raw` is what the repairs are handed — no `isMark`, no groups, nothing put back.
// `grouped` is the finished stream, which is where flags like `recovered` live.
// The first version of this dump derived its own attribution from `grouped` and
// therefore reported a deficit production could not see; the budget below now
// comes from the production module, on the production input.
const raw = stextGlyphs(page);
const budget = attributePage(raw, devs);
const glyphs = extractGlyphs(page, arity);

/** A whitespace device glyph. Its debt is a space, and stext supplies spaces. */
const isSpace = (d) => d.unicode === 0x20 || d.unicode === 0xa0;

const inY = (y) => Y == null || Math.abs(y - Y) <= BAND;
const inX = (x) => !XWIN || (x >= XWIN[0] && x <= XWIN[1]);
const keep = (g) => inY(g.y) && inX(g.x);

const dev = devs.filter(keep).sort((a, b) => a.x - b.x);
const st = [...glyphs].filter(keep).sort((a, b) => a.x - b.x);

console.log(`${pair.name} p${PAGE + 1}   y band ${Y == null ? "ALL" : `${Y} +/- ${BAND}`}${XWIN ? `   x ${XWIN[0]}..${XWIN[1]}` : ""}`);
console.log(`REPAIR_ORDER=${process.env.REPAIR_ORDER ?? "shipped"}`);

console.log(`\nBLOCKS overlapping this band`);
for (const b of buildLines(extractGlyphs(page, arity))) {
  if (!inY(b.y)) continue;
  console.log(`  y=${b.y.toFixed(1)} x1=${b.x1.toFixed(1)} n=${b.glyphs.length}  ${blockText(b, blockIsRtl(b)).slice(0, 96)}`);
}

// ATTRIBUTION comes from `src/extract/attribute.js`, on the RAW stream.
//
// This file used to re-derive it, and the two models disagreed in a way that made
// the instrument useless exactly when it was needed: production reads a stream
// where `isMark` is not set yet, counted every combining mark as a supplied base
// letter, and starved the tanween repair on 199 blocks — while this dump, reading
// the grouped stream, showed the correct deficit and looked like a clean bill of
// health. An instrument that computes its own answer will eventually compute a
// different one (EVO-028). It now asks the same module the repairs ask.
const inWindow = (d) => inY(d.y) && inX(d.x);

console.log(`\nDEVICE glyphs, with the characters they own (half-open advance span)`);
console.log(`   ${"x".padStart(8)} ${"adv".padStart(6)} ${"y".padStart(7)}  ${"uni".padStart(6)} ${"gid".padStart(5)} owed  parts        owns        word deficit`);
for (const d of dev) {
  const mine = budget.charsOf(d);
  const chars = mine.map((g) => `${g.c === " " ? "␠" : g.c}${isCombiningMark(g.c) ? "̣" : ""}`).join("");
  const deficit = budget.deficitOf(d);
  console.log(`   ${d.x.toFixed(2).padStart(8)} ${d.advance.toFixed(2).padStart(6)} ${d.y.toFixed(2).padStart(7)}` +
    `  ${(d.unicode > 0 ? "U+" + d.unicode.toString(16).toUpperCase().padStart(4, "0") : "-").padStart(6)}` +
    ` ${String(d.glyph).padStart(5)} ${String(d.owed ?? 1).padStart(4)}  ${(d.parts?.join("") ?? (d.fromFont ? "named" : "-")).padEnd(12)}` +
    ` ${chars.padEnd(11)} ${deficit || ""}`);
}

// THE BUDGET IS PER WORD. Structured text's x positions are unreliable at exactly
// the collision sites this family is about, so a per-GLYPH deficit is noise: at
// the بُني site glyph 619 (owes 2) owns one character while glyph 783 (owes 1)
// owns two — a deficit of 1 beside a surplus of 1, where the word owes 3 and got
// 3. Summed over the word it is 0, which is the answer.
console.log(`\nWORDS touching this window — the unit the deficit budget is computed on`);
let bandDeficit = 0;
for (const w of budget.words) {
  if (!w.devs.some(inWindow)) continue;
  bandDeficit += w.deficit;
  const last = w.devs[w.devs.length - 1];
  console.log(`   x ${w.devs[0].x.toFixed(2)}..${(last.x + Math.max(last.advance, 0)).toFixed(2)}` +
    ` y ${w.devs[0].y.toFixed(2)}  glyphs ${String(w.devs.length).padStart(2)}` +
    `  owed ${String(w.owed).padStart(2)}  supplied ${String(w.supplied).padStart(2)}` +
    `  ${w.deficit ? `DEFICIT ${w.deficit}` : "ok      "}  ${w.chars.map((g) => g.c + (Math.abs(g.y - w.devs[0].y) > 1 ? `(y${g.y.toFixed(0)})` : "")).join("")}`);
}
console.log(`   deficit over this window, BY WORD: ${bandDeficit}`);

// The RAW stream, with the owner attribution beside each character, then the
// GROUPED stream, which is the only place flags like `recovered` and `groupId`
// exist. Both, because a character can be present in the first and misfiled by
// the time it reaches the second — which is exactly how a mark-carrying base ends
// up in the wrong block.
const ownerIndex = new Map();
for (const d of devs) for (const g of budget.charsOf(d)) ownerIndex.set(g, d);

console.log(`\nRAW structured text, with its attributed owner`);
console.log(`   ${"x".padStart(8)} ${"y".padStart(7)}  c    owner        flags`);
for (const g of raw.filter((g) => inY(g.y) && inX(g.x)).sort((a, b) => a.x - b.x)) {
  const owner = ownerIndex.get(g);
  const flags = [isCombiningMark(g.c) && "mark", g.x1 - g.x0 < 0.5 && "zero-width"].filter(Boolean).join(" ");
  console.log(`   ${g.x.toFixed(2).padStart(8)} ${g.y.toFixed(2).padStart(7)}  ${g.c === " " ? "␠" : g.c}` +
    `    ${(owner ? `x=${owner.x.toFixed(2)} y=${owner.y.toFixed(1)}` : "UNOWNED").padEnd(22)} ${flags}`);
}

console.log(`\nGROUPED structured text (after the repairs and groupAtomicUnits)`);
console.log(`   ${"x".padStart(8)} ${"x0..x1".padStart(15)} ${"y".padStart(7)}  c    flags`);
for (const g of st) {
  const flags = [g.isMark && "mark", g.recovered && `recovered:${g.recoveredBy ?? "?"}`,
    g.x1 - g.x0 < 0.5 && "zero-width", g.groupId != null && `group ${g.groupId}`,
    g.advanceRestored && "advance-restored"].filter(Boolean).join(" ");
  console.log(`   ${g.x.toFixed(2).padStart(8)} ${`${g.x0.toFixed(2)}..${g.x1.toFixed(2)}`.padStart(15)} ${g.y.toFixed(2).padStart(7)}` +
    `  ${g.c === " " ? "␠" : g.c}    ${flags}`);
}

// PROPOSALS, with the resolver's verdict on each. "Why did my repair not fire"
// is the question this whole family generates, and before this existed the only
// way to answer it was to reason about gates in three files and be wrong.
console.log(`\nPROPOSALS and the resolver's verdict`);
{
  // From the SAME extractGlyphs run whose output is printed above. An earlier
  // version re-ran the producers and resolver here and reported ACCEPTED for a
  // proposal production had rejected — the second time in this work that an
  // instrument deriving its own answer derived a different one.
  const proposals = glyphs.proposals ?? [];
  const rejected = new Map((glyphs.rejectedProposals ?? []).map(([p, why]) => [p, why]));
  const here = proposals.filter((p) => inY(p.slotY) && inX(p.slotX));
  if (!here.length) console.log(`   none in this window (${proposals.length} on the page)`);
  for (const p of here.sort((a, b) => a.slotX - b.slotX)) {
    const why = rejected.get(p);
    console.log(`   ${p.producer.padEnd(9)} rank ${p.rank} funded ${p.funded !== false ? "y" : "n"}` +
      `  slot x=${p.slotX.toFixed(2)} y=${p.slotY.toFixed(2)}  +${JSON.stringify(p.glyph.c)}` +
      `  w=${(p.glyph.x1 - p.glyph.x0).toFixed(2)}  ${why ? `REJECTED: ${why}` : "ACCEPTED"}`);
  }
}

const ownedChars = new Set(devs.flatMap((d) => budget.charsOf(d)));
const unowned = raw.filter((g) => g.c.trim() && !ownedChars.has(g) && inY(g.y) && inX(g.x))
  .map((g) => ({ g, owner: null }));
const orphans = unowned.filter(({ g }) => g.c.trim());
if (orphans.length) {
  console.log(`\nCHARACTERS NO ADVANCE SPAN REACHES (${orphans.length}) — attribution gaps, not page losses`);
  for (const { g, owner } of orphans) {
    console.log(`   ${g.x.toFixed(2).padStart(8)}  ${g.c}${g.isMark ? " (mark)" : ""}` +
      `   nearest preceding origin ${owner ? owner.x.toFixed(2) : "none"}`);
  }
}
