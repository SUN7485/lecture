/**
 * Attribute every TEXTBOX_HEIGHT and OBJECT_OVERLAP finding to a named family.
 *
 * WHY. `classify.js` counts classes; it does not say what a count MEANS. On the
 * Chrome corpus both classes are near-empty (6 and 21 of 10350 shapes) and the
 * question never arose. On four foreign decks they are 237 and 84 of 1679 — two
 * hundred times denser — and a residue that large cannot be left unattributed,
 * because "0.32% of shapes have a defect" is only a ceiling claim if the
 * remainder is known not to be damage.
 *
 * This file does NOT introduce a new measurement of PowerPoint. It reads the same
 * `measureDeck` output `classify.js` reads and joins it to two things that file
 * never had:
 *
 *   the WRITER'S OWN FORMULA   `write.js` declares a text box of
 *                              `sourceInkHeight + 0.18 x maxFontSize`, with
 *                              inset 0, wrap off, autofit off, valign middle.
 *                              PowerPoint answers `BoundHeight`, which is a LINE
 *                              BOX (ascent + descent + leading). Those are two
 *                              different quantities, so their difference is a
 *                              definition gap until something proves otherwise.
 *
 *   the SOURCE MODEL           whether the PDF itself paints the two blocks
 *                              overlapping. A delivered overlap that the source
 *                              also has is fidelity, not damage.
 *
 * Every rule below is written to be falsifiable, and every population it reports
 * carries its unmatched count — a join that silently drops rows is EVO-039's
 * "not found" wearing a verdict's clothes.
 *
 * Usage: node experiments/delivery/attribute.js <a.pdf> [b.pdf ...] [--reuse]
 *        --reuse   measure the deck already in out/delivery instead of rebuilding.
 *                  REFUSED when any src/web file is newer than the deck.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import { modelFromPdf } from "../../src/model/normalize.js";
import { writePptx } from "../../src/pptx/write.js";
import { applyFixes, DEFAULT_REPAIRS } from "../../web/doctor.js";
import { requireSubjects } from "../lib-gate.js";
import { measureDeck } from "./measure.js";

const OUT = path.resolve("out/delivery");
const REUSE = process.argv.includes("--reuse");
const JSON_OUT = process.argv.includes("--json")
  ? process.argv[process.argv.indexOf("--json") + 1]
  : "out/delivery/attribute.json";
const FILES = process.argv.slice(2).filter((a) => !a.startsWith("--") && fs.existsSync(a) && /\.pdf$/i.test(a));

/** Same tolerances as classify.js. Changing one here would compare two populations. */
const FIT_TOL = 0.75;
const OVERLAP_TOL = 1.0;
const EMU_PER_PT = 12700;
/** write.js: the declared box is the source ink height plus this share of the type size. */
const BASELINE_TRIM = 0.18;
/**
 * A single line's rendered extent, as a multiple of its type size, may plausibly
 * be a LINE BOX. Real font line boxes run about 1.0 (tight Latin) to 1.6 (Arabic
 * faces with deep descenders); above that the number is not a line box and the
 * finding needs reading by hand rather than filing.
 */
const LINEBOX_MAX = 1.75;

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const round = (v, n = 2) => (v == null ? null : +v.toFixed(n));

/** Every shape offset the package DECLARES, per slide, in points. (Same as classify.js.) */
async function declaredBoxes(deck) {
  const zip = await JSZip.loadAsync(fs.readFileSync(deck));
  const per = new Map();
  for (const n of Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))) {
    const xml = await zip.file(n).async("string");
    const boxes = [];
    for (const m of xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)) {
      const b = { x: +m[1] / EMU_PER_PT, y: +m[2] / EMU_PER_PT, w: +m[3] / EMU_PER_PT, h: +m[4] / EMU_PER_PT };
      if (b.w > 0 && b.h > 0) boxes.push(b);
    }
    per.set(+n.match(/\d+/)[0], boxes);
  }
  return per;
}

