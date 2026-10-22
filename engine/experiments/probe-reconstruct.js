/**
 * PROBE 2 — Reconstruct logical lines from isolated glyphs.
 *
 * Probe 1 established: MuPDF emits one "line" per glyph (Chromium positions
 * every Arabic glyph individually), so any flat asText() read is garbage.
 * The glyphs themselves are base Arabic letters in VISUAL order, carrying
 * origin, font, size, colour and a resolved bidi level each.
 *
 * Here we do the reconstruction the old experiment never did:
 *   1. group glyphs into real lines by baseline
 *   2. sort each line left-to-right by x (visual order)
 *   3. apply UAX#9 rule L2 using MuPDF's per-char levels -> logical order
 * and print the result for inspection against the source HTML.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = process.argv[2] ?? "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const PAGE_INDEX = Number(process.argv[3] ?? 0);

/** Glyphs whose baselines differ by less than this fraction of font size are one line. */
const BASELINE_TOLERANCE = 0.5;
/** Gap larger than this fraction of font size means a word break. */
const SPACE_FACTOR = 0.22;

export function extractGlyphs(page) {
  const stext = page.toStructuredText("preserve-whitespace,preserve-spans");
  const glyphs = [];
  stext.walk({
    onChar(c, origin, font, size, quad, color, bidi) {
      glyphs.push({
        c,
        x: origin[0],
        y: origin[1],
        font: font.getName(),
        size,
        bidi,
        color,
        x0: Math.min(quad[0], quad[2], quad[4], quad[6]),
        x1: Math.max(quad[0], quad[2], quad[4], quad[6]),
        y0: Math.min(quad[1], quad[3], quad[5], quad[7]),
        y1: Math.max(quad[1], quad[3], quad[5], quad[7]),
      });
    },
  });
  return glyphs;
}

/** Group glyphs sharing a baseline into lines, each sorted left-to-right. */
export function groupIntoLines(glyphs) {
  const rows = [];
  for (const g of glyphs) {
    if (!g.c.trim()) continue; // drop the PDF's own spacing glyphs; we re-derive gaps
    const tol = Math.max(g.size * BASELINE_TOLERANCE, 1);
    const row = rows.find((r) => Math.abs(r.y - g.y) <= tol);
    if (row) {
      row.glyphs.push(g);
      row.y = (r_avg(row.glyphs));
    } else {
      rows.push({ y: g.y, glyphs: [g] });
    }
  }
  for (const r of rows) r.glyphs.sort((a, b) => a.x0 - b.x0);
  rows.sort((a, b) => a.y - b.y);
  return rows;
}

const r_avg = (gs) => gs.reduce((s, g) => s + g.y, 0) / gs.length;

/**
 * UAX#9 rule L2, applied to a visually-ordered run to recover logical order:
 * from the highest level down to the lowest odd level, reverse every contiguous
 * subsequence at that level or higher.
 */
export function reorderToLogical(items) {
  const out = items.slice();
  const levels = out.map((g) => g.bidi);
  const maxLevel = Math.max(...levels);
  const minOdd = Math.min(...levels.filter((l) => l % 2 === 1).concat([maxLevel + 1]));
  for (let lvl = maxLevel; lvl >= minOdd; lvl--) {
    let i = 0;
    while (i < out.length) {
      if (out[i].bidi >= lvl) {
        let j = i;
        while (j + 1 < out.length && out[j + 1].bidi >= lvl) j++;
        for (let a = i, b = j; a < b; a++, b--) [out[a], out[b]] = [out[b], out[a]];
        i = j + 1;
      } else i++;
    }
  }
  return out;
}

/** Re-insert spaces from geometry: the PDF's own space glyphs are unreliable. */
export function withSpaces(visualOrdered) {
  const parts = [];
  for (let i = 0; i < visualOrdered.length; i++) {
    const g = visualOrdered[i];
    parts.push(g);
    const next = visualOrdered[i + 1];
    if (!next) continue;
    const gap = next.x0 - g.x1;
    if (gap > g.size * SPACE_FACTOR) {
      parts.push({ c: " ", bidi: Math.min(g.bidi, next.bidi), x0: g.x1, x1: next.x0, size: g.size, synthetic: true });
    }
  }
  return parts;
}

export function lineText(row) {
  const spaced = withSpaces(row.glyphs);
  return reorderToLogical(spaced)
    .map((g) => g.c)
    .join("")
    .trim();
}

// ---------------------------------------------------------------- main ------
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
  const page = doc.loadPage(PAGE_INDEX);
  const glyphs = extractGlyphs(page);
  const rows = groupIntoLines(glyphs);

  console.log("=".repeat(72));
  console.log(`page ${PAGE_INDEX}: ${glyphs.length} glyphs -> ${rows.length} reconstructed lines`);
  console.log("=".repeat(72));

  for (const [i, row] of rows.entries()) {
    const visual = withSpaces(row.glyphs).map((g) => g.c).join("").trim();
    const logical = lineText(row);
    const fonts = [...new Set(row.glyphs.map((g) => g.font.replace(/^[A-Z]{6}\+/, "")))];
    const size = row.glyphs[0].size.toFixed(1);
    console.log(`\n[line ${i}] y=${row.y.toFixed(1)} size=${size} ${fonts.join(",")}`);
    console.log(`  visual : ${JSON.stringify(visual)}`);
    console.log(`  LOGICAL: ${JSON.stringify(logical)}`);
  }
}
