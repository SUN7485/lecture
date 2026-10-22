/**
 * Glyph-level extraction from a native PDF page.
 *
 * MEASURED CONTEXT (Chp1-Lec6-2.pdf, 21pp, Chromium-produced):
 * MuPDF reports one stext "line" per glyph because every Arabic glyph is
 * positioned individually by the producer. Its line/block grouping is
 * therefore useless and we rebuild lines from baseline geometry instead.
 */
import { visualToLogical, textIsRtl, isCombiningMark } from "./bidi.js";
import { deviceGlyphs, proposeLigatures, proposeTanweenAlef, proposeCollidedAlef, proposeMarkedBase, owedOf } from "./ligatures.js";
import { attributePage } from "./attribute.js";
import { resolveProposals } from "./resolve.js";
import { release } from "./mupdf-lifetime.js";
// import { buildAdvanceTable, repairBlock } from "./repair.js"; // see note in buildLines

/** Baselines within this fraction of font size belong to one line. */
const BASELINE_TOL = 0.4;
/**
 * The baseline a glyph is FILED on: the one the device painted it at, falling
 * back to what structured text reported.
 *
 * These disagree, and the disagreement is a defect class of its own. A shadda or
 * damma raises the reported origin — measured at 10.8 and 11.9pt on `Chp1-Lec6-2`
 * p11, where `ذ` and `ت` claim y=81 while the device paints their glyphs at y=93
 * — so the row grouping files them as a line of their own and whole words end up
 * stranded above the line they belong to. `mergeOrphanFragments` cannot reach
 * those: it rescues slivers under 2pt and these are words wide.
 *
 * The earlier reading of this, in KNOWN_ISSUES, was that `buildLines` should use
 * the pen ORIGIN rather than the raised ink bbox. It already did — it has only
 * ever grouped on `g.y`, which IS the origin, and the bbox is never consulted for
 * row assignment. The origin itself is what is raised, so the fix has to come
 * from the other stream.
 */
const baselineOf = (g) => g.baselineY ?? g.y;
/**
 * Horizontal gap (x font size) above which a word break is inserted.
 *
 * MEASURED on one page, two distinct regimes:
 *   - normal text: intra-word gaps 0.00pt, word gaps 3.15pt @13.5 / 4.74pt @30
 *   - letter-spaced text (CSS letter-spacing): intra-word 1.50pt @18pt,
 *     word gap 7.19pt
 * As a fraction of font size that is intra-word <= 0.083 and word >= 0.158,
 * so 0.12 separates both regimes with margin on either side.
 */
/** Narrower than this carries no advance: stext reports a mark's base this way. */
const ZERO_ADVANCE = 0.5;
/**
 * Two reports of the same character this close together are one glyph painted
 * twice (a drop shadow, or a double strike faking bold). A genuinely repeated
 * letter is one ADVANCE apart — 5 to 18pt at the sizes measured — while the
 * shadow offsets measured on a Distiller export ran 0.10 to 0.59pt, so the two
 * populations are an order of magnitude apart and this is not a tuned threshold.
 */
const SHADOW_EPS = 0.75;
/**
 * How far a shadow may fall, as a share of the type size.
 *
 * A flat 1.2pt was the first version and it was wrong in BOTH directions. It missed
 * a table whose shadow falls 3.12pt (0.342 em at 9.12pt type), and it deleted real
 * lines on a brand guide whose two mockups happen to sit 0.46pt apart. Measured
 * over every adjacent pair of baselines carrying an identical 8+ glyph sequence,
 * across the 28-deck corpus (which has ZERO such pairs) and four foreign decks:
 *
 *   shadows          0.024 .. 0.343 em      Feasibility, headings and one table
 *   real second line 0.105 .. 1.593 em      MiM, a stack of identical specimen lines
 *
 * The two populations OVERLAP on dy, so dy alone cannot decide and no threshold on
 * it is honest. See SHADOW_DIAGONAL for the one that can. This bound only stops the
 * diagonal test from reaching a line a whole line-height away.
 */
const SHADOW_ROW_MAX_EM = 0.5;
/**
 * A DROP SHADOW IS A DIAGONAL OFFSET. A SECOND LINE IS NOT.
 *
 * This is the discriminator dy could not give, and unlike dy the two populations
 * are an order of magnitude apart — measured as the largest |dx| between the two
 * rows' corresponding glyphs:
 *
 *   shadow            |dx| 0.01 .. 3.14pt   =  0.001 .. 0.344 em
 *   real second line  |dx| EXACTLY 0.00     a stack set from one left margin
 *                     |dx| 128 .. 418pt     =  26 .. 130 em, two objects that
 *                                              merely share a baseline
 *
 * A factor of SEVENTY-FIVE between the two, against an overlap on dy — so the same
 * half-em bound serves both axes and a shadow is simply "an offset of less than
 * half an em in each direction". `dx == 0` is deliberately excluded: a purely
 * vertical double strike is indistinguishable from a second line, and leaving
 * doubled text visible is a far cheaper failure than silently deleting a line.
 *
 * A RATIO WAS TRIED FIRST AND IS WRONG. `dx <= 2 * dy` re-doubled four headings
 * whose shadow falls (0.72, 0.24) — a 3:1 diagonal, not the 45° the table uses.
 * The offset's SHAPE varies between producers; its SIZE relative to the type does
 * not.
 */
/** Rows shorter than this can match by coincidence and are never treated as a shadow. */
const SHADOW_ROW_MIN = 8;
const SPACE_GAP = 0.12;
/**
 * A gap this much of the font size cannot be explained by ONE hidden advance, so a
 * zero-width glyph beside it is not evidence against a word space. Measured plateau:
 * 0.35 to 0.55 all recover 15 of 17 PowerPoint spaces and change 0 of 1679 Chrome ones.
 */
const WIDE_GAP = 0.45;
/** Horizontal gap (x font size) above which glyphs are separate text blocks. */
// LOWERED 2.0 -> 1.25 on 2026-08-19. At 2.0 the four x-axis tick labels of a
// chart merged into one block ("100 200 300 *Q=400"), whose text then rendered
// far narrower than the box the source measured, so the numbers sat nowhere near
// their tick marks. Their gap is 1.33 ems; 600 and 800, at 4.1, split correctly.
// Measured over the whole corpus before keeping it: delivered 98.49% -> 98.57%,
// every chapter improved or held, and the set diff is 9 FIXED / 0 BROKEN.
const BLOCK_GAP = 1.25;
/** Tolerance (pt) for "this glyph sits exactly where the previous one ended". */
const LIGATURE_EPS = 0.5;
/** Arabic nunation. It marks the END of a word, never the beginning. */
const isTanween = (ch) => /[\u064B-\u064D]/.test(ch);
/** How close to the line-start edge a mark must be to count as past it (pt). */
const ORPHAN_EPS = 0.01;
/** Max origin-x distance (pt) from a combining mark to its base letter. */
const MARK_EPS = 1.5;
/** The four alef forms that combine with lam into a mandatory ligature. */
const LAM_ALEF_PARTNERS = new Set(["ا", "أ", "إ", "آ"]);
const LAM = "ل";
/** Lam-alef components sit within this distance (pt) of each other. */
const LAM_ALEF_EPS = 1.0;
/** Re-exported: this module was where every caller learned to look for it. */
export { isCombiningMark };

/** Fewer characters than this is not a line, it is a mark. */
const TAG_TEXT_MIN = 2;
/** Origins this close are one point; advances this small are none. */
const TAG_TEXT_EPS = 0.01;
/** Glyphs within this vertical distance (pt) share a baseline — house tolerance. */
const TAG_TEXT_BASELINE = 0.6;
/** How far past a painted glyph's own advance still counts as its edge (pt). */
const TAG_TEXT_REACH = 0.6;

/** Classify whole degenerate structured-text lines using painted device evidence. */
export function classifyUnpaintedTagText(glyphs, devs) {
  const lines = new Map();
  for (const g of glyphs) {
    if (g.lineSeq == null) continue;
    const row = lines.get(g.lineSeq);
    if (row) row.push(g); else lines.set(g.lineSeq, [g]);
  }

  const drop = new Set();
  const sites = [];
  let candidates = 0;
  let kept = 0;
  for (const row of lines.values()) {
    if (row.length < TAG_TEXT_MIN) continue;
    const a = row[0];
    if (!row.every((g) => Math.abs(g.x - a.x) < TAG_TEXT_EPS && Math.abs(g.y - a.y) < TAG_TEXT_EPS)) continue;
    if (!row.every((g) => g.x1 - g.x0 < TAG_TEXT_EPS)) continue;
    candidates++;
    // Does anything the page actually painted reach this origin, on this line?
    if (devs.some((d) => Math.abs(d.y - a.y) < TAG_TEXT_BASELINE &&
                         a.x >= d.x - TAG_TEXT_REACH &&
                         a.x <= d.x + (d.advance || 0) + TAG_TEXT_REACH)) {
      kept++;
      continue;
    }
    for (const g of row) drop.add(g);
    sites.push({ text: row.map((g) => g.c).join(""), x: a.x, y: a.y, size: a.size });
  }

  return { candidates, kept, dropped: candidates - kept, drop, sites };
}

/**
 * The raw structured-text walk, before any repair or grouping.
 *
 * Exported so a diagnostic can see EXACTLY what the repairs are handed. When
 * `experiments/dump-glyph-evidence.js` re-implemented this walk it read the
 * post-grouping stream instead, which set `isMark` — so the dump reported a
 * deficit the production code could not see, and a 199-block regression looked
 * correct in the instrument built to catch it. One walk, one truth.
 */
/**
 * Snap a baseline angle to the nearest right angle, in degrees.
 *
 * Returns 0 for anything within a degree of horizontal, so every existing
 * caller sees exactly what it saw before and the rotated path below cannot be
 * entered by rasterisation noise.
 */
function snapAngle(radians) {
  const deg = (radians * 180) / Math.PI;
  const snapped = Math.round(deg / 90) * 90;
  if (Math.abs(deg - snapped) > 1) return 0;   // off-axis: treat as upright
  return ((snapped % 360) + 360) % 360 === 0 ? 0 : snapped;
}

export function stextGlyphs(page) {
  // `inhibit-spaces` stops MuPDF inventing a space wherever it sees a large TJ
  // position adjustment. Inside shaped Arabic that misfires and splits words
  // (measured: 13 invented spaces on page 2 alone). What survives is only the
  // real U+0020 glyphs from the content stream, which we can trust.
  const stext = page.toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces");
  const glyphs = [];
  let seq = 0;
  // MuPDF's own line grouping, recorded and not used for layout — `buildLines`
  // rebuilds lines from baseline geometry and that stays the truth. This is
  // carried for exactly one question a per-glyph view cannot answer: is the
  // WHOLE of what MuPDF called a line degenerate? See `dropUnpaintedTagText`.
  let lineSeq = -1;

  try {
    stext.walk({
      beginLine() { lineSeq++; },
      onChar(c, origin, font, size, quad, color, bidi) {
        try {
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          const fontName = font.getName();
          glyphs.push({
            c,
            paintSeq: seq++,          // preserved: paint order is evidence OCR cannot have
            lineSeq,                  // MuPDF's grouping, for the degeneracy test only
            x: origin[0],
            y: origin[1],
            // The glyph's BASELINE DIRECTION, straight off the quad we already
            // read. `quad` is [ul, ur, ll, lr]; for upright text ul->ur is
            // horizontal, and for a rotated chart axis label it is not. Taking
            // min/max of the corners (below) collapses that rectangle to an
            // axis-aligned box and throws the angle away — which is why a
            // rotated caption arrived as a column of one-glyph lines drawn on
            // top of one another. Snapped to the right angles: no page in this
            // corpus paints text off-axis, and a snapped value keeps the
            // grouping exact. Measured: 42 rotated glyphs in 603896, all -90.
            rot: snapAngle(Math.atan2(quad[3] - quad[1], quad[2] - quad[0])),
            font: fontName,
            family: fontName.replace(/^[A-Z]{6}\+/, ""),
            size,
            color,
            mupdfBidi: bidi,          // recorded for forensics; not trusted for ordering
            x0: Math.min(...xs), x1: Math.max(...xs),
            y0: Math.min(...ys), y1: Math.max(...ys),
          });
        } finally {
          release(font);
        }
      },
    });
  } finally {
    release(stext);
  }

  return glyphs;
}

