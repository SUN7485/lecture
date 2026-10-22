/**
 * Ask the FONT how many characters a glyph carries.
 *
 * Every route through the document is closed (probe-glyph-arity*.js,
 * probe-glyph-selfarity.js, probe-arity-table.js): the advance does not separate
 * ligatures from wide letters in any font, arity is not inferable from which
 * blocks a glyph appears on, and it cannot be self-calibrated because the loss
 * is 100% consistent — 60 of 60 occurrences of the `لي` glyph yield one
 * character, never two.
 *
 * What is left is the font's own GSUB table, which states outright that glyph X
 * is the ligature of glyphs A + B. The fonts are subset-EMBEDDED in the PDF and
 * their bytes are reachable through the object tree, so this needs no external
 * font files and no ground truth — it works on any PDF that embeds its fonts.
 *
 * This reads GSUB LookupType 4 (Ligature Substitution) directly rather than
 * adding a font-parsing dependency, because the question here is only "how many
 * components", not "shape this text". ~120 lines against a library the project
 * has deliberately gone without.
 *
 * Usage: node experiments/probe-gsub-arity.js [pdf] [glyphId]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = process.argv[2] ?? "C:/Users/mosun/Downloads/final lecs/chp.4/done/Chp4-Lec23-1.pdf";
const WANT = Number(process.argv[3] ?? 612);

// ---- pull the embedded font programs out of the PDF -------------------------
function embeddedFonts(pdf) {
  const out = [];
  for (let i = 1; i < pdf.countObjects(); i++) {
    let o;
    try { o = pdf.newIndirect(i).resolve(); } catch { continue; }
    if (!o?.isDictionary?.() || String(o.get("Type")) !== "/FontDescriptor") continue;
    for (const k of ["FontFile", "FontFile2", "FontFile3"]) {
      const ff = o.get(k);
      if (!ff || ff.isNull()) continue;
      // The KEY is not the format. Every Arabic font here is declared FontFile2
      // — which the spec reserves for TrueType — and every one of them starts
      // "OTTO", i.e. CFF-based OpenType. Believe the magic, not the dictionary.
      out.push({
        name: String(o.get("FontName")).replace(/^\/(?:[A-Z]{6}\+)?/, ""),
        bytes: Buffer.from(ff.readStream().asUint8Array()),
      });
    }
  }
  return out;
}

// ---- the smallest sfnt reader that can answer the question ------------------
const u16 = (b, o) => b.readUInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);

function tableOffset(b, tag) {
  const numTables = u16(b, 4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (b.toString("latin1", rec, rec + 4) === tag) return u32(b, rec + 8);
  }
  return -1;
}

function coverageGlyphs(b, off) {
  const format = u16(b, off);
  const out = [];
  if (format === 1) {
    const n = u16(b, off + 2);
    for (let i = 0; i < n; i++) out.push(u16(b, off + 4 + i * 2));
  } else if (format === 2) {
    const n = u16(b, off + 2);
    for (let i = 0; i < n; i++) {
      const r = off + 4 + i * 6;
      for (let g = u16(b, r); g <= u16(b, r + 2); g++) out.push(g);
    }
  }
  return out;
}

/** ligature glyph id -> component glyph ids (including the first). */
function ligatures(b) {
  const gsub = tableOffset(b, "GSUB");
  const map = new Map();
  if (gsub < 0) return map;

  const lookupList = gsub + u16(b, gsub + 8);
  const lookupCount = u16(b, lookupList);

  const readLigatureSubst = (sub) => {
    if (u16(b, sub) !== 1) return;                       // only format 1 exists
    const cov = coverageGlyphs(b, sub + u16(b, sub + 2));
    const setCount = u16(b, sub + 4);
    for (let s = 0; s < setCount; s++) {
      const set = sub + u16(b, sub + 6 + s * 2);
      const ligCount = u16(b, set);
      for (let l = 0; l < ligCount; l++) {
        const lig = set + u16(b, set + 2 + l * 2);
        const ligGlyph = u16(b, lig);
        const compCount = u16(b, lig + 2);
        const comps = [cov[s]];
        for (let c = 0; c < compCount - 1; c++) comps.push(u16(b, lig + 4 + c * 2));
        map.set(ligGlyph, comps);
      }
    }
  };

  for (let i = 0; i < lookupCount; i++) {
    const lookup = lookupList + u16(b, lookupList + 2 + i * 2);
    const type = u16(b, lookup);
    const subCount = u16(b, lookup + 4);
    for (let s = 0; s < subCount; s++) {
      const sub = lookup + u16(b, lookup + 6 + s * 2);
      if (type === 4) readLigatureSubst(sub);
      // Type 7 wraps a real lookup so it can use a 32-bit offset.
      else if (type === 7 && u16(b, sub) === 1 && u16(b, sub + 2) === 4) {
        readLigatureSubst(sub + u32(b, sub + 4));
      }
    }
  }
  return map;
}

// ---- report -----------------------------------------------------------------
const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const fonts = embeddedFonts(doc.asPDF());

for (const f of fonts) {
  const magic = f.bytes.toString("latin1", 0, 4);
  const ligs = ligatures(f.bytes);
  const arity = new Map();
  for (const [, comps] of ligs) arity.set(comps.length, (arity.get(comps.length) ?? 0) + 1);
  console.log(`${f.name.padEnd(34)} ${String(f.bytes.length).padStart(7)} bytes  magic ${JSON.stringify(magic)}`);
  console.log(`   ligature glyphs in GSUB : ${ligs.size}`
    + (ligs.size ? `   components: ${[...arity].sort().map(([n, c]) => `${n}x${c}`).join(" ")}` : ""));

  const hit = ligs.get(WANT);
  if (hit) {
    console.log(`   >> glyph ${WANT} is a ligature of ${hit.length} glyphs: ${hit.join(" + ")}`);
  }
}
