/**
 * How many characters does a glyph stand for? Ask the font.
 *
 * `owedOf` knows exactly one family — the lam-alef presentation forms — so every
 * other ligature owes 1, the deficit count balances, and 65 blocks lose a letter
 * with nothing in the document able to say so. `LyonArabicTextLF-Bold` carries
 * **422** such glyphs.
 *
 * The font names them. Glyph 612, the one that swallows the `ي` in `التشغيلي`,
 * is called `lam_yehar.fina.rlig` — lam plus Arabic yeh, final form, required
 * ligature — in the CFF charset, which survives subsetting even though GSUB does
 * not (Chromium shapes text before printing, so the subsetter drops GSUB as dead
 * weight). Five other routes to the same fact were measured and closed first;
 * KNOWN_ISSUES has each with its number.
 *
 * This is ~140 lines of sfnt + CFF reading rather than a font-parsing
 * dependency, because the question is only "how many components", never "shape
 * this text".
 */

const u8 = (b, o) => b.readUInt8(o);
const u16 = (b, o) => b.readUInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);

/** A CFF INDEX: count, offset array, then the data those offsets point into. */
function readIndex(b, off) {
  if (off + 2 > b.length) return { items: [], end: off + 2 };
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

/** A CFF DICT: operands accumulate until an operator consumes them. */
function readDict(b) {
  const out = new Map();
  let operands = [];
  for (let i = 0; i < b.length;) {
    const v = u8(b, i);
    if (v <= 21) {
      const op = v === 12 ? 1200 + u8(b, i + 1) : v;
      i += v === 12 ? 2 : 1;
      out.set(op, operands);
      operands = [];
    } else if (v === 28) { operands.push(b.readInt16BE(i + 1)); i += 3; }
    else if (v === 29) { operands.push(b.readInt32BE(i + 1)); i += 5; }
    else if (v === 30) {                       // real number: skip to its end nibble
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
  if (b.length < 12) return null;
  for (let i = 0, n = u16(b, 4); i < n; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > b.length) break;
    if (b.toString("latin1", rec, rec + 4) === tag) return { off: u32(b, rec + 8), len: u32(b, rec + 12) };
  }
  return null;
}

/** The first 391 SIDs are predefined; only their COUNT matters here. */
const N_STANDARD_STRINGS = 391;

/** @returns {string[]|null} glyph id -> name, from the CFF charset. */
export function glyphNames(sfnt) {
  const cff = tableOffset(sfnt, "CFF ");
  if (!cff) return null;
  const b = sfnt.subarray(cff.off, cff.off + cff.len);
  if (b.length < 4) return null;

  const name = readIndex(b, u8(b, 2));
  const top = readIndex(b, name.end);
  const strings = readIndex(b, top.end);
  if (!top.items.length) return null;

  const dict = readDict(top.items[0]);
  const charStringsOff = dict.get(17)?.[0];
  const charsetOff = dict.get(15)?.[0];
  // 0, 1 and 2 are the predefined charsets — none of them names a ligature.
  if (!charStringsOff || !(charsetOff > 2)) return null;

  const nGlyphs = readIndex(b, charStringsOff).items.length;
  const sidName = (sid) => sid < N_STANDARD_STRINGS
    ? null                                     // standard strings are all Latin
    : (strings.items[sid - N_STANDARD_STRINGS]?.toString("latin1") ?? null);

  const names = [".notdef"];
  const fmt = u8(b, charsetOff);
  let p = charsetOff + 1;
  if (fmt === 0) {
    for (let g = 1; g < nGlyphs; g++, p += 2) names.push(sidName(u16(b, p)));
  } else if (fmt === 1 || fmt === 2) {
    while (names.length < nGlyphs && p + 3 <= b.length) {
      const first = u16(b, p);
      const nLeft = fmt === 1 ? u8(b, p + 2) : u16(b, p + 2);
      p += fmt === 1 ? 3 : 4;
      for (let k = 0; k <= nLeft && names.length < nGlyphs; k++) names.push(sidName(first + k));
    }
  } else return null;
  return names;
}

/**
 * Components in a glyph name, by the AFDKO convention: parts joined with `_`,
 * then dot-suffixes for the form and the feature. `lam_yehar.fina.rlig` is two.
 */
export const arityOfName = (n) => (typeof n === "string" && n.includes("_"))
  ? n.split(".")[0].split("_").length
  : 1;

/**
 * AFDKO component names to the character each one stands for.
 *
 * The list is bounded by measurement, not by ambition:
 * `experiments/probe-ligature-components.js` reports **65 distinct component
 * names across 887 ligature glyphs** in the two Lyon faces, and this covers the
 * letters among them. What it deliberately does NOT cover is as important:
 * `part`, `threedotsdown`, `space`, `uni0326` and the Latin parts of `fi`/`fl`
 * are not Arabic letters, and a glyph built from one of them yields null below
 * rather than a guess — so it is never repaired.
 */
const COMPONENT_CHAR = new Map(Object.entries({
  alef: "ا", alefHamzaabove: "أ", alefHamzabelow: "إ",
  alefMadda: "آ", alefWasla: "ٱ", alefMaksura: "ى",
  beh: "ب", behdotless: "ٮ", peh: "پ", teh: "ت",
  tehMarbuta: "ة", theh: "ث", tteh: "ٹ",
  jeem: "ج", jeh: "ژ", tcheh: "چ", hah: "ح", khah: "خ",
  dal: "د", thal: "ذ", reh: "ر", rreh: "ڑ", zain: "ز",
  seen: "س", sheen: "ش", sad: "ص", dad: "ض",
  tah: "ط", zah: "ظ", ain: "ع", ghain: "غ",
  feh: "ف", fehDotless: "ڡ", veh: "ڤ", qaf: "ق",
  kaf: "ك", gaf: "گ", lam: "ل", meem: "م",
  noon: "ن", noonghunna: "ں", heh: "ه", waw: "و",
  yeh: "ي", yehfarsi: "ی", yehHamzaabove: "ئ", hamza: "ء",
}));

/**
 * Lyon suffixes its Arabic parts with `ar` — `meemar`, `yehar`, `alefMaksuraar`
 * — to keep them apart from the Latin glyphs in the same font. The suffix is
 * only stripped when what remains is a name we already know, so nothing is
 * invented for a part this table has never seen.
 */
export function componentChar(name) {
  if (COMPONENT_CHAR.has(name)) return COMPONENT_CHAR.get(name);
  const base = /^(.+)ar$/.exec(name)?.[1];
  return base && COMPONENT_CHAR.has(base) ? COMPONENT_CHAR.get(base) : null;
}

/**
 * The characters a ligature glyph name stands for, or null when ANY part is
 * unknown. All-or-nothing on purpose: a repair that inserts the parts it
 * recognised and drops the rest would be inventing the word's shape.
 */
export function componentsOfName(n) {
  if (typeof n !== "string" || !n.includes("_")) return null;
  const parts = n.split(".")[0].split("_");
  if (parts.length < 2) return null;
  const chars = parts.map(componentChar);
  return chars.every(Boolean) ? chars : null;
}

/**
 * Every embedded font's ligature glyphs, keyed by the name the device reports.
 *
 * @param {object} pdf a mupdf PDFDocument
 * @returns {Map<string, Map<number, number>>} font name -> glyph id -> arity
 */
export function ligatureArity(pdf) {
  const out = new Map();
  if (!pdf?.countObjects) return out;

  for (let i = 1; i < pdf.countObjects(); i++) {
    let o;
    try { o = pdf.newIndirect(i).resolve(); } catch { continue; }
    if (!o?.isDictionary?.() || String(o.get("Type")) !== "/FontDescriptor") continue;

    // `get` returns a NULL PDFObject for a missing key rather than undefined, so
    // `a ?? b` never falls through here and finds nothing at all.
    let stream = null;
    for (const k of ["FontFile3", "FontFile2", "FontFile"]) {
      const v = o.get(k);
      if (v && !v.isNull()) { stream = v; break; }
    }
    if (!stream) continue;

    // The KEY is not the format: every Arabic font in this corpus is declared
    // FontFile2, which the spec reserves for TrueType, and every one of them
    // begins "OTTO". Only `glyphNames` decides, by looking for a CFF table.
    let names;
    try { names = glyphNames(Buffer.from(stream.readStream().asUint8Array())); }
    catch { continue; }
    if (!names) continue;

    // `owed` stays the raw part COUNT, which is what every gate has been
    // measured against; `parts` is the repair's evidence and is null whenever a
    // component name is not a letter this module can name.
    const ligs = new Map();
    names.forEach((n, g) => {
      const owed = arityOfName(n);
      if (owed > 1) ligs.set(g, { owed, parts: componentsOfName(n) });
    });
    if (!ligs.size) continue;

    // The device reports the name WITH its subset tag and no leading slash.
    const name = String(o.get("FontName")).replace(/^\//, "");
    out.set(name, ligs);

    // ...but not always the SAME name. MuPDF reads `font.getName()` out of the
    // font program, and the PDF's descriptor is free to disagree: this corpus
    // declares `DAAAAA+LyonArabicTextLF-RegularNo2` and paints
    // `DAAAAA+LyonArabicTextLF-Regular`. Measured: 1489 painted glyphs belong to
    // a font the map held under a name the lookup could never ask for, so all
    // 465 ligatures that face knows were invisible — the glyph owed 1, the line
    // balanced, and `التشغيلي` lost its final ya with every gate silent.
    //
    // The subset tag is the document's own identifier for an embedded font, so
    // it is indexed as a second key rather than guessing at name variants.
    const tag = (name.match(/^([A-Z]{6})\+/) ?? [])[1];
    if (tag && !out.has(tag)) out.set(tag, ligs);
  }
  return out;
}