/** Newest mtime under src/ and web/ — a reused deck older than this is stale. */
function newestSourceMtime() {
  let newest = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  for (const d of ["src", "web"]) if (fs.existsSync(d)) walk(d);
  return newest;
}

/**
 * Join a rendered shape back to the source block it came from.
 *
 * `segmentByFieldBoxes` and `tableSegments` split one source block into several
 * shapes, so this is many-to-one and cannot be an equality test. A shape matches
 * a source block when its text is a substring of the block's and its declared box
 * sits inside the block's ink box; ties break on containment area.
 *
 * @returns {{obj:object|null, why:string}}
 */
function joinToSource(shape, textObjects) {
  const t = norm(shape.text);
  if (!t) return { obj: null, why: "empty-text" };
  const byText = textObjects.filter((o) => norm(o.text).includes(t));
  if (byText.length === 1) return { obj: byText[0], why: "unique-text" };
  const pool = byText.length ? byText : textObjects;
  if (!pool.length) return { obj: null, why: "no-text-objects-on-page" };

  // Declared box vs source ink box. write.js insets the box by lead/2 vertically,
  // so the source box is the SMALLER one and containment runs the other way.
  const sx = shape.left, sy = shape.top, sw = shape.width, sh = shape.height;
  if (sx == null) return { obj: null, why: byText.length ? "ambiguous-text-no-geometry" : "no-text-match" };
  let best = null, bestScore = 0;
  for (const o of pool) {
    const ox = Math.min(sx + sw, o.bbox.x + o.bbox.w) - Math.max(sx, o.bbox.x);
    const oy = Math.min(sy + sh, o.bbox.y + o.bbox.h) - Math.max(sy, o.bbox.y);
    if (ox <= 0 || oy <= 0) continue;
    const score = (ox * oy) / Math.max(sw * sh, 0.01);
    if (score > bestScore) { bestScore = score; best = o; }
  }
  if (!best) return { obj: null, why: byText.length ? "text-match-no-overlap" : "no-match" };
  return { obj: best, why: byText.length ? "text+geometry" : "geometry-only" };
}

// ---------------------------------------------------------------------------

requireSubjects(FILES.length, "PDFs", "usage: attribute.js <a.pdf> [b.pdf ...] [--reuse]");
fs.mkdirSync(OUT, { recursive: true });
const NEWEST_SRC = newestSourceMtime();

const heights = [];
const overlaps = [];
const allShapes = [];          // the CONTROL population: every text shape, finding or not
const joinFailures = new Map();
let decks = 0, slides = 0, textShapes = 0;

