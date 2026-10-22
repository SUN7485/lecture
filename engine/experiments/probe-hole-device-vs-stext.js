/**
 * Is the missing alef PAINTED but unreported, or genuinely absent?
 *
 * probe-dropped-alef-sites.js showed a ~4.1pt horizontal hole immediately to the
 * right of a lam-alef ligature, exactly where a standalone alef belongs, with no
 * glyph emitted by the structured-text path.
 *
 * The two extraction paths disagree in general (device 108,912 glyphs vs stext
 * 111,093 chars corpus-wide), so the question is local, not aggregate:
 *
 *   Does the DEVICE path report a glyph inside that hole?
 *
 *   YES -> the character exists in the content stream and stext is dropping it.
 *          Fix = merge device evidence into extraction. No inference, no risk.
 *   NO  -> nothing is painted there. Fix can only be inference from the gap,
 *          which is what repair.js attempted and got wrong.
 *
 * Read-only.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec1-3(New).pdf";
const PAGE = 1;                 // categorize-misses reports this as p2 (1-indexed)
const HOLE = { xLo: 476.0, xHi: 487.0 };   // the 4.12pt gap plus a margin either side

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const page = doc.loadPage(PAGE);

// ---------- device path ----------
const dev = [];
let seq = 0;
const device = new mupdf.Device({
  // The `ctm` is NOT optional. `trm` is the text-rendering matrix in content
  // -stream space; without concatenating the CTM the reported x/y are in a
  // different space entirely (measured here: 4/3 scale and a y flip vs stext),
  // which is why every position-filtered probe before this one came back empty.
  fillText(text, ctm) {
    text.walk({
      showGlyph(font, trm, glyph, unicode) {
        const cx = ctm[0] * trm[4] + ctm[2] * trm[5] + ctm[4];
        const cy = ctm[1] * trm[4] + ctm[3] * trm[5] + ctm[5];
        dev.push({
          gid: glyph, unicode,
          c: unicode > 0 ? String.fromCodePoint(unicode) : null,
          x: cx, y: cy, rawX: trm[4], rawY: trm[5],
          font: font.getName().replace(/^[A-Z]+\+/, ""),
          adv: font.advanceGlyph(glyph),
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

// ---------- structured-text path (what production uses) ----------
const st = [];
page.toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces").walk({
  onChar(c, origin, font, size, quad) {
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    st.push({
      c, x: origin[0], y: origin[1],
      x0: Math.min(...xs), x1: Math.max(...xs),
      font: font.getName().replace(/^[A-Z]+\+/, ""), size,
    });
  },
});

console.log(`page ${PAGE}:  device glyphs ${dev.length}   stext chars ${st.length}   (delta ${st.length - dev.length})`);

// Do not assume the two paths share a coordinate space — measure it.
const range = (a) => `[${Math.min(...a).toFixed(1)}, ${Math.max(...a).toFixed(1)}]`;
console.log(`  device x ${range(dev.map((g) => g.x))}   y ${range(dev.map((g) => g.y))}`);
console.log(`  stext  x ${range(st.map((g) => g.x))}   y ${range(st.map((g) => g.y))}`);
console.log(`  page bounds ${JSON.stringify(page.getBounds().map((v) => +v.toFixed(2)))}`);
// Same character, same x, in both paths => tells us the y offset directly.
const dl = dev.filter((g) => Math.abs(g.x - 470.81) < 0.6 && g.c === "ل");
console.log(`  device lams at x~470.81: ${dl.map((g) => `y=${g.y.toFixed(2)}`).join(" ") || "(none)"}`);

// The failing block sits on the baseline near y=177 in the earlier dump; find it
// by locating the stext lam at x~470.81 and using its y.
const anchor = st.find((g) => Math.abs(g.x - 470.81) < 0.6 && g.c === "\u0644");
if (!anchor) {
  console.log("could not locate the anchor lam at x~470.81 — dumping nothing.");
  process.exit(0);
}
const Y = anchor.y;
console.log(`anchor lam found at x=${anchor.x.toFixed(2)} y=${Y.toFixed(2)}\n`);

// stext reports y from the TOP of the page; the device runs in PDF user space
// (y up from the bottom), so the same baseline has two different numbers.
// Derive the device's y for this baseline instead of assuming they match.
// With the CTM applied, both paths report the SAME page space (verified above:
// identical x and y ranges), so the baseline y needs no conversion.
const PAGE_H = page.getBounds()[3] - page.getBounds()[1];
const Y_DEV = Y;
const near = (g) => Math.abs(g.y - Y) < 2.5 && g.x >= HOLE.xLo - 12 && g.x <= HOLE.xHi + 12;
const nearDev = near;

console.log(`---- STRUCTURED TEXT in x=[${HOLE.xLo - 12}, ${HOLE.xHi + 12}] ----`);
console.log("    char  codepoint   originX     x0       x1       w");
for (const g of st.filter(near).sort((a, b) => b.x - a.x)) {
  console.log(
    `    ${JSON.stringify(g.c).padEnd(6)} U+${g.c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}    ` +
    `${g.x.toFixed(2).padStart(8)} ${g.x0.toFixed(2).padStart(8)} ${g.x1.toFixed(2).padStart(8)} ${(g.x1 - g.x0).toFixed(2).padStart(6)}`
  );
}

console.log(`\n---- DEVICE PATH in the same band (device y=${Y_DEV.toFixed(2)}, page height ${PAGE_H.toFixed(2)}) ----`);
console.log("    gid   char  codepoint   originX    advance   font");
for (const g of dev.filter(nearDev).sort((a, b) => b.x - a.x)) {
  console.log(
    `    ${String(g.gid).padStart(4)}  ${JSON.stringify(g.c ?? "—").padEnd(6)} ` +
    `U+${(g.unicode > 0 ? g.unicode : 0).toString(16).toUpperCase().padStart(4, "0")}    ` +
    `${g.x.toFixed(2).padStart(8)} ${g.adv.toFixed(3).padStart(9)}   ${g.font}`
  );
}

// ---------- the verdict ----------
const inHole = (g) => Math.abs(g.y - Y) < 2.5 && g.x > HOLE.xLo && g.x < HOLE.xHi;
const inHoleDev = (g) => Math.abs(g.y - Y_DEV) < 2.5 && g.x > HOLE.xLo && g.x < HOLE.xHi;
const devHole = dev.filter(inHoleDev);
const stHole = st.filter(inHole);

console.log(`\n================ VERDICT ================`);
console.log(`glyphs the DEVICE path reports inside the hole (x ${HOLE.xLo}..${HOLE.xHi}): ${devHole.length}`);
for (const g of devHole) console.log(`   gid ${g.gid} ${JSON.stringify(g.c ?? "—")} x=${g.x.toFixed(2)} adv=${g.adv.toFixed(3)}`);
console.log(`chars the STEXT path reports inside the hole: ${stHole.length}`);
for (const g of stHole) console.log(`   ${JSON.stringify(g.c)} x=${g.x.toFixed(2)}`);

if (devHole.length > stHole.length) {
  console.log("\n=> DEVICE SEES IT, STEXT DOES NOT. The character is in the content");
  console.log("   stream and is recoverable exactly. Merge device evidence; no inference.");
} else if (devHole.length === 0 && stHole.length === 0) {
  console.log("\n=> NOTHING IS PAINTED THERE. The alef is absent from the content stream;");
  console.log("   only inference from the gap can recover it (repair.js's approach).");
} else {
  console.log("\n=> Both paths agree. The hole is not where this probe looked.");
}
