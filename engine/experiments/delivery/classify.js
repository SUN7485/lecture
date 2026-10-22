/**
 * What is actually wrong with the DELIVERED deck, by class, measured in PowerPoint.
 *
 * Phase 3 of the delivery work. `measure.js` asks PowerPoint what it did; this file
 * compares that against what the package DECLARED and puts every difference in a
 * named class, so the largest one can be fixed first instead of the most recently
 * noticed one.
 *
 * THREE DEFINITIONS THIS FILE GOT WRONG ON ITS FIRST RUN, all corrected here,
 * because an instrument that over-reports sends the whole phase after phantoms:
 *
 *   RTL          reported 382 of 428 shapes as "not RTL" while `verify-pptx` says
 *                370 of 370 paragraphs carry rtl="1" and passes. PowerPoint's
 *                `ParagraphFormat.RightToLeft` returns 0 for every shape and every
 *                paragraph regardless, so it does not answer this question. The
 *                class is DROPPED here: it already has a working gate that reads
 *                the package directly, and duplicating it with a worse instrument
 *                is how a green gate gets argued with.
 *
 *   POSITION     reported 246 shapes as misplaced with dy 1.62, 2.70, 1.21 — which
 *                is exactly `BASELINE_TRIM 0.18 x fontSize`, an offset the writer
 *                applies ON PURPOSE. Comparing PowerPoint against the MODEL measures
 *                our own deliberate decisions. The real delivery question is whether
 *                PowerPoint honoured what the PACKAGE declared, so that is what is
 *                compared now.
 *
 *   OVERLAP      reported 135 pairs using full textbox boxes. A textbox is as tall
 *                as its line box, so consecutive lines touch by design and none of
 *                that is visible. PowerPoint reports the real painted extent as
 *                `BoundLeft/BoundTop/BoundWidth/BoundHeight`, and INK is what a
 *                reader sees, so ink is what is compared.
 *
 * It does not compare pixels — a photo or antialiasing difference must never move
 * text (EVO-023) — and it does not judge TEXT, which is closed and has its own gates.
 *
 * Usage: node experiments/delivery/classify.js <source.pdf> [more.pdf ...]
 *        node experiments/delivery/classify.js --corpus
 */
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import { modelFromPdf } from "../../src/model/normalize.js";
import { writePptx } from "../../src/pptx/write.js";
import { applyFixes, DEFAULT_REPAIRS } from "../../web/doctor.js";
import { findPairs } from "../../src/truth/corpus.js";
import { requireSubjects } from "../lib-gate.js";
import { measureDeck } from "./measure.js";

const OUT = path.resolve("out/delivery");
const SHOW = Number((process.argv.includes("--show") && process.argv[process.argv.indexOf("--show") + 1]) || 6);
const FILES = process.argv.includes("--corpus")
  ? findPairs().map((p) => p.pdf)
  : process.argv.slice(2).filter((a) => !a.startsWith("--") && fs.existsSync(a));

const EMU_PER_PT = 12700;
/** A rendered extent may exceed its box by this much before it counts (pt). */
const FIT_TOL = 0.75;
/** Two INK boxes overlapping by less than this share only an edge (pt). */
const OVERLAP_TOL = 1.0;
/** PowerPoint moved a shape if it differs from the declaration by more than this. */
const MOVE_TOL = 0.5;
/** A shape this far outside the slide is off it (pt). */
const OFF_TOL = 1.0;

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * How far past its box the text renders, as a SHARE of the box.
 *
 * The count alone cannot decide whether this class matters: with wordWrap off and
 * autofit off, text exceeding its box neither wraps nor clips — it renders a little
 * wider, which is the irreducible difference between two shaping engines. A fix is
 * only justified for overflows large enough for a reader to see.
 */
const overflow = [];
const classes = new Map();
const samples = new Map();
const note = (cls, detail) => {
  classes.set(cls, (classes.get(cls) ?? 0) + 1);
  const s = samples.get(cls) ?? [];
  if (s.length < SHOW) { s.push(detail); samples.set(cls, s); }
};

let decks = 0, textShapes = 0, slides = 0;

requireSubjects(FILES.length, "PDFs", "usage: classify.js <file.pdf> ... | --corpus");
fs.mkdirSync(OUT, { recursive: true });

