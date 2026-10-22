/**
 * Can the deficit be attributed to a WORD instead of a whole baseline?
 *
 * The font-named ligature repair scores 71 fixed / 1 broken, and the single
 * failure is a row that is short by one character SOMEWHERE ELSE while the
 * ligature the repair spends it on is already complete. A baseline is simply too
 * coarse a unit to attribute a missing character to.
 *
 * A word is not. Both streams see the same spaces — the device paints U+0020
 * with a real advance and structured text emits it — so a row splits into the
 * same segments on both sides without any block machinery, and the repair can
 * ask "is THIS word short" instead of "is this line short".
 *
 * This prints the two sites that decide it, plus the corpus-wide count of
 * ligatures that a word-level gate would treat differently from a row-level one.
 *
 *   node experiments/probe-word-deficit.js [--show 12]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { deviceGlyphs } from "../src/extract/ligatures.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { findPairs } from "../src/truth/corpus.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const SHOW = Number(arg("show", 12));
const SAME_BASELINE = 0.6;

/** Split a row into words on its space glyphs, right to left. */
function words(items, isSpace) {
  const sorted = items.slice().sort((a, b) => b.x - a.x);
  const out = [];
  let cur = [];
  for (const it of sorted) {
    if (isSpace(it)) { if (cur.length) out.push(cur); cur = []; continue; }
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out;
}

const cells = { rowShortWordShort: 0, rowShortWordWhole: 0, rowWhole: 0 };
const samples = [];

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const arity = ligatureArity(doc.asPDF());

  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p);
    const devs = deviceGlyphs(page, arity);
    const raw = [];
    page.toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces")
      .walk({ onChar(c, origin) { raw.push({ c, x: origin[0], y: origin[1] }); } });

    const rows = new Map();
    for (const d of devs) {
      const k = Math.round(d.y * 10);
      if (!rows.has(k)) rows.set(k, { dev: [], st: [] });
      rows.get(k).dev.push(d);
    }
    for (const g of raw) {
      for (let k = Math.round(g.y * 10) - 6; k <= Math.round(g.y * 10) + 6; k++) {
        if (rows.has(k)) { rows.get(k).st.push(g); break; }
      }
    }

    for (const [, row] of rows) {
      const ligs = row.dev.filter((d) => d.parts?.length >= 2);
      if (!ligs.length) continue;
      const rowDeficit = row.dev.reduce((s, d) => s + d.owed, 0) - row.st.length;

      const devWords = words(row.dev, (d) => d.unicode === 0x20 || d.unicode === 0xa0);
      const stWords = words(row.st, (g) => /\s/.test(g.c));

      for (const lig of ligs) {
        const dw = devWords.find((w) => w.includes(lig));
        if (!dw) continue;
        const lo = Math.min(...dw.map((d) => d.x)), hi = Math.max(...dw.map((d) => d.x + d.advance));
        // The structured-text word that covers the same ground.
        const sw = stWords.find((w) => w.some((g) => g.x >= lo - 0.6 && g.x <= hi + 0.6)) ?? [];
        const wordDeficit = dw.reduce((s, d) => s + d.owed, 0) - sw.length;

        if (rowDeficit <= 0) cells.rowWhole++;
        else if (wordDeficit > 0) cells.rowShortWordShort++;
        else {
          cells.rowShortWordWhole++;                     // the row-level gate over-fires here
          if (samples.length < SHOW) {
            samples.push(`${pair.name} p${p + 1} y=${lig.y.toFixed(1)}  lig ${JSON.stringify(lig.parts.join(""))}` +
              `  row deficit ${rowDeficit}, word deficit ${wordDeficit}` +
              `\n      word: ${JSON.stringify(sw.map((g) => g.c).join(""))}   ${dw.length} glyphs owing ${dw.reduce((s, d) => s + d.owed, 0)}`);
          }
        }
      }
    }
  }
}

console.log(`ligatures examined on a row the ROW gate calls short:`);
console.log(`  ${String(cells.rowShortWordShort).padStart(5)}  the word is short too   -> both gates repair`);
console.log(`  ${String(cells.rowShortWordWhole).padStart(5)}  the word is COMPLETE    -> the row gate over-fires here`);
console.log(`  ${String(cells.rowWhole).padStart(5)}  the row is not short at all (neither gate fires)`);
console.log();
for (const s of samples) console.log(`  ${s}`);
