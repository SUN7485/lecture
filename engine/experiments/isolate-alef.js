/**
 * Isolate the dropped-alef case: "والانحراف" reconstructs as "ولانحراف".
 * Dumps the raw walk order (before any grouping/sorting) around the word.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const PAGE = Number(process.argv[2] ?? 3);

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const st = doc.loadPage(PAGE).toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces");

const gs = [];
let seq = 0;
st.walk({
  onChar(c, origin, font, size, quad) {
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    gs.push({
      c, x: origin[0], y: origin[1],
      x0: Math.min(...xs), x1: Math.max(...xs), seq: seq++,
    });
  },
});

// "والانحراف" in visual order runs ...ف ا ر ح ن ا ل ا و... (reversed).
// Anchor on the ن whose neighbour is ح.
const at = gs.findIndex((g, i) => g.c === "ن" && gs[i + 1] && gs[i + 1].c === "ا");
const from = at >= 0 ? Math.max(0, at - 3) : 0;

console.log(`page ${PAGE}, raw walk order (anchor idx ${at}):`);
console.log("char U+     x        x0      x1      w     y       seq");
for (const g of gs.slice(from, from + 16)) {
  console.log(
    `${JSON.stringify(g.c).padEnd(5)} ${g.c.codePointAt(0).toString(16).padStart(4, "0")}  ` +
      `${g.x.toFixed(2).padStart(7)} ${g.x0.toFixed(2).padStart(7)} ${g.x1.toFixed(2).padStart(7)} ` +
      `${(g.x1 - g.x0).toFixed(2).padStart(5)} ${g.y.toFixed(1).padStart(6)} ${g.seq}`
  );
}
