/**
 * PDF font name -> a font face PowerPoint will actually render.
 *
 * This cannot be done by string munging alone. Measured on this machine, the
 * two families in the corpus need OPPOSITE handling:
 *
 *   installed: "Diodrum Arabic", "Diodrum Arabic Medium", "Diodrum Arabic Semibold"
 *   installed: "Lyon Arabic Text LF Bold", "Lyon Arabic Text LF Semibold"
 *              (there is NO plain "Lyon Arabic Text LF" family)
 *
 * So "DiodrumArabic-Bold" is family "Diodrum Arabic" + the bold attribute,
 * while "LyonArabicTextLF-Bold" is the family "Lyon Arabic Text LF Bold" with
 * NO bold attribute — setting bold there would ask PowerPoint to synthesise a
 * second layer of weight on an already-bold face.
 *
 * The only way to tell them apart is to check what is actually installed, so
 * that is what we do, and any font we cannot match is reported as a
 * substitution rather than silently swapped.
 *
 * AND THE NAME CAN LIE ABOUT WEIGHT. Measured 2026-08-15: the title-slide fonts
 * are named `Cairo-ExtraLight` and declare `FontWeight 700`; the page renders
 * bold. When the FontDescriptor states a weight it beats the name, because it is
 * the producer describing what it drew rather than a leftover subset label. See
 * src/fonts/type3.js.
 *
 * Every resolution reports the weight it was ASKED for and the weight it can
 * actually DELIVER, so an approximation is visible instead of silent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { availableFaces } from "./webfonts.js";

const CACHE = path.join(process.cwd(), ".cache", "installed-fonts.json");

const PS = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "$f = New-Object System.Drawing.Text.InstalledFontCollection",
  "[Console]::Out.Write(( @($f.Families | ForEach-Object { $_.Name } | Sort-Object -Unique) | ConvertTo-Json -Compress))",
].join("; ");

/**
 * Installed family names, cached on disk so model building stays synchronous.
 *
 * This is the GDI view — the same list of family NAMES PowerPoint offers — and
 * it is the right oracle for "what may I ask for". It is the wrong oracle for
 * "does this family own a real bold cut": MEASURED 2026-08-15,
 * `FontFamily.IsStyleAvailable(Bold)` returned true for 368 of 368 families on
 * this machine, Cairo included, because GDI counts a style it can SYNTHESISE as
 * available. A gate built on it would have been decorative. `hasRealCut` below
 * reads the font files instead.
 */
export function installedFamilies({ refresh = false } = {}) {
  if (!refresh && fs.existsSync(CACHE)) {
    try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { /* fall through */ }
  }
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    });
    const list = JSON.parse(out || "[]");
    const families = (Array.isArray(list) ? list : [list]).filter(Boolean).map(String);
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(families, null, 0), "utf8");
    return families;
  } catch {
    return [];
  }
}

/**
 * Does a family ship a real cut at (or above) this weight, or would the renderer
 * have to fake it?
 *
 * Answered from the font FILES' own name tables via webfonts.js, which is the
 * only source that tells a shipped Bold from a synthesised one. Loaded lazily
 * and memoised: reading ~450 name tables costs about two seconds, and a document
 * with no bold text should never pay it.
 */
let realCuts = null;
function hasRealCut(family, weight) {
  if (weight < 600) return true;                       // nothing to synthesise
  if (!realCuts) {
    realCuts = new Map();
    try {
      for (const f of availableFaces()) {
        const k = norm(f.family);
        realCuts.set(k, Math.max(realCuts.get(k) ?? 0, f.weight));
        // Families GDI splits by cut ("Lyon Arabic Text LF Bold") are addressed
        // by their split name too, so both spellings answer.
        const split = norm(`${f.family} ${f.subfamily}`);
        realCuts.set(split, Math.max(realCuts.get(split) ?? 0, f.weight));
      }
    } catch { /* unreadable font dirs: fall back to trusting the request */ }
  }
  const best = realCuts.get(norm(family));
  // Unknown family (nothing readable) is not evidence of a missing cut.
  return best === undefined || best >= 600;
}

// `psmt` is the FUSED Monotype PostScript suffix. The hyphenated spellings
// already resolved because `ps` and `mt` are separate entries — `TimesNewRomanPS-BoldMT`
// splits into family "Times New Roman PS" + style "Bold MT" and step 3 drops the
// `PS`. But `TimesNewRomanPSMT` has no hyphen, so it arrives as the single family
// "Times New Roman PSMT", nothing drops, and it lands as a SUBSTITUTION for a font
// that is installed on every Windows machine. Measured on the 118-page Unit Five
// deck: 3 runs of box-drawing rules asked PowerPoint for a family that does not
// exist, and the shipping gate then refused the whole document. Dropping the word
// is safe because step 3 only accepts a shortened name that is actually INSTALLED —
// a wrong guess cannot be invented, it just falls through as before.
const STYLE_WORDS = /^(regular|roman|book|normal|it|italic|oblique|bold|black|heavy|light|extralight|ultralight|thin|medium|semibold|demibold|demi|semi|condensed|cond|lf|mt|ps|psmt|rgno\d*)$/i;

/**
 * OpenType usWeightClass -> the style word type designers and font menus use.
 * Descending, so the first entry a weight reaches is its band.
 */
const WEIGHT_WORDS = [
  [900, "Black"], [800, "ExtraBold"], [700, "Bold"], [600, "Semibold"],
  [500, "Medium"], [400, ""], [300, "Light"], [200, "ExtraLight"], [100, "Thin"],
];
const weightWord = (w) => (WEIGHT_WORDS.find(([n]) => w >= n) ?? [0, ""])[1];

