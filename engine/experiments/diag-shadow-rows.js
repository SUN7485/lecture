/**
 * How many glyphs does the ROW-level shadow pass remove, per deck?
 *
 * This is the one path by which excluding shadow evidence can change DELIVERED
 * TEXT rather than only the doctor's verdict: `sourceEvidence` counts lam-alef
 * ligatures to set `lamAlefLost`, and `repairStrandedFathatan` inserts `لا`
 * rather than `ا` when it is true. Tatweel and space cannot reach that count —
 * neither owes two characters — so a deck with no row-shadow drops cannot have
 * had its text changed by the exclusion at all.
 *
 * Usage: node experiments/diag-shadow-rows.js [--only <deckId>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import { extractGlyphs } from "../src/extract/glyphs.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { release } from "../src/extract/mupdf-lifetime.js";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CORPUS = JSON.parse(fs.readFileSync(path.join(HERE, "benchmark/corpus.json"), "utf8"));
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };
const only = argOf("--only", null);

console.log("deck                     rowShadowGlyphs   ligatureAmongThem   pagesAffected");
for (const deck of CORPUS.decks.filter((d) => !only || d.id === only)) {
  if (!fs.existsSync(deck.path)) continue;
  const doc = mupdf.Document.openDocument(fs.readFileSync(deck.path), "application/pdf");
  let arity = null;
  try { arity = ligatureArity(doc.asPDF?.()); } catch {}
  let total = 0, ligs = 0, pages = 0;
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      const g = extractGlyphs(page, arity);
      const rows = g.shadowRowGlyphs ?? [];
      if (rows.length) pages++;
      total += rows.length;
      // A dropped glyph that is part of a lam-alef pair is the only kind that
      // can move `lamAlefLost`, and therefore the only kind that can move text.
      ligs += rows.filter((x) => /[لاآأإﻵ-ﻼ]/u.test(x.c ?? "")).length;
    } finally { release(page); }
  }
  release(doc);
  console.log(`${deck.id.padEnd(24)} ${String(total).padStart(15)} ${String(ligs).padStart(19)} ${String(pages).padStart(15)}`);
}
