/**
 * spec -> model -> PPTX -> PowerPoint -> PDF.
 *
 * The PPTX is written by the REAL writer, so this route also exercises delivery;
 * the PDF is exported by PowerPoint, which makes it a genuinely foreign producer
 * for the extractor to read back.
 *
 * Layout is deliberately dull: one item per line, 26pt apart, left edge fixed.
 * `score.js` matches an extracted block to its item by BASELINE, never by text,
 * so the measurement cannot quietly assume the answer it is checking.
 *
 * Usage: node experiments/factory/build.js [outDir]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { writePptx } from "../../src/pptx/write.js";
import { paragraphDirection } from "../../src/model/direction.js";
import { SPEC } from "./spec.js";

/** Points between one item's baseline and the next. Wide enough that no two
 *  items can be confused by the matcher, narrow enough to fit a page. */
export const ROW_PITCH = 26;
export const TOP = 30;
export const LEFT = 40;
export const WIDTH = 620;
export const FONT_PT = 14;
/** Items per page, so a long spec does not run off the slide. */
export const PER_PAGE = 16;

const FACE = "Diodrum Arabic";

export function specModel() {
  const pages = [];
  for (let start = 0; start < SPEC.length; start += PER_PAGE) {
    const slice = SPEC.slice(start, start + PER_PAGE);
    const objects = slice.map((s, i) => {
      const runs = [{ text: s.text, fontFamily: FACE, bold: false, italic: false,
        fontSizePt: FONT_PT, color: "1A1A1A", script: /[؀-ۿ]/.test(s.text) ? "Arab" : "Latn" }];
      return {
        id: `p${pages.length}_text_${String(i).padStart(3, "0")}`,
        type: "text",
        bbox: { x: LEFT, y: TOP + i * ROW_PITCH, w: WIDTH, h: FONT_PT * 1.4 },
        baselinePt: TOP + i * ROW_PITCH + FONT_PT,
        zIndex: 10 + i,
        text: s.text,
        sourceStreamDirection: s.dir,
        paragraphDirection: paragraphDirection(s.text, s.dir),
        alignment: s.dir === "rtl" ? "right" : "left",
        runs,
        reconstructionStrategy: "native_text",
        provenance: { sourcePage: pages.length, specId: s.id },
      };
    });
    pages.push({ index: pages.length, widthPt: 713.04, heightPt: 487.92, objects, background: null });
  }
  return { schemaVersion: "1.0", document: { sourceFile: "factory.pdf" }, pages };
}

const PS_TO_PDF = String.raw`
$ErrorActionPreference = 'Stop'
$pptx = $args[0]
$pdf  = $args[1]
$out  = [ordered]@{ ok = $false; error = $null }
$createdApp = $false
try {
  if (Test-Path $pdf) { Remove-Item $pdf -Force }
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
  catch { $app = New-Object -ComObject PowerPoint.Application; $createdApp = $true }
  $pres = $app.Presentations.Open($pptx, $true, $false, $false)   # readonly, no window
  # 32 = ppSaveAsPDF. ExportAsFixedFormat needs more arguments than late binding
  # can supply and gives nothing extra here.
  $pres.SaveAs($pdf, 32)
  $pres.Close()
  if ($createdApp) { $app.Quit() }
  $out.ok = $true
}
catch {
  $out.error = $_.Exception.Message
  try { if ($pres) { $pres.Close() } } catch {}
  try { if ($createdApp -and $app) { $app.Quit() } } catch {}
}
[System.IO.File]::WriteAllText($args[2], ($out | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
`;

export function pptxToPdf(pptx, pdf) {
  const dir = path.dirname(path.resolve(pdf));
  fs.mkdirSync(dir, { recursive: true });
  const ps = path.join(dir, "_topdf.ps1");
  const log = path.join(dir, "_topdf.json");
  fs.writeFileSync(ps, PS_TO_PDF, "utf8");
  fs.rmSync(log, { force: true });
  execFileSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps,
     path.resolve(pptx), path.resolve(pdf), log],
    { encoding: "utf8", timeout: 600000, windowsHide: true });
  const r = JSON.parse(fs.readFileSync(log, "utf8"));
  if (!r.ok) throw new Error(`PowerPoint export failed: ${r.error}`);
  return path.resolve(pdf);
}

if (process.argv[1] && process.argv[1].endsWith("build.js")) {
  const out = path.resolve(process.argv[2] ?? ".work/factory");
  fs.mkdirSync(out, { recursive: true });
  const model = specModel();
  const pptx = path.join(out, "factory.pptx");
  await writePptx(model, pptx);
  console.log(`spec: ${SPEC.length} items over ${model.pages.length} page(s)`);
  console.log(`wrote ${pptx}`);
  const pdf = pptxToPdf(pptx, path.join(out, "powerpoint.pdf"));
  console.log(`wrote ${pdf}`);
}
