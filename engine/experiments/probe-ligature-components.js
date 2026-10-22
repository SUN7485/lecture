/**
 * What does a repair have to KNOW, if the font is going to state it?
 *
 * `arityOfName` already reads the count out of `lam_yehar.fina.rlig`. A repair
 * needs the COMPONENTS, which means turning AFDKO part names into characters —
 * and that is only honest if the vocabulary is small, closed and unambiguous.
 * This prints every distinct component name used by every ligature glyph in the
 * corpus, with how many glyphs use it, so the size of that table is a measured
 * fact rather than an assumption.
 *
 *   node experiments/probe-ligature-components.js
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { findPairs } from "../src/truth/corpus.js";

// The reader is not exported, so this walks the same descriptors ligatureArity
// walks and re-uses its glyphNames via a dynamic import of the module internals.
const { glyphNamesOf } = await (async () => {
  const src = fs.readFileSync("src/extract/cff-names.js", "utf8");
  // `glyphNames` is module-private; expose it by evaluating the module with an
  // extra export appended, which keeps the production file untouched.
  const patched = src + "\nexport { glyphNames as glyphNamesOf };\n";
  const url = "data:text/javascript;base64," + Buffer.from(patched).toString("base64");
  return import(url);
})();

const parts = new Map();
const byFont = new Map();
const seenFonts = new Set();

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const pdf = doc.asPDF();
  for (let i = 1; i < pdf.countObjects(); i++) {
    let o;
    try { o = pdf.newIndirect(i).resolve(); } catch { continue; }
    if (!o?.isDictionary?.() || String(o.get("Type")) !== "/FontDescriptor") continue;
    const font = String(o.get("FontName")).replace(/^\/[A-Z]{6}\+/, "").replace(/^\//, "");
    if (seenFonts.has(font)) continue;

    let stream = null;
    for (const k of ["FontFile3", "FontFile2", "FontFile"]) {
      const v = o.get(k);
      if (v && !v.isNull()) { stream = v; break; }
    }
    if (!stream) continue;
    let names;
    try { names = glyphNamesOf(Buffer.from(stream.readStream().asUint8Array())); } catch { continue; }
    if (!names) continue;
    seenFonts.add(font);

    let ligs = 0;
    for (const n of names) {
      if (typeof n !== "string" || !n.includes("_")) continue;
      ligs++;
      for (const p of n.split(".")[0].split("_")) parts.set(p, (parts.get(p) ?? 0) + 1);
    }
    byFont.set(font, ligs);
  }
}

console.log("fonts with ligature-named glyphs:");
for (const [f, n] of byFont) console.log(`  ${String(n).padStart(5)}  ${f}`);
console.log(`\ndistinct component names: ${parts.size}`);
for (const [p, n] of [...parts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${p}`);
