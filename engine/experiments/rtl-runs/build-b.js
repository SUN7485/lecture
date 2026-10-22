/**
 * Variant B — the same package as A, plus an explicit run-level direction.
 *
 * DrawingML defines `a:rtl` as a child of CT_TextCharacterProperties
 * (ECMA-376 §21.1.2.2.8, parents defRPr/endParaRPr/rPr). The child order in that
 * type is fixed, and `rtl` sits after the font elements (latin/ea/cs/sym) and
 * the hyperlinks, before extLst — so it is inserted after `<a:cs .../>` when one
 * is present and immediately before `</a:rPr>` otherwise.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import { hasStrongRtl } from "../../src/model/direction.js";
import { LAB } from "./fixture.js";

const src = path.join(LAB, "A-paragraph-only.pptx");
const dst = path.join(LAB, "B-run-rtl.pptx");

const zip = await JSZip.loadAsync(fs.readFileSync(src));
const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
let patched = 0;

for (const n of names) {
  let xml = await zip.file(n).async("string");
  xml = xml.replace(/<a:r>[\s\S]*?<\/a:r>/g, (run) => {
    const t = (run.match(/<a:t>([\s\S]*?)<\/a:t>/) || [, ""])[1];
    const val = hasStrongRtl(t) ? "1" : "0";
    const tag = `<a:rtl val="${val}"/>`;
    if (/<a:rtl\b/.test(run)) return run;
    patched++;
    if (/<a:cs\b[^>]*\/>/.test(run)) return run.replace(/(<a:cs\b[^>]*\/>)/, `$1${tag}`);
    if (/<\/a:rPr>/.test(run)) return run.replace("</a:rPr>", `${tag}</a:rPr>`);
    return run.replace(/(<a:rPr\b[^>]*)\/>/, `$1>${tag}</a:rPr>`);
  });
  zip.file(n, xml);
}

fs.writeFileSync(dst, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(`B built: ${patched} runs carry an explicit <a:rtl>`);
