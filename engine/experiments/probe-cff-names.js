/**
 * The last place a ligature could name itself: the CFF charset.
 *
 * Everything else is exhausted for `التشغيلي` -> `التشغلي`:
 *
 *   GSUB          stripped by the subsetter — the embedded font has only
 *                 CFF OS/2 cmap gasp head hhea hmtx maxp name post
 *   ToUnicode     every entry maps one glyph to ONE character; zero
 *                 multi-character destinations in the whole CMap
 *   advance       does not separate ligatures from wide letters in any font
 *   the document  cannot self-calibrate: the loss is 100% consistent, 60 of
 *                 60 occurrences of the glyph yield one character
 *
 * A CFF font carries a charset — a glyph name per glyph — and a ligature is
 * conventionally named for its parts (`lam_yeh`, `uni0644064A`). If the
 * subsetter kept it, the font states outright what glyph 612 is.
 *
 * Usage: node experiments/probe-cff-names.js [pdf] [glyphId]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = process.argv[2] ?? "C:/Users/mosun/Downloads/final lecs/chp.4/done/Chp4-Lec23-1.pdf";
const WANT = Number(process.argv[3] ?? 612);

const u8 = (b, o) => b.readUInt8(o);
const u16 = (b, o) => b.readUInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);

/** CFF INDEX -> { items: Buffer[], end } */
function readIndex(b, off) {
  const count = u16(b, off);
  if (count === 0) return { items: [], end: off + 2 };
  const offSize = u8(b, off + 2);
  const offAt = (i) => {
    const p = off + 3 + i * offSize;
    let v = 0;
    for (let k = 0; k < offSize; k++) v = (v << 8) | u8(b, p + k);
    return v;
  };
  const dataStart = off + 3 + (count + 1) * offSize - 1;
  const items = [];
  for (let i = 0; i < count; i++) items.push(b.subarray(dataStart + offAt(i), dataStart + offAt(i + 1)));
  return { items, end: dataStart + offAt(count) };
}

/** Top DICT -> { operator: [operands] } */
function readDict(b) {
  const out = new Map();
  let operands = [];
  for (let i = 0; i < b.length;) {
    const v = u8(b, i);
    if (v <= 21) {                                   // operator
      const op = v === 12 ? 1200 + u8(b, i + 1) : v;
      i += v === 12 ? 2 : 1;
      out.set(op, operands);
      operands = [];
    } else if (v === 28) { operands.push(b.readInt16BE(i + 1)); i += 3; }
    else if (v === 29) { operands.push(b.readInt32BE(i + 1)); i += 5; }
    else if (v === 30) {                             // real: skip to the nibble end
      i++;
      while (i < b.length) { const n = u8(b, i++); if ((n & 0x0f) === 0x0f || (n >> 4) === 0x0f) break; }
      operands.push(0);
    }
    else if (v >= 32 && v <= 246) { operands.push(v - 139); i++; }
    else if (v >= 247 && v <= 250) { operands.push((v - 247) * 256 + u8(b, i + 1) + 108); i += 2; }
    else if (v >= 251 && v <= 254) { operands.push(-(v - 251) * 256 - u8(b, i + 1) - 108); i += 2; }
    else i++;
  }
  return out;
}

function tableOffset(b, tag) {
  for (let i = 0, n = u16(b, 4); i < n; i++) {
    const rec = 12 + i * 16;
    if (b.toString("latin1", rec, rec + 4) === tag) return { off: u32(b, rec + 8), len: u32(b, rec + 12) };
  }
  return null;
}

/** glyph id -> name, read from the CFF charset. */
function glyphNames(sfnt) {
  const cff = tableOffset(sfnt, "CFF ");
  if (!cff) return null;
  const b = sfnt.subarray(cff.off, cff.off + cff.len);

  const hdrSize = u8(b, 2);
  const name = readIndex(b, hdrSize);
  const top = readIndex(b, name.end);
  const strings = readIndex(b, top.end);
  if (!top.items.length) return null;

  const dict = readDict(top.items[0]);
  const charStringsOff = dict.get(17)?.[0];
  const charsetOff = dict.get(15)?.[0];
  if (!charStringsOff || charsetOff === undefined || charsetOff < 3) return null;  // 0-2 are predefined

  const nGlyphs = readIndex(b, charStringsOff).items.length;
  const sidName = (sid) => sid < STANDARD.length
    ? STANDARD[sid]
    : (strings.items[sid - STANDARD.length]?.toString("latin1") ?? `sid${sid}`);

  const names = [".notdef"];
  const fmt = u8(b, charsetOff);
  let p = charsetOff + 1;
  if (fmt === 0) {
    for (let g = 1; g < nGlyphs; g++, p += 2) names.push(sidName(u16(b, p)));
  } else if (fmt === 1 || fmt === 2) {
    while (names.length < nGlyphs) {
      const first = u16(b, p);
      const nLeft = fmt === 1 ? u8(b, p + 2) : u16(b, p + 2);
      p += fmt === 1 ? 3 : 4;
      for (let k = 0; k <= nLeft && names.length < nGlyphs; k++) names.push(sidName(first + k));
    }
  } else return null;
  return names;
}

