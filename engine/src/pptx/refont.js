/**
 * Rewrite a finished .pptx so every typeface it names is one the READER already
 * has, and drop the embedded-font machinery it no longer needs.
 *
 * WHY THIS EXISTS. `src/fonts/resolve.js` matches a PDF's font name against the
 * fonts installed on THIS machine. That is the right question for rendering a
 * preview here and the wrong question for a file we hand to somebody else: the
 * corpus is set in Diodrum Arabic and Lyon Arabic Text LF, both installed per
 * user on the author's profile and on essentially no other machine. So a deck
 * that resolves perfectly here names, on 7064 of 7712 runs, fonts the reader
 * does not have.
 *
 * Embedding was supposed to close that gap and cannot, for these two families:
 * MEASURED, both are fsType 4 — "preview & print" — which forbids embedding into
 * an editable document. PowerPoint honours it. Its own SaveAs strips every one
 * of our font parts, which is PowerPoint stating the same fact a second time.
 *
 * WHAT THE READER SEES INSTEAD is decided by their machine, not by us: a clean
 * Arabic fallback on one install, tofu on another, CJK-looking glyphs on a
 * third. Reported from the field: correct in Google Slides (which ignores both
 * the embed and the font name and substitutes sanely), wrong in desktop
 * PowerPoint, and unchanged in read-only mode.
 *
 * SO THE FIX IS NOT A BETTER SUBSTITUTE — it is having nothing to substitute.
 * Every run is re-pointed at a face that ships with Windows and Office, chosen
 * per run from the characters that run actually sets, verified against the real
 * `cmap` rather than against a list of names. MEASURED on the Unit Five deck:
 * Segoe UI draws 100% of the characters of all four restricted families, and the
 * union of the ubiquitous set misses 0 of the deck's 225 distinct characters.
 *
 * COST, stated because it is real: the reader no longer sees the designer's
 * typeface, and the metrics change, so a `wrap="none"` box can end up wider than
 * it was. `refontPptx` reports every swap it makes; the caller renders and looks.
 *
 * IT ALSO CORRECTS `charset`. pptxgenjs hardcodes `charset="-122"` on every
 * `a:ea` and `charset="-120"` on every `a:cs`. Read as the signed bytes OOXML
 * declares them to be, those are [MS-WMF] `GB2312_CHARSET` (0x86, Simplified
 * Chinese) and `CHINESEBIG5_CHARSET` (0x88, Traditional Chinese) — announced on
 * 7,712 runs of Arabic, in the slot Arabic actually routes through.
 *
 * This was held back through one release ON PURPOSE and the reason has expired.
 * It was TESTED as the cause of the reader's CJK report and refused — a deck
 * naming a font installed nowhere, carrying those exact charsets, renders as
 * clean Arabic through PowerPoint here (.work/charset-exp) — so while the fix
 * was unverified in the field it was worth keeping the rewrite to ONE variable,
 * so that the reader's verdict meant something. The reader has since confirmed
 * the font fix works, so the variable is spent, and what is left is a value that
 * is simply false. See DOCS.md for the enumeration.
 */
import * as fs from "node:fs";
import JSZip from "jszip";
import { cmapLookup } from "../fonts/coverage.js";
import { findFace } from "../fonts/webfonts.js";
import { UBIQUITOUS_FONTS } from "./inspect.js";
import { getFontLicense } from "../fonts/license.js";

/**
 * Faces to fall back on, best first. Every one of these ships with Windows and
 * Office; the order is "closest in role to a body-text face", so Arabic prose
 * lands on Segoe UI rather than on a symbol font that merely happens to cover it.
 */
export const PORTABLE_PREFERENCE = Object.freeze([
  "Segoe UI",
  "Arial",
  "Times New Roman",
  "Tahoma",
  "Calibri",
  "Segoe UI Symbol",
  "Cambria Math",
  "Segoe UI Emoji",
]);

const ENTITIES = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&amp;": "&" };
const decode = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (m) => ENTITIES[m]);