for (const pdf of FILES) {
  const name = path.basename(pdf).replace(/\.pdf$/i, "");
  const deck = path.join(OUT, `${name}.pptx`);
  const model = modelFromPdf(pdf);
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

  if (REUSE && fs.existsSync(deck) && fs.statSync(deck).mtimeMs >= NEWEST_SRC) {
    console.log(`  ${name}: reusing deck built ${new Date(fs.statSync(deck).mtimeMs).toISOString()}`);
  } else {
    if (REUSE) console.log(`  ${name}: deck missing or older than src/ — rebuilding`);
    await writePptx(model, deck);
  }

  const declared = await declaredBoxes(deck);
  const m = measureDeck(deck);
  if (!m.ok) { console.log(`  ${name}: MEASUREMENT FAILED ${m.error}`); continue; }
  decks++; slides += m.slides.length;

  for (const [si, slide] of m.slides.entries()) {
    const page = model.pages[si];
    const textObjects = (page?.objects ?? []).filter((o) => o.type === "text");
    const texts = slide.shapes.filter((s) => s.hasText);
    textShapes += texts.length;
    const decl = declared.get(si + 1) ?? [];

    const joined = new Map();
    for (const sh of texts) {
      const j = joinToSource(sh, textObjects);
      joined.set(sh, j.obj);
      if (!j.obj) joinFailures.set(j.why, (joinFailures.get(j.why) ?? 0) + 1);

      const innerH = (sh.height ?? 0) - (sh.mT ?? 0) - (sh.mB ?? 0);
      const innerW = (sh.width ?? 0) - (sh.mL ?? 0) - (sh.mR ?? 0);
      const size = sh.fontSize ?? 0;

      allShapes.push({
        deck: name, page: si + 1, size, lines: sh.lines, paras: sh.paragraphs,
        innerH: round(innerH), boundH: round(sh.boundH), innerW: round(innerW), boundW: round(sh.boundW),
        overH: round(sh.boundH != null ? sh.boundH - innerH : null),
        boundHPerEm: size ? round(sh.boundH / size, 3) : null,
        innerHPerEm: size ? round(innerH / size, 3) : null,
        rot: (joined.get(sh)?.rotation ?? 0) || 0,
      });

      if (sh.boundH != null && innerH > 0 && sh.boundH - innerH > FIT_TOL) {
        const src = joined.get(sh);
        heights.push({
          deck: name, page: si + 1, text: norm(sh.text).slice(0, 60),
          innerH: round(innerH), boundH: round(sh.boundH), over: round(sh.boundH - innerH),
          rel: round((sh.boundH - innerH) / innerH, 3),
          size, lines: sh.lines, paras: sh.paragraphs,
          wordWrap: sh.wordWrap, autoSize: sh.autoSize, spaceWithin: sh.spaceWithin,
          fontName: sh.fontName,
          boundHPerEm: size ? round(sh.boundH / size, 3) : null,
          perLinePerEm: size && sh.lines ? round(sh.boundH / sh.lines / size, 3) : null,
          // The writer's own declaration, recomputed from the SOURCE object so a
          // disagreement between formula and package shows up as a family.
          srcInkH: src ? round(src.bbox.h) : null,
          declaredH: src ? round(src.bbox.h + BASELINE_TRIM * Math.max(...src.runs.map((r) => r.fontSizePt), 0)) : null,
          rot: (src?.rotation ?? 0) || 0,
          box: { l: round(sh.left), t: round(sh.top), w: round(sh.width), h: round(sh.height) },
          ink: { l: round(sh.boundL), t: round(sh.boundT), w: round(sh.boundW), h: round(sh.boundH) },
          joined: !!src,
        });
      }
    }

    // ---- ink overlap between two text shapes, with the SOURCE's answer beside it
    const ink = texts.filter((s) => s.boundL != null && s.boundW > 0 && s.boundH > 0);
    for (let a = 0; a < ink.length; a++) {
      for (let b = a + 1; b < ink.length; b++) {
        const A = ink[a], B = ink[b];
        const ox = Math.min(A.boundL + A.boundW, B.boundL + B.boundW) - Math.max(A.boundL, B.boundL);
        const oy = Math.min(A.boundT + A.boundH, B.boundT + B.boundH) - Math.max(A.boundT, B.boundT);
        if (!(ox > OVERLAP_TOL && oy > OVERLAP_TOL)) continue;

        const sa = joined.get(A), sb = joined.get(B);
        let srcOx = null, srcOy = null, sameBlock = null;
        if (sa && sb) {
          sameBlock = sa === sb;
          srcOx = Math.min(sa.bbox.x + sa.bbox.w, sb.bbox.x + sb.bbox.w) - Math.max(sa.bbox.x, sb.bbox.x);
          srcOy = Math.min(sa.bbox.y + sa.bbox.h, sb.bbox.y + sb.bbox.h) - Math.max(sa.bbox.y, sb.bbox.y);
        }
        const size = Math.max(A.fontSize ?? 0, B.fontSize ?? 0);
        overlaps.push({
          deck: name, page: si + 1,
          a: norm(A.text).slice(0, 40), b: norm(B.text).slice(0, 40),
          ox: round(ox), oy: round(oy), size,
          oyPerEm: size ? round(oy / size, 3) : null,
          oxPerEm: size ? round(ox / size, 3) : null,
          // Vertical separation of the two ink centres: two different LINES sit
          // about one line height apart, two shapes drawn on top of each other do not.
          dyCentres: round(Math.abs((A.boundT + A.boundH / 2) - (B.boundT + B.boundH / 2))),
          areaShare: round((ox * oy) / Math.min(A.boundW * A.boundH, B.boundW * B.boundH), 3),
          srcOx: round(srcOx), srcOy: round(srcOy), sameBlock,
          joined: !!(sa && sb),
          aInk: { l: round(A.boundL), t: round(A.boundT), w: round(A.boundW), h: round(A.boundH) },
          bInk: { l: round(B.boundL), t: round(B.boundT), w: round(B.boundW), h: round(B.boundH) },
          aLines: A.lines, bLines: B.lines,
        });
      }
    }

    void decl; // declared boxes are read for the join only; geometry honour is classify.js's job
  }
}

