/**
 * The same spec, as HTML, printed by a Chromium browser.
 *
 * THIS IS THE CONTROL, and the factory is not trustworthy without it. A score
 * from the PowerPoint route alone cannot separate "the extractor is wrong about
 * this construct" from "this producer's PDF is degraded" — and the PowerPoint
 * route is known to be degraded in one specific way: its PDF export drops
 * install-on-demand embedded fonts, so every glyph in it is named Calibri.
 *
 * Chromium is the producer the 28-deck corpus is made of, where delivered
 * accuracy is 98.49%. So a family that scores badly HERE is an extractor bug the
 * corpus never happened to contain, and a family that scores badly only on the
 * PowerPoint route is a producer difference. Neither reading is available from
 * one number.
 *
 * Layout mirrors build.js exactly — same rows, same pitch — so `score.js` can
 * match blocks to items by baseline on either route without knowing which.
 *
 * Usage: node experiments/factory/emit-html.js [outDir]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { SPEC } from "./spec.js";
import { ROW_PITCH, TOP, LEFT, WIDTH, FONT_PT, PER_PAGE } from "./build.js";

const PAGE_W = 713.04, PAGE_H = 487.92;

/** Chromium, whatever it is called on this machine. Edge IS Chromium, and its
 *  print path is the same Skia PDF backend the corpus was produced by. */
const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
export function findChromium() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function specHtml() {
  const pages = [];
  for (let start = 0; start < SPEC.length; start += PER_PAGE) {
    const rows = SPEC.slice(start, start + PER_PAGE).map((s, i) => {
      // `dir` is set per item so the browser lays it out the way the spec says,
      // which is what makes the PDF's painted order a real test of the reader.
      const y = TOP + i * ROW_PITCH;
      const align = s.dir === "rtl" ? "right" : "left";
      return `<div class="r" dir="${s.dir}" style="top:${y}pt;text-align:${align}">${esc(s.text)}</div>`;
    }).join("\n");
    pages.push(`<div class="page">\n${rows}\n</div>`);
  }
  return `<meta charset="utf-8">
<style>
  @page { size: ${PAGE_W}pt ${PAGE_H}pt; margin: 0 }
  html,body { margin:0; padding:0 }
  .page { position:relative; width:${PAGE_W}pt; height:${PAGE_H}pt; overflow:hidden;
          page-break-after:always; background:#fff }
  .r { position:absolute; left:${LEFT}pt; width:${WIDTH}pt; height:${(FONT_PT * 1.4).toFixed(2)}pt;
       font-family:"Diodrum Arabic"; font-size:${FONT_PT}pt; color:#1A1A1A;
       line-height:${(FONT_PT * 1.4).toFixed(2)}pt; white-space:nowrap }
</style>
${pages.join("\n")}`;
}

export function htmlToPdf(html, pdf, browser = findChromium()) {
  if (!browser) throw new Error("no Chromium-family browser found — see CANDIDATES");
  const profile = path.join(path.dirname(path.resolve(pdf)), "_chromeprofile");
  execFileSync(browser, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--no-pdf-header-footer",
    `--print-to-pdf=${path.resolve(pdf)}`,
    `file:///${path.resolve(html).replace(/\\/g, "/")}`,
  ], { encoding: "utf8", timeout: 300000, windowsHide: true, stdio: "pipe" });
  if (!fs.existsSync(pdf)) throw new Error("the browser produced no PDF");
  return path.resolve(pdf);
}

if (process.argv[1] && process.argv[1].endsWith("emit-html.js")) {
  const out = path.resolve(process.argv[2] ?? ".work/factory");
  fs.mkdirSync(out, { recursive: true });
  const browser = findChromium();
  console.log(`browser: ${browser ?? "NONE FOUND"}`);
  const html = path.join(out, "factory.html");
  fs.writeFileSync(html, specHtml(), "utf8");
  console.log(`wrote ${html}`);
  console.log(`wrote ${htmlToPdf(html, path.join(out, "chromium.pdf"), browser)}`);
}