/** Pull every glyph off a page with its full geometric and style evidence. */
export function extractGlyphs(page, arity) {
  // A page may paint its text twice — a drop shadow, or a double strike faking
  // bold — and `buildLines` merges the two strikes onto one row. Remove the copy
  // underneath before anything else reads the stream.
  const struck = dropDoubleStruck(stextGlyphs(page));
  let glyphs = struck.glyphs;

  // A lam-alef ligature is one painted glyph standing for two characters, and
  // stext drops one of them wherever a real glyph collides with the ligature's
  // tail position. The device path knows the glyph's true identity, so the lost
  // character is recovered from the document's own evidence, never inferred.
  // Count-gated: baselines that are not short are untouched. See ligatures.js.
  // A tanween whose alef vanished is the same class of loss at a different site,
  // and the device path names that alef too. Both repairs share one device walk.
  // A standalone alef that collided with a ligature's tail is a third site of
  // the same loss, and the only one that survives a font with no usable cmap.
/**
 * Put back the 0x10000 structured text drops from an astral codepoint.
 *
 * MEASURED, `Chp4-Lec29-1` p10. The PDF is CORRECT — its ToUnicode says
 * `<A1> <D83EDD41>`, the UTF-16 surrogate pair for U+1F941 DRUM — and MuPDF
 * combines the pair but omits the offset that turns a surrogate index into a
 * codepoint:
 *
 *   ((0xD83E & 0x3FF) << 10) | (0xDD41 & 0x3FF)  =  0xF941      what stext gives
 *   + 0x10000                                    =  0x1F941     what it is
 *
 * 0xF941 is in CJK Compatibility Ideographs, so a drum emoji shipped on the
 * slide as 論. The other two on that page were 🛡 -> a Private Use character
 * (invisible, leaving a bare variation selector) and 🪢 -> 甆.
 *
 * The DEVICE walk has it right — U+1F941 — so nothing is inferred here and no
 * range is guessed at: a stext character is corrected only where the device
 * glyph at the SAME POSITION reports exactly that character plus the missing
 * offset. Anything else is left alone.
 */
const ASTRAL_OFFSET = 0x10000;
/** Two reports describe the same glyph within this distance (pt). */
const ASTRAL_SAME_POS = 0.6;

/** The four alef forms a lam can ligate with. */
const ALEF_FORMS = new Set(["ا", "أ", "إ", "آ"]);
const LAM = "ل";
/** Two reports describe one cluster within this distance (pt). */
const CLUSTER_EPS = 0.6;

/**
 * Inside a proven lam-alef cluster, the DEVICE's glyph order outranks stext's.
 *
 * MEASURED on 273 authored cases exported by PowerPoint (`experiments/synth/`),
 * over the 133 that neither MuPDF nor any shipped repair gets right:
 *
 *   lam+alef adjacent pairs in DEVICE order      214, across 133 of 133 cases
 *     device order is LAM then ALEF              214/214   the correct logical order
 *     painted at the SAME x                      140/214
 *     alef carries gid -1                        140/214
 *   glyphs naming themselves a presentation form   0/133
 *
 * Two things follow. The Chrome route does not apply here — no glyph says "I am
 * U+FEFB", which is how that path decomposes a ligature without parsing a font. And
 * the order is not lost: the page paints the cluster correctly every single time and
 * structured text hands it back reversed. So this is not a new repair inventing a
 * character; it is a decision about WHICH EVIDENCE WE ALREADY COLLECT to believe.
 *
 * THE TRIGGER IS DELIBERATELY NARROW. "Whenever the device says lam then alef" would
 * reorder legitimate neighbouring characters — a lam ending one word beside an alef
 * starting the next is not a ligature. All four conditions must hold:
 *
 *   1 structured text has an ALEF form immediately followed by a LAM   (reversed)
 *   2 one of the two carries NO ADVANCE — the ligature partner's signature
 *   3 they are geometrically contiguous, so they are one cluster and not neighbours
 *   4 the device reports LAM immediately followed by that ALEF at the lam's own x
 *
 * Anything short of all four is refused and counted, so the remainder stays
 * inspectable rather than silently absorbed.
 */
function restoreLamAlefOrder(glyphs, devs) {
  const stats = { applied: 0, refused: new Map(), sites: [] };
  const refuse = (why) => stats.refused.set(why, (stats.refused.get(why) ?? 0) + 1);
  if (!devs?.length) return stats;

  const charOf = (d) => (d.unicode != null ? String.fromCodePoint(d.unicode) : "");

  for (let i = 0; i + 1 < glyphs.length; i++) {
    const a = glyphs[i], b = glyphs[i + 1];
    // 1. stext must be saying ALEF -> LAM. A cluster already in the right order is
    //    not a candidate and must never be touched.
    if (!ALEF_FORMS.has(a.c) || b.c !== LAM) continue;

    // 2. one of the pair carries no advance: the ligature is painted as a single
    //    glyph and its partner is reported at zero width.
    const zeroPartner = (a.x1 - a.x0) < ZERO_ADVANCE || (b.x1 - b.x0) < ZERO_ADVANCE;
    if (!zeroPartner) { refuse("no zero-advance partner"); continue; }

    // 3. one cluster, not two neighbouring letters.
    const contiguous = Math.abs(a.x0 - b.x1) < CLUSTER_EPS || Math.abs(a.x0 - b.x0) < CLUSTER_EPS;
    if (!contiguous) { refuse("not contiguous"); continue; }

    // 4. the device's own sequence at this position.
    const j = devs.findIndex((d) => charOf(d) === LAM &&
      Math.abs(d.x - b.x0) < CLUSTER_EPS && Math.abs((d.y ?? b.y) - b.y) < CLUSTER_EPS);
    if (j < 0) { refuse("device has no lam at this position"); continue; }
    if (!ALEF_FORMS.has(charOf(devs[j + 1] ?? {}))) { refuse("device does not follow the lam with an alef"); continue; }

    // SWAPPING THE STREAM IS NOT ENOUGH — `buildLines` re-sorts by x, and the
    // zero-advance alef sits at the lam's RIGHT edge, so a descending-x read puts
    // it first again and the swap is undone. Measured: extraction returned the
    // correct order and `blockText` still produced the reversed one.
    //
    // The partner carries NO ADVANCE, so its x is not a position on the page — it
    // is where structured text happened to report a glyph that paints nothing of
    // its own. Moving it to just inside the lam's own origin makes every later
    // stage read the cluster in the order the device painted it, without touching
    // any character or any glyph that has real ink.
    const zeroIsAlef = (a.x1 - a.x0) < ZERO_ADVANCE;
    if (zeroIsAlef) { a.x = a.x0 = a.x1 = b.x0 - CLUSTER_EPS / 6; }
    else { b.x = b.x0 = b.x1 = a.x0 - CLUSTER_EPS / 6; }
    glyphs[i] = b;
    glyphs[i + 1] = a;
    b.deviceOrdered = true;            // declared, never silent
    a.deviceOrdered = true;
    stats.applied++;
    if (stats.sites.length < 20) stats.sites.push(`${b.c}${a.c}@${b.x0.toFixed(1)}`);
  }
  return stats;
}

/**
 * One glyph painted twice at the same place is ONE character, not two.
 *
 * MEASURED on an Acrobat Distiller export of a PowerPoint deck, where every heading
 * came back with every letter doubled:
 *
 *     RAW structured text   "The Feasibility Study -- 3 Dimensions of Feasibility"
 *     our reconstruction    "DDiimmeennssiioonnss ooff FFeeaassiibbiilliittyy"
 *
 * The page paints the text TWICE with a small diagonal offset — a drop shadow, or a
 * double strike faking bold — as two separate runs:
 *
 *     "D" x0 194.18  y 137.98  seq 147     the real text, painted last, on top
 *     "D" x0 194.90  y 138.70  seq 122     the shadow, painted first, behind
 *
 * The two strikes sit 0.72pt apart in both axes, `buildLines` groups baselines that
 * close onto one row, and the block ends up holding both copies interleaved. The
 * text is not wrong in the evidence — MuPDF has it right — so this is our own
 * merge, and the delivered heading was also twice as wide as its box, which is how
 * the delivery instrument found it.
 *
 * THE TEST IS UNAMBIGUOUS AND NEEDS NO THRESHOLD TUNING. Two glyphs of the SAME
 * character, on the same row, whose origins differ by a fraction of a point cannot
 * be two letters: a real repeated letter is one advance apart, which at these sizes
 * is 5 to 18pt, while the measured shadow offsets here run 0.10 to 0.59pt. The gap
 * between the two populations is an order of magnitude, so `SHADOW_EPS` is not
 * doing delicate work.
 *
 * The LAST painted copy is kept, because that is the one drawn on top and therefore
 * the one the reader sees; the shadow behind it is discarded.
 */
/**
 * TWO BASELINES CARRYING THE SAME TEXT ARE ONE LINE STRUCK TWICE.
 *
 * The per-glyph test below catches a shadow whose offset is constant. It is not,
 * quite: the two strikes are laid out with very slightly different letter spacing,
 * so the horizontal offset DRIFTS along the line while the vertical one does not.
 * Measured on `VII. The Feasibility Study`:
 *
 *     dy   0.72 for every glyph
 *     dx   0.72 0.69 0.66 ... 0.01 -0.02 ... -0.46
 *
 * A per-glyph window therefore matches the head of a line and loses its tail, which
 * is exactly what the surviving blocks looked like — `What is a Feasibiilliittyy
 * SSttuuddyy??`, clean at the start and doubled at the end.
 *
 * At ROW level there is no threshold to drift. Two baselines within a point of each
 * other carrying the SAME character sequence are one line painted twice; two
 * different lines never spell the same string a fraction of a point apart. The row
 * painted LAST is kept, because that is the one on top.
 */

function dropDoubleStruckRows(glyphs) {
  const rows = new Map();
  for (const g of glyphs) {
    const k = g.y.toFixed(2);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(g);
  }
  const ys = [...rows.keys()].map(Number).sort((a, b) => a - b);
  const drop = new Set();

  for (let i = 1; i < ys.length; i++) {
    const dy = ys[i] - ys[i - 1];
    const A = rows.get(ys[i - 1].toFixed(2)), B = rows.get(ys[i].toFixed(2));
    // A SHORT row matching another is coincidence — two table cells reading "5",
    // two labels reading "OK". A long one is not: the odds of two independent
    // baselines a point apart spelling the same eight characters are nil. Measured:
    // at a minimum of 2 this dropped 94 delivered corpus blocks.
    if (!A || !B || A.length !== B.length || A.length < SHADOW_ROW_MIN) continue;
    const size = Math.max(...A.map((g) => g.size ?? 0), ...B.map((g) => g.size ?? 0));
    if (!(size > 0) || dy > SHADOW_ROW_MAX_EM * size) continue;
    const sa = [...A].sort((p, q) => p.x0 - q.x0), sb = [...B].sort((p, q) => p.x0 - q.x0);
    if (sa.map((g) => g.c).join("") !== sb.map((g) => g.c).join("")) continue;
    // The offset must be DIAGONAL. Two rows spelling the same string with no
    // horizontal offset at all are a stack of identical lines, and two 139pt apart
    // are two different objects that happen to share a baseline — neither is a
    // shadow, and dropping either deletes a real line of the document.
    const dx = Math.max(...sa.map((g, k) => Math.abs(sb[k].x0 - g.x0)));
    if (!(dx > 0) || dx > SHADOW_ROW_MAX_EM * size) continue;
    // Same text, same count, a small diagonal offset: one strike is a shadow of
    // the other. Keep whichever was painted last.
    const seqA = Math.max(...A.map((g) => g.paintSeq ?? 0));
    const seqB = Math.max(...B.map((g) => g.paintSeq ?? 0));
    for (const g of (seqA >= seqB ? B : A)) drop.add(g);
  }
  return drop;
}

function dropDoubleStruck(glyphs) {
  // Rows first: that test needs no threshold and survives the drift. The per-glyph
  // pass then takes any residue it could not see, such as a shadow that covers only
  // part of a line or a row whose two strikes differ by one glyph.
  const rowDrop = dropDoubleStruckRows(glyphs);
  const drop = new Set(rowDrop);
  // Compare against a small window of neighbours in x rather than all pairs: the
  // duplicate is always within a fraction of a point, so it is always adjacent
  // once sorted, and this stays linear on a page with 100k glyphs.
  const byX = [...glyphs].sort((a, b) => a.x0 - b.x0 || a.y - b.y);
  for (let i = 0; i < byX.length; i++) {
    const a = byX[i];
    if (drop.has(a)) continue;
    for (let j = i + 1; j < byX.length && byX[j].x0 - a.x0 <= SHADOW_EPS; j++) {
      const b = byX[j];
      if (drop.has(b) || b.c !== a.c) continue;
      if (Math.abs(b.y - a.y) > SHADOW_EPS) continue;
      // Keep whichever was painted LAST; that copy is on top.
      drop.add((a.paintSeq ?? 0) >= (b.paintSeq ?? 0) ? b : a);
    }
  }
  // WHICH glyphs the ROW pass removed, not just how many. `sourceEvidence`
  // compares what the page PAINTED against what the text CARRIES, and a shadow
  // strike is painted and then deliberately not carried — so without this list
  // the deficit charges the line for the copy this function just deleted.
  // Measured on `Feasibility.pdf`, whose every heading is painted twice:
  //
  //   distiller-mac p1  owed 52  supplied 26  missing 26
  //     got  "VII. The Feasibility Study"
  //     diff "VII. The Feasibility Study"     <- the surplus IS the line
  //
  // All 30 of that deck's `characters-missing` flags were its own drop shadow,
  // on lines whose extracted text is correct.
  //
  // ONLY THE ROW PASS IS REPORTED, AND THAT LIMIT IS THE WHOLE POINT. The row
  // test needs no threshold: same glyph count, identical string, a diagonal
  // offset under an em. The per-glyph residue below is a heuristic on two
  // coincident identical characters, and it can delete a REAL one — on the
  // InDesign guide it removes a ligature component, which is precisely what the
  // deficit then detects. Excusing that drop made the gate blind to the defect
  // the extractor had just created: 3 dropped glyphs on p2 suppressed exactly
  // the page's 3 genuine flags. A suppression may only be as confident as the
  // evidence behind it, so the loose pass gets no vote here.
  if (!drop.size) return { dropped: 0, glyphs, shadowRowGlyphs: [] };
  return { dropped: drop.size, glyphs: glyphs.filter((g) => !drop.has(g)), shadowRowGlyphs: [...rowDrop] };
}

/**
 * A TAGGED PDF'S /ActualText IS METADATA, AND METADATA IS NOT INK.
 *
 * MEASURED, `Presentation 7 (MH).pdf` (PowerPoint 2013's own export). Where a
 * title carries a text effect PowerPoint cannot express in PDF, it rasterises
 * the effect, wraps the picture in a marked-content span, and hangs the logical
 * string off the structure tree so the page stays searchable:
 *
 *   /P <</MCID 8/Lang (en-CA)>> BDC  q  369.48 0 0 95.76 91.44 369.36 cm
 *   /Image65 Do  Q  EMC
 *   1512 0 obj <</Type/StructElem/S/Span/ActualText(Material Handling)/K[8]>>
 *
 * There is no text-showing operator anywhere in that span. MuPDF hands the
 * ActualText back through structured text anyway — as ONE line, every character
 * at the picture's origin, every character with no advance, at a "font size" of
 * `fz_matrix_expansion` of the PICTURE'S transform: sqrt(369.48 x 95.76) =
 * 188.10pt for a 43pt title. That run reached the model as an editable text box,
 * so every slide shipped a second copy of its own title in black at four times
 * the size, in a box of zero width, with characters lost to the zero-advance
 * grouping on the way — `Mter Hadling`. 49 such runs over 41 slides; all 43
 * OFF_SLIDE regions in the convergence benchmark were these.
 *
 * THE GEOMETRIC SIGNATURE ALONE WOULD BE A DISASTER, and that is why the device
 * walk is the gate. Over the frozen 294-page corpus, "every character of a line
 * at one origin with no advance" matches 649 lines — and 600 of them are real
 * Arabic clusters (a tanween on its base; a lam-alef ligature's alef) that this
 * project spent three sessions learning to recover. What separates them is
 * provenance, not shape.
 *
 * THE PROVENANCE TEST HAD TO BE A REACH, NOT A POINT, and one site in the corpus
 * is the whole reason. `Chp1-Lec4-2` p6 puts `أً` at (649.49, 358.50) where the
 * page paints NOTHING — because the ligature it belongs to is painted once, as
 * U+FEF7, at x 643.48 with an advance of 6.01, and 643.48 + 6.01 = 649.49 to the
 * hundredth. Structured text reports a ligature's second character at the
 * ligature's right EDGE. A point test called that real text a phantom and would
 * have deleted an alef and its tanween from a lecture slide; asking instead
 * whether any glyph painted ON THIS BASELINE reaches this origin keeps it.
 *
 *   candidates 649 · kept 600 · dropped 49 — and the 49 are all one deck.
 *
 * LIMIT, stated rather than discovered later: `deviceGlyphs` observes `fillText`
 * only, so text drawn purely as a stroke or a clip has no device record. It also
 * has real advances, which keeps it out of the candidate set entirely — the
 * conjunction is what makes the fillText-only evidence safe here.
 */
function dropUnpaintedTagText(glyphs, devs) {
  const classified = classifyUnpaintedTagText(glyphs, devs);
  const stats = {
    candidates: classified.candidates,
    kept: classified.kept,
    dropped: classified.dropped,
  };
  if (!classified.drop.size) return { dropped: 0, glyphs, sites: classified.sites, stats };
  return {
    dropped: classified.drop.size,
    glyphs: glyphs.filter((g) => !classified.drop.has(g)),
    sites: classified.sites,
    stats,
  };
}

function restoreAstralChars(glyphs, devs) {
  const truncated = glyphs.filter((g) => {
    const cp = g.c?.codePointAt(0);
    return cp != null && cp < ASTRAL_OFFSET && [...g.c].length === 1;
  });
  if (!truncated.length || !devs.length) return;

  for (const g of truncated) {
    const want = g.c.codePointAt(0) + ASTRAL_OFFSET;
    const d = devs.find((d) => d.unicode === want &&
      Math.abs(d.x - g.x) < ASTRAL_SAME_POS && Math.abs(d.y - g.y) < ASTRAL_SAME_POS);
    if (!d) continue;
    g.c = String.fromCodePoint(want);
    g.astralRestored = true;          // declared, never silent
  }
}
  const devs = deviceGlyphs(page, arity);
  // Before any repair reads the stream: a tag's ActualText is not something the
  // page painted, so it must not be in the budget the repairs are priced against.
  const tagText = dropUnpaintedTagText(glyphs, devs);
  glyphs = tagText.glyphs;
  restoreAstralChars(glyphs, devs);
  const deviceOverride = restoreLamAlefOrder(glyphs, devs);
  const repaired = applyRepairs(glyphs, devs);
  const out = groupAtomicUnits(repaired, devs);
  out.proposals = repaired.proposals;
  out.rejectedProposals = repaired.rejectedProposals;
  // The device walk is the only evidence anyone has about what the page really
  // paints, and it costs a full page run. Hand it back rather than throw it away
  // and pay for it twice — `charactersMissing` needs exactly this.
  out.deviceGlyphs = devs;
  out.deviceOverride = deviceOverride;
  out.doubleStruck = struck.dropped;
  // The shadow strike itself, so the deficit can decline to charge for a copy
  // this extractor deliberately deleted. See `shadowedDevices`.
  out.shadowRowGlyphs = struck.shadowRowGlyphs;
  // Declared, never silent: what was removed and what it said.
  out.tagText = tagText.sites;
  out.tagTextStats = tagText.stats;
  return out;
}