/** The reverse: what weight a style word implies. Longest words first. */
const WORD_WEIGHTS = [
  ["extralight", 200], ["ultralight", 200], ["extrabold", 800], ["ultrabold", 800],
  ["semibold", 600], ["demibold", 600], ["black", 900], ["heavy", 900],
  ["medium", 500], ["light", 300], ["thin", 100], ["bold", 700],
  ["regular", 400], ["normal", 400], ["roman", 400], ["book", 400],
];
/** Weight implied by any name or style string; 400 when it says nothing. */
export function weightOfName(...parts) {
  const k = parts.join(" ").toLowerCase().replace(/[^a-z]/g, "");
  for (const [word, w] of WORD_WEIGHTS) if (k.includes(word)) return w;
  return 400;
}

/** "BAAAAA+LyonArabicTextLF-Bold" -> { family: "Lyon Arabic Text LF", style: "bold" } */
export function splitFontName(pdfName) {
  const bare = String(pdfName).replace(/^[A-Z]+\+/, "");
  const [familyRaw, ...styleParts] = bare.split("-");
  const family = familyRaw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
  return { bare, family, style: styleParts.join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").trim() };
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const isItalicish = (s) => /italic|oblique/i.test(s);

/**
 * Build a resolver bound to a set of installed families.
 * Exposed as a factory so tests can pass a fixed list.
 */
export function makeFontResolver(installed = installedFamilies()) {
  const byNorm = new Map(installed.map((f) => [norm(f), f]));

  /**
   * @param {string} pdfName the font name as the PDF/MuPDF spells it
   * @param {{family?:string, weight?:number|null, italicAngle?:number}} [declared]
   *        FontDescriptor facts, when the file states them. They win over the name.
   */
  return function resolveFont(pdfName, declared = null) {
    const { bare, family: namedFamily, style: namedStyle } = splitFontName(pdfName);

    // The descriptor is the producer describing what it drew; the subset name is
    // a label that survived from somewhere else. Where they disagree, believe
    // the descriptor — this is the whole reason slide-1 headings were thin.
    const declaredWeight = Number(declared?.weight) > 0 ? Number(declared.weight) : null;
    const family = declared?.family?.trim() || namedFamily;
    const italic = isItalicish(namedStyle) || Math.abs(Number(declared?.italicAngle) || 0) > 1;
    const style = declaredWeight
      ? [weightWord(declaredWeight), italic ? "Italic" : ""].filter(Boolean).join(" ")
      : namedStyle;
    const weight = declaredWeight ?? weightOfName(namedStyle);

    /** Finish a match: does the chosen face carry the weight, or must it be faked? */
    const land = (face, substituted) => {
      const faceWeight = weightOfName(face);
      // A face whose NAME carries the weight already IS that weight; otherwise
      // the family is a plain one and the attribute has to supply it.
      const bold = faceWeight === 400 && weight >= 600;
      const delivered = faceWeight !== 400 ? faceWeight : bold ? 700 : 400;
      // Bold asked of a family that owns no bold cut is DRAWN bold by the
      // renderer smearing the regular one. It lands near the right weight but it
      // is not the designer's face, so it is declared rather than passed off as
      // exact. Measured: Cairo wants 700 and only Cairo Regular is installed.
      const synthesised = !substituted && bold && !hasRealCut(face, weight);
      return {
        face,
        bold,
        italic,
        substituted,
        requested: bare,
        weightRequested: weight,
        weightDelivered: delivered,
        weightSynthesised: synthesised,
        // Off by a band, or faked: either way the reader does not see the
        // designer's weight, and the doctor says so instead of staying quiet.
        weightApprox: Math.abs(delivered - weight) >= 100 || synthesised,
        familyRequested: family,
      };
    };

    // 1. Family + style as a single installed family name, e.g.
    //    "Lyon Arabic Text LF" + "Bold" -> "Lyon Arabic Text LF Bold".
    //    Weight lives in the NAME, so no bold attribute on top of it.
    const combined = byNorm.get(norm(`${family} ${style}`));
    if (combined) return land(combined, false);

    // 2. Family installed on its own; weight becomes a real attribute.
    const plain = byNorm.get(norm(family));
    if (plain) return land(plain, false);

    // 3. Drop trailing style-ish words one at a time ("Lyon Arabic Text LF" ->
    //    "Lyon Arabic Text") and retry, so a subset name that carries a suffix
    //    the system does not use still lands on the right family.
    const words = family.split(" ");
    for (let i = words.length - 1; i >= 1; i--) {
      if (!STYLE_WORDS.test(words[i])) break;
      const shorter = words.slice(0, i).join(" ");
      const hit = byNorm.get(norm(`${shorter} ${style}`)) ?? byNorm.get(norm(shorter));
      if (hit) return land(hit, false);
    }

    // 4. Prefix match — "Diodrum Arabic Xyz" installed, "Diodrum Arabic" asked.
    //    Pick the cut CLOSEST IN WEIGHT, never the alphabetically first: asking
    //    for "LyonArabicTextLF-RegularNo2" used to land on "Lyon Arabic Text LF
    //    Black" purely because Black sorts first.
    const prefixes = installed.filter((f) => norm(f).startsWith(norm(family) + " "));
    if (prefixes.length) {
      prefixes.sort((a, b) =>
        Math.abs(weightOfName(a) - weight) - Math.abs(weightOfName(b) - weight) || a.length - b.length);
      return land(prefixes[0], false);
    }

    // 5. Nothing matched. Never silently swap — say so.
    return land(family, true);
  };
}
