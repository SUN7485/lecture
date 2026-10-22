/**
 * For every lam-alef ligature the device reports, what does structured text
 * actually emit for it — one character or two, and where?
 *
 * The first repair attempt assumed stext's own decomposition always looks like
 * "lam at the origin + zero-width alef at the lam's right edge". Wiring that in
 * regressed the corpus 81.09% -> 63.28% with 367 blocks gaining a spurious alef,
 * so the assumption is wrong for most ligatures. KNOWN_ISSUES already warns that
 * lam-alef has TWO encodings (zero-width tail OR zero-width lead), which the
 * guard did not cover.
 *
 * Method: a stext glyph that has NO device glyph at its position is a character
 * stext SYNTHESISED — i.e. evidence it decomposed the ligature itself. Classify
 * every ligature by how many such synthesised characters sit within its advance.
 *
 * Read-only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import { deviceGlyphs, posKey, LAM_ALEF_LIGATURES } from "./lib-device-glyphs.js";

const CORPUS = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done";
const files = fs.readdirSync(CORPUS).filter((f) => f.toLowerCase().endsWith(".pdf"));
const SAME_POS = 0.6;

function stextGlyphs(page) {
  const out = [];
  page.toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces").walk({
    onChar(c, origin, font, size, quad) {
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      out.push({ c, x: origin[0], y: origin[1], x0: Math.min(...xs), x1: Math.max(...xs), size });
    },
  });
  return out;
}

const shape = new Map();          // classification -> count
const examples = new Map();
let ligTotal = 0;

for (const file of files) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(path.join(CORPUS, file)), "application/pdf");
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p);
    const dev = deviceGlyphs(page);
    const st = stextGlyphs(page);

    // Which stext characters have no device glyph of their own?
    for (const g of st) g.synthesised = !dev.has(posKey(g.x, g.y));

    for (const [k, ev] of dev) {
      const pair = LAM_ALEF_LIGATURES.get(ev.unicode);
      if (!pair) continue;
      ligTotal++;
      const [lamCh, alefCh] = pair;
      const [xs, ys] = k.split(":").map((v) => Number(v) / 10);

      // stext characters sitting inside this ligature's advance span
      const lo = Math.min(xs, xs + ev.advance) - SAME_POS;
      const hi = Math.max(xs, xs + ev.advance) + SAME_POS;
      const inside = st
        .filter((g) => Math.abs(g.y - ys) < SAME_POS && g.x >= lo && g.x <= hi)
        .sort((a, b) => a.x - b.x);

      const hasLam = inside.some((g) => g.c === lamCh);
      const hasAlef = inside.some((g) => g.c === alefCh);
      const synthAlef = inside.some((g) => g.c === alefCh && g.synthesised);

      const cls =
        hasLam && synthAlef ? "A. decomposed by stext (alef synthesised)" :
        hasLam && hasAlef ? "B. lam + alef, but alef has its OWN device glyph" :
        hasLam ? "C. lam only — ALEF LOST" :
        "D. no lam in span";

      shape.set(cls, (shape.get(cls) ?? 0) + 1);
      if (!examples.has(cls)) {
        examples.set(cls,
          `${file} p${p + 1}  U+${ev.unicode.toString(16).toUpperCase()} at x=${xs.toFixed(2)} adv=${ev.advance.toFixed(2)}\n` +
          "        " + inside.map((g) =>
            `${JSON.stringify(g.c)}@${g.x.toFixed(2)} w=${(g.x1 - g.x0).toFixed(2)}${g.synthesised ? " SYNTH" : " dev"}`
          ).join("  ")
        );
      }
    }
  }
}

console.log(`lam-alef ligature glyphs reported by the device: ${ligTotal}\n`);
for (const [cls, n] of [...shape.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(5)}  ${((n / ligTotal) * 100).toFixed(1).padStart(5)}%  ${cls}`);
  console.log(`        ${examples.get(cls)}\n`);
}
console.log("Only class C needs repair. Classes A and B must be left alone —");
console.log("injecting there is what produced the 367 spurious alefs.");