// Only the first 391 standard strings matter for names; anything a subsetter
// invents lands in the String INDEX above them.
const STANDARD = [".notdef", "space", "exclam", "quotedbl", "numbersign", "dollar", "percent",
  "ampersand", "quoteright", "parenleft", "parenright", "asterisk", "plus", "comma", "hyphen",
  "period", "slash", "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "colon", "semicolon", "less", "equal", "greater", "question", "at"];
while (STANDARD.length < 391) STANDARD.push(`std${STANDARD.length}`);

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const pdf = doc.asPDF();

for (let i = 1; i < pdf.countObjects(); i++) {
  let o;
  try { o = pdf.newIndirect(i).resolve(); } catch { continue; }
  if (!o?.isDictionary?.() || String(o.get("Type")) !== "/FontDescriptor") continue;
  // `get` on a missing key returns a NULL PDFObject, not undefined, so `??`
  // never falls through — every font was skipped in silence.
  let ff = null;
  for (const k of ["FontFile3", "FontFile2", "FontFile"]) {
    const v = o.get(k);
    if (v && !v.isNull()) { ff = v; break; }
  }
  if (!ff) continue;
  const nm = String(o.get("FontName")).replace(/^\/(?:[A-Z]{6}\+)?/, "");
  const bytes = Buffer.from(ff.readStream().asUint8Array());
  const names = glyphNames(bytes);

  if (!names) { console.log(`${nm.padEnd(32)} no readable CFF charset`); continue; }
  const real = names.filter((n) => n && !/^(sid|std)\d+$|^cid\d+$|^g\d+$/.test(n));
  console.log(`${nm.padEnd(32)} ${names.length} glyphs, ${real.length} with real names`);
  console.log(`   sample: ${names.slice(1, 9).join(" ")}`);
  if (names[WANT]) console.log(`   >> glyph ${WANT} is named: ${JSON.stringify(names[WANT])}`);
}

// ---- how many glyphs name themselves as ligatures? --------------------------
// AFDKO convention: components joined by `_`, then dot-suffixes for the form
// and the feature. `lam_yehar.fina.rlig` is lam + Arabic yeh, final, required.
if (process.argv.includes("--survey")) {
  console.log("\nligature-named glyphs per font (arity = components in the name):");
  for (let i = 1; i < pdf.countObjects(); i++) {
    let o; try { o = pdf.newIndirect(i).resolve(); } catch { continue; }
    if (!o?.isDictionary?.() || String(o.get("Type")) !== "/FontDescriptor") continue;
    let ff = null;
    for (const k of ["FontFile3", "FontFile2", "FontFile"]) {
      const v = o.get(k); if (v && !v.isNull()) { ff = v; break; }
    }
    if (!ff) continue;
    const nm = String(o.get("FontName")).replace(/^\/(?:[A-Z]{6}\+)?/, "");
    const names = glyphNames(Buffer.from(ff.readStream().asUint8Array()));
    if (!names) continue;
    const arity = new Map();
    const samples = [];
    names.forEach((n, g) => {
      const base = String(n).split(".")[0];
      if (!base.includes("_")) return;
      const k = base.split("_").length;
      arity.set(k, (arity.get(k) ?? 0) + 1);
      if (samples.length < 5) samples.push(`g${g}=${n}`);
    });
    const total = [...arity.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${nm.padEnd(30)} ${String(total).padStart(4)} ligature glyphs  `
      + [...arity].sort().map(([k, c]) => `${k}-part x${c}`).join("  "));
    if (samples.length) console.log(`      ${samples.join("  ")}`);
  }
}
