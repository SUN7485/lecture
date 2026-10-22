/** Six mixed-direction paragraphs, built through the REAL writer. */
import * as fs from "node:fs";
import * as path from "node:path";
import { writePptx } from "../../src/pptx/write.js";
import { paragraphDirection } from "../../src/model/direction.js";

const AR = "Diodrum Arabic";
const r = (text, script) => ({ text, fontFamily: AR, bold: false, italic: false,
  fontSizePt: 18, color: "1A1A1A", script });

/** [name, sourceStreamDirection, runs] */
export const FIXTURES = [
  ["PURE_ARABIC",   "rtl", [r("الحل البياني للبرمجة الخطية", "Arab")]],
  ["FORMULA_ONLY",  "ltr", [r("=SQRT(2*D*S/H)", "Latn")]],
  ["ARABIC_FORMULA","rtl", [r("زمن الطلب: ", "Arab"), r("Ttakt = 25200 ÷ 900 = 28", "Latn"), r(" ثانية", "Arab")]],
  ["CITATION",      "ltr", [r("[4] Shingo, S. (1985). ", "Latn"), r("منهجية تقليص زمن", "Arab"), r(".", "Latn")]],
  ["EMOJI_MATH",    "ltr", [r("1000 × √4 ≤ 40", "Latn")]],
  ["LATIN_ISLAND",  "rtl", [r("تحسين بيئة العمل ", "Arab"), r("(Ergonomics)", "Latn"), r(" في المصنع", "Arab")]],
];

export function fixtureModel() {
  const objects = FIXTURES.map(([name, src, runs], i) => {
    const text = runs.map((x) => x.text).join("");
    return {
      id: `p0_text_${String(i).padStart(3, "0")}`,
      type: "text",
      bbox: { x: 40, y: 40 + i * 60, w: 640, h: 26 },
      baselinePt: 40 + i * 60 + 20,
      zIndex: 10 + i,
      text,
      sourceStreamDirection: src,
      paragraphDirection: paragraphDirection(text, src),
      alignment: src === "rtl" ? "right" : "left",
      runs,
      reconstructionStrategy: "native_text",
      provenance: { sourcePage: 0, fixture: name },
    };
  });
  return {
    schemaVersion: "1.0",
    document: { sourceFile: "rtl-runs-lab.pdf" },
    pages: [{ index: 0, widthPt: 713.04, heightPt: 487.92, objects, background: null }],
  };
}

export const LAB = path.resolve(".work/rtl-lab");

if (process.argv[1] && process.argv[1].endsWith("fixture.js")) {
  fs.mkdirSync(LAB, { recursive: true });
  const m = fixtureModel();
  await writePptx(m, path.join(LAB, "A-paragraph-only.pptx"));
  for (const o of m.pages[0].objects)
    console.log(`${o.provenance.fixture.padEnd(16)} src=${o.sourceStreamDirection}  para=${o.paragraphDirection}  runs=${o.runs.length}`);
  console.log("\nbuilt A-paragraph-only.pptx");
}
