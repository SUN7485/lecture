/**
 * Which of these PDFs were NOT made by the corpus's one generator?
 *
 * Every accuracy number in this project describes 28 Chrome prints of one HTML
 * template, and nothing in the pipeline can see that. This is the cheapest way
 * to find an input that would actually test it: metadata plus first-page size,
 * which is enough to tell a foreign producer from a reprint of the same
 * template, and fast enough to sweep a whole disk.
 *
 * Usage: node experiments/census-producers.js <file.pdf> [more.pdf ...]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

for (const f of process.argv.slice(2)) {
  try {
    const buf = fs.readFileSync(f);
    const doc = mupdf.Document.openDocument(buf, "application/pdf");
    const [x0, y0, x1, y1] = doc.loadPage(0).getBounds();
    const size = `${(x1 - x0).toFixed(2)}x${(y1 - y0).toFixed(2)}`;
    const prod = doc.getMetaData?.("info:Producer") || "(none)";
    const creat = doc.getMetaData?.("info:Creator") || "(none)";
    const corpus = size === "713.04x487.92" ? "SAME-SIZE" : "";
    console.log(
      [String(doc.countPages()).padStart(4), size.padStart(15), corpus.padEnd(9),
       prod.slice(0, 34).padEnd(35), creat.slice(0, 22).padEnd(23), f.split("/").pop()].join("  ")
    );
  } catch (e) {
    console.log(`   ?  ${"".padStart(15)}  ${"FAILED".padEnd(9)}  ${String(e.message).slice(0, 58).padEnd(59)}  ${f.split("/").pop()}`);
  }
}
