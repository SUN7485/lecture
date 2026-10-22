/**
 * Prove the RTL gate is not decoration (EVO-019).
 *
 * The gate used to read "every paragraph containing Arabic carries rtl=1", which
 * is a claim about the LANGUAGE. It now reads "every paragraph whose base
 * direction is RTL carries rtl=1", which is a claim about DIRECTION and shares
 * its predicate with the extractor — a reference entry and a formula line hold
 * Arabic and are laid out left to right, and the old form failed those decks.
 *
 * A gate that got looser has to prove it can still fail. This strips rtl="1"
 * from one slide of a real deck and re-inspects it.
 *
 *   node experiments/prove-rtl-gate.js [deck.pptx]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import { inspectPptx, summarize } from "../src/pptx/inspect.js";

const src = process.argv[2] ?? "out/Chp1-Lec1-3(New).pptx";
if (!fs.existsSync(src)) {
  console.error(`no deck at ${src} — run a convert first, or pass one`);
  process.exit(2);
}
const dst = path.join(os.tmpdir(), "prove-rtl-gate.pptx");

const zip = await JSZip.loadAsync(fs.readFileSync(src));
const slide = Object.keys(zip.files).find((n) => /ppt\/slides\/slide2\.xml$/.test(n));
const xml = await zip.file(slide).async("string");
const stripped = xml.replace(/ rtl="1"/g, "");
console.log(`removed ${(xml.match(/ rtl="1"/g) ?? []).length} rtl="1" attributes from ${slide}\n`);
zip.file(slide, stripped);
fs.writeFileSync(dst, await zip.generateAsync({ type: "nodebuffer" }));

let bothWaysSame = true;
const results = [];
for (const [label, file] of [["untouched deck", src], ["one slide stripped", dst]]) {
  const report = await inspectPptx(file);
  const { gates } = summarize(report);
  const [name, ok] = gates.find(([n]) => n.includes("RTL"));
  results.push(ok);
  console.log(`  ${label.padEnd(20)} ${name}: ${ok ? "PASS" : "FAIL"}`);
}
fs.rmSync(dst, { force: true });

bothWaysSame = results[0] === results[1];
console.log();
if (results[0] === true && results[1] === false) console.log("GATE IS REAL: it passes a good deck and fails a broken one.");
else console.log(`GATE IS DECORATIVE: ${bothWaysSame ? "same verdict either way" : "it fails the good deck"}.`);
process.exit(results[0] === true && results[1] === false ? 0 : 1);