// ---------------------------------------------------------------------------
// FAMILIES. Each rule is one sentence and each one can be wrong out loud.

/**
 * A height finding is a DEFINITION GAP when the rendered extent is a plausible
 * line box for the type actually used: the writer declared the source's INK
 * height and PowerPoint answered with its LINE height, and those never agree.
 */
const heightFamily = (h) => {
  if (h.lines != null && h.paras != null && h.lines > h.paras) return "WRAPPED";
  if (h.rot) return "ROTATED";
  const perLine = h.perLinePerEm;
  if (perLine != null && perLine <= LINEBOX_MAX) return "LINEBOX_VS_INK";
  return "UNEXPLAINED";
};

/**
 * An overlap is inherited when the SOURCE paints the same two blocks overlapping.
 * It is two lines touching when the ink boxes are a line apart and share only a
 * sliver. Everything else is a candidate for damage and gets read by hand.
 */
const overlapFamily = (o) => {
  // A shape whose text is only whitespace cannot be joined to a source block BY
  // TEXT, so it used to land in UNJOINED — a family named after the instrument's
  // failure rather than after anything in the document. It is a segment of a line
  // the field-box splitter cut at a table rule, and its ink is one space wide.
  if (!o.a || !o.b) return "WHITESPACE_SEGMENT";
  if (o.sameBlock) return "SAME_SOURCE_BLOCK";
  if (o.joined && o.srcOx > OVERLAP_TOL && o.srcOy > OVERLAP_TOL) return "SOURCE_OVERLAP";
  if (o.oyPerEm != null && o.oyPerEm <= 0.35 && o.dyCentres > 0) return "ADJACENT_LINE_TOUCH";
  if (!o.joined) return "UNJOINED";
  // The source blocks do NOT overlap (srcOx is negative) and ours do: something we
  // did made a block wider than its source. Read the text before believing it.
  return "CANDIDATE_DAMAGE";
};

for (const h of heights) h.family = heightFamily(h);
for (const o of overlaps) o.family = overlapFamily(o);

const tally = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.family, (m.get(r.family) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);

console.log(`\nATTRIBUTION — ${decks} deck(s) · ${slides} slides · ${textShapes} text shapes\n`);

console.log(`TEXTBOX_HEIGHT — ${heights.length}`);
for (const [f, n] of tally(heights)) console.log(`  ${String(n).padStart(5)}  ${f}`);
{
  const over = heights.map((h) => h.over).sort((a, b) => a - b);
  const rel = heights.map((h) => h.rel).sort((a, b) => a - b);
  console.log(`  overflow pt   p50 ${q(over, 0.5)}  p90 ${q(over, 0.9)}  p99 ${q(over, 0.99)}  max ${over[over.length - 1]}`);
  console.log(`  share of box  p50 ${(q(rel, 0.5) * 100).toFixed(1)}%  p90 ${(q(rel, 0.9) * 100).toFixed(1)}%  max ${(rel[rel.length - 1] * 100).toFixed(1)}%`);
  console.log(`  beyond one em ${heights.filter((h) => h.size && h.over > h.size).length} of ${heights.length}`);
  console.log(`  join failed   ${heights.filter((h) => !h.joined).length}`);
}