/** family -> (codePoint) => boolean, read from the installed file's real cmap. */
function makeCoverage() {
  const cache = new Map();
  return (family) => {
    if (cache.has(family)) return cache.get(family);
    const face = findFace(family);
    let has = null;
    if (face) {
      try { has = cmapLookup(fs.readFileSync(face.file)); } catch { has = null; }
    }
    cache.set(family, has);
    return has;
  };
}

const isUbiquitous = (family) => UBIQUITOUS_FONTS.has(String(family).toLowerCase());

/**
 * `charset` values, as the SIGNED bytes OOXML declares the attribute to be
 * (`CT_TextFont/@charset` is `xsd:byte`). Names and codes from [MS-WMF]
 * CharacterSet Enumeration; see DOCS.md.
 */
const CHARSET = Object.freeze({ ANSI: 0, ARABIC: -78, HEBREW: -79 });
const RE_ARABIC_SCRIPT = /\p{Script_Extensions=Arabic}/u;
const RE_HEBREW_SCRIPT = /\p{Script_Extensions=Hebrew}/u;

/**
 * The charset a slot should announce for the characters this run actually sets.
 *
 * `a:ea` is East Asian and we never set East Asian text, so it says ANSI rather
 * than naming a Chinese code page. `a:cs` is the COMPLEX SCRIPT slot, which is
 * the one Arabic routes through, so it names the script that is really there.
 * `Script_Extensions`, not `Script`: the Arabic comma U+060C is script `Common`
 * and a `Script=Arabic` test misses it (EVO-037's revision).
 */
export function charsetFor(slot, chars) {
  if (slot === "latin") return CHARSET.ANSI;
  if (slot === "ea") return CHARSET.ANSI;
  const text = Array.isArray(chars) ? chars.join("") : String(chars ?? "");
  if (RE_ARABIC_SCRIPT.test(text)) return CHARSET.ARABIC;
  if (RE_HEBREW_SCRIPT.test(text)) return CHARSET.HEBREW;
  return CHARSET.ANSI;
}

/**
 * Families the caller would RATHER have than a stock system face, tried first.
 *
 * This is the fidelity tier. A face here does not ship with Windows, so the deck
 * depends on it being embedded — which is only honest for a font whose own
 * `fsType` permits embedding into an editable document. `preferredFaces` refuses
 * anything else rather than trusting the caller, because getting that wrong is
 * the entire bug this module was written for.
 *
 * MEASURED: Cairo is fsType 0 — "Installable embedding", the most permissive
 * level OpenType defines, where the font "may be embedded, and may be
 * permanently installed for use on a remote system" — and it draws 100% of the
 * 435 distinct characters the four restricted families set in the corpus.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AND IT STILL CAME BACK AS BOXES. DO NOT REACH FOR A THIRD FONT.
 *
 * 2026-08-25, from the reader who reported the original bug: the Cairo deck
 * rendered as tofu on their PowerPoint while the stock-font deck, sent in the
 * same message, rendered correctly. That is the SECOND font to fail this way —
 * Diodrum Arabic (fsType 4) did it two days earlier — and the two differ on
 * every axis anyone would tune:
 *
 *     Diodrum  fsType 4  spec FORBIDS editable embedding   -> boxes
 *     Cairo    fsType 0  spec PERMITS it, most permissive  -> boxes
 *
 * The licence was varied, the font was varied, the packaging was varied, and
 * the outcome did not move. So the missing thing is not on our side of the
 * wire: that reader's PowerPoint does not load embedded fonts at all. A
 * PERMISSIVE FLAG IS NOT A CAPABILITY — the consumer's implementation is the
 * only oracle, and it has now answered twice.
 *
 * This tier is kept because it is correct, tested and licence-gated, and a
 * different reader may well load embeds fine. It is NOT the delivery default,
 * and it must not become one on the strength of a spec quotation. The delivery
 * path is plain `--portable`, which needs no embed and is confirmed working by
 * the same reader.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function preferredFaces(families, { license = getFontLicense } = {}) {
  const usable = [], refused = [];
  for (const f of families) {
    const lic = license(f);
    // fsType null means the face is not installed here, so we cannot embed it
    // and cannot check it either. Not a candidate.
    if (lic.fsType === null || lic.fsType === undefined) refused.push({ family: f, why: "not-installed-here" });
    else if (!lic.editable) refused.push({ family: f, why: `fsType 0x${lic.fsType.toString(16).padStart(4, "0")} forbids editable embedding` });
    else usable.push(f);
  }
  return { usable, refused };
}

/**
 * The face a reader will actually have, for one run.
 * @returns {{face:string, reason:string}} `reason` is "kept" when nothing moved.
 */