/**
 * The three producers, by name. Order is now a diagnostic, not a budget.
 *
 * It used to be a budget, and that was the defect: the repairs mutated the
 * stream in turn, each recomputing its own per-baseline deficit from whatever it
 * was handed, so the registration order silently decided the corpus score — the
 * shipped order was the WORST of the six, costing +7 blocks for no stated reason.
 *
 * Producers are now pure and the resolver decides once, so `REPAIR_ORDER` should
 * make no difference to anything. It is kept for exactly that reason:
 * `experiments/verify-repair-order.js` runs every permutation and asserts the
 * output is byte-identical, which is a claim that needs a way to be tested.
 */
const PRODUCERS = {
  ligature: proposeLigatures,
  tanween: proposeTanweenAlef,
  collided: proposeCollidedAlef,
  markedBase: proposeMarkedBase,
};
const SHIPPED_ORDER = ["ligature", "tanween", "collided", "markedBase"];

export function repairOrder() {
  const raw = typeof process !== "undefined" ? process.env?.REPAIR_ORDER : null;
  if (!raw) return SHIPPED_ORDER;
  const order = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = order.filter((k) => !PRODUCERS[k]);
  // A typo here would silently drop a repair and read as a corpus regression, so
  // it fails loudly instead. Same reason the set must be complete: a permutation
  // gate that quietly omits a producer proves nothing about the producer.
  if (unknown.length) throw new Error(`REPAIR_ORDER names no such repair: ${unknown.join(", ")}`);
  if (order.length !== SHIPPED_ORDER.length) {
    throw new Error(`REPAIR_ORDER must list all ${SHIPPED_ORDER.length} repairs, got ${order.length}`);
  }
  return order;
}

/**
 * Gather every proposal against the SAME stream, then resolve once.
 *
 * The two halves both matter. One budget per page, shared, means two producers
 * cannot both spend one missing character and none can spend a character missing
 * from another word. One unmutated input means no producer can see another's work,
 * so none of them can be starved by running late — which is what made the order
 * load-bearing in the first place.
 */
function applyRepairs(glyphs, devs) {
  const budget = attributePage(glyphs, devs);
  // The baseline the page actually painted this character on. Stamped BEFORE the
  // producers run so a recovered character, which is spread from its anchor,
  // inherits it and lands on the same line. See buildLines.
  for (const g of glyphs) {
    const y = budget.baselineOf(g);
    if (y != null) g.baselineY = y;
  }
  const proposals = repairOrder().flatMap((name) => PRODUCERS[name](glyphs, devs, budget));
  const out = resolveProposals(glyphs, proposals, budget);
  // Handed back so a diagnostic can read THIS run's verdicts instead of
  // re-deriving them. Re-deriving has already produced a different answer than
  // production twice in this work, both times while looking authoritative.
  out.proposals = proposals;
  return out;
}

