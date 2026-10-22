/**
 * DECISIVE EXPERIMENT for the dropped-alef bug.
 *
 * The structured-text walker gives CHARACTERS via ToUnicode, so a glyph with no
 * ToUnicode entry produces nothing. The Device path is different: it hands us a
 * `Text` object whose `showGlyph` callback reports the GLYPH ID and the unicode
 * separately. If the missing alef has a GID but a bad unicode, we can recover it
 * by reverse-mapping the GID through the font itself.
 *
 * Font.encodeCharacter(unicode) -> gid gives us the forward map; iterating the
 * Arabic ranges builds the reverse map with no extra dependency.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const PAGE = 3;
// The word "walinhiraf" sits here; the hole is between x 294.42 and 296.73.
const X_MIN = 285, X_MAX = 302;

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const page = doc.loadPage(PAGE);

const glyphs = [];
let seq = 0;

const device = new mupdf.Device({
  fillText(text, ctm) {
    text.walk({
      showGlyph(font, trm, glyph, unicode) {
        // trm carries the glyph's placement; e/f are the translation.
        glyphs.push({
          gid: glyph,
          unicode,
          char: unicode > 0 ? String.fromCodePoint(unicode) : null,
          x: trm[4],
          y: trm[5],
          font: font.getName(),
          fontRef: font,
          seq: seq++,
        });
      },
    });
  },
  fillPath() {}, strokePath() {}, clipPath() {}, clipStrokePath() {},
  strokeText() {}, clipText() {}, clipStrokeText() {}, ignoreText() {},
  fillShade() {}, fillImage() {}, fillImageMask() {}, clipImageMask() {},
  popClip() {}, beginMask() {}, endMask() {}, beginGroup() {}, endGroup() {},
  beginTile() { return 0; }, endTile() {}, close() {}, drop() {},
});

page.run(device, mupdf.Matrix.identity);
device.close();

console.log(`total glyphs seen via showGlyph: ${glyphs.length}`);

const noUnicode = glyphs.filter((g) => !(g.unicode > 0));
console.log(`glyphs with NO usable unicode: ${noUnicode.length}`);

const win = glyphs
  .filter((g) => g.x >= X_MIN && g.x <= X_MAX && Math.abs(g.y - 177) < 3)
  .sort((a, b) => a.x - b.x);

console.log(`\nWINDOW x=${X_MIN}..${X_MAX} (the word with the dropped alef):`);
console.log("  gid    unicode  char   x        font");
for (const g of win) {
  console.log(
    `  ${String(g.gid).padStart(5)}  ${String(g.unicode).padStart(7)}  ` +
      `${JSON.stringify(g.char ?? "—").padEnd(6)} ${g.x.toFixed(2).padStart(7)}  ${g.font.replace(/^[A-Z]+\+/, "")}`
  );
}

// ---- can we reverse-map a GID back to a character using the font itself? ----
const sample = win.find((g) => g.font.includes("Diodrum")) ?? glyphs[0];
if (sample) {
  const font = sample.fontRef;
  const reverse = new Map();
  // Arabic block + presentation forms + Latin/digits, enough for this corpus.
  const ranges = [[0x0020, 0x007e], [0x0600, 0x06ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]];
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp <= hi; cp++) {
      const gid = font.encodeCharacter(cp);
      if (gid > 0 && !reverse.has(gid)) reverse.set(gid, cp);
    }
  }
  console.log(`\nreverse map built for ${sample.font.replace(/^[A-Z]+\+/, "")}: ${reverse.size} gid->unicode entries`);

  console.log("\nRESOLVING THE WINDOW THROUGH THE REVERSE MAP:");
  for (const g of win) {
    const cp = reverse.get(g.gid);
    const resolved = cp ? String.fromCodePoint(cp) : "UNRESOLVED";
    const adv = g.fontRef.advanceGlyph(g.gid);
    const flag = !(g.unicode > 0) ? "  <-- RECOVERED" : "";
    console.log(`  gid ${String(g.gid).padStart(4)}  toUnicode=${JSON.stringify(g.char ?? "—").padEnd(5)} reverse=${JSON.stringify(resolved).padEnd(5)} adv=${adv.toFixed(3)}${flag}`);
  }
}
