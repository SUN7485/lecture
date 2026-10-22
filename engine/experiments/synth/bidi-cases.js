/**
 * Same-token mixed-script bidi ordering — the last open Arabic class.
 *
 * WHY THIS SET. The spacing population's negative controls surfaced it: `VAM*` comes
 * back `*VAM`, `Q*` comes back `*Q`, `%100` comes back `100%`. These are ONE token
 * whose characters have different bidi classes — letters are strong LTR, `*` and `%`
 * are neutral or of a class that resolves against the paragraph — so the reordering
 * moves the neutral to the wrong end of the token it belongs to.
 *
 * This project has paid for both directions of this before. EVO-034: splitting `%`
 * off `%100` into its own run cost 2 delivered blocks, because every text repair
 * downstream runs per run and an expression cannot straddle a boundary. EVO-037:
 * a hand-written character range called `×` a strong LTR letter, so an operator was
 * carried out of its own expression on 39 blocks. And EVO-027: a general edge-neutral
 * rule scored 2 fixed / 38 broken while the narrow one scored 3 / 0.
 *
 * So the set is built to make a rule FAIL loudly if it is too general:
 *
 *   - the same neutral on the LEFT and on the RIGHT of a token
 *   - the same token alone on a line and inside an Arabic sentence, because the
 *     reordering only happens when there is something to reorder against
 *   - separators that are genuinely between two tokens, where a split is CORRECT
 *   - decimals, signs and percentages, which look like the failing shapes and are
 *     not the same thing
 *
 * Filler text varies per case, with the tables coprime to the shape count, so one
 * unrelated word cannot fill a bucket and read as a family.
 */
export const AR = "Arial";

const PLACE = ["التقرير", "الجدول", "الملف", "الصفحة", "القسم", "النموذج", "المحضر"];   // 7
const VERB = ["يظهر", "يوضح", "يسجل", "يعرض", "يثبت"];                                  // 5

/**
 * ATOMIC tokens: one word, mixed scripts or classes inside it. A space must never
 * appear inside these and their character order must survive unchanged.
 */
const ATOMIC = [
  "VAM*", "Q*", "ABC*", "*ABC", "%100", "100%", "ABC(123)", "ABC/123", "123/ABC",
  "ABC-123", "123-ABC", "A4", "H2O", "CO2", "N=5", "Z=40", "x2", "MP3", "IPv6", "3D",
  "+15", "-20", "12.5", "0.75", "1,250", "50%", "%50", "(ABC)", "[123]", "C2:L2",
];

/** Shapes that place an atomic token in a context that forces reordering. */
const SHAPES = [
  { id: "bare", make: (t) => t },
  { id: "arabic-before", make: (t, k) => `${PLACE[k % PLACE.length]} ${t}` },
  { id: "arabic-after", make: (t, k) => `${t} ${PLACE[k % PLACE.length]}` },
  { id: "arabic-both", make: (t, k) => `${VERB[k % VERB.length]} ${t} في ${PLACE[k % PLACE.length]}` },
  { id: "period", make: (t) => `${t}.` },
  { id: "comma", make: (t, k) => `${t}، ${VERB[k % VERB.length]}` },
  { id: "parens-around", make: (t) => `(${t})` },
  { id: "colon-before", make: (t, k) => `${PLACE[k % PLACE.length]}: ${t}` },
];

/**
 * SEPARATED controls: the same characters as neighbours of two DIFFERENT tokens,
 * where a boundary really is there. A rule that fuses these is as wrong as one that
 * splits an atomic token.
 */
const SEPARATED = [
  "العربية ABC", "ABC العربية", "العربية 123", "123 العربية",
  "ABC* العربية", "العربية *ABC", "ABC، 123", "123 / ABC",
  "القياس % الوحدة", "ABC - 123", "الوحدة (ABC) الثانية", "ABC : 123",
];

const cases = [];
let seq = 0;

for (const shape of SHAPES) {
  for (const t of ATOMIC) {
    seq++;
    cases.push({
      name: `atomic-${shape.id}-${ATOMIC.indexOf(t)}`,
      font: AR, dir: "rtl", size: 20, text: shape.make(t, seq),
      meta: { token: t, shape: shape.id, atomic: true },
    });
  }
}

for (const [i, t] of SEPARATED.entries()) {
  cases.push({
    name: `separated-${i}`, font: AR, dir: "rtl", size: 20, text: t,
    meta: { token: t, shape: "separated", atomic: false },
  });
  cases.push({
    name: `separated-${i}-in-line`, font: AR, dir: "rtl", size: 20,
    text: `${VERB[i % VERB.length]} ${t} هنا`,
    meta: { token: t, shape: "separated-in-line", atomic: false },
  });
}

// LTR-based paragraphs of the same shapes: the reordering is a different problem
// once the base direction flips, and a rule that only holds in RTL is not general.
for (const t of ATOMIC.slice(0, 12)) {
  cases.push({
    name: `ltr-${ATOMIC.indexOf(t)}`, font: AR, dir: "ltr", size: 20,
    text: `Value ${t} in table`,
    meta: { token: t, shape: "ltr-context", atomic: true },
  });
}

export const BIDI_CASES = cases;
