/**
 * GATE: MuPDF is applying /ActualText on the shipping path.
 *
 * This project spent a session building a module to read ActualText spans and
 * apply them, on the belief that MuPDF ignored them. It does not — it has since
 * 1.24, and structured text applies it unless `ignore-actualtext` is passed.
 * The module was re-applying what the library had already done, which is why it
 * duplicated characters (`الاستكشافي` -> `الااستكشافي`) and broke 618 blocks.
 *
 * The proof is the negative control, and it is worth keeping as a test: turning
 * ActualText OFF must lose characters. If this ever stops being true, either the
 * options string changed or the library did, and the extractor is quietly
 * getting less text than it thinks.
 *
 * Usage: node experiments/verify-actualtext-active.js [pdf] [page1based]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = process.argv[2] ?? "C:/Users/mosun/Downloads/final lecs/chp.4/done/Chp4-Lec23-1.pdf";
const PAGE = Number(process.argv[3] ?? 7) - 1;
/** Exactly what src/extract/glyphs.js asks for. Keep the two in step. */
const SHIPPING = "preserve-whitespace,preserve-spans,inhibit-spaces";

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const count = (opts) => {
  let n = 0;
  doc.loadPage(PAGE).toStructuredText(opts).walk({ onChar(c) { if (c !== " ") n++; } });
  return n;
};

const on = count(SHIPPING);
const off = count(`${SHIPPING},ignore-actualtext`);

console.log(`page ${PAGE + 1} of ${PDF.split(/[\\/]/).pop()}`);
console.log(`  shipping options      : ${on} characters`);
console.log(`  + ignore-actualtext   : ${off} characters`);
console.log(`  ActualText contributes: ${on - off}\n`);

if (on > off) {
  console.log("GATE PASS: ActualText is being applied on the shipping path.");
  process.exit(0);
}
console.log("GATE FAIL: turning ActualText off changed nothing, so it is not being applied.");
console.log("  Either the options string in src/extract/glyphs.js changed, or the");
console.log("  mupdf version did. The extractor is receiving less text than it should.");
process.exit(1);
