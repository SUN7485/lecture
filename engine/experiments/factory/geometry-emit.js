/**
 * The geometry spec, as HTML, printed by a Chromium browser.
 *
 * Every item is an absolutely positioned box at its authored coordinates with
 * its authored anchor, so the PDF that comes out has the truth baked into it by
 * a producer rather than asserted by us.
 *
 * `white-space: nowrap` and `overflow: visible` on purpose: a box narrower than
 * its text must OVERFLOW rather than wrap, because wrapping would silently
 * change the truth the spec authored. The `tight` family exists to exercise
 * exactly that boundary.
 *
 * Usage: node experiments/factory/geometry-emit.js [outDir]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { GEOMETRY, PAGE } from "./geometry-spec.js";
import { findChromium, htmlToPdf } from "./emit-html.js";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function geometryHtml() {
  const boxes = GEOMETRY.map((g) => {
    // Rotation about the box's own top-left, so the authored x/y stays the
    // anchor point and the delta has something fixed to be measured against.
    const rot = g.rotation ? `transform:rotate(${g.rotation}deg);transform-origin:0 0;` : "";
    return `<div class="b" dir="${g.dir}" style="left:${g.x}pt;top:${g.y}pt;width:${g.w}pt;` +
           `height:${g.h}pt;text-align:${g.anchor};font-size:${g.fontSize}pt;` +
           `line-height:${g.h}pt;${rot}">${esc(g.text)}</div>`;
  }).join("\n");
  return `<meta charset="utf-8">
<style>
  @page { size: ${PAGE.w}pt ${PAGE.h}pt; margin: 0 }
  html,body { margin:0; padding:0 }
  .page { position:relative; width:${PAGE.w}pt; height:${PAGE.h}pt; overflow:hidden; background:#fff }
  .b { position:absolute; font-family:"Diodrum Arabic"; color:#1A1A1A;
       white-space:nowrap; overflow:visible }
</style>
<div class="page">
${boxes}
</div>`;
}

if (process.argv[1] && process.argv[1].endsWith("geometry-emit.js")) {
  const out = path.resolve(process.argv[2] ?? ".work/factory");
  fs.mkdirSync(out, { recursive: true });
  const browser = findChromium();
  console.log(`browser: ${browser ?? "NONE FOUND"}`);
  const html = path.join(out, "geometry.html");
  fs.writeFileSync(html, geometryHtml(), "utf8");
  console.log(`wrote ${html}`);
  console.log(`wrote ${htmlToPdf(html, path.join(out, "geometry.pdf"), browser)}`);
  console.log(`${GEOMETRY.length} authored objects`);
}
