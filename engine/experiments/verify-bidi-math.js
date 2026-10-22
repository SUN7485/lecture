/**
 * Mixed Arabic / mathematics: named sites, asserted through `visualToLogical`.
 *
 * WHY THIS GATE EXISTS. A reader reported "2X1 + X2 <= 40" coming back as
 * "X1+X2<=402" on a lecture slide. The cause was in the island rule, not in the
 * classification: in an RTL paragraph UAX#9 I2 raises L, EN and AN all to level
 * 2, so they form ONE reversal run, and requiring an island to share a single
 * class split it wherever a formula's leading DIGIT met its first LETTER. The
 * digit then landed on the far side of the line reversal.
 *
 * The cases below are VISUAL strings — the left-to-right order the page actually
 * paints — taken verbatim from the reported document, so no case is an invention
 * about how a renderer "should" behave. `want` is the logical reading.
 *
 * THREE OF THEM ARE GUARDS, and they are the point. The class boundary this fix
 * relaxes is exactly the one an earlier comment said to keep: two number runs
 * separated by a real direction change must still NOT merge. All three produce
 * byte-identical output before and after the change, which is what makes the fix
 * surgical rather than a widened threshold.
 *
 * Lam-alef sites are deliberately absent: the pipeline hands `visualToLogical`
 * grouped ligature components, and a bare string cannot carry the grouping, so a
 * fixture built from one would assert against an input the function never sees.
 *
 * Usage: node experiments/verify-bidi-math.js [--show]
 */
import { visualToLogical } from "../src/extract/bidi.js";

const CASES = [
  // ---- the reported defect ------------------------------------------------
  {
    name: "leading-digit-of-a-formula",
    site: "Unit Five p45 block 6 (fragment)",
    visual: "ةعاس 2X1+X2≤40 :ةراجنلا ديق",
    want: "قيد النجارة: 2X1+X2≤40 ساعة",
    was: "قيد النجارة: X1+X2≤402 ساعة",
  },
  {
    name: "model-line-with-four-islands",
    site: "Unit Five p45 block 6",
    visual: "X1,X2≥0 | ةعاس X1+X2≤30 :عيمجتلا ديق | ةعاس 2X1+X2≤40 :ةراجنلا ديق | Max Z = 40X1+30X2 :جذومنلا",
    want: "النموذج: Max Z = 40X1+30X2 | قيد النجارة: 2X1+X2≤40 ساعة | قيد التجميع: X1+X2≤30 ساعة | X1,X2≥0",
    was: "النموذج: Max Z = 40X1+30X2 | قيد النجارة: X1+X2≤402 ساعة | قيد التجميع: X1+X2≤30 ساعة | X1,X2≥0",
  },
  {
    name: "evaluation-line-many-parenthesised-numbers",
    site: "Unit Five p45 block 12",
    visual: "Z: Z(O)=0 | Z(A)=900 | Z(B)=40(10)+30(20)=400+600=1000 | Z(C)=800 مييقت — 5 ةوطخلا",
    want: "الخطوة 5 — تقييم Z: Z(O)=0 | Z(A)=900 | Z(B)=40(10)+30(20)=400+600=1000 | Z(C)=800",
  },
  {
    name: "formula-whose-island-opens-with-a-letter",
    site: "Unit Five p45 block 6 (fragment) — worked before the fix, must keep working",
    visual: "ةعاس X1+X2≤30 :عيمجتلا ديق",
    want: "قيد التجميع: X1+X2≤30 ساعة",
  },

  // ---- guards: these must NOT change ---------------------------------------
  {
    name: "GUARD two number runs split by an RTL-resolved dash",
    site: "the case the old single-class island rule was written for",
    visual: ")3–1( قاطنلا",
    want: "النطاق (1–3)",
    guard: true,
  },
  {
    name: "GUARD a Latin phrase with a trailing number reverses as ONE unit",
    site: "the W7 case in bidi.js",
    visual: "(Microsoft Excel 365) جمانربلا",
    want: "البرنامج (Microsoft Excel 365)",
    guard: true,
  },
  {
    name: "GUARD a bare number between Arabic words stays where it is",
    site: "the commonest shape in the corpus",
    visual: "ةنس 2020 يف",
    want: "في 2020 سنة",
    guard: true,
  },
  {
    name: "an Arabic-Indic number keeps its own digit order",
    site: "experiments/factory item digits-1, on a Chromium print of an authored string",
    // U+0660-0669 sit INSIDE the Arabic block, so a classifier that tests
    // "is this Arabic?" before "is this an Arabic number?" calls them strong R
    // and reverses them with the sentence. Ten was delivered as one. The corpus
    // writes its numbers in Western digits and can never show it.
    visual: "١٩ نم ١٠ ةحيرشلا",
    want: "الشريحة ١٠ من ١٩",
    was: "الشريحة ٠١ من ٩١",
  },
  {
    name: "an Arabic number keeps its separator INSIDE it",
    site: "experiments/factory items separator-1 and separator-2",
    // U+066B ARABIC DECIMAL SEPARATOR and U+066C ARABIC THOUSANDS SEPARATOR are
    // Bidi_Class AN. Classed as strong R — which they are by block membership —
    // they split one number into two AN islands with an R between, and the whole
    // thing reverses around the separator: pi came back as fourteen point three.
    visual: "اًبيرقت ٣٫١٤ ةميقلا",
    want: "القيمة ٣٫١٤ تقريبًا",
    was: "القيمة ١٤٫٣ تقريبًا",
  },
];

const run = (visual) => visualToLogical([...visual].map((c) => ({ c })), true).map((g) => g.c).join("");

let failures = 0;
console.log("\nMIXED ARABIC / MATH — visual order in, logical order out\n");
for (const c of CASES) {
  const got = run(c.visual);
  const ok = got === c.want;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok || process.argv.includes("--show")) {
    console.log(`          site    ${c.site}`);
    console.log(`          visual  ${JSON.stringify(c.visual)}`);
    console.log(`          want    ${JSON.stringify(c.want)}`);
    console.log(`          got     ${JSON.stringify(got)}`);
    if (c.was) console.log(`          was     ${JSON.stringify(c.was)}   (before the island fix)`);
  }
}

// A fixture that has never failed is decoration. The four non-guard cases each
// carry the string the old code produced; assert they are DIFFERENT from `want`,
// so this file cannot silently become a set of tautologies.
for (const c of CASES.filter((x) => x.was)) {
  if (c.was === c.want) { failures++; console.log(`  FAIL  ${c.name}: recorded "was" equals "want" — the case proves nothing`); }
}

console.log(failures ? `\nFIXTURES FAIL: ${failures}\n` : `\nFIXTURES PASS: ${CASES.length} cases, ${CASES.filter((c) => c.guard).length} of them guards.\n`);
process.exit(failures ? 1 : 0);