/** A device glyph belongs to a block if it sits on its baseline, within its span. */
export const EVIDENCE_BASELINE = 1.5;
export const EVIDENCE_X_MARGIN = 1.0;
/**
 * Blocks where the page paints MORE characters than we extracted.
 *
 * The largest defect class left in this project has no signature in the output:
 * `يفصّل` comes out `يفل` and both read as ordinary Arabic, so no rule written
 * against the text can find it. This finds it from the source instead — every
 * painted glyph is answerable for a known number of characters (a lam-alef
 * presentation form owes two, an ordinary glyph owes one), and when that total
 * exceeds what structured text supplied on the same baseline, characters were
 * lost. Nothing is guessed: the count comes from the document.
 *
 * Measured over all 28 decks, 10206 blocks (`experiments/probe-suspicion.js`):
 *
 *   device owes MORE than stext supplied   107 flagged, 107 wrong, 100.0% precision
 *   any unnamed device glyph              1175 flagged, 112 wrong,   9.5% precision
 *
 * against a 6.0% base rate. The first is a perfect detector and is what this
 * returns. The second is the intuitive rule and is barely better than chance —
 * unnamed glyphs are everywhere and usually harmless, so it is deliberately NOT
 * used. It cannot say WHICH character is missing, and it does not try to: it
 * says this line is wrong, which is the thing nobody could see before.
 *
 * `lamAlefLost` is a second, narrower reading of the same walk: the device
 * painted more lam-alef ligature glyphs than the text contains `لا` sequences,
 * so a lam-alef went missing on THIS line specifically. It exists because the
 * blunt `missing` count is decided by losses anywhere on the line, and using it
 * to choose what to put back turned `تنظيفً` into `تنظيفلاً`. Measured on the
 * repair, the specific evidence is worth 11 blocks over the blunt one (80 -> 91).
 *
 * @returns {Map<object, {owed:number, supplied:number, missing:number, lamAlefLost:boolean}>}
 */
/**
 * PAINTED, AND THE TEXT IS RIGHT NOT TO CARRY IT.
 *
 * The deficit treats every painted glyph as a character the line owes. That
 * holds only where each painted glyph is supposed to survive into the text, and
 * MEASURED over the frozen 294-page corpus (`experiments/probe-missing-identity.js`)
 * two kinds of glyph break it, together accounting for 104 of 198 flags:
 *
 *   TATWEEL U+0640, 70 flags.  Justification elongation. The InDesign brand
 *     guide sets its Arabic justified, so the page paints kashidas that carry no
 *     meaning — `الشـعار` and `الشعار` are the same word. Charging the line for
 *     them reports a correct extraction as a lost letter, and "repairing" it
 *     would insert characters the document does not say.
 *   WHITESPACE, 34 flags.  A painted space glyph the text expresses as a gap.
 *
 * Neither can occur in the 28-deck corpus the rule's 100% precision was measured
 * on — 28 Chrome prints of one HTML template, none of them justified. Same shape
 * as EVO-041 and EVO-045: a monoculture corpus cannot fail an assumption.
 */
const TATWEEL = "ـ";
function isPaintOnlyChar(c) {
  if (!c) return false;
  return c === TATWEEL || /\s/u.test(c);
}
function isPaintOnly(unicode) {
  if (!Number.isInteger(unicode) || unicode <= 0 || unicode > 0x10ffff) return false;
  return isPaintOnlyChar(String.fromCodePoint(unicode));
}

/** Origins this close are the same glyph. The two paths agree well within it. */
const SHADOW_MATCH_PT = 0.5;

/**
 * The device glyphs belonging to a strike `dropDoubleStruck` already removed.
 *
 * Matched ONE FOR ONE and nearest-first rather than by a radius: a shadow sits a
 * fraction of a point from the copy it shadows, so a radius test wide enough to
 * find it is also wide enough to swallow the real glyph's evidence — and under-
 * counting `owed` hides genuine losses, which is the failure this whole gate
 * exists to catch. One removed character excuses exactly one painted glyph.
 */
function shadowedDevices(devs, droppedGlyphs) {
  const out = new Set();
  if (!droppedGlyphs?.length) return out;
  for (const g of droppedGlyphs) {
    let best = null, bestD = Infinity;
    for (const d of devs) {
      if (out.has(d)) continue;
      const dx = Math.abs(d.x - g.x), dy = Math.abs(d.y - g.y);
      if (dx > SHADOW_MATCH_PT || dy > SHADOW_MATCH_PT) continue;
      const dist = dx + dy;
      if (dist < bestD) { best = d; bestD = dist; }
    }
    if (best) out.add(best);
  }
  return out;
}

export function sourceEvidence(blocks, devs, textOf, droppedGlyphs = null) {
  const found = new Map();
  if (!devs?.length) return found;
  const shadowed = shadowedDevices(devs, droppedGlyphs);

  for (const b of blocks) {
    if (!b.glyphs?.length) continue;
    const x0 = Math.min(...b.glyphs.map((g) => g.x0));
    const x1 = Math.max(...b.glyphs.map((g) => g.x1));
    let owed = 0, ligatures = 0;
    for (const d of devs) {
      if (Math.abs(d.y - b.y) > EVIDENCE_BASELINE) continue;
      if (d.x < x0 - EVIDENCE_X_MARGIN || d.x > x1 + EVIDENCE_X_MARGIN) continue;
      if (shadowed.has(d) || isPaintOnly(d.unicode)) continue;
      owed += d.owed ?? owedOf(d.unicode);
      // LAM-ALEF specifically, from the unicode — not "anything owing 2". Once
      // the font's own ligature names feed `owed`, hundreds of glyphs owe 2, and
      // counting those here would tell the tanween repair to insert `لا` on
      // lines whose missing ligature was something else entirely.
      if (owedOf(d.unicode) === 2) ligatures++;
    }
    // BOTH SIDES EXCLUDE THE SAME THING. If `owed` stops counting a kashida the
    // page painted while `supplied` still counts one the text carries, the
    // deficit shrinks against a line that really did lose a letter — a gate that
    // fails silently in the safe-looking direction.
    const supplied = b.glyphs.filter((g) => !isPaintOnlyChar(g.c)).length;
    const present = ((textOf?.(b) ?? "").match(/ل[اآأإ]/gu) ?? []).length;
    const lamAlefLost = ligatures > present;
    if (owed > supplied || lamAlefLost) {
      found.set(b, { owed, supplied, missing: Math.max(0, owed - supplied), lamAlefLost });
    }
  }
  return found;
}


/**
 * Bind glyphs that must move as one unit through the bidi reversal, and fix
 * their internal logical order.
 *
 * Two cases, both measured on the real corpus:
 *
 * 1. LIGATURE TAILS. MuPDF maps a single lam-alef glyph back to two codepoints
 *    and emits them in LOGICAL order at increasing x; the trailing component is
 *    ZERO width and starts exactly where the leading one ends:
 *      "ل" origin 407.13 [407.13,417.98]   "أ" origin 417.98 [417.98,417.98]
 *    Reversing these against each other turns "الأسبوع" into "األسبوع".
 *
 * 2. COMBINING MARKS. A mark is painted BEFORE the letter it sits on, sharing
 *    that letter's origin x exactly:
 *      mark U+064F seq 113 x 530.39  ->  base "ي" seq 114 x 530.39
 *    So the base is found spatially (shared origin), never by paint adjacency,
 *    and must be emitted FIRST despite being painted second — otherwise
 *    "يُدار" comes out "دُيار".
 */
function groupAtomicUnits(glyphs, devs) {
  let group = 0;

  for (let i = 1; i < glyphs.length; i++) {
    const a = glyphs[i - 1], b = glyphs[i];
    if (isCombiningMark(b.c) || isCombiningMark(a.c)) continue;
    const zeroWidth = b.x1 - b.x0 < LIGATURE_EPS;
    const abuts = Math.abs(b.x - a.x1) < LIGATURE_EPS;
    const sameLine = Math.abs(a.y - b.y) < LIGATURE_EPS;

    // Lam-alef is the one Arabic ligature that is mandatory, and MuPDF encodes
    // it two ways — sometimes the tail carries zero width, sometimes the lead:
    //   "ل"[407.13,417.98]  "أ"[417.98,417.98]   (zero tail)
    //   "ل"[200.73,200.73]  "ا"[201.27,209.44]   (zero lead)
    // Widening the geometric test to cover both chains through the ~46
    // zero-width glyphs on a page and freezes whole runs (measured 56.48% vs
    // 77.55%). Identifying it by character is exact and cannot over-group.
    // The signature is the ZERO-WIDTH LAM. Matching lam+alef on characters
    // alone also catches the ubiquitous definite article "ال", whose alef
    // legitimately follows the lam in paint order — that froze half the corpus
    // in visual order (28.04%).
    const lamAlef = a.c === LAM && a.x1 - a.x0 < LIGATURE_EPS &&
      LAM_ALEF_PARTNERS.has(b.c) && sameLine && Math.abs(b.x - a.x1) < LAM_ALEF_EPS;

    if ((zeroWidth && abuts && sameLine) || lamAlef) {
      if (a.groupId == null) a.groupId = ++group;
      b.groupId = a.groupId;
    }
  }

  // The same ligature with its two glyphs emitted the other way round: the
  // ALEF first and the zero-width lam after it. Measured, "كاملاً":
  //   "ً" seq 633 origin 535.90   "ا" seq 634 box 526.60..535.90
  //   "ل" seq 635 box 525.94..525.94 (zero)
  // The geometry is identical to the "zero lead" case above — a zero-width lam
  // immediately left of its alef — only the emission order differs, and the pass
  // above pairs on emission order alone, so it never saw this one. Ungrouped,
  // the two halves reversed independently and gave "كاماًل".
  //
  // It runs SECOND and skips any lam already grouped, because a zero-width lam
  // followed by an alef is the LEAD of the next ligature ("الأسبوع": ا ل أ) and
  // that reading has to win.
  for (let i = 1; i < glyphs.length; i++) {
    const alef = glyphs[i - 1], lam = glyphs[i];
    if (lam.groupId != null || lam.c !== LAM || lam.x1 - lam.x0 >= LIGATURE_EPS) continue;
    if (!LAM_ALEF_PARTNERS.has(alef.c) || Math.abs(alef.y - lam.y) >= LIGATURE_EPS) continue;
    if (Math.abs(alef.x - lam.x1) >= LAM_ALEF_EPS) continue;
    if (alef.groupId == null) alef.groupId = ++group;
    lam.groupId = alef.groupId;
  }

  // A ligature whose two halves BOTH arrived at full width, with the tail landing
  // exactly on the next letter's origin. The two passes above identify a ligature
  // by the ZERO-WIDTH half, which is the shape stext uses when it decomposes one
  // cleanly; here neither half is zero-width and nothing pairs them:
  //
  //   device   x 608.08 adv 7.29  U+FEF8  parts لا      owes 2, stext gave it 1
  //   stext    x 608.08 box 606.10..619.01  "ل"        the ligature
  //            x 615.37 box 613.39..619.01  "أ"        ITS ALEF — same right edge
  //            x 615.37 box 613.39..622.50  "ل"        a real, separate lam
  //
  // Every character is present and the word's budget balances, so no producer
  // fires. Only the ORDER is wrong: the alef sorts on its own origin, which is the
  // standalone lam's, and `للأسبوع` comes out `لألسبوع` — on the closing slide of
  // 25 of the 28 decks.
  //
  // THE DISCRIMINATOR IS THE RIGHT EDGE, not the origin. Two glyphs share the
  // origin 615.37 and geometry alone cannot say which is the ligature's; but the
  // tail is drawn INSIDE the ligature's box and ends where the ligature ends
  // (619.01), while the separate lam has a box of its own (622.50). Binding on the
  // origin alone would swallow the real lam, which is how an earlier attempt at
  // this site turned correct text into differently wrong text.
  for (const d of devs) {
    if (d.parts?.length !== 2 || !(d.advance > 0)) continue;
    const [head, tail] = d.parts;
    const lam = glyphs.find((g) => g.c === head && g.groupId == null &&
      Math.abs(g.x - d.x) < LIGATURE_EPS && Math.abs(g.y - d.y) < LIGATURE_EPS);
    if (!lam) continue;
    const alef = glyphs.find((g) => g.c === tail && g !== lam && g.groupId == null &&
      Math.abs(g.x - (d.x + d.advance)) < LIGATURE_EPS &&
      Math.abs(g.y - d.y) < LIGATURE_EPS &&
      Math.abs(g.x1 - lam.x1) < LIGATURE_EPS);
    if (!alef) continue;
    if (lam.groupId == null) lam.groupId = ++group;
    alef.groupId = lam.groupId;
  }

  // A ligature whose two halves are far apart in emission order, named by
  // repairCollidedAlef because only the device evidence could identify it. The
  // passes above walk neighbours and cannot reach it.
  for (const g of glyphs) {
    const lam = g.ligatureLam;
    if (!lam || g.groupId != null) continue;
    if (lam.groupId == null) lam.groupId = ++group;
    g.groupId = lam.groupId;
  }

  const bases = glyphs.filter((g) => !isCombiningMark(g.c) && g.c.trim());
  for (let i = 0; i < glyphs.length; i++) {
    const m = glyphs[i];
    if (!isCombiningMark(m.c)) continue;
    m.isMark = true;

    // A mark is painted OVER its base, so the base is the letter whose advance
    // box spans the mark's origin. Nearest-origin distance is not equivalent:
    // it picks the neighbouring letter whenever the true base is wide, which
    // measured as "يتحوّل" -> "يتحّ ول" across the whole corpus.
    //
    // Origin alone is not enough either, and this is where "متكاملاً" was lost.
    // Two letters can share the mark's origin — one STARTING there and one
    // ENDING there — and geometry cannot say which is meant:
    //   "ً" origin 535.90   "ا" box 526.60..535.90   "م" box 535.90..544.31
    // The tanween belongs to the alef; nearest-origin picked the meem, giving
    // "كاًمال" for "كاملاً". MuPDF emits a mark IMMEDIATELY BEFORE the letter it
    // sits on (stacked marks come out together, before their shared base), so
    // emission order settles what position cannot. It only ever chooses between
    // letters the mark already sits on, so it cannot reach across a word.
    const adjacent = nextBase(glyphs, i);
    let best = null, bestDist = Infinity;
    for (const b of bases) {
      if (Math.abs(b.y - m.y) > 3) continue;
      const contains = m.x >= b.x0 - MARK_EPS && m.x <= b.x1 + MARK_EPS;
      if (!contains) continue;
      if (b === adjacent) { best = b; break; }
      const d = Math.abs(b.x - m.x);
      if (d < bestDist) { bestDist = d; best = b; }
    }
    if (!best) {
      for (const b of bases) {
        if (Math.abs(b.y - m.y) > 3) continue;
        const d = Math.abs(b.x - m.x);
        if (d < bestDist && d <= MARK_EPS) { bestDist = d; best = b; }
      }
    }
    if (best) {
      if (best.groupId == null) best.groupId = ++group;
      m.groupId = best.groupId;
    }
  }

  return anchorGroups(glyphs);
}

