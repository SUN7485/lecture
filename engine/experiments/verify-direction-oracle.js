/**
 * THE DELIVERY DIRECTION ORACLE, held to known answers.
 *
 * `src/model/direction.js` decides which paragraphs are declared right-to-left
 * in the PPTX. It is one regex, which is exactly the kind of thing that looks
 * obviously correct and is quietly wrong about one character — measured: the
 * first version used `\p{Script=Arabic}`, which excludes U+060C ARABIC COMMA
 * (Script=Common), and turned `D ، C` from RTL to LTR on a slide whose source
 * paints `C ، D`.
 *
 * Every case below carries WHY it is what it is, and the two cases that a naive
 * predicate gets wrong are marked, so this file cannot decay into a tautology
 * that only tests the implementation against itself.
 *
 * Usage: node experiments/verify-direction-oracle.js [--seed-regression]
 */
import { hasStrongRtl, paragraphDirection } from "../src/model/direction.js";
import { requireSubjects } from "./lib-gate.js";

const SEED = process.argv.includes("--seed-regression");
/** With the seed, ask the question the OLD Arabic-block range asked. */
const rtl = SEED ? (t) => /[\u0600-\u06FF\u0750-\u077F]/.test(t) && !/\u060C/.test(t) : hasStrongRtl;

const CASES = [
  // --- right-to-left, and each for a different reason ----------------------
  ["العربية",     true,  "ordinary Arabic"],
  ["ﺣﺮﺍﺭﺓ",       true,  "Arabic PRESENTATION FORMS — outside the 0600-06FF block"],
  ["D ، C",       true,  "U+060C ARABIC COMMA is Script=Common; only Script_Extensions sees it. " +
                         "The source paints `C ، D` and the logical string is `D ، C`, so LTR reverses the cell."],
  ["شلاير 5",      true,  "Arabic with Western digits"],
  ["שלום",        true,  "Hebrew — no document here has one yet, and that is the point"],
  ["ܣܘܪܝܝܐ",      true,  "Syriac"],

  // --- left-to-right, and every one of these SHIPPED as RTL before ---------
  ["(Ergonomics)",                        false, "a Latin island the extractor read RTL to recover its brackets"],
  ["=SUMIF(range ; criteria ; sum_range)", false, "a field-box segment of an Arabic line"],
  ["$F$2",                                false, "ditto, and nothing in it is directional"],
  ["«78»",                                false, "guillemets and digits: neutrals only"],
  [";",                                   false, "one neutral, its own paragraph"],
  ["0+(−16)=−16",                         false, "arithmetic"],
  ["Shop)",                               false, "a fragment whose opener is on the line above"],
  ["[Taha, H. A. (2017). Operations Research]", false, "a citation line"],
  ["💡",                                   false, "an emoji is not a script"],
];

let checked = 0;
const bad = [];
for (const [text, want, why] of CASES) {
  checked++;
  const got = rtl(text);
  if (got !== want) bad.push({ text, want, got, why });
}

// The narrowing may only ever turn RTL OFF. If it can turn it on, a paragraph
// the extractor read left-to-right could be reversed by delivery, which no
// evidence at this stage supports.
for (const text of CASES.map((c) => c[0])) {
  checked++;
  if (paragraphDirection(text, "ltr") !== "ltr") {
    bad.push({ text, want: "ltr from an ltr source", got: "rtl", why: "the narrowing must not turn RTL on" });
  }
}

requireSubjects(checked, "direction cases", "CASES is empty — the gate would pass over nothing.");

console.log(`\nDELIVERY DIRECTION ORACLE — ${checked} cases`);
for (const b of bad) {
  console.log(`  WRONG  ${JSON.stringify(b.text)}  want ${b.want}, got ${b.got}`);
  console.log(`         ${b.why}`);
}
console.log("=".repeat(74));
if (bad.length) {
  console.log(`  GATE FAIL: ${bad.length} of ${checked} cases wrong.`);
  process.exit(1);
}
console.log("  GATE PASS: every case answers the way the source says it must.");