// CONTROL (EVO-039): the same ratio over every shape, finding or not. If the
// rendered height is a line box everywhere, a "finding" describes the DECLARED
// box being tight, not the text being too tall.
{
  const withEm = allShapes.filter((s) => s.boundHPerEm != null && s.lines === 1);
  const per = withEm.map((s) => s.boundHPerEm).sort((a, b) => a - b);
  const inner = withEm.map((s) => s.innerHPerEm).sort((a, b) => a - b);
  console.log(`\n  CONTROL over ALL ${withEm.length} single-line text shapes:`);
  console.log(`    PowerPoint boundH / em   p10 ${q(per, 0.1)}  p50 ${q(per, 0.5)}  p90 ${q(per, 0.9)}  max ${per[per.length - 1]}`);
  console.log(`    declared innerH / em     p10 ${q(inner, 0.1)}  p50 ${q(inner, 0.5)}  p90 ${q(inner, 0.9)}  max ${inner[inner.length - 1]}`);
}

console.log(`\nOBJECT_OVERLAP — ${overlaps.length}`);
for (const [f, n] of tally(overlaps)) console.log(`  ${String(n).padStart(5)}  ${f}`);
{
  const oy = overlaps.map((o) => o.oy).sort((a, b) => a - b);
  const share = overlaps.map((o) => o.areaShare).sort((a, b) => a - b);
  console.log(`  oy pt         p50 ${q(oy, 0.5)}  p90 ${q(oy, 0.9)}  max ${oy[oy.length - 1]}`);
  console.log(`  area share    p50 ${(q(share, 0.5) * 100).toFixed(1)}%  p90 ${(q(share, 0.9) * 100).toFixed(1)}%  max ${(share[share.length - 1] * 100).toFixed(1)}%`);
  console.log(`  join failed   ${overlaps.filter((o) => !o.joined).length}`);
}

if (joinFailures.size) {
  console.log(`\n  SOURCE JOIN FAILURES (shapes, not findings):`);
  for (const [why, n] of [...joinFailures].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(5)}  ${why}`);
}

// The worst members of each class, by name, because a benign median hides a tail.
console.log(`\nWORST TEXTBOX_HEIGHT (by absolute overflow):`);
for (const h of [...heights].sort((a, b) => b.over - a.over).slice(0, 12)) {
  console.log(`  ${h.family.padEnd(16)} ${h.deck} p${h.page}  +${h.over}pt over ${h.innerH} at ${h.size}pt  ${h.lines}L/${h.paras}P  boundH/em ${h.boundHPerEm}  ${JSON.stringify(h.text.slice(0, 34))}`);
}
console.log(`\nWORST OBJECT_OVERLAP (by overlapped area share):`);
for (const o of [...overlaps].sort((a, b) => b.areaShare - a.areaShare).slice(0, 12)) {
  console.log(`  ${o.family.padEnd(20)} ${o.deck} p${o.page}  ${o.ox}x${o.oy}pt (${(o.areaShare * 100).toFixed(0)}% of smaller) src ${o.srcOx}x${o.srcOy}  ${JSON.stringify(o.a.slice(0, 22))} / ${JSON.stringify(o.b.slice(0, 22))}`);
}

fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
fs.writeFileSync(JSON_OUT, JSON.stringify({ decks, slides, textShapes, heights, overlaps, allShapes }, null, 1), "utf8");
console.log(`\nwrote ${JSON_OUT}\n`);