/** The next real letter after position i in emission order, skipping marks. */
function nextBase(glyphs, i) {
  for (let k = i + 1; k < glyphs.length; k++) {
    if (isCombiningMark(glyphs[k].c)) continue;
    return glyphs[k].c.trim() ? glyphs[k] : null;
  }
  return null;
}

/**
 * All members of a group sort as one unit, anchored on the group's base glyph,
 * ordered base-first then marks. Sorting members on their own x lets unrelated
 * glyphs land between them (measured: the damma of "يُدار" sorted next to "د").
 */
function anchorGroups(glyphs) {
  const anchor = new Map();
  for (const g of glyphs) {
    if (g.groupId == null || g.isMark) continue;
    const cur = anchor.get(g.groupId);
    if (!cur || g.paintSeq < cur.paintSeq) anchor.set(g.groupId, g);
  }
  for (const g of glyphs) {
    const base = g.groupId != null ? anchor.get(g.groupId) : null;
    g.sortX = base ? base.x : g.x;
    g.groupRank = g.isMark ? 1 : 0;   // base and ligature tail first, marks after
  }
  return glyphs;
}

/**
 * Deterministic visual ordering.
 *
 * Key order matters and is measured, not arbitrary:
 *  1. anchored origin x  — group members share their base's origin
 *  2. right edge         — a zero-advance cluster head, its marks and a
 *                          following SPACE can all share one origin; the space
 *                          extends furthest right so it must sort last.
 *                          Without this the space splits the cluster and
 *                          "يتحوّل" comes out "يتحّ ول".
 *  3. base before mark   — same origin AND same right edge: the letter first
 *  4. paint order        — final tie-break, keeps emission order stable
 */
const originKey = (g) => Math.round((g.sortX ?? g.x) * 100);
const rightKey = (g) => Math.round(g.x1 * 100);
const byOriginThenPaint = (a, b) =>
  originKey(a) - originKey(b) ||
  rightKey(a) - rightKey(b) ||
  (a.groupRank ?? 0) - (b.groupRank ?? 0) ||
  a.paintSeq - b.paintSeq;

/** Group glyphs onto shared baselines, then split each baseline into blocks. */
/**
 * Lines whose baseline is not horizontal — chart axis captions, in practice.
 *
 * These get their own pass rather than a second orientation threaded through
 * the main one. The upright pipeline carries the bidi reconstruction, the
 * ligature grouping and the mark attribution, all keyed on "advance along x,
 * group by y"; generalising it would put every one of those at risk to serve
 * 42 glyphs in 603896. Partitioning instead means the corpus path is not merely
 * unchanged but UNREACHABLE from here — no deck in the corpus has a rotated
 * glyph at all.
 *
 * At -90 the roles of the axes swap: the constant is x, the advance is y, and
 * the text reads bottom-to-top, so it sorts by DESCENDING y.
 */
function buildRotatedLines(glyphs) {
  const byRotation = new Map();
  for (const g of glyphs) {
    const k = `${g.rot}|${Math.round(crossAxis(g) / 2)}|${g.family}|${g.size}`;
    byRotation.set(k, [...(byRotation.get(k) ?? []), g]);
  }
  const blocks = [];
  for (const gs of byRotation.values()) {
    const rot = gs[0].rot;
    // Advance direction: -90 reads bottom-to-top, 90 top-to-bottom, 180 right-to-left.
    gs.sort((a, b) => (rot === -90 ? b.y - a.y : rot === 90 ? a.y - b.y : b.x - a.x));
    blocks.push({
      glyphs: gs,
      rotation: rot,
      y: mean(gs.map((g) => g.y)),
      x0: Math.min(...gs.map((g) => g.x0)),
      x1: Math.max(...gs.map((g) => g.x1)),
      yTop: Math.min(...gs.map((g) => g.y0)),
      yBot: Math.max(...gs.map((g) => g.y1)),
      size: mode(gs.map((g) => g.size)),
      family: mode(gs.map((g) => g.family)),
      color: gs[0].color,
    });
  }
  return blocks;
}

/** The axis that stays CONSTANT along a rotated baseline. */
const crossAxis = (g) => (g.rot === 90 || g.rot === -90 ? g.x : g.y);

export function buildLines(glyphs) {
  // Rotated glyphs are removed before the upright pass so nothing downstream
  // sees a baseline it cannot interpret. `deviceGlyphs` is carried on the array
  // itself by extractGlyphs, so it has to survive the filter.
  const rotated = glyphs.filter((g) => g.rot);
  let upright = glyphs;
  if (rotated.length) {
    upright = glyphs.filter((g) => !g.rot);
    upright.deviceGlyphs = glyphs.deviceGlyphs;
  }
  glyphs = upright;

  const rows = [];
  for (const g of glyphs) {
    const tol = Math.max(g.size * BASELINE_TOL, 0.8);
    const gy = baselineOf(g);
    let row = null;
    for (const r of rows) {
      if (Math.abs(r.y - gy) <= tol && sameStyleFamily(r, g)) { row = r; break; }
    }
    if (row) { row.glyphs.push(g); row.y = mean(row.glyphs.map(baselineOf)); }
    else rows.push({ y: gy, glyphs: [g] });
  }

  // Sort by pen ORIGIN, not bounding-box left edge: Arabic cursive glyphs
  // overlap and carry side bearings, so x0 ordering swaps adjacent letters
  // (measured: "المؤشرات" came out "المرؤشات").
  for (const r of rows) r.glyphs.sort(byOriginThenPaint);
  rows.sort((a, b) => a.y - b.y || byOriginThenPaint(a.glyphs[0], b.glyphs[0]));

  // NOTE: src/extract/repair.js can synthesise glyphs for unencoded holes, but
  // is NOT wired in — measured at 67.56% vs 72.56% baseline. Arabic letters have
  // contextual forms with different advances, so width alone does not identify
  // the missing character. See KNOWN_ISSUES.md before trying again.
  // A letter split into a block of its own is not a missing letter. Merge it
  // back before anything downstream reads the text. See mergeOrphanFragments.
  // DO NOT put back "missing" characters here from unmatched device glyphs.
  // That was built, measured and reverted on 2026-08-17 — the SECOND time this
  // project has tried it. It is not dangerous this time, it is merely worthless:
  // 18 characters inserted corpus-wide, 0 blocks fixed, 0 broken, character
  // recall 97.883% -> 97.881%. See KNOWN_ISSUES before attempting a third.
  const blocks = mergeSuperscripts(mergeOrphanFragments(readingOrder(rows.flatMap(splitIntoBlocks).map(dropOrphanTanween))));
  return rotated.length ? [...blocks, ...buildRotatedLines(rotated)] : blocks;
}

/** A block no wider than this is not a line of text; it is a fragment of one. */
const ORPHAN_WIDTH = 2.0;
/**
 * How far off the host's baseline a fragment may sit and still belong to it.
 *
 * A flat limit is font-size-blind, and this corpus runs from 8pt body text to
 * 30pt headings. A shadda on a heading sits proportionally further from the
 * baseline than the same mark on a caption, so six fragments — every one of them
 * on a title slide, `عّ` at 13.3pt, `كّ` at 15.8pt — were inside their host's
 * span and rejected purely for being large. The limit scales with the host.
 */
const ORPHAN_HOST_DY = 12.0;
const ORPHAN_HOST_DY_EM = 0.6;

