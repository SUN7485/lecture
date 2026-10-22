/**
 * THE DELIVERY DIRECTION ORACLE — deliberately not the extraction one.
 *
 * There are two direction questions in this pipeline and they had one answer
 * between them until 2026-08-20, which cost 102 paragraphs shipped as RTL with
 * no RTL character in them (KNOWN_ISSUES 2026-08-20):
 *
 *   sourceStreamDirection  "which base direction turns this painted glyph
 *                          stream back into a logical string" — answered by
 *                          `textIsRtl` in src/extract/bidi.js, from the VISUAL
 *                          glyph order, before any text exists. `(Ergonomics)`
 *                          is painted `)Ergonomics(` inside an Arabic line, so
 *                          the answer there is RTL and it is what recovers the
 *                          brackets.
 *
 *   paragraphDirection     "which base direction should the DESTINATION lay this
 *                          paragraph out in" — answered here, from the finished
 *                          logical text. The reconstruction has already resolved
 *                          the source's order; the paragraph PowerPoint receives
 *                          holds `(Ergonomics)` and nothing right-to-left, so
 *                          declaring it RTL asks the destination to re-order a
 *                          string that is already in reading order.
 *
 * The extraction oracle must not be reused as the delivery oracle, and the two
 * live in different modules so that reaching for the wrong one is a visible
 * import rather than a field access. A third question — run-level direction
 * inside a mixed paragraph (`a:rtl` under `a:rPr`, PowerPoint's RtlRun/LtrRun) —
 * is not answered anywhere yet and belongs here when it is.
 *
 * WHY THE TWO CANNOT SHARE AN ANSWER, concretely: `textIsRtl`'s lone-closer
 * clause is not order-invariant, because reversing a string moves a trailing
 * closer to the front. It calls `وقياس الأزمنة).` LTR as finished text and RTL
 * as the glyph stream it came from. Measured at the artifact: 59 paragraphs over
 * 30 decks where the two callers disagree, and in all 59 the extractor is right.
 */

/**
 * Scripts written right to left, as Unicode properties rather than codepoint
 * ranges — a hand-written range has holes and the hole is always the character
 * the logic is about (EVO-037: `[À-ɏ]` swallows `×` and `÷`).
 *
 * The living RTL scripts, which is what a document can plausibly carry:
 * Arabic (with its presentation forms, which `Script=Arabic` already covers),
 * Hebrew, Syriac, Thaana, N'Ko, Samaritan, Mandaic, Adlam, Hanifi Rohingya.
 * Historic RTL scripts — Phoenician, Old Turkic, Avestan and the rest — are
 * deliberately out: nothing here can typeset them and adding one is one word.
 *
 * `hasStrongRtl` is NOT the same claim as "is an Arabic document". It asks
 * whether the paragraph belongs to a right-to-left script, which is a fact about
 * the text that no reordering can change — and that invariance is exactly why
 * the gate in src/pptx/inspect.js is built on it rather than on a reconstruction
 * predicate.
 *
 * SCRIPT_EXTENSIONS, NOT SCRIPT, and the difference cost a real paragraph.
 * `\p{Script=Arabic}` excludes U+060C ARABIC COMMA, whose Script is Common
 * because several scripts share it. The first version of this file used
 * `Script=` and turned `D ، C` on Chp4-Lec31-1 p8 from RTL to LTR — the source
 * paints `C ، D`, the logical string is `D ، C`, and only an RTL paragraph
 * renders one as the other. The old Arabic-block range caught it by accident of
 * block membership; `Script_Extensions` catches it on purpose, because that
 * property means "used with this script" rather than "belongs to it".
 *
 * Caught by a byte-diff of 618 slide XMLs against the previous build — one
 * differed. A widening that looks strictly safer is still a change, and the only
 * thing that separated "strictly safer" from "regression" here was the diff.
 */
const RE_STRONG_RTL =
  /[\p{Script_Extensions=Arabic}\p{Script_Extensions=Hebrew}\p{Script_Extensions=Syriac}\p{Script_Extensions=Thaana}\p{Script_Extensions=Nko}\p{Script_Extensions=Samaritan}\p{Script_Extensions=Mandaic}\p{Script_Extensions=Adlam}\p{Script_Extensions=Hanifi_Rohingya}]/u;

/** Does this text belong to a right-to-left script? */
export const hasStrongRtl = (text) => RE_STRONG_RTL.test(String(text ?? ""));

/**
 * The base direction to DECLARE for a paragraph.
 *
 * A strict narrowing of the reconstruction's answer: it can turn RTL off, never
 * on. Turning it on would be a claim about layout that no evidence here
 * supports — the extractor saw the painted stream and this function has only the
 * finished string — and the one direction that was already gated (a paragraph
 * that should be RTL and is not) measures 0 over 14040 paragraphs.
 *
 * @param {string} text     the finished logical text of the paragraph
 * @param {"rtl"|"ltr"} sourceStreamDirection  what the reconstruction decided
 * @returns {"rtl"|"ltr"}
 */
export function paragraphDirection(text, sourceStreamDirection) {
  return sourceStreamDirection === "rtl" && hasStrongRtl(text) ? "rtl" : "ltr";
}
