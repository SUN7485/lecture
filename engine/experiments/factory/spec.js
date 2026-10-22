/**
 * THE SYNTHETIC GROUND-TRUTH SPEC — text whose truth is authored, not extracted.
 *
 * WHY THIS EXISTS. Every accuracy number this project publishes describes 28
 * Chrome prints of one HTML template, because that is the only corpus with a
 * ground truth beside it. `probe-producer-robustness.js` already builds a second
 * producer out of parts here, but its "truth" is model A — itself an extraction —
 * so it can prove the extractor is SELF-CONSISTENT across producers and cannot
 * say whether it is RIGHT. This file is the other half: the string is written
 * here, by hand, and every producer downstream is asked to reproduce it.
 *
 *   spec.js  --build-->  PPTX  --PowerPoint-->  PDF  --extract-->  model
 *      |                                                             |
 *      +------------------------ compared -------------------------- +
 *
 * SCOPE OF v1, stated so nobody quotes it for more than it measures: TEXT ONLY.
 * One item per line, one line per row, well separated vertically so an extracted
 * block can be matched to its item by baseline without the text being consulted.
 * Tables, per-glyph geometry, font identity and formula structure are NOT
 * measured yet and each needs its own emitter.
 *
 * A caveat that belongs with any result from the PowerPoint route: PowerPoint's
 * PDF export drops install-on-demand embedded fonts, so every glyph in the
 * exported PDF is named Calibri. Text is measurable there; font identity is not.
 *
 * FAMILIES are chosen to be the things this project has actually been wrong
 * about, so a regression in any of them is a regression in something that cost a
 * session before: lam-alef ligatures, marks on a base, tanween, mixed direction,
 * bracket order, arithmetic direction, and Arabic-Indic digits.
 */

/** @typedef {{ id: string, family: string, text: string, dir: "rtl"|"ltr", note?: string }} SpecItem */

const item = (family, id, text, dir, note) => ({ family, id: `${family}-${id}`, text, dir, note });

/** @type {SpecItem[]} */
export const SPEC = [
  // --- plain Arabic, the baseline every other family is measured against ----
  item("arabic", "1", "الحل البياني للبرمجة الخطية", "rtl"),
  item("arabic", "2", "هندسة العمليات واللوجستيات الصناعية", "rtl"),
  item("arabic", "3", "تحسين بيئة العمل في المصنع", "rtl"),

  // --- lam-alef: one glyph standing for two characters ----------------------
  item("lamalef", "1", "الأسبوع الثالث والثلاثون", "rtl", "أ after ل"),
  item("lamalef", "2", "للأسبوع القادم إن شاء الله", "rtl", "the ligature whose halves both arrive full width"),
  item("lamalef", "3", "لا يوجد تحسين ممكن للحل", "rtl", "bare lam-alef"),
  item("lamalef", "4", "إفشال الخطة لا يعني الفشل", "rtl", "hamza-below alef in a ligature"),

  // --- marks on a base: the class structured text drops at the mark's origin -
  item("marks", "1", "يُعدّ هذا المعيار الأهم", "rtl", "damma then shadda on a dal"),
  item("marks", "2", "خلال ثوانٍ معدودة", "rtl", "kasratan on a noon"),
  item("marks", "3", "منتجات عالية جودةً", "rtl", "fathatan on ta-marbuta"),
  item("marks", "4", "الفعّالة في الإنتاج", "rtl", "shadda raising the box"),
  item("marks", "5", "زمن الطلَب قصير", "rtl", "a bare fatha mid-word"),

  // --- mixed direction, one paragraph ---------------------------------------
  item("mixed", "1", "تحسين بيئة العمل (Ergonomics) في المصنع", "rtl", "a Latin island inside Arabic"),
  item("mixed", "2", "القيم المستهدفة (Target Values) لكل قسم", "rtl"),
  item("mixed", "3", "زمن الطلب: Ttakt = 25200 ÷ 900 = 28 ثانية", "rtl", "an Arabic sentence quoting a formula"),

  // --- arithmetic: laid out left to right whatever surrounds it --------------
  item("formula", "1", "8 × 60 = 480 دقيقة", "ltr", "an LTR expression with an Arabic unit word"),
  item("formula", "2", "=SQRT(2*D*S/H)", "ltr", "a spreadsheet formula, no Arabic at all"),
  item("formula", "3", "1000 × √4 ≤ 40", "ltr", "operators inside the Latin-1 letter range"),
  item("formula", "4", "0 + (−16) = −16", "ltr", "a signed number in parentheses"),

  // --- brackets and citations: direction read off the edges -----------------
  item("citation", "1", "[4] Shingo, S. (1985). النظام الياباني", "ltr", "a numbered reference marker at the start"),
  item("citation", "2", "Taha, H. A. (2017). Operations Research.", "ltr"),

  // --- digits ---------------------------------------------------------------
  item("digits", "1", "الشريحة ١٠ من ١٩", "rtl", "Arabic-Indic digits"),
  item("digits", "2", "شريحة 10 من 19", "rtl", "Western digits in an Arabic line"),

  // --- Arabic-script separators: Bidi_Class AN, and inside a number ---------
  item("separator", "1", "القيمة ٣٫١٤ تقريباً", "rtl", "U+066B ARABIC DECIMAL SEPARATOR inside a number"),
  item("separator", "2", "المجموع ١٬٠٠٠ وحدة", "rtl", "U+066C ARABIC THOUSANDS SEPARATOR inside a number"),
  item("separator", "3", "النسبة ٪٢٥ من الكل", "rtl", "U+066A ARABIC PERCENT SIGN"),

  // --- ta-marbuta carrying a mark at the end of a word ----------------------
  item("tamarbuta", "1", "منتجات عالية جودةً", "rtl", "fathatan on a word-final ta-marbuta"),
  item("tamarbuta", "2", "راجع الخطة مرةً أخرى", "rtl", "the same shape, mid-sentence"),
  item("tamarbuta", "3", "منتجات عالية الجودة", "rtl", "CONTROL: the same word with no mark"),

  // --- arithmetic painted TIGHT, with no spaces between the operators -------
  item("tight", "1", "0+0=0", "ltr", "no spaces anywhere; we have been inventing them"),
  // NOT `16=16+0`: that shape is genuinely AMBIGUOUS — it is both a valid
  // left-to-right equation and the visual form of `0+16=16`, and the repair that
  // reverses it says so itself ("both readings are arithmetically TRUE, so the
  // sum is not the evidence"). A fixture whose truth cannot be decided tests
  // nothing. This shape is not one the reversal rule matches, so it measures
  // SPACING, which is what this family is for.
  item("tight", "2", "16+0=16", "ltr"),
  item("tight", "3", "2X1+X2≤40", "ltr", "a constraint with no spaces"),
  item("tight", "4", "0+(−16)=−16", "ltr", "the one row of the five that did NOT gain spaces"),

  // --- Latin only -----------------------------------------------------------
  item("latin", "1", "Operations Research and Industrial Logistics", "ltr"),
  item("latin", "2", "Reduced Cost / Shadow Price / Allowable Increase", "ltr"),
];

/** Families in a stable order, for reports. */
export const FAMILIES = [...new Set(SPEC.map((s) => s.family))];