/**
 * Put back a letter that was split into a block of its own.
 *
 * `Chp1-Lec3-2(New)` slide 9 carries a block whose entire content is `صّ`, width
 * 0.00pt, sitting inside the span of the line `إصدار حكم ني حسب شرط`. The truth
 * is `نصّي`. Nothing was ever lost — the shadda-carrying letter became its own
 * block, and the word it belongs to reads as ordinary Arabic without it, which
 * is why this defect has been invisible and was being reported as
 * `characters-missing` with nothing to do about it.
 *
 * A shadda raises a glyph's bounding box, so the row grouping in `buildLines`
 * puts it on a baseline of its own, and `splitIntoBlocks` then has one glyph
 * with nothing beside it. That is why almost every orphan carries a shadda.
 *
 * Measured over all 28 decks (`experiments/probe-orphan-blocks.js`):
 *
 *   63 orphan blocks · 50 with exactly one containing host · 13 with none
 *   merged: 33 fixed, 1 broken
 *
 * **Splice, never re-sort.** The host's glyph order is not a plain sort by x —
 * `groupAtomicUnits` has already bound ligature halves, marks and their bases
 * into units whose internal order is deliberate. Rebuilding the merged array
 * with `.sort((a,b) => a.x0 - b.x0)` scored 16 fixed instead of 33, because on
 * the very line it repaired `وسنفل` -> `وسنفصّل` it also broke `الحالات` ->
 * `الحاالت`, `الأسبوع` -> `أالسبوع` and `Effective` -> `Efefctive`. Only the
 * orphan is allowed to move.
 *
 * Containment, not proximity, picks the host: the fragment's span must lie
 * inside the candidate's, so a fragment cannot be stolen onto a neighbouring
 * line that merely happens to be closer.
 */
/**
 * A SUPERSCRIPT is a line of its own, and it belongs inside the line below it.
 *
 * `mergeOrphanFragments` below cannot reach these: it admits a fragment only if
 * it is narrower than ORPHAN_WIDTH (2.0pt), which is right for the one-letter
 * Arabic strips it exists for and hopeless for `3/2` at 21.8pt wide. Widening
 * that limit would loosen the pass for every fragment; a superscript has three
 * pieces of evidence of its own and needs none of the width test:
 *
 *   RAISED   its baseline sits above the host's, by less than one em
 *   SMALLER  its type is smaller than the host's
 *   INSIDE   its x-span falls within the host's
 *
 * Measured over all 28 decks: SIX strips, every one a real exponent with an
 * unambiguous host, and no false positive to reject.
 *
 *   Phover = (m·g) ÷ ( η · √(2·ρ·A) )   +  `3/2` at y 156.0, host y 162.9
 *   W = 451.5                           +  `1.5` at y 230.3, host y 234.8
 *   L = ½ · ρ · V · S · CL              +  `2`   at y 177.0, host y 183.9
 */
const SUPERSCRIPT_TEXT = /^[\d.,/\u00b2\u00b3]+$/u;
/** A strip longer than this is a line, not an exponent. */
const SUPERSCRIPT_MAX_GLYPHS = 6;
/** The host's type must exceed the strip's by this factor. */
const SUPERSCRIPT_SIZE_RATIO = 1.08;

function mergeSuperscripts(blocks) {
  const span = (b) => ({
    x0: Math.min(...b.glyphs.map((g) => g.x0)),
    x1: Math.max(...b.glyphs.map((g) => g.x1)),
  });
  const merged = new Set();

  for (const strip of blocks) {
    if (!strip.glyphs?.length || strip.glyphs.length > SUPERSCRIPT_MAX_GLYPHS) continue;
    if (!SUPERSCRIPT_TEXT.test(strip.glyphs.map((g) => g.c).join(""))) continue;
    const size = Math.max(...strip.glyphs.map((g) => g.size ?? 0));
    const s = span(strip);

    const hosts = blocks.filter((h) => {
      if (h === strip || merged.has(h) || (h.glyphs?.length ?? 0) <= SUPERSCRIPT_MAX_GLYPHS) return false;
      const hSize = Math.max(...h.glyphs.map((g) => g.size ?? 0));
      if (hSize < size * SUPERSCRIPT_SIZE_RATIO) return false;
      // BELOW the strip, and by less than one em: further than that is the next
      // paragraph, not the line this exponent sits on.
      const drop = h.y - strip.y;
      if (drop <= 1.5 || drop >= size * 0.8) return false;
      const g = span(h);
      return s.x0 >= g.x0 - 2 && s.x1 <= g.x1 + 2;
    });
    // Two candidates is a genuine ambiguity and there are none in this corpus.
    // Leave it alone rather than pick one — the same rule the pass below uses.
    if (hosts.length !== 1) continue;

    const host = hosts[0];
    const at = host.glyphs.findIndex((g) => g.x0 > s.x0);
    // No flag is set here. The strip keeps its own raised baseline and its own
    // smaller size, so `tagScriptLevels` measures the offset from the host's
    // type exactly as it does for a subscript that was never a block of its own.
    host.glyphs.splice(at < 0 ? host.glyphs.length : at, 0, ...strip.glyphs);
    if (strip.droppedGlyphs) host.droppedGlyphs = (host.droppedGlyphs ?? 0) + strip.droppedGlyphs;
    merged.add(strip);
  }
  return blocks.filter((b) => !merged.has(b));
}

function mergeOrphanFragments(blocks) {
  // ORPHAN_WIDTH=n overrides the threshold and 0 disables the pass, so the value
  // below can be defended against the corpus instead of asserted.
  const env = typeof process !== "undefined" ? Number(process.env?.ORPHAN_WIDTH) : NaN;
  const limit = Number.isFinite(env) ? env : ORPHAN_WIDTH;
  if (limit <= 0) return blocks;

  const span = (b) => ({
    x0: Math.min(...b.glyphs.map((g) => g.x0)),
    x1: Math.max(...b.glyphs.map((g) => g.x1)),
  });
  const merged = new Set();

  for (const orphan of blocks) {
    if (!orphan.glyphs?.length) continue;
    const s = span(orphan);
    if (s.x1 - s.x0 > limit) continue;
    // A fragment made only of combining marks is not a lost letter — it is the
    // stray nunation `dropOrphanTanween` exists to remove, which escaped that
    // pass by becoming its own block. Merging it puts a mark the source never
    // wrote onto a real word: measured, exactly one regression, `مسألة` ->
    // `مًسألة`. A fragment has to carry a BASE to be worth restoring.
    if (!orphan.glyphs.some((g) => !isCombiningMark(g.c))) continue;

    const hosts = blocks.filter((b) => {
      if (b === orphan || merged.has(b) || !b.glyphs?.length) return false;
      const h = span(b);
      if (h.x1 - h.x0 <= limit) return false;
      const size = Math.max(...b.glyphs.map((g) => g.size));
      const dy = Math.max(ORPHAN_HOST_DY, size * ORPHAN_HOST_DY_EM);
      return Math.abs(b.y - orphan.y) <= dy && s.x0 >= h.x0 - 1 && s.x1 <= h.x1 + 1;
    });
    if (!hosts.length) continue;

    hosts.sort((a, b) => Math.abs(a.y - orphan.y) - Math.abs(b.y - orphan.y));
    // Two hosts the same distance away is a genuine ambiguity, and there are
    // none in this corpus. Leave it alone rather than pick one.
    if (hosts.length > 1 && Math.abs(hosts[0].y - orphan.y) === Math.abs(hosts[1].y - orphan.y)) continue;

    const host = hosts[0];
    const at = host.glyphs.findIndex((g) => g.x0 > orphan.glyphs[0].x0);
    host.glyphs.splice(at < 0 ? host.glyphs.length : at, 0, ...orphan.glyphs);
    // The orphan may itself have had glyphs deliberately removed by
    // `dropOrphanTanween`, and that record is the only thing standing between a
    // deliberate repair and a silent loss. Deleting the block without carrying
    // the count forward cost coverage exactly one glyph on two slides of
    // Chp1-Lec6-2 — 100.00% became 99.99%, `unmapped-glyphs`, 2 errors.
    if (orphan.droppedGlyphs) host.droppedGlyphs = (host.droppedGlyphs ?? 0) + orphan.droppedGlyphs;
    merged.add(orphan);
  }
  return blocks.filter((b) => !merged.has(b));
}

/**
 * Drop a tanween the source never wrote.
 *
 * Some lines are painted with a stray nunation mark at the RIGHT MARGIN, past
 * the end of every letter on the line, zero advance. It has no base to belong
 * to: in RTL the character a mark applies to is the one on its right, and there
 * is nothing there. Measured, Chp4-Lec23-1 p2 — the source paragraph is
 * "<p>تتمحور", the PDF paints U+064B at x 666.00 while the first letter ends at
 * 666.00, and the line was reconstructed as "تًتمحور".
 *
 * Restricted to TANWEEN and that is the whole safety of it. Arabic nunation
 * marks the END of a word, and a word does not split across lines, so a tanween
 * on a line's first letter is impossible. Any other mark there is ordinary
 * vowelling — "يُنتج", "طُبّقت" — and dropping those cost 22 correct blocks when
 * the rule was written for marks in general.
 *
 * Measured over 28 decks: 99 blocks fixed, 0 broken.
 */
function dropOrphanTanween(block) {
  const bases = block.glyphs.filter((g) => !isCombiningMark(g.c) && g.c.trim());
  if (!bases.length) return block;
  const lineStart = Math.max(...bases.map((b) => b.x1));
  const orphan = (g) => isTanween(g.c) && g.x0 >= lineStart - ORPHAN_EPS;
  if (!block.glyphs.some(orphan)) return block;
  const kept = block.glyphs.filter((g) => !orphan(g));
  // Declared, never silent: the coverage ledger is a hard gate on "every glyph
  // the extractor saw reached an object", and a repair that deletes ink owes it
  // a count. See model/coverage.js.
  return { ...block, glyphs: kept, droppedGlyphs: block.glyphs.length - kept.length };
}

/**
 * Put blocks in READING order, not page order.
 *
 * Blocks are built left-to-right because that is how glyphs are positioned, but
 * an Arabic page is read right-to-left: two blocks sharing a baseline (a pair of
 * footers, a label and its value, table cells) must be emitted right one first.
 * Emitting them left-first silently reverses the document's reading order.
 */
function readingOrder(blocks) {
  if (!blocks.length) return blocks;
  const rtlBlocks = blocks.filter(blockIsRtl).length;
  const pageIsRtl = rtlBlocks * 2 >= blocks.length;

  return blocks.slice().sort((a, b) => {
    const sameRow = Math.abs(a.y - b.y) <= Math.max(a.size, b.size) * BASELINE_TOL;
    if (!sameRow) return a.y - b.y;
    return pageIsRtl ? b.x1 - a.x1 : a.x0 - b.x0;
  });
}

/** Two glyphs join a baseline only if their type size is comparable. */
function sameStyleFamily(row, g) {
  const s = row.glyphs[0].size;
  return Math.abs(s - g.size) <= Math.max(s * 0.35, 1.0);
}

/** A wide horizontal gap on one baseline means two independent text blocks. */
function splitIntoBlocks(row) {
  const blocks = [];
  let cur = [row.glyphs[0]];
  for (let i = 1; i < row.glyphs.length; i++) {
    const prev = row.glyphs[i - 1], g = row.glyphs[i];
    if (g.x0 - prev.x1 > prev.size * BLOCK_GAP) { blocks.push(cur); cur = [g]; }
    else cur.push(g);
  }
  blocks.push(cur);

  return blocks.map((gs) => ({
    glyphs: gs,
    y: mean(gs.map(baselineOf)),
    x0: Math.min(...gs.map((g) => g.x0)),
    x1: Math.max(...gs.map((g) => g.x1)),
    yTop: Math.min(...gs.map((g) => g.y0)),
    yBot: Math.max(...gs.map((g) => g.y1)),
    size: mode(gs.map((g) => g.size)),
    family: mode(gs.map((g) => g.family)),
    color: gs[0].color,
  }));
}

