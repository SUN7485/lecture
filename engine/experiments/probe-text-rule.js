/**
 * Score a candidate TEXT rewrite against the whole corpus, before building it.
 *
 * Every repair this project ships was measured before it was written, and the
 * ones that were not have been expensive: a dictionary repair scored 7 fixed /
 * 347 broken, a bare lam-alef swap 20 / 878. The pattern that works is to state
 * the rewrite, run it over every DELIVERED block, and read `fixed / broken` — a
 * block that was verbatim and stops being verbatim is the number that matters,
 * and a rule that touches nothing is free to reject.
 *
 * This is a CEILING, not a verdict. It scores a rewrite on the finished text; a
 * rule shipped in `web/doctor.js` runs per RUN, over a model, after the other
 * repairs, and the two disagree — the tanween probe said 91 where the real path
 * gave 73 (EVO-028). Anything that wins here still has to pass
 * `experiments/verify-repair.js` once implemented.
 *
 *   node experiments/probe-text-rule.js               # score every candidate
 *   node experiments/probe-text-rule.js percent-after --show 12
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const SHOW = Number(arg("show", 0));
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== String(SHOW));

/**
 * Candidate rewrites. Each is a pure string -> string.
 *
 * A candidate must be narrow enough to state in one sentence, because the whole
 * point of the exercise is that "plausible" is not evidence and the corpus is.
 */
const CANDIDATES = {
  /**
   * A percent sign that ended up BEFORE its number. Arabic writes `90%` exactly
   * as English does — the sign follows the digits — and `%90` is what bidi
   * resolution produces when the sign is treated as a neutral and takes the
   * paragraph's direction instead of the number's.
   */
  "percent-after": (s) => s.replace(/%(\d[\d.,]*)/gu, "$1%"),

  /**
   * The same shape for a lone `×` that drifted to the head of a numeric run:
   * `× 4 4` for `4 × 4`, `× 0.9 × 0.9 0.9` for `0.9 × 0.9 × 0.9`.
   */
  "times-between": (s) => s.replace(/×\s*(\d[\d.,]*)\s+(\d[\d.,]*)/gu, "$1 × $2"),

  /**
   * A numeric RANGE reversed end for end, with the percent sign dragged to the
   * middle: `10%–5` for `5–10%`, `95%–90` for `90–95%`. The whole block is the
   * range, so there is no Arabic around it to anchor the direction.
   */
  "percent-range": (s) => s.replace(/(\d[\d.,]*)%\s*–\s*(\d[\d.,]*)/gu, "$2–$1%"),

  /**
   * A word split by spaces around a letter that carries a combining mark:
   * `الف عّ الة` for `الفعّالة`. The mark breaks the advance chain, so the
   * synthetic-space pass in `withSpaces` sees a gap that is not a word boundary.
   */
  "join-mark-spaces": (s) => s.replace(/\s+(?=[ء-ي][ً-ْٰ])/gu, "").replace(/([ً-ْٰ])\s+(?=[ء-ي])/gu, "$1"),

  /**
   * A SHADDA sitting on a bare alef. Arabic does not double a long vowel, so
   * `اّ` is not something the language writes — the mark belongs to the letter
   * before the alef and was sorted past it. An impossibility, like the shipped
   * lam-alef rule's `ا` followed by another alef form.
   */
  "shadda-off-alef": (s) => s.replace(/([اآ])(ّ)/gu, "$2$1"),

  /** The same, widened to every combining mark on a bare alef. */
  "any-mark-off-alef": (s) => s.replace(/([اآ])([ً-ْٰ])/gu, "$2$1"),

  /**
   * A lam-alef ligature whose halves came out alef-first, in the ONE context the
   * shipped rule does not cover: preceded by a lam rather than by an alef.
   * `لألسبوع` for `للأسبوع`.
   */
  "lam-lam-alef": (s) => s.replace(/ل([اآأإ])ل(?=[ء-ي])/gu, "لل$1"),

  /**
   * After the named-ligature binding, a reversed article comes out ROTATED
   * rather than swapped: `إلاجراء` for `الإجراء`. First and third characters trade.
   */
  "rotated-article": (s) => s.replace(/([اآأإ])ل([اآأإ])/gu, "$2ل$1"),

  /**
   * The same reversal mid-word with no article context at all: `العالج` for
   * `العلاج`. Deliberately included to be REJECTED if it breaks blocks — `عال`
   * is ordinary Arabic (`عالم`, `عالي`) and this has no impossibility behind it.
   */
  "bare-alef-lam-swap": (s) => s.replace(/ا(ل)(?=[ء-ي])/gu, "لا"),

  /**
   * A signed number whose SIGN ended up behind it, in a block that is nothing
   * else: `6\u2212` for `\u22126`, `2+` for `+2`. Anchored at both ends, so it can only
   * match a cell that IS a signed number — and a number written sign-LAST is not
   * something this corpus writes, which is the licence every safe rule here has.
   */
  "sign-behind-number": (s) => s.replace(/^(\d[\d.,]*)\s*([+\u2212-])$/u, "$2$1"),

  /**
   * A whole arithmetic line reversed end for end, in a block that is nothing else:
   * `95 = 55 + 40` for `40 + 55 = 95`. Both readings are arithmetically TRUE, so
   * the evidence is not the sum — it is that the block is ENTIRELY the equation,
   * and this corpus writes the operands first. Deliberately included to be
   * rejected if the corpus disagrees.
   */
  "equation-reversed": (s) => s.replace(
    /^(\d[\d.,]*)\s*=\s*(\d[\d.,]*)\s*([+\u2212\u00d7\u00f7])\s*(\d[\d.,]*)$/u,
    "$4 $3 $2 = $1"),

  /**
   * A word broken by spaces around a mark-carrying letter, in a block that is
   * NOTHING BUT that word: `الف عّ الة` for `الفعّالة`. The unanchored form of this
   * rule is `join-mark-spaces` above, measured at 25 fixed / 1155 broken. Anchored
   * to the whole block it can only touch a fragment that is already not a word.
   */
  "join-marks-whole-block": (s) => /^[\u0600-\u06FF\s]+$/u.test(s) && /[\u064B-\u0652]/u.test(s)
    ? s.replace(/\s+/gu, "")
    : s,
};