export function portableFaceFor(family, chars, coverage, prefer = []) {
  const covers = (f) => {
    const has = coverage(f);
    if (!has) return false;
    for (const ch of chars) if (!has(ch.codePointAt(0))) return false;
    return true;
  };

  // A face everybody has, that can draw this run, is already the answer — and
  // the fidelity tier must NOT touch it. `prefer` exists to rescue what would
  // otherwise be DOWNGRADED to a stock face, not to repaint the whole deck: the
  // corpus genuinely names Segoe UI on 378 runs and Times New Roman on 5, and
  // dragging those into the preferred face would be inventing a design decision
  // the source never made, at the cost of an embed they do not need.
  if (isUbiquitous(family) && covers(family)) return { face: family, reason: "kept" };
  if (prefer.includes(family)) return { face: family, reason: "kept" };

  // Now, and only now: this family was going to be replaced anyway. If the
  // caller named an embeddable face that can draw the run, it beats the stock
  // fallback, and the embed is what pays for it.
  for (const cand of prefer) {
    if (covers(cand)) return { face: cand, reason: "preferred-embeddable-face" };
  }

  for (const cand of PORTABLE_PREFERENCE) {
    if (covers(cand)) {
      return {
        face: cand,
        reason: isUbiquitous(family) ? "ubiquitous-but-cannot-draw-this-run" : "not-on-reader-machine",
      };
    }
  }

  // Nothing ubiquitous can draw it. Leave the run alone rather than swap it for
  // a face that would render tofu — and say so, so the caller can refuse.
  return { face: family, reason: "no-portable-face-covers-it" };
}

/**
 * @param {string} src  path to a .pptx
 * @param {string} dest path to write the rewritten .pptx
 */