/**
 * Word separation.
 *
 * The PDF carries explicit space glyphs (measured: 54 on page 0 across 10
 * baselines, widths 2.27-5.54pt) and those are authoritative. Inter-glyph gap
 * width is NOT a usable substitute: on a densely vocalised line the real word
 * gap is 3.15pt while three non-gaps measure 4.90-5.54pt, because zero-advance
 * shaped clusters and combining marks break the advance chain.
 *
 * So: trust the document's own spaces, and fall back to geometry only for a
 * line that contains none (some headings are emitted without space glyphs).
 */
/**
 * A real space glyph belongs between the glyphs it separated IN THE STREAM.
 *
 * THE DEFECT. `1250 مجال` comes back `1250مجال`. Structured text gets it right —
 * the raw stream is `1 2 5 0 <space> م ج ا ل`, and RAW scores 99.06% recall on a
 * population built entirely of these boundaries, against 92.22% for our model.
 *
 * WHY WE LOSE IT. `buildLines` orders a block by x, and PowerPoint paints the space
 * of a reordered mixed-script run at the END of the LTR token rather than between
 * the two:
 *
 *     "0"   653.14..664.28      the last digit
 *     " "   664.30..669.87      the space, painted to the RIGHT of all of them
 *     "م"   611.65..619.55      the Arabic, far to the LEFT
 *
 * Sorted by x the space lands at the block EDGE and is trimmed, and the real
 * boundary gets nothing — the digits and the Arabic are 0.13pt apart, so no
 * gap-based inference can find it either. The separator is not missing from the
 * evidence; it has been moved by a sort.
 *
 * THE RULE USES ONLY WHAT THE STREAM ALREADY RECORDS. Every glyph carries its
 * `paintSeq`, so a space's stream neighbours are known exactly. A space that was
 * INTERIOR in the stream and became an EDGE after sorting is put back between the
 * two glyphs it actually separated. A space that is interior in both is untouched,
 * and one that was an edge in the stream too is left alone — it really is a leading
 * or trailing space.
 */
function restoreStreamSpaces(glyphs) {
  const spaces = glyphs.filter((g) => g.c === " " && g.paintSeq != null);
  if (!spaces.length) return 0;
  let moved = 0;

  for (const sp of spaces) {
    const at = glyphs.indexOf(sp);
    if (at > 0 && at < glyphs.length - 1) continue;        // interior already
    // Its stream neighbours: the glyphs painted immediately before and after it.
    const before = glyphs.find((g) => g.paintSeq === sp.paintSeq - 1);
    const after = glyphs.find((g) => g.paintSeq === sp.paintSeq + 1);
    if (!before || !after) continue;                        // an edge in the stream too
    const i = glyphs.indexOf(before), j = glyphs.indexOf(after);
    if (i < 0 || j < 0) continue;
    // The two neighbours are NOT adjacent after sorting — that is the whole point:
    // one belongs to the Latin run and one to the Arabic, and the sort has put the
    // runs on either side. The separator goes at the boundary BETWEEN those runs,
    // which is immediately after whichever neighbour sorts first. Placing it beside
    // the later one instead drops it inside a run and separates nothing.
    const insertAt = Math.min(i, j) + 1;
    if (insertAt === at) continue;
    glyphs.splice(at, 1);
    glyphs.splice(at < insertAt ? insertAt - 1 : insertAt, 0, sp);
    sp.streamPlaced = true;                                 // declared, never silent
    moved++;
  }
  return moved;
}

export function withSpaces(sortedGlyphs) {
  restoreStreamSpaces(sortedGlyphs);
  if (sortedGlyphs.some((g) => g.c === " ")) return sortedGlyphs;

  const out = [];
  let lastSolid = null;   // marks carry no advance, so they never define a gap
  // A ZERO-WIDTH BASE hides an advance, so neither side of it is a word gap.
  //
  // Structured text reports a mark-carrying base at its MARK's origin with no
  // width — that is the same fact `attribute.js` and `proposeMarkedBase` are
  // built on. The letter still occupies its real advance on the page, so the
  // stext hole either side of it is not evidence of anything, and reading it as
  // a gap breaks the word in two. Measured on `Chp4-Lec26-1` p7, a table cell
  // holding one word:
  //
  //   ل  632.39   ع  634.00..634.00 (zero)   ّ   ف  638.86
  //   -> `الف عّ الة` for `الفعّالة`, and the SAME word one line below, inside a
  //      sentence, is correct — because a block that already has real spaces
  //      never reaches this pass at all.
  // WHICH zero-width glyph, not merely whether there was one. The guard above was
  // unconditional — any hidden glyph killed the next gap — and that is wrong for
  // half of the producers this project has now measured. Two different things
  // arrive with zero width and they need opposite answers:
  //
  //   a MARK-CARRYING BASE, reported at its mark's origin. Its advance is real and
  //   unreported, it sits INSIDE a word, and the hole around it is not a word gap.
  //   This is the Chrome case the guard was built for.
  //
  //   a LIGATURE PARTNER — the alef of a lam-alef, whose ligature glyph already
  //   carries the whole advance. It occupies nothing, it sits at the END of a word,
  //   and the gap after it is a real space.
  //
  // MEASURED over 28 corpus decks and an authored PowerPoint deck whose truth we
  // wrote (`experiments/synth/`), on every gap a hidden glyph suppressed:
  //
  //                        suppressed   hidden glyph carries a mark
  //     Chrome                   1679        1660   99%
  //     PowerPoint                 17           1    6%
  //
  // So "does the hidden glyph carry a combining mark" separates them, and it names
  // no producer. Two geometric conditions come with it: a hidden glyph whose origin
  // falls INSIDE the interval can plausibly fill it, and a gap no wider than
  // WIDE_GAP is within one hidden advance either way. The three together:
  //
  //     insert when NOT marked AND NOT inside the gap AND gap > WIDE_GAP
  //     -> PowerPoint recovers 15 of 17 spaces · Chrome changes 0 of 1679
  //
  // The threshold sits on a plateau (0.35 to 0.55 all give 15 and 0), so it is not
  // doing delicate work — which is the bar this project asks of any constant.
  let hidden = null;
  const markNear = (x, size) => sortedGlyphs.some((m) => m.isMark && Math.abs(m.x0 - x) < size * 0.6);

  for (const g of sortedGlyphs) {
    const zeroWidth = !g.isMark && g.x1 - g.x0 < ZERO_ADVANCE;
    if (!g.isMark && !zeroWidth && lastSolid) {
      const size = Math.min(g.size, lastSolid.size);
      const gap = g.x0 - lastSolid.x1;
      // Can the hidden glyph account for this interval? Only then does it earn
      // the right to suppress it.
      const explains = hidden !== null && (
        markNear(hidden.x0, size) ||
        (hidden.x0 > lastSolid.x1 && hidden.x0 < g.x0) ||
        gap <= size * WIDE_GAP);
      if (!explains && gap > size * SPACE_GAP) {
        out.push({ c: " ", synthetic: true, size: g.size, x0: lastSolid.x1, x1: g.x0 });
      }
    }
    out.push(g);
    if (g.isMark) continue;
    if (zeroWidth) hidden = g;
    else { lastSolid = g; hidden = null; }
  }
  return out;
}

/**
 * Logical-order runs for one block, split where typography changes.
 * A run is the unit PowerPoint styles independently, so mixed Arabic/Latin
 * and bold/regular spans inside one paragraph survive as real formatting.
 */
/**
 * Mark the runs the source SET smaller and off the baseline: sub- and superscript.
 *
 * Every formula variable in this corpus is subscripted — `Capacity_line`,
 * `T_available`, `C/T_bottleneck`, `FC_1` — and the deck rendered all of them
 * flat, which turns a variable name into a different variable name. Measured
 * over all 28 decks: 1128 lowered glyphs in 185 blocks, and 14 raised ones.
 *
 * The evidence is the glyph's own, and both halves are needed. SIZE alone is an
 * inline style change; BASELINE alone is a line that wrapped. Together, at less
 * than half an em off a larger neighbour's baseline, they are the definition of
 * a script level.
 *
 * `mergeSuperscripts` handles the case where the raised strip became a block of
 * its own; this handles the far commoner case where it did not.
 */
const SCRIPT_SIZE_RATIO = 0.95;
const SCRIPT_MIN_DY = 1.2;
const SCRIPT_MAX_DOWN_EM = 0.45;
const SCRIPT_MAX_UP_EM = 0.6;

function tagScriptLevels(block) {
  const solid = block.glyphs.filter((g) => g.c?.trim());
  if (solid.length < 2) return;

  // The line's own type is the LARGEST present, and its baseline is where that
  // type sits. Two simpler references were tried and both fail on the blocks
  // that matter most:
  //
  //   the modal SIZE       `Capacityline = Tavailable ÷ C/Tbottleneck` is 23
  //                        subscript characters against 18 on the line, so the
  //                        mode IS the subscript size and nothing looks small.
  //   the block's own y    `block.y` is the row's baseline, not the glyphs' —
  //                        measured 0.61pt off on `Phover`, which is enough to
  //                        empty a 0.6pt window and tag nothing at all.
  //
  // A sub- or superscript is smaller than the main type BY DEFINITION, so the
  // largest type cannot be one, and the baseline it sits on is the line's.
  let main = 0;
  for (const g of solid) if ((g.size ?? 0) > main) main = g.size ?? 0;
  if (!(main > 0)) return;
  const counts = new Map();
  for (const g of solid) {
    if ((g.size ?? 0) < main - 0.01) continue;
    const y = Math.round((g.baselineY ?? g.y) * 2) / 2;
    counts.set(y, (counts.get(y) ?? 0) + 1);
  }
  let base = null, best = -1;
  for (const [y, n] of counts) if (n > best) { base = y; best = n; }
  if (base == null) return;

  for (const g of solid) {
    if (!((g.size ?? 0) < main * SCRIPT_SIZE_RATIO)) continue;
    const dy = (g.baselineY ?? g.y) - base;
    const up = dy < -SCRIPT_MIN_DY && dy > -main * SCRIPT_MAX_UP_EM;
    const down = dy > SCRIPT_MIN_DY && dy < main * SCRIPT_MAX_DOWN_EM;
    if (!up && !down) continue;
    // The MEASURED offset, as a fraction of the em, not a preset. OOXML's
    // `baseline` is an offset ONLY — it does not resize — and the run already
    // carries the source's own smaller size, so a preset would shrink it twice:
    // PowerPoint's subscript is 65% of a size that is already 83% of the line.
    // Positive is RAISED, which is the opposite sign to y.
    g.scriptOffset = -dy / main;
  }
}

export function blockRuns(block, baseIsRtl = true) {
  tagScriptLevels(block);
  const ordered = visualToLogical(withSpaces(block.glyphs), baseIsRtl);
  const runs = [];
  for (const g of ordered) {
    const family = g.family ?? block.family;
    const size = g.size ?? block.size;
    const color = g.color ?? block.color;
    const script = scriptOf(g.c);
    const last = runs[runs.length - 1];
    // Neutrals (spaces, punctuation, brackets) carry no script of their own and
    // simply continue whatever run they are in.
    const scriptOk = !last || script == null || last.script == null || last.script === script;
    const lift = Math.round((g.scriptOffset ?? 0) * 100);
    if (last && last.family === family && last.size === size && sameColor(last.color, color) &&
        scriptOk && (last.lift ?? 0) === lift) {
      last.text += g.c;
      last.x0 = Math.min(last.x0, g.x0);
      last.x1 = Math.max(last.x1, g.x1);
      if (last.script == null) last.script = script;
    } else {
      // The run's SOURCE x-extent. A run's characters are in logical order but
      // its geometry is the visual span its glyphs occupied — that is what a
      // decorative box drawn around part of a line was drawn around, so the
      // writer needs it to keep the two together (see KNOWN_ISSUES, field boxes).
      // rebalanceBrackets may later move one character across a boundary; the
      // resulting error is a single glyph and never decides a split.
      runs.push({ text: g.c, family, size, color, script, lift, x0: g.x0, x1: g.x1 });
    }
  }
  return rebalanceBrackets(runs, baseIsRtl)
    .filter((r) => r.text.length)
    .map((r) => ({ ...r, text: r.text.replace(/\s+/g, " ") }));
}