/** Every shape offset the package DECLARES, per slide, in points. */
async function declaredBoxes(deck) {
  const zip = await JSZip.loadAsync(fs.readFileSync(deck));
  const per = new Map();
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  for (const n of names) {
    const xml = await zip.file(n).async("string");
    const boxes = [];
    for (const m of xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)) {
      const b = { x: +m[1] / EMU_PER_PT, y: +m[2] / EMU_PER_PT, w: +m[3] / EMU_PER_PT, h: +m[4] / EMU_PER_PT };
      // <p:grpSpPr> carries a zero-size child offset/extent that is not a shape.
      // Counting those reported 45 "moved" boxes on a deck where nothing moved.
      if (b.w > 0 && b.h > 0) boxes.push(b);
    }
    per.set(+n.match(/\d+/)[0], boxes);
  }
  return per;
}

for (const pdf of FILES) {
  const name = path.basename(pdf).replace(/\.pdf$/i, "");
  const model = modelFromPdf(pdf);
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

  const deck = path.join(OUT, `${name}.pptx`);
  await writePptx(model, deck);
  const declared = await declaredBoxes(deck);
  const m = measureDeck(deck);
  if (!m.ok) { console.log(`  ${name}: MEASUREMENT FAILED ${m.error}`); continue; }
  decks++; slides += m.slides.length;

  for (const [si, slide] of m.slides.entries()) {
    const texts = slide.shapes.filter((s) => s.hasText);
    textShapes += texts.length;
    const decl = declared.get(si + 1) ?? [];

    for (const sh of texts) {
      const t = norm(sh.text);

      // ---- fit: does the rendered text stay inside its own box? --------------
      const innerW = (sh.width ?? 0) - (sh.mL ?? 0) - (sh.mR ?? 0);
      const innerH = (sh.height ?? 0) - (sh.mT ?? 0) - (sh.mB ?? 0);
      if (sh.boundW != null && innerW > 0 && sh.boundW - innerW > FIT_TOL) {
        overflow.push({ abs: sh.boundW - innerW, rel: (sh.boundW - innerW) / innerW, size: sh.fontSize ?? 0,
                        where: `${name} p${si + 1}`, text: t.slice(0, 40), box: innerW, lines: sh.lines });
        note("TEXTBOX_WIDTH", `${name} p${si + 1} +${(sh.boundW - innerW).toFixed(2)}pt over ${innerW.toFixed(1)}  ${JSON.stringify(t.slice(0, 30))}`);
      }
      if (sh.boundH != null && innerH > 0 && sh.boundH - innerH > FIT_TOL) {
        note("TEXTBOX_HEIGHT", `${name} p${si + 1} +${(sh.boundH - innerH).toFixed(2)}pt over ${innerH.toFixed(1)}  ${JSON.stringify(t.slice(0, 30))}`);
      }

      // ---- line breaks: the model emits ONE paragraph per source line --------
      if (sh.lines != null && sh.paragraphs != null && sh.lines > sh.paragraphs) {
        note("LINE_BREAK", `${name} p${si + 1} ${sh.lines} lines for ${sh.paragraphs} paragraph(s)  ${JSON.stringify(t.slice(0, 30))}`);
      }

      // Position is checked per SLIDE below, as a set. Matching a rendered shape
      // to a declared box by size alone paired the wrong ones and invented 91
      // moves of up to 90pt on a deck where nothing had moved at all.

      // ---- off the slide, by INK ---------------------------------------------
      if (sh.boundL != null && (sh.boundL < -OFF_TOL || sh.boundT < -OFF_TOL ||
          sh.boundL + sh.boundW > m.slideW + OFF_TOL || sh.boundT + sh.boundH > m.slideH + OFF_TOL)) {
        note("OFF_SLIDE", `${name} p${si + 1} ink ${sh.boundL},${sh.boundT} ${sh.boundW}x${sh.boundH} on ${m.slideW}x${m.slideH}`);
      }

      // ---- insets we did not ask for -----------------------------------------
      if ([sh.mL, sh.mR, sh.mT, sh.mB].some((v) => v != null && v > 0.05)) {
        note("INTERNAL_MARGIN", `${name} p${si + 1} margins ${sh.mL}/${sh.mR}/${sh.mT}/${sh.mB}`);
      }
    }

    // ---- did PowerPoint honour the declared geometry? -----------------------
    // As a SET, not by identity. Every declared box should have a rendered box at
    // the same place; a box with no counterpart is one PowerPoint moved or resized.
    // This needs no matching rule, so it cannot invent a move by pairing wrongly.
    {
      // TOLERANCE, not a string key. EMU/12700 gives 386.7xx where PowerPoint reports
      // 386.75, and rounding to one decimal straddles that — which reported 40
      // shapes as moved on a deck whose geometry PowerPoint honoured exactly.
      const rendered = slide.shapes.filter((s2) => s2.left != null);
      const near = (b) => rendered.some((s2) =>
        Math.abs(s2.left - b.x) <= MOVE_TOL && Math.abs(s2.top - b.y) <= MOVE_TOL &&
        Math.abs(s2.width - b.w) <= MOVE_TOL && Math.abs(s2.height - b.h) <= MOVE_TOL);
      for (const b of decl) {
        if (near(b)) continue;
        note("OBJECT_POSITION", `${name} p${si + 1} declared ${b.x.toFixed(1)},${b.y.toFixed(1)} ${b.w.toFixed(1)}x${b.h.toFixed(1)} has no rendered counterpart`);
      }
    }

    // ---- overlap between the INK of two text shapes -------------------------
    const ink = texts.filter((s) => s.boundL != null && s.boundW > 0 && s.boundH > 0);
    for (let a = 0; a < ink.length; a++) {
      for (let b = a + 1; b < ink.length; b++) {
        const A = ink[a], B = ink[b];
        const ox = Math.min(A.boundL + A.boundW, B.boundL + B.boundW) - Math.max(A.boundL, B.boundL);
        const oy = Math.min(A.boundT + A.boundH, B.boundT + B.boundH) - Math.max(A.boundT, B.boundT);
        if (ox > OVERLAP_TOL && oy > OVERLAP_TOL) {
          note("OBJECT_OVERLAP", `${name} p${si + 1} ${ox.toFixed(1)}x${oy.toFixed(1)}pt ink  ${JSON.stringify(norm(A.text).slice(0, 20))} / ${JSON.stringify(norm(B.text).slice(0, 20))}`);
        }
      }
    }
  }
}

