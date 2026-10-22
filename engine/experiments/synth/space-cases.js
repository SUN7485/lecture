/**
 * Latin/digit <-> Arabic boundaries, where a word space is won or lost.
 *
 * WHY. The corrected PACKAGE scorer exposed this class: the model holds "68مجال"
 * where the truth is "68 مجال". 28 of 273 lam-alef cases carried it, and it was
 * hidden for a while because the scorer was joining runs with a space and putting
 * the missing separator back by accident.
 *
 * The question a rule has to answer from evidence alone is which of three things a
 * gap between a Latin/digit token and an Arabic one actually is:
 *
 *   a TRUE inter-word boundary        "68 مجال"      -> a space belongs there
 *   BIDI VISUAL ADJACENCY             the two tokens are neighbours on the page
 *                                     only because the reordering put them there
 *   SAME-TOKEN MIXED SCRIPT           "VAM*"، "Q*"، "%100" -> one token, no space
 *
 * The third is the dangerous one: this project has already paid for splitting `%100`
 * into two runs (EVO-034) and for an operator escaping its own expression (EVO-037).
 * So the set carries same-token cases as NEGATIVE CONTROLS, and a rule that inserts
 * a space inside `VAM*` or `Q*` is refused however well it scores elsewhere.
 *
 * Both directions are generated, because RTL makes them different problems: Arabic
 * then Latin is not the mirror of Latin then Arabic once the line is reordered.
 */
export const AR = "Arial";

const ARABIC = ["مجال", "الإنتاج", "اختبار", "العربية", "الوحدة", "القياس"];
const LATIN = ["VAM", "Excel", "ABC", "Report", "Solver", "MODI"];
const DIGITS = ["68", "2026", "1250", "12", "440", "9"];

/** Shapes where a space IS expected between the two tokens. */
const SEPARATED = [
  { id: "digit-then-arabic", make: (a, l, d) => `${d} ${a}` },
  { id: "arabic-then-digit", make: (a, l, d) => `${a} ${d}` },
  { id: "latin-then-arabic", make: (a, l, d) => `${l} ${a}` },
  { id: "arabic-then-latin", make: (a, l, d) => `${a} ${l}` },
  { id: "arabic-latin-arabic", make: (a, l, d) => `${a} ${l} ${a}` },
  { id: "digit-arabic-digit", make: (a, l, d) => `${d} ${a} ${d}` },
  { id: "paren-latin-arabic", make: (a, l, d) => `(${l}) ${a}` },
  { id: "arabic-paren-latin", make: (a, l, d) => `${a} (${l})` },
  { id: "comma-between", make: (a, l, d) => `${a}، ${l}` },
  { id: "period-after-latin", make: (a, l, d) => `${a} ${l}.` },
  { id: "colon-then-digit", make: (a, l, d) => `${a}: ${d}` },
  { id: "percent-after", make: (a, l, d) => `${a} ${d}%` },
];

/**
 * NEGATIVE CONTROLS — one token that happens to mix scripts. A rule that puts a
 * space inside any of these is wrong no matter what it fixes elsewhere.
 */
const SAME_TOKEN = [
  "VAM*", "Q*", "%100", "A4", "H2O", "Excel365", "COVID19", "3D", "PDF2PPT", "N=5",
  "س=5", "ص2", "م3", "كم/س", "12.5%", "Z=40", "x2", "CO2", "IPv6", "MP3",
];

const cases = [];
let seq = 0;

for (const shape of SEPARATED) {
  for (let k = 0; k < ARABIC.length; k++) {
    seq++;
    const text = shape.make(ARABIC[k], LATIN[(k + seq) % LATIN.length], DIGITS[(k + 2 * seq) % DIGITS.length]);
    cases.push({
      name: `sep-${shape.id}-${k}`, font: AR, dir: "rtl", size: 20, text,
      meta: { shape: shape.id, expectSpace: true },
    });
  }
}

for (const [i, t] of SAME_TOKEN.entries()) {
  cases.push({
    // A bare mixed token alone on the line, and the same token inside a sentence:
    // the reordering only happens when there is something to reorder against.
    name: `same-token-${i}-bare`, font: AR, dir: "rtl", size: 20, text: t,
    meta: { shape: "same-token", expectSpace: false },
  });
  cases.push({
    name: `same-token-${i}-in-line`, font: AR, dir: "rtl", size: 20,
    text: `القيمة ${t} في الجدول`,
    meta: { shape: "same-token-in-line", expectSpace: false },
  });
}

export const SPACE_CASES = cases;
