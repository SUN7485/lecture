/**
 * The test cases, and the TRUTH for each one.
 *
 * WHY THIS FILE EXISTS. Text accuracy is measurable on exactly one of the nine
 * producers this project has converted, because only the Chrome corpus has HTML
 * ground truth beside it (see PRODUCER_MATRIX.md). Everywhere else "the text looks
 * right" is an impression. That is the largest hole in the project's evidence, and
 * it is the reason no second extraction engine can be justified or refused yet.
 *
 * The fix is to AUTHOR the source. Each case below is a slide whose text we wrote,
 * so the truth is not inferred from anything — it is the string in this file. The
 * slide is exported to PDF by a real producer and converted back, and the score is
 * a comparison against these exact strings.
 *
 * Every case targets a defect class this project has actually paid for, so a
 * regression in any of them is a regression in something already measured:
 * lam-alef ligatures, dropped marks, tanween, bidi ordering of digits and
 * neutrals, Latin islands inside Arabic, and the arithmetic lines that carry an
 * Arabic unit word.
 */

/** Fonts installed on this machine; see `src/fonts/webfonts.js` for the list. */
export const AR = "Diodrum Arabic";
export const AR2 = "Lyon Arabic Text LF RgNo2";
export const LATIN = "Arial";

/**
 * One case = one slide = one or more boxes whose text we know exactly.
 *
 * `dir` is the base direction we intend, which the scorer does NOT use to judge
 * text — it is recorded so a future reading-order check has something to compare
 * against without re-deriving it.
 */
export const CASES = [
  { name: "arabic-plain", font: AR, dir: "rtl", size: 20,
    text: "هندسة العمليات واللوجستيات الصناعية" },

  { name: "arabic-sentence", font: AR, dir: "rtl", size: 18,
    text: "الهدف من هذه الوحدة هو فهم كيفية قياس الطاقة الإنتاجية للمصنع." },

  // The defect class that cost this project the most: a lam-alef ligature is one
  // glyph standing for two characters.
  { name: "lam-alef", font: AR, dir: "rtl", size: 20,
    text: "الانحراف الأمثل لأسبوع الإنتاج الآلي لإدارة الأعمال" },

  // A mark-carrying base letter that structured text drops at the mark's origin.
  { name: "diacritics", font: AR, dir: "rtl", size: 20,
    text: "يُعدّ المعيار الفعّال مصدرًا للجودة في ثوانٍ معدودة" },

  // Tanween with no alef either side — a shipped doctor rule.
  { name: "tanween", font: AR, dir: "rtl", size: 20,
    text: "زاد الإنتاج تدريجيًا وأصبح المصنع أكثر كفاءةً وجودةً" },

  // Digits inside RTL text: the bidi class that produced `numeric-direction`.
  { name: "arabic-digits", font: AR, dir: "rtl", size: 18,
    text: "بلغ الإنتاج 1250 وحدة بنسبة 83.3% خلال 12 ساعة" },

  // Arabic-Indic digits beside Western ones.
  { name: "mixed-digits", font: AR, dir: "rtl", size: 18,
    text: "الكمية ١٢٣٤ مقابل 1234 في التقرير" },

  // A Latin island inside an Arabic sentence — brackets, dots and all.
  { name: "latin-island", font: AR, dir: "rtl", size: 18,
    text: "استخدم برنامج (Microsoft Excel 365) لحساب الانحراف المعياري" },

  // The arithmetic line with an Arabic unit word: 79% of one named miss bucket.
  { name: "formula-unit", font: AR, dir: "rtl", size: 18,
    text: "الزمن المتاح = 480 دقيقة ÷ 40 وحدة = 12 دقيقة لكل وحدة" },

  // An operator between two numbers — the × that used to escape its expression.
  { name: "operators", font: AR, dir: "rtl", size: 18,
    text: "الناتج 1000 × 4 ÷ 2 = 2000 ريال" },

  // Neutrals at a run edge: the class `verify-run-edges` exists for.
  { name: "punctuation", font: AR, dir: "rtl", size: 18,
    text: "المعايير: الجودة، الكلفة، والزمن؛ هل هي كافية؟ نعم!" },

  // A paragraph with no Arabic that is nonetheless laid out RTL in the source.
  { name: "latin-only", font: LATIN, dir: "ltr", size: 18,
    text: "Capacity Utilization = Actual Output / Design Capacity" },

  { name: "latin-mixed-case", font: LATIN, dir: "ltr", size: 18,
    text: "The WIP formula: WIP = Throughput x Flow Time (Little's Law)" },

  // A second Arabic face, to catch a resolver that only works for one family.
  { name: "second-face", font: AR2, dir: "rtl", size: 20,
    text: "تحليل نقطة التعادل والكلفة الثابتة" },

  // Bullets: each becomes its own paragraph, and the marker must not be text.
  { name: "bullets", font: AR, dir: "rtl", size: 16, bullet: true,
    lines: ["قياس الطاقة التصميمية", "قياس الطاقة الفعلية", "حساب نسبة الاستغلال"] },

  // Small type, where a rounding error in geometry shows first.
  { name: "tiny-text", font: AR, dir: "rtl", size: 8,
    text: "ملاحظة: القيم التقديرية قابلة للمراجعة" },

  // Superscript/subscript, which the model records as `lift`.
  { name: "superscript", font: LATIN, dir: "ltr", size: 18,
    runs: [{ text: "Area = r" }, { text: "2", sup: true }, { text: " x pi" }] },

  // Two boxes on one slide: the simplest reading-order question there is.
  { name: "two-columns", font: AR, dir: "rtl", size: 16,
    columns: ["العمود الأيمن يحتوي على المقدمة", "العمود الأيسر يحتوي على الخلاصة"] },
];

/** The exact string a case is expected to yield, joined the way the scorer reads it. */
export function truthText(c) {
  if (c.text) return c.text;
  if (c.lines) return c.lines.join("\n");
  if (c.columns) return c.columns.join("\n");
  if (c.runs) return c.runs.map((r) => r.text).join("");
  throw new Error(`case ${c.name} has no text`);
}
