/**
 * Gate: `tiny-text` must judge type in the PAGE's own scale, not the canvas's.
 *
 * The defect this exists to prevent destroyed a 118-page deck. A document whose
 * pages are not all one size has the odd ones uniformly fitted into the
 * dominant canvas, which scales their type down with everything else. With a
 * flat 9pt threshold, an ordinary 10.5pt line arrives as 6.84pt and reads as
 * "too small": on Unit Five that was 1455 of the 1506 text objects on the 31
 * fitted pages. The fix then raised every one to a flat 9pt while its box
 * stayed at the fitted size — text overflowing every box, colliding with its
 * neighbours, and the type hierarchy flattened (5.29pt and 7.82pt both became
 * 9pt).
 *
 * Four assertions, and the third is the one that matters: a rule that simply
 * stopped firing would pass the first two while being useless (EVO-019).
 *
 *   1. ordinary type on a FITTED page is not flagged
 *   2. ordinary type on an UNFITTED page is not flagged
 *   3. GENUINELY tiny type is still flagged on both kinds of page
 *   4. the fix raises to the page's own floor, so the box relationship holds
 *      and the type hierarchy is preserved
 *
 * Run: node experiments/verify-tiny-text.js
 */
import { RULES } from "../web/doctor.js";

const rule = RULES.find((r) => r.id === "tiny-text");
if (!rule) { console.error("FAIL: no tiny-text rule"); process.exit(1); }

const FIT = 0.651394;                 // Unit Five's real fit scale
const TINY_PT = 9;

let id = 0;
const textObj = (sizes) => ({
  id: `o${id++}`, type: "text", text: "نص",
  bbox: { x: 0, y: 0, w: 100, h: 12 },
  runs: sizes.map((s) => ({ text: "نص", fontSizePt: s, fontFamily: "Diodrum Arabic", color: "000000" })),
});
const page = (scale, objects) => ({
  widthPt: 713.04, heightPt: 487.92, objects,
  sourceFit: { scale, x: 0, y: 0, fitted: Math.abs(scale - 1) > 0.0001 },
});

// 10.5pt and 12pt source type, as it arrives after the fit.
const ORDINARY_FITTED = [10.5 * FIT, 12 * FIT];       // 6.84, 7.82
const ORDINARY_PLAIN = [10.5, 12];
// Type that really is below the floor in the SOURCE's own terms.
const REALLY_TINY_FITTED = [6 * FIT];                  // 3.91 — 6pt at source scale
const REALLY_TINY_PLAIN = [6];

const model = {
  pages: [
    page(FIT, [textObj(ORDINARY_FITTED)]),        // p0 fitted, ordinary  -> clean
    page(1, [textObj(ORDINARY_PLAIN)]),           // p1 plain,  ordinary  -> clean
    page(FIT, [textObj(REALLY_TINY_FITTED)]),     // p2 fitted, tiny      -> FLAG
    page(1, [textObj(REALLY_TINY_PLAIN)]),        // p3 plain,  tiny      -> FLAG
  ],
};

const flagged = new Set(rule.check(model).map((f) => f.page));
const fail = [];

if (flagged.has(0)) fail.push("ordinary type on a FITTED page was flagged (the 118-page regression)");
if (flagged.has(1)) fail.push("ordinary type on an unfitted page was flagged");
if (!flagged.has(2)) fail.push("genuinely tiny type on a FITTED page was NOT flagged — the rule went silent");
if (!flagged.has(3)) fail.push("genuinely tiny type on an unfitted page was NOT flagged");

// 4. The fix must raise to the PAGE's floor, not to a flat 9pt, so that the
//    text keeps its relationship to a box that was scaled by the same factor.
const p2 = model.pages[2];
rule.fix(p2.objects[0], p2, model);
const got = p2.objects[0].runs[0].fontSizePt;
const want = TINY_PT * FIT;
if (Math.abs(got - want) > 0.001) {
  fail.push(`fix on a fitted page raised type to ${got.toFixed(2)}pt; the page's own floor is ${want.toFixed(2)}pt`);
}

// Hierarchy: two different sizes below the floor must not collapse onto one
// another unless both were genuinely below it.
const hier = page(FIT, [textObj([5.29, 7.82])]);
rule.fix(hier.objects[0], hier, { pages: [hier] });
const [a, b] = hier.objects[0].runs.map((r) => r.fontSizePt);
if (a === b) fail.push(`type hierarchy flattened: 5.29pt and 7.82pt both became ${a}pt`);

if (fail.length) {
  console.error("FAIL — verify-tiny-text");
  for (const f of fail) console.error(`  · ${f}`);
  process.exit(1);
}
console.log("PASS — verify-tiny-text");
console.log(`  fitted page floor ${(TINY_PT * FIT).toFixed(2)}pt · unfitted ${TINY_PT}pt`);
console.log(`  ordinary type clean on both · genuinely tiny type still flagged on both`);
console.log(`  fix raises to the page's own floor and preserves hierarchy`);
