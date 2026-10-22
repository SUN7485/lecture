/**
 * Which characters can a font actually draw, read from its own `cmap`.
 *
 * WHY THIS EXISTS. A font that does not travel with the deck is not automatically
 * a defect: the reader's machine substitutes something, and the only question that
 * matters is whether the substitute can draw the characters. Answering it by NAME
 * — an allowlist of "fonts everyone has" — is the assumption this project keeps
 * getting burned by (EVO-021, EVO-024). The font file states its own coverage, so
 * ask it.
 *
 * MEASURED, and the reason this module exists at all: the 118-page Unit Five deck
 * names MS PGothic on 12 runs, all of them circled numerals `①②③④` (U+2460..). MS
 * PGothic is NOT licence-restricted — `OS/2.fsType` is 0x0008, Editable, and
 * PowerPoint's own `Presentation.Fonts` reports `embeddable=true` — PowerPoint
 * simply declines to embed it, exactly as it declines Calibri and Times New Roman.
 * Rendering the same string through a font installed nowhere showed the numerals
 * drawn correctly by fallback, no tofu. This module is that experiment, made
 * deterministic and repeatable: `Segoe UI Symbol` carries U+2460..2463, it ships
 * everywhere, so the fallback is guaranteed rather than observed once.
 *
 * Only the characters actually USED are checked. A font is not required to be a
 * superset of anything — the deck's real content is the whole question.
 */
import * as fs from "node:fs";
import { availableFaces } from "./webfonts.js";
import { UBIQUITOUS_FONTS } from "../pptx/inspect.js";

/** Offset of a table in an SFNT, or 0. `.ttc` collections are not handled. */
export function tableOffset(buf, want) {
  if (buf.length < 12) return 0;
  const tag = buf.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return 0;
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) return 0;
    if (buf.toString("latin1", rec, rec + 4) === want) return buf.readUInt32BE(rec + 8);
  }
  return 0;
}

/**
 * The set of codepoints a font can draw, as a predicate.
 *
 * Subtables are preferred in the order the spec intends: (3,10) full Unicode,
 * then (3,1) BMP, then (0,*) Unicode. Format 12 is a plain range list; format 4
 * is the segmented BMP mapping every Windows font carries.
 */
export function cmapLookup(buf) {
  const off = tableOffset(buf, "cmap");
  if (!off || off + 4 > buf.length) return null;

  const n = buf.readUInt16BE(off + 2);
  let best = 0, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const rec = off + 4 + i * 8;
    if (rec + 8 > buf.length) break;
    const plat = buf.readUInt16BE(rec), enc = buf.readUInt16BE(rec + 2);
    const sub = off + buf.readUInt32BE(rec + 4);
    const score = plat === 3 && enc === 10 ? 3 : plat === 3 && enc === 1 ? 2 : plat === 0 ? 1 : 0;
    if (score > bestScore) { bestScore = score; best = sub; }
  }
  if (!best || best + 4 > buf.length) return null;

  const format = buf.readUInt16BE(best);

  if (format === 12) {
    const groups = buf.readUInt32BE(best + 12);
    const base = best + 16;
    return (cp) => {
      for (let g = 0; g < groups; g++) {
        const r = base + g * 12;
        if (r + 12 > buf.length) return false;
        if (cp >= buf.readUInt32BE(r) && cp <= buf.readUInt32BE(r + 4)) return true;
      }
      return false;
    };
  }

  if (format === 4) {
    const segX2 = buf.readUInt16BE(best + 6);
    const segs = segX2 / 2;
    const endBase = best + 14;
    const startBase = endBase + segX2 + 2;
    const deltaBase = startBase + segX2;
    const rangeBase = deltaBase + segX2;
    return (cp) => {
      if (cp > 0xffff) return false;
      for (let s = 0; s < segs; s++) {
        if (endBase + s * 2 + 2 > buf.length) return false;
        const end = buf.readUInt16BE(endBase + s * 2);
        if (end < cp) continue;
        const start = buf.readUInt16BE(startBase + s * 2);
        if (start > cp) return false;                       // falls in a gap
        const ro = buf.readUInt16BE(rangeBase + s * 2);
        if (ro === 0) return ((cp + buf.readInt16BE(deltaBase + s * 2)) & 0xffff) !== 0;
        const gi = rangeBase + s * 2 + ro + (cp - start) * 2;
        if (gi + 2 > buf.length) return false;
        const glyph = buf.readUInt16BE(gi);
        return glyph !== 0 && ((glyph + buf.readInt16BE(deltaBase + s * 2)) & 0xffff) !== 0;
      }
      return false;
    };
  }

  return null;                                              // format 0/6/13: not needed here
}

let ubiquitous = null;
/** Every readable face whose family is on the ships-everywhere list, with its lookup. */
function ubiquitousFaces() {
  if (ubiquitous) return ubiquitous;
  ubiquitous = [];
  for (const f of availableFaces()) {
    if (!UBIQUITOUS_FONTS.has(String(f.family).toLowerCase())) continue;
    try {
      const has = cmapLookup(fs.readFileSync(f.file));
      if (has) ubiquitous.push({ family: f.family, has });
    } catch { /* unreadable: simply not offered as a fallback */ }
  }
  return ubiquitous;
}

/**
 * Can a font that ships everywhere draw all of these characters?
 *
 * This is the question behind "the deck names a font it does not carry": if some
 * ubiquitous face covers the text, the reader sees the right glyphs in a different
 * shape, which is a portability WARNING. If nothing covers it they see tofu, which
 * is damage.
 *
 * @param {string} text every character actually set in the missing font
 * @returns {{covered:boolean, by:string|null, missing:string[]}}
 */
export function coveredByUbiquitous(text) {
  const wanted = [...new Set([...String(text)])].filter((c) => !/\s/.test(c));
  if (!wanted.length) return { covered: true, by: null, missing: [] };

  const faces = ubiquitousFaces();

  // COVERAGE IS PER CHARACTER, not per face. An earlier version asked whether ONE
  // face could draw the whole string, which is stricter than what actually happens:
  // a renderer's fallback is chosen per character, so a string split across two
  // ubiquitous faces still renders completely. Measured: `CMSY10` on a pdfTeX
  // dissertation sets maths symbols that no single ubiquitous face carries but
  // every one of which some face does — the strict rule called that damage and it
  // is not. `CMEX10` on the same document is real damage: its big delimiters live
  // in the PRIVATE USE AREA (U+F8EE, U+F8F9 …) where nothing standard can follow.
  const missing = wanted.filter((c) => !faces.some((f) => f.has(c.codePointAt(0))));
  if (missing.length) return { covered: false, by: null, missing };

  // Name a single face when one covers everything, because that is the common case
  // and it makes the warning concrete; otherwise say the coverage is shared.
  const whole = faces.find((f) => wanted.every((c) => f.has(c.codePointAt(0))));
  return { covered: true, by: whole ? whole.family : "several fonts that ship everywhere", missing: [] };
}
