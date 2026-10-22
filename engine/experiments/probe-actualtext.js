/**
 * Can an ActualText span be matched to the glyph it wraps?
 *
 * The producer records the logical text of every reversed Arabic run in a
 * marked-content span, and 569 characters per deck are carried there that
 * structured text never returns — the ligatures. MuPDF does not consume them.
 *
 * Reading them is easy. Placing them is the whole question: a repair needs to
 * know WHICH glyph a span belongs to, and the span lives in the content stream
 * while the glyph comes from the text extractor. This tests the cheapest
 * possible answer — that both are emitted in the same order, so span i belongs
 * to glyph i.
 *
 * Usage: node experiments/probe-actualtext.js [pdf] [page1based]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs } from "../src/extract/glyphs.js";

const PDF = process.argv[2] ?? "C:/Users/mosun/Downloads/final lecs/chp.4/done/Chp4-Lec23-1.pdf";
const PAGE = Number(process.argv[3] ?? 7) - 1;

/**
 * Every ActualText span on a page, in content-stream order.
 *
 * Chromium emits `/Span <</ActualText <FEFF…>>> BDC … EMC` around each run it
 * reverses. The hex is UTF-16BE, with an optional byte-order mark.
 */
export function actualTextSpans(pdf, pageIndex) {
  const contents = pdf.loadPage(pageIndex).getObject().get("Contents");
  if (!contents || contents.isNull()) return [];
  const src = Buffer.from(contents.readStream().asUint8Array()).toString("latin1");

  const spans = [];
  const re = /<<\s*\/ActualText\s*<([0-9A-Fa-f]+)>\s*>>\s*BDC([\s\S]*?)EMC/g;
  let m;
  while ((m = re.exec(src))) {
    let hex = m[1];
    if (hex.slice(0, 4).toUpperCase() === "FEFF") hex = hex.slice(4);
    let text = "";
    for (let i = 0; i + 3 < hex.length; i += 4) text += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    // How many glyphs the span actually paints: Tj shows one string, TJ shows an
    // array of them. Counting them is what lets a 2-character span over ONE
    // glyph be recognised as a ligature rather than as ordinary text.
    const body = m[2];
    const shows = (body.match(/\((?:\\.|[^\\)])*\)\s*Tj|<[0-9A-Fa-f\s]*>\s*Tj|\[[\s\S]*?\]\s*TJ/g) ?? []).length;
    spans.push({ text, shows, body: body.trim() });
  }
  return spans;
}

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const spans = actualTextSpans(doc.asPDF(), PAGE);
const glyphs = extractGlyphs(doc.loadPage(PAGE)).filter((g) => g.c !== " ");

const chars = spans.reduce((n, s) => n + [...s.text].length, 0);
const multi = spans.filter((s) => [...s.text].length > 1);

console.log(`ActualText spans        : ${spans.length}`);
console.log(`characters they carry   : ${chars}`);
console.log(`spans carrying 2+ chars : ${multi.length}`);
console.log(`structured-text glyphs  : ${glyphs.length}  (spaces excluded)\n`);

const showCounts = new Map();
for (const s of spans) showCounts.set(s.shows, (showCounts.get(s.shows) ?? 0) + 1);
console.log(`text-showing operators per span: ${[...showCounts].sort().map(([k, v]) => `${k}x${v}`).join("  ")}`);

// If every span paints exactly one glyph, span order IS glyph order and the
// match is an index. Anything else needs real content-stream positioning.
const oneToOne = [...showCounts.keys()].every((k) => k === 1);
console.log(`every span paints exactly one glyph: ${oneToOne}\n`);

console.log("first 14 spans against the glyphs at the same index:");
console.log("  idx  ActualText      stext   agree");
for (let i = 0; i < Math.min(14, spans.length); i++) {
  const a = spans[i].text, g = glyphs[i]?.c ?? "—";
  const agree = [...a].length === 1 ? (a === g ? "yes" : "NO") : ([...a].includes(g) ? "contains" : "NO");
  console.log(`  ${String(i).padStart(3)}  ${JSON.stringify(a).padEnd(14)}  ${JSON.stringify(g).padEnd(6)}  ${agree}`);
}

// The real test: walking both in order, does every single-character span match
// its glyph, and does every multi-character span contain it?
let matched = 0, contained = 0, wrong = 0;
for (let i = 0; i < Math.min(spans.length, glyphs.length); i++) {
  const a = [...spans[i].text], g = glyphs[i].c;
  if (a.length === 1 && a[0] === g) matched++;
  else if (a.length > 1 && a.includes(g)) contained++;
  else wrong++;
}
console.log(`\nindex alignment over ${Math.min(spans.length, glyphs.length)} pairs:`);
console.log(`  single-char span equals the glyph : ${matched}`);
console.log(`  multi-char span contains it       : ${contained}`);
console.log(`  disagree                          : ${wrong}`);
