/**
 * Does MuPDF give us a cleaner text stream via structured-text options?
 * Measures each candidate option set on page 1 so the choice is evidence-based.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");

const OPTIONS = [
  "preserve-whitespace,preserve-spans",
  "preserve-whitespace,preserve-spans,inhibit-spaces",
  "preserve-whitespace,preserve-spans,preserve-ligatures",
  "preserve-whitespace,preserve-spans,inhibit-spaces,preserve-ligatures",
  "preserve-spans",
];

const PRESENTATION = /[\uFB50-\uFDFF\uFE70-\uFEFF]/;

for (const opt of OPTIONS) {
  const page = doc.loadPage(1);
  let total = 0, spaces = 0, zeroWidth = 0, presentation = 0;
  try {
    page.toStructuredText(opt).walk({
      onChar(c, origin, font, size, quad) {
        total++;
        if (c === " ") spaces++;
        const w = Math.max(quad[0], quad[2], quad[4], quad[6]) - Math.min(quad[0], quad[2], quad[4], quad[6]);
        if (w < 0.5) zeroWidth++;
        if (PRESENTATION.test(c)) presentation++;
      },
    });
    console.log(
      `${opt.padEnd(66)} chars=${String(total).padStart(4)} spaces=${String(spaces).padStart(3)} zeroW=${String(zeroWidth).padStart(3)} presForm=${presentation}`
    );
  } catch (e) {
    console.log(`${opt.padEnd(66)} ERROR: ${e.message}`);
  }
}
