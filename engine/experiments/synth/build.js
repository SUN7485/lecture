/**
 * Build the synthetic source deck, then have a REAL producer export it to PDF.
 *
 * The chain this establishes:
 *
 *   cases.js (the truth we wrote)
 *        -> a .pptx we author
 *        -> PowerPoint exports a .pdf          <- a real producer, not a mock
 *        -> src/cli.js converts it back
 *        -> score.js compares against the truth
 *
 * PowerPoint is the first producer because its automation already works in this
 * project and because the round trip is the actual product use case. It is also
 * the honest hard case: the PDF it writes is majority DeviceGray and names fonts
 * the way Office names them, both of which have already produced defects here.
 *
 * Usage: node experiments/synth/build.js [outDir]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { CASES, truthText } from "./cases.js";
import { LAM_CASES } from "./lam-alef-cases.js";
import { SPACE_CASES } from "./space-cases.js";
import { BIDI_CASES } from "./bidi-cases.js";

/** --lam swaps in the targeted lam-alef population; see lam-alef-cases.js. */
const LAM = process.argv.includes("--lam");
const SPACE = process.argv.includes("--space");
const BIDI = process.argv.includes("--bidi");
const SET = BIDI ? BIDI_CASES : SPACE ? SPACE_CASES : LAM ? LAM_CASES : CASES;
const TAG = BIDI ? "bidi" : SPACE ? "space" : LAM ? "lam" : "synth";

const OUT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "out/synth");
fs.mkdirSync(OUT, { recursive: true });

const SLIDE_W_IN = 10, SLIDE_H_IN = 5.625;
const PT_PER_IN = 72;

/** Where a case's text sits, in inches. One box unless the case says otherwise. */
const BOX = { x: 0.6, y: 1.6, w: 8.8, h: 1.6 };

const pptx = new PptxGenJS();
pptx.defineLayout({ name: "SYNTH", width: SLIDE_W_IN, height: SLIDE_H_IN });
pptx.layout = "SYNTH";

const truth = [];

for (const [i, c] of SET.entries()) {
  const slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };

  // A label in a face that is never under test, so a scorer bug that reads the
  // wrong box is obvious rather than silent.
  slide.addText(`case ${i + 1}: ${c.name}`, {
    x: 0.3, y: 0.25, w: 9.4, h: 0.4, fontSize: 12, fontFace: "Arial", color: "999999",
  });

  const common = {
    fontFace: c.font, fontSize: c.size, color: "111111",
    align: c.dir === "rtl" ? "right" : "left",
  };
  // pptxgenjs reads rtlMode off the FIRST RUN's options when text is an array, so
  // a call-level rtlMode never reaches <a:pPr> (EVO-020). Set it per run.
  const rtl = c.dir === "rtl";

  const boxes = [];
  if (c.columns) {
    const w = (BOX.w - 0.4) / 2;
    c.columns.forEach((t, k) => {
      const x = BOX.x + (rtl ? (1 - k) * (w + 0.4) : k * (w + 0.4));
      slide.addText([{ text: t, options: { ...common, rtlMode: rtl } }],
        { ...BOX, x, w, ...common, rtlMode: rtl });
      boxes.push({ text: t, xPt: +(x * PT_PER_IN).toFixed(2), wPt: +(w * PT_PER_IN).toFixed(2) });
    });
  } else if (c.lines) {
    slide.addText(c.lines.map((t) => ({ text: t, options: { ...common, rtlMode: rtl, bullet: !!c.bullet, breakLine: true } })),
      { ...BOX, ...common, rtlMode: rtl });
    for (const t of c.lines) boxes.push({ text: t });
  } else if (c.runs) {
    slide.addText(c.runs.map((r) => ({
      text: r.text,
      options: { ...common, rtlMode: rtl, ...(r.sup ? { superscript: true } : {}) },
    })), { ...BOX, ...common, rtlMode: rtl });
    boxes.push({ text: truthText(c) });
  } else {
    slide.addText([{ text: c.text, options: { ...common, rtlMode: rtl } }],
      { ...BOX, ...common, rtlMode: rtl });
    boxes.push({ text: c.text });
  }

  truth.push({
    slide: i + 1, name: c.name, font: c.font, sizePt: c.size, dir: c.dir,
    text: truthText(c), boxes, meta: c.meta ?? null,
  });
}

const pptxPath = path.join(OUT, `${TAG}-source.pptx`);
await pptx.writeFile({ fileName: pptxPath });

// COMPLEX-SCRIPT TYPEFACE. pptxgenjs writes <a:latin> only, so PowerPoint chooses
// its own font for Arabic runs — and it exported the entire first lam-alef
// population in CALIBRI. The device walk showed Calibri glyphs and a gid of -1 on
// the alef, which means every number taken from that deck described a font nobody
// sets Arabic in. The project's own writer sets <a:cs> for exactly this reason
// (see src/pptx/write.js); a generator that does not is testing a substitution
// instead of the case it wrote.
{
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  for (const name of Object.keys(zip.files).filter((n) => /^ppt[/]slides[/]slide\d+[.]xml$/.test(n))) {
    let xml = await zip.file(name).async("string");
    xml = xml.replace(/<a:latin typeface="([^"]+)"[/]>/g, (m, face) => m + '<a:cs typeface="' + face + '"/>');
    zip.file(name, xml);
  }
  fs.writeFileSync(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}
fs.writeFileSync(path.join(OUT, `${TAG}-truth.json`), JSON.stringify(truth, null, 2), "utf8");
console.log(`source deck : ${pptxPath}  (${SET.length} cases)`);
console.log(`truth       : ${path.join(OUT, `${TAG}-truth.json`)}`);

// ---- export to PDF through PowerPoint itself -------------------------------
// ppSaveAsPDF = 32. Attach to a running instance rather than starting a second
// one, and only ever quit an app we started (src/render/powerpoint.js has the
// same rule, and the reason: PowerPoint is a single-instance automation server).
const PS = String.raw`
$ErrorActionPreference='Stop'
$src=$args[0]; $dst=$args[1]
$made=$false
try {
  try { $app=[Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
  catch { $app=New-Object -ComObject PowerPoint.Application; $made=$true }
  $app.DisplayAlerts = 1
  if (Test-Path $dst) { Remove-Item $dst -Force }
  $p=$app.Presentations.Open($src,$true,$false,$false)
  $p.SaveAs($dst, 32, -1)
  $p.Close()
  if ($made) { $app.Quit() }
  Write-Output "OK"
} catch {
  Write-Output "FAIL $($_.Exception.Message)"
  try { if ($made -and $app) { $app.Quit() } } catch {}
}
`;
const script = path.join(OUT, "_export.ps1");
fs.writeFileSync(script, PS, "utf8");
const pdfPath = path.join(OUT, `${TAG}-powerpoint.pdf`);
const res = execFileSync("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, pptxPath, pdfPath],
  { encoding: "utf8", timeout: 300000, windowsHide: true }).trim();

if (!res.startsWith("OK") || !fs.existsSync(pdfPath)) {
  console.error(`PDF export failed: ${res}`);
  process.exit(1);
}
console.log(`pdf         : ${pdfPath}  (${(fs.statSync(pdfPath).size / 1024).toFixed(0)} KB, producer: PowerPoint)`);