console.log(`\nDELIVERY DEFECT CLASSES — ${decks} deck(s) · ${slides} slides · ${textShapes} text shapes\n`);
if (!classes.size) { console.log("  no delivery defect found in any class.\n"); process.exit(0); }

const ranked = [...classes].sort((a, b) => b[1] - a[1]);
for (const [cls, n] of ranked) {
  console.log(`  ${String(n).padStart(6)}  ${cls.padEnd(18)} ${((n / textShapes) * 100).toFixed(2)}% of text shapes`);
}
console.log(`  ${String(ranked.reduce((n, [, v]) => n + v, 0)).padStart(6)}  TOTAL`);

// The COUNT cannot decide whether TEXTBOX_WIDTH is worth fixing. With wordWrap off
// and autofit off, text wider than its box neither wraps nor clips — it renders a
// little wider, which is the irreducible difference between two shaping engines.
// Only the MAGNITUDE says whether a reader could see it.
if (overflow.length) {
  const rel = overflow.map((o) => o.rel).sort((a, b) => a - b);
  const abs = overflow.map((o) => o.abs).sort((a, b) => a - b);
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  console.log(`\n  TEXTBOX_WIDTH overflow — wordWrap is OFF, so this neither wraps nor clips:`);
  console.log(`     absolute pt   p50 ${q(abs, 0.5).toFixed(2)}  p90 ${q(abs, 0.9).toFixed(2)}  p99 ${q(abs, 0.99).toFixed(2)}  max ${abs[abs.length - 1].toFixed(2)}`);
  console.log(`     share of box  p50 ${(q(rel, 0.5) * 100).toFixed(2)}%  p90 ${(q(rel, 0.9) * 100).toFixed(2)}%  p99 ${(q(rel, 0.99) * 100).toFixed(2)}%  max ${(rel[rel.length - 1] * 100).toFixed(2)}%`);
  console.log(`     wider than one em: ${overflow.filter((o) => o.size && o.abs > o.size).length} of ${overflow.length}`);
  // A benign median can hide a real defect in the tail, so the tail is printed by
  // name. These are the only members of this class a fix could be justified for.
  const big = overflow.filter((o) => o.size && o.abs > o.size).sort((a, b) => b.abs - a.abs);
  if (big.length) {
    console.log(`
  overflow beyond ONE EM — the only members worth a fix:`);
    for (const o of big.slice(0, 12)) {
      console.log(`     ${o.where}  +${o.abs.toFixed(1)}pt over ${o.box.toFixed(1)} (${(o.rel * 100).toFixed(0)}%) at ${o.size}pt, ${o.lines} line(s)`);
      console.log(`        ${JSON.stringify(o.text)}`);
    }
  }
}

for (const [cls, n] of ranked) {
  console.log(`\n${cls} — ${n}, first ${Math.min(SHOW, n)}:`);
  for (const d of samples.get(cls) ?? []) console.log(`   ${d}`);
}
console.log("");
