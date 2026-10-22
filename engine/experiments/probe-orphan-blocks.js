/**
 * Letters that are not missing — they are in a block of their own.
 *
 * `Chp1-Lec3-2(New)` slide 9 carries a text block whose entire content is `صّ`
 * and whose width is 0.00pt, sitting inside the x-span of the line
 * `إصدار حكم ني حسب شرط`. The truth is `نصّي`. Nothing was lost: the shadda-
 * carrying letter was split into a separate block, and the word it belongs to
 * reads as ordinary Arabic without it.
 *
 * This is a different defect from `characters-missing` and wants a different
 * repair — a MERGE, not an insertion, which means no character is invented and
 * the bidi pass still decides the order from geometry.
 *
 * Measures: how many such orphans exist, whether a host line can be identified
 * unambiguously, and what merging them does to verbatim accuracy.
 *
 * Usage: node experiments/probe-orphan-blocks.js [--show]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SHOW = process.argv.includes("--show");
/** A block this narrow is not a line of text; it is a fragment of one. */
const ORPHAN_W = 2.0;
/** How far above or below the host's baseline an orphan may sit (pt). */
const HOST_DY = 12.0;

let orphans = 0, hosted = 0, ambiguous = 0, noHost = 0;
let fixed = 0, broken = 0, stillWrong = 0;
const samples = [];

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);
  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p)))
      .map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const truth = slideText[align[p]];
    const blocks = buildLines(extractGlyphs(doc.loadPage(p)));

    const span = (b) => ({
      x0: Math.min(...b.glyphs.map((g) => g.x0)),
      x1: Math.max(...b.glyphs.map((g) => g.x1)),
    });

    for (const orphan of blocks) {
      const s = span(orphan);
      if (s.x1 - s.x0 > ORPHAN_W) continue;
      orphans++;

      // A host is a wider block on a nearby baseline whose span contains the
      // orphan's position. Requiring containment rather than proximity is what
      // keeps this from stealing a fragment onto the wrong line.
      const hosts = blocks.filter((b) => {
        if (b === orphan) return false;
        const h = span(b);
        if (h.x1 - h.x0 <= ORPHAN_W) return false;
        return Math.abs(b.y - orphan.y) <= HOST_DY && s.x0 >= h.x0 - 1 && s.x1 <= h.x1 + 1;
      });

      if (!hosts.length) { noHost++; continue; }
      if (hosts.length > 1) {
        // Prefer the nearest baseline; count how often that is a real choice.
        hosts.sort((a, b) => Math.abs(a.y - orphan.y) - Math.abs(b.y - orphan.y));
        if (Math.abs(hosts[0].y - orphan.y) === Math.abs(hosts[1].y - orphan.y)) { ambiguous++; continue; }
      }
      hosted++;
      const host = hosts[0];

      const before = normalize(blockText(host, blockIsRtl(host)));
      // SPLICE, never re-sort. The host's glyph order is not a plain sort by x —
      // `groupAtomicUnits` has already bound ligature halves, marks and their
      // bases into units whose internal order is deliberate. Re-sorting the
      // merged array by x0 destroys that: measured, it fixed `وسنفل` -> `وسنفصّل`
      // on the same line it broke `الحالات` -> `الحاالت`, `الأسبوع` -> `أالسبوع`
      // and `Effective` -> `Efefctive`. Only the orphan moves.
      const at = host.glyphs.findIndex((g) => g.x0 > orphan.glyphs[0].x0);
      const glyphs = host.glyphs.slice();
      glyphs.splice(at < 0 ? glyphs.length : at, 0, ...orphan.glyphs);
      const merged = { ...host, glyphs };
      const after = normalize(blockText(merged, blockIsRtl(merged)));

      const wasOk = truth.includes(before);
      const isOk = truth.includes(after);
      if (!wasOk && isOk) fixed++;
      else if (wasOk && !isOk) broken++;
      else if (!isOk) stillWrong++;

      if (SHOW && samples.length < 16) {
        samples.push(`${isOk ? "OK  " : "MISS"} ${pair.name} p${p + 1}  orphan "${normalize(blockText(orphan, false))}"`
          + `\n        before: ${before.slice(0, 66)}\n        after : ${after.slice(0, 66)}`);
      }
    }
  }
}

console.log(`orphan blocks (width <= ${ORPHAN_W}pt) : ${orphans}`);
console.log(`  a single containing host line     : ${hosted}`);
console.log(`  two hosts equally near            : ${ambiguous}`);
console.log(`  no containing line at all         : ${noHost}\n`);
console.log(`merging the orphan into its host:`);
console.log(`  FIXED   (miss -> verbatim) : ${fixed}`);
console.log(`  BROKEN  (verbatim -> miss) : ${broken}`);
console.log(`  still wrong                : ${stillWrong}`);
if (SHOW) for (const s of samples) console.log(`\n  ${s}`);
