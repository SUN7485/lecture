/**
 * Targeted lam-alef population, generated rather than hand-written.
 *
 * WHY TARGETED AND NOT 500 CASES OF EVERYTHING. The space rule was nearly derived
 * from a six-deck sample that said it would touch ONE Chrome site; the full corpus
 * said many more, and a ratio threshold that separated four samples cleanly
 * overlapped completely at scale. Lam-alef is the most dangerous repair path in
 * this project — `lam-alef-reversed` scored 20 fixed / 878 broken as a plain
 * 2-character swap and only reached 0 broken once it was gated on a context Arabic
 * cannot produce — so the population has to come before the rule.
 *
 * A lam-alef is ONE glyph standing for TWO characters. Four of them exist:
 *
 *   لا  U+0644 U+0627   lam + alef
 *   لأ  U+0644 U+0623   lam + alef with hamza above
 *   لإ  U+0644 U+0625   lam + alef with hamza below
 *   لآ  U+0644 U+0622   lam + alef with madda
 *
 * Each is generated at word start, middle and end, bare and in the contexts that
 * have historically changed the answer: a diacritic on the cluster, punctuation
 * against it, digits either side, a Latin island beside it, and two of them in one
 * line. NEGATIVE CONTROLS carry a lam that is NOT followed by an alef — a repair
 * that fires on those is inventing Arabic, and the corpus has already refused two
 * rules for exactly that.
 */

const FORMS = [
  { id: "lam-alef", ch: "لا" },
  { id: "lam-hamza-above", ch: "لأ" },
  { id: "lam-hamza-below", ch: "لإ" },
  { id: "lam-madda", ch: "لآ" },
];

/** Real words carrying each form, by where the cluster sits in the word. */
const WORDS = {
  "لا": { start: ["لاعب", "لازم"], middle: ["البلاد", "السلام", "الطلاب"], end: ["مجال", "شمال", "أعمال"] },
  "لأ": { start: ["لأجل", "لأنه"], middle: ["الأعلام", "المسألة"], end: ["ملجأ", "المبدأ"] },
  "لإ": { start: ["لإدارة", "لإنتاج"], middle: ["الإنتاج", "الإجراء"], end: ["يبدأ", "الملجإ"] },
  "لآ": { start: ["لآخر", "لآلة"], middle: ["الآلي", "الآمال"], end: ["المرآة", "الصدآ"] },
};

/**
 * Contexts that have changed this answer before.
 *
 * The filler words VARY per case. In the first run every -comma case ended in غيره,
 * so a single ي/ر transposition in that one word filled the whole BROKEN-BY-US
 * bucket twelve times and read as a class. A fixture whose filler repeats cannot
 * tell one defect from twelve.
 */
const FILL = ["نعم", "دائمًا", "بوضوح", "سريعًا", "لاحقًا", "أيضًا", "تمامًا"];        // 7: coprime with the 10 contexts
const PLACE = ["التقرير", "الجدول", "الملف", "الصفحة", "القسم", "النموذج", "المحضر", "الكشف", "البيان"];  // 9
const CONTEXTS = [
  { id: "bare", wrap: (w) => w },
  { id: "sentence", wrap: (w, k) => `هذا ${w} في ${PLACE[k % PLACE.length]}` },
  { id: "period", wrap: (w) => `${w}.` },
  { id: "comma", wrap: (w, k) => `${w}، ${FILL[k % FILL.length]}` },
  { id: "parens", wrap: (w) => `(${w})` },
  { id: "digit-before", wrap: (w, k) => `${12 + k} ${w}` },
  { id: "digit-after", wrap: (w, k) => `${w} ${2020 + k}` },
  { id: "latin-before", wrap: (w, k) => `${["Excel", "Word", "Visio", "Access"][k % 4]} ${w}` },
  { id: "latin-after", wrap: (w, k) => `${w} ${["Report", "Summary", "Notes", "Draft"][k % 4]}` },
  { id: "diacritic", wrap: (w, k) => `${w}ً في ${PLACE[(k + 3) % PLACE.length]}` },
];

/** A lam NOT followed by an alef. A rule that fires here is inventing Arabic. */
const NEGATIVES = [
  "قلم وكتاب", "العلم نور", "لبن وعسل", "الملف الجديد", "سلمان يكتب",
  "الحلم الكبير", "ملعب واسع", "الفلك والنجوم", "كلمة السر", "العالم يتغير",
];

/**
 * A SYSTEM-installed Arabic face, and the reason matters.
 *
 * The first population asked for Diodrum Arabic and every one of its 273 cases came
 * back painted in Calibri. That is not a generator bug: exporting a deck THIS
 * PROJECT wrote — one that names Diodrum on every Arabic run — gives the same
 * result. Diodrum, Lyon and Cairo are installed PER USER on this machine
 * (%LOCALAPPDATA%\Microsoft\Windows\Fonts + HKCU, see CONTEXT.md), and
 * PowerPoint driven over COM does not resolve per-user fonts when it writes a PDF.
 *
 * So the fixture uses a face that ships with Windows for everyone. The limitation is
 * real and worth stating: this measures Arabic shaping and PDF encoding in Arial,
 * not in the corpus faces. What it CAN answer is whether our reconstruction mangles
 * a well-formed Arabic PDF, which is the question the lam-alef work needs.
 */
export const AR = "Arial";

const cases = [];
let seq = 0;

for (const f of FORMS) {
  const byPos = WORDS[f.ch];
  for (const pos of ["start", "middle", "end"]) {
    for (const [wi, word] of byPos[pos].entries()) {
      for (const ctx of CONTEXTS) {
        seq++;
        cases.push({
          name: `${f.id}-${pos}-w${wi}-${ctx.id}`,
          font: AR, dir: "rtl", size: 20,
          text: ctx.wrap(word, seq),
          meta: { form: f.ch, position: pos, word, context: ctx.id, expectRepair: true },
        });
      }
    }
  }
}

// Two clusters in one line — where a per-word budget and a per-line one disagree.
for (const [i, [a, b]] of [["الاستقلال", "الاعتماد"], ["الأعمال", "الإدارة"], ["الآلي", "البلاد"]].entries()) {
  cases.push({
    name: `two-clusters-${i}`, font: AR, dir: "rtl", size: 20,
    text: `${a} و${b} معًا`,
    meta: { form: "multi", position: "line", word: `${a} ${b}`, context: "two", expectRepair: true },
  });
}

for (const [i, t] of NEGATIVES.entries()) {
  cases.push({
    name: `negative-${i + 1}`, font: AR, dir: "rtl", size: 20, text: t,
    meta: { form: "none", position: "none", word: t, context: "negative", expectRepair: false },
  });
}

export const LAM_CASES = cases;