/**
 * Move a bracket that hugs a Latin island into that island's run.
 *
 * Splitting runs by script fixes PowerPoint's number handling, but it strands
 * the brackets in the Arabic run where they mirror independently of the island
 * they enclose — "(Microsoft Excel 365)" then renders as "((Microsoft Excel 365)".
 * Keeping the pair inside the Latin run makes the whole island one directional
 * unit, which is what it is.
 */
function rebalanceBrackets(runs, baseIsRtl) {
  // Neutrals that belong to the SENTENCE rather than to the island beside them:
  // whitespace, dashes and sentence punctuation. Brackets are excluded because
  // rebalanceBrackets above deliberately pulls those IN — they wrap the island —
  // and so are the operators, which `resolveNeutrals` already decided belong to
  // it (a leading "=" is the formula's, not the sentence's).
  //
  // Measured on every worked example in the corpus: `الخطوة 1 — إجمالي الإنتاج`
  // split as ar `الخطوة ` | en `1 —` | ar ` إجمالي الإنتاج `, and PowerPoint laid
  // the en-US run out as one left-to-right island, so the dash rendered to the
  // RIGHT of the number and the line read `الخطوة — 1`. The dash is the
  // sentence's; only the digit is the island.
  const EDGE_NEUTRAL_LEAD = /^[\s–—،؛؟:.,?!]+/;
  const EDGE_NEUTRAL_TAIL = /[\s–—،؛؟:.,?!]+$/;
  /**
   * The run of edge characters that belong to the SENTENCE, peeled from one end.
   *
   * A sentence separator always does. A BRACKET does when its partner is not in
   * this run: the pull above is pair-gated, so a bracket still sitting alone at
   * an edge was never part of an island. `(1، 2، 3)` splits as en `(1` | ar `، `
   * | en `2` | ar `، ` | en `3)`, and the two lone halves are tagged en-US inside
   * an Arabic paragraph — PowerPoint gives them the island's direction and the
   * line renders `1) ، 2 ، 3(`. An OPERATOR never does: `=SUM(...)` and `$F$2`
   * are the island's own, and every doctor repair runs per run.
   */
  const OPENERS_E = "([{«‹", CLOSERS_E = ")]}»›";
  function peelEdge(text, side) {
    let n = 0;
    for (;;) {
      const k = side === "lead" ? n : text.length - 1 - n;
      const ch = text[k];
      if (!ch || n >= text.length) break;
      if (EDGE_NEUTRAL_LEAD.test(ch)) { n++; continue; }
      const oi = OPENERS_E.indexOf(ch), ci = CLOSERS_E.indexOf(ch);
      const partner = oi >= 0 ? CLOSERS_E[oi] : ci >= 0 ? OPENERS_E[ci] : null;
      if (!partner) break;
      const rest = side === "lead" ? text.slice(k + 1) : text.slice(0, k);
      if (rest.includes(partner)) break;               // the pair is this run's own
      n++;
    }
    return n ? (side === "lead" ? text.slice(0, n) : text.slice(text.length - n)) : "";
  }
  // The wider class for the orphan case below: sentence neutrals PLUS brackets
  // and quotes. A bracket that wraps an Arabic phrase inside a Latin sentence
  // belongs to the sentence, exactly as one wrapping a Latin island inside an
  // Arabic sentence belongs to the island.
  //
  // OPERATORS ARE STILL EXCLUDED, and the reason is a downstream invariant, not
  // taste: every text repair in the doctor runs PER RUN, on the stated grounds
  // that "an expression cannot straddle a run boundary — the whole island is one
  // run". Splitting a leading "%" off `%100` into a run of its own left
  // `numeric-direction` with nothing to match and cost two delivered blocks.
  const OPENERS = "([{«‹";
  const CLOSERS = ")]}»›";

  // A BRACKET MOVES INTO AN ISLAND ONLY AS PART OF A COMPLETE PAIR.
  //
  // Each half used to move on its own, which is right whenever the pair really
  // does wrap the island — `(Microsoft Excel 365)` has both halves adjacent to
  // the Latin run and both come in. It is wrong whenever the pair wraps a MIXED
  // span, because only one half is ever adjacent:
  //
  //   (250 وردية)   ar `... للسنة ` | en `250` | ar ` وردية).`
  //
  // The "(" is next to the Latin run, so it was pulled in and tagged en-US while
  // its ")" stayed Arabic. PowerPoint then gives the two halves opposite
  // directions and the line renders `250) وردية)`. Measured on the finished
  // decks by experiments/verify-run-edges.js: 399 sites over 28 decks, none of
  // which any text gate can see, because the text is correct.
  //
  // Pairing is the whole discriminator, and it is the same one the orphan split
  // below uses: a bracket whose partner is not coming with it belongs to the
  // sentence, not to the island.
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].script !== "Latn") continue;
    const prev = runs[i - 1], next = runs[i + 1];

    const openCh = prev && prev.script !== "Latn" ? prev.text.slice(-1) : "";
    const closeCh = next && next.script !== "Latn" ? next.text.slice(0, 1) : "";
    // `indexOf("")` is 0, not -1, so an ABSENT neighbour would read as the first
    // bracket in the table and move a character that does not exist.
    const oi = openCh ? OPENERS.indexOf(openCh) : -1;
    const ci = closeCh ? CLOSERS.indexOf(closeCh) : -1;

    // The opener may come in if its own closer comes with it, or is already here.
    const openHasPartner = oi >= 0 &&
      (CLOSERS[oi] === closeCh || runs[i].text.includes(CLOSERS[oi]));
    // And symmetrically for the closer.
    const closeHasPartner = ci >= 0 &&
      (OPENERS[ci] === openCh || runs[i].text.includes(OPENERS[ci]));

    if (openHasPartner) {
      runs[i].text = openCh + runs[i].text;
      prev.text = prev.text.slice(0, -1);
    }
    if (closeHasPartner) {
      runs[i].text += closeCh;
      next.text = next.text.slice(1);
    }
  }

  // A space left on the edge of a run whose direction is NOT the paragraph's
  // base gets trimmed by PowerPoint when it lays the run out, so "شريحة 1 من 21"
  // renders as "شريحة 1من 21". Push those spaces into the neighbouring
  // BASE-DIRECTION run; the concatenated text is unchanged, only the run
  // boundary moves.
  //
  // WHICH RUN IS NON-BASE DEPENDS ON THE PARAGRAPH, and reading it as "always
  // the Latin one" is right for an Arabic line and exactly backwards for a
  // Latin one. Measured on the worked-example rows, which are LTR paragraphs
  // ending in an Arabic unit word: the space was pushed OUT of the base Latin
  // run and INTO the ar-SA run, where PowerPoint trimmed it, and
  // `600 ÷ 60 = 10 ساعات عمل` rendered `600 ÷ 60 = 10ساعات عمل` — on every row
  // of every worked example in the corpus.
  const nonBase = baseIsRtl ? "Latn" : "Arab";
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].script !== nonBase) continue;
    const prev = runs[i - 1]?.script !== nonBase ? runs[i - 1] : null;
    const next = runs[i + 1]?.script !== nonBase ? runs[i + 1] : null;
    const lead = peelEdge(runs[i].text, "lead");
    if (lead && prev) { prev.text += lead; runs[i].text = runs[i].text.slice(lead.length); }
    const tail = peelEdge(runs[i].text, "tail");
    if (tail && next) { next.text = tail + next.text; runs[i].text = runs[i].text.slice(0, -tail.length); }
  }

  // Edge neutrals with NOWHERE to go become a run of their own, in the base
  // direction. `rebalanceBrackets` above hands a bracket to the run that owns
  // the island it wraps, and the push above hands a sentence neutral to the
  // neighbouring base run — but neither can act when there is no base run on
  // that side at all. Measured on the bibliography, where the Arabic
  // parenthetical ENDS the line:
  //
  //   en `... Wiley. (`   ar `المرجع التطبيقي للجداول المحورية).`
  //
  // The `).` sat at the tail of an ar-SA run, PowerPoint gave it that run's
  // direction, and it rendered on the far side of the phrase: `(.)المرجع`. The
  // text is right and only the run boundary is wrong, which is why no text gate
  // can see this one.
  const baseScript = baseIsRtl ? "Arab" : "Latn";
  const NEUTRAL_RUN = /^[^\p{L}\p{N}]+$/u;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    // A run that is ALL neutrals is not an island with an edge; leave it alone.
    if (r.script !== nonBase || NEUTRAL_RUN.test(r.text)) continue;
    // The SAME peel the push above uses. It was a second, separate implementation
    // and the two disagreed: this one inspected the INNERMOST character of a tail
    // and looked for its partner only in the run BODY, so `=AVERAGE()` reported
    // its own complete pair as unpaired, split `()` into a run of its own, and
    // PowerPoint drew it on the far side — `()=AVERAGE`. Two copies of one
    // question will eventually answer it differently (EVO-033); there is now one.
    const tail = peelEdge(r.text, "tail");
    if (tail && !runs[i + 1]) {
      r.text = r.text.slice(0, -tail.length);
      runs.splice(i + 1, 0, { ...r, text: tail, script: baseScript });
    }
    const lead = peelEdge(r.text, "lead");
    if (lead && !runs[i - 1]) {
      r.text = r.text.slice(lead.length);
      runs.splice(i, 0, { ...r, text: lead, script: baseScript });
    }
  }

  return runs;
}

/**
 * Script of a character, or null for neutrals.
 *
 * Runs must split on this, not just on typography: PowerPoint decides bidi and
 * number handling per run from its `lang`, so Arabic + Latin + digits inside one
 * `ar-SA` run gets Arabic number treatment and "(Microsoft Excel 365)" renders
 * as "(365Microsoft Excel )". Splitting lets the Latin island be tagged en-US.
 */
export function scriptOf(ch) {
  if (/[؀-ۿݐ-ݿ]/.test(ch)) return "Arab";
    // À-ɏ minus U+00D7 and U+00F7: the multiplication and division signs sit inside
  // Latin-1 Supplement and are not letters. Tagged Latn they become an en-US run
  // of their own, which is a direction boundary where there is no boundary.
  if (/[A-Za-z0-9À-ÖØ-öø-ɏ]/.test(ch)) return "Latn";
  return null;
}

const sameColor = (a, b) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.every((v, i) => Math.abs(v - b[i]) < 0.01));

/**
 * Base direction of a block, decided from its glyphs.
 *
 * Must be computed BEFORE any text is produced and then used everywhere:
 * deriving it from already-reconstructed text is circular, and a block with no
 * Arabic (a bare formula) reconstructed as RTL comes out back to front.
 *
 * The decision itself lives in bidi.js, on the text: the PPTX forensics have to
 * make the same call about the finished XML, and two copies of it would drift.
 */
export const blockIsRtl = (block) => textIsRtl(block.glyphs.map((g) => g.c).join(""));

/** Final logical text for one reconstructed block. */
export function blockText(block, baseIsRtl = true) {
  return visualToLogical(withSpaces(block.glyphs), baseIsRtl)
    .map((g) => g.c)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const mode = (a) => {
  const m = new Map();
  for (const v of a) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((x, y) => y[1] - x[1])[0][0];
};