export async function refontPptx(src, dest, { prefer = [] } = {}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(src));
  const coverage = makeCoverage();
  // Gate the fidelity tier ONCE, at entry, on the font's own licence — never
  // per run, and never on the caller's say-so.
  const { usable: preferOk, refused: preferRefused } = preferredFaces(prefer);
  const swaps = new Map();
  const uncovered = new Set();
  // family -> the face the real, text-bearing runs chose for it. Placeholders
  // and empty paragraphs follow this rather than guessing on their own.
  const familyMap = new Map();
  let runs = 0;
  let rewritten = 0;
  let charsetFixed = 0;

  const partNames = Object.keys(zip.files).filter((n) =>
    /^ppt\/(slides|slideLayouts|slideMasters|notesSlides)\/[^/]+\.xml$/.test(n));

  for (const name of partNames) {
    let xml = await zip.file(name).async("string");

    // One run at a time: the characters it sets decide the face it gets.
    xml = xml.replace(/<a:r>[\s\S]*?<\/a:r>/g, (run) => {
      runs++;
      const t = run.match(/<a:t>([\s\S]*?)<\/a:t>/);
      const chars = new Set(decode(t ? t[1] : ""));
      // A whitespace-only run constrains nothing, so it must not get a VOTE on
      // which face wins — but it still must not be left NAMING a font the reader
      // lacks, or PowerPoint still reports the deck as missing that font. It
      // takes the same portable face as everything else, with no coverage test:
      // every face draws a space.
      const meaningful = [...chars].filter((c) => !/\s/.test(c));

      // The whole element, so `charset` can be corrected whether or not the
      // typeface moves — the two defects are independent.
      return run.replace(/<a:(latin|ea|cs)\s([^>]*?)\/>/g, (m, slot, attrs) => {
        const fam = attrs.match(/typeface="([^"]*)"/);
        if (!fam) return m;
        const family = fam[1];

        let out = m;
        const want = charsetFor(slot, meaningful);
        const has = attrs.match(/charset="(-?\d+)"/);
        if (has && Number(has[1]) !== want) {
          out = out.replace(/charset="-?\d+"/, `charset="${want}"`);
          charsetFixed++;
        }

        if (family.startsWith("+")) return out;        // theme reference, leave it
        const { face, reason } = portableFaceFor(family, meaningful, coverage, preferOk);
        if (reason === "no-portable-face-covers-it") { uncovered.add(family); return out; }
        if (face !== family) {
          const rec = swaps.get(family) ?? { to: face, slots: 0, reason };
          rec.slots++; swaps.set(family, rec);
          if (meaningful.length) familyMap.set(family, face);
          rewritten++;
          out = out.replace(/typeface="[^"]*"/, `typeface="${face}"`);
        }
        return out;
      });
    });

    // Font names also live OUTSIDE <a:r>: <a:defRPr> on list styles and
    // placeholders, and <a:endParaRPr> on every empty paragraph. Those carry no
    // text, so they cannot be judged by coverage — but a deck that still NAMES
    // an absent font there is still a deck PowerPoint reports as missing it, and
    // the next run typed into that paragraph inherits the dead name. They follow
    // the decision the real runs already made for that family.
    xml = xml.replace(/<a:(latin|ea|cs) typeface="([^"]*)"/g, (m, slot, family) => {
      if (family.startsWith("+") || isUbiquitous(family)) return m;
      const face = familyMap.get(family) ?? preferOk[0] ?? PORTABLE_PREFERENCE[0];
      // A face that is already the answer is not a rewrite. Without this the
      // fidelity tier counted 21,270 Cairo->Cairo "swaps" and, worse, a second
      // pass would have found the same work again — breaking idempotency on
      // exactly the decks the tier is for.
      if (face === family) return m;
      const rec = swaps.get(family) ?? { to: face, slots: 0, reason: "not-on-reader-machine" };
      rec.slots++; swaps.set(family, rec);
      rewritten++;
      return `<a:${slot} typeface="${face}"`;
    });

    zip.file(name, xml);
  }

  // The embedded fonts were the failed half of the old plan. A deck that names
  // only ubiquitous faces has nothing to embed, and leaving dead font parts in
  // the package is part of what made this bug hard to see in the first place.
  const fontParts = Object.keys(zip.files).filter((n) => /^ppt\/fonts\/.+\.fntdata$/.test(n));
  for (const n of fontParts) zip.remove(n);

  let pres = await zip.file("ppt/presentation.xml").async("string");
  pres = pres.replace(/<p:embeddedFontLst>[\s\S]*?<\/p:embeddedFontLst>/, "");
  zip.file("ppt/presentation.xml", pres);

  let rels = await zip.file("ppt/_rels/presentation.xml.rels").async("string");
  rels = rels.replace(/<Relationship[^>]*Target="fonts\/[^"]*"[^>]*\/>/g, "");
  zip.file("ppt/_rels/presentation.xml.rels", rels);

  let ct = await zip.file("[Content_Types].xml").async("string");
  ct = ct.replace(/<Default Extension="fntdata"[^>]*\/>/, "");
  zip.file("[Content_Types].xml", ct);

  // DEFLATE explicitly: JSZip's default is STORE, which turned a 2.4 MB deck
  // into an 8.0 MB one on the first run of this pass — while REMOVING 8 font
  // parts. A deck this size gets emailed; the compression is not optional.
  fs.writeFileSync(dest, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  }));
  return { swaps, uncovered: [...uncovered], droppedFontParts: fontParts.length, runs, rewritten, charsetFixed,
           prefer: preferOk, preferRefused };
}