const rows = [];
for (const pair of findPairs()) {
  const model = modelFromPdf(pair.pdf);
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);
  const slideText = loadSlides(pair.html).map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);
  for (const [i, page] of model.pages.entries()) {
    if (align[i] < 0) continue;
    for (const o of page.objects) {
      if (o.type !== "text" || !o.text) continue;
      const got = normalize(o.text);
      if (got) rows.push({ deck: pair.name, page: i + 1, got, truth: slideText[align[i]] });
    }
  }
}

console.log(`${rows.length} delivered blocks, ${rows.filter((r) => !r.truth.includes(r.got)).length} misses\n`);
console.log("candidate".padEnd(22) + "touched".padStart(9) + "fixed".padStart(8) + "broken".padStart(8) + "   net");
console.log("-".repeat(60));

for (const [name, fn] of Object.entries(CANDIDATES)) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  let touched = 0, fixed = 0, broken = 0;
  const wins = [], losses = [];
  for (const r of rows) {
    const after = normalize(fn(r.got));
    if (after === r.got) continue;
    touched++;
    const was = r.truth.includes(r.got), is = r.truth.includes(after);
    if (!was && is) { fixed++; if (wins.length < SHOW) wins.push(r); }
    else if (was && !is) { broken++; if (losses.length < SHOW) losses.push(r); }
  }
  const net = fixed - broken;
  console.log(name.padEnd(22) + String(touched).padStart(9) + String(fixed).padStart(8) +
    String(broken).padStart(8) + `   ${net >= 0 ? "+" : ""}${net}`);
  if (SHOW) {
    for (const r of losses) console.log(`   BROKE ${r.deck} p${r.page}\n     was ${r.got.slice(0, 90)}\n     now ${normalize(fn(r.got)).slice(0, 90)}`);
    for (const r of wins.slice(0, 4)) console.log(`   fixed ${r.deck} p${r.page}\n     now ${normalize(fn(r.got)).slice(0, 90)}`);
  }
}
