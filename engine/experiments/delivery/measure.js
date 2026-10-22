/**
 * Ask PowerPoint what it ACTUALLY did with the deck we gave it. Read-only.
 *
 * WHY THIS EXISTS. Every fidelity number this project has is either a property of
 * the model (coverage, text accuracy) or a whole-page pixel comparison (ink IoU).
 * Neither can say "this textbox wrapped where the source did not" or "this
 * paragraph overflows its own box by 4pt", which is the entire remaining class of
 * defect now that Arabic extraction is closed. The reader's four layout complaints
 * were all found by a human reading a deck, and the two static gates built
 * afterwards (`verify-run-edges`, `verify-segments`) each catch exactly one shape.
 *
 * PowerPoint is the only authority on how PowerPoint lays text out, and it will
 * answer if asked. `TextRange.BoundWidth`/`BoundHeight` are the REAL rendered
 * extent of the text, `Lines().Count` is how many lines it actually produced, and
 * both are computed by the same engine the reader will use.
 *
 * NOTHING HERE CHANGES A DECK. Phase 1 of the delivery work is measurement only:
 * no fix may be attempted until the instrument says which class is largest. That
 * ordering is the one this project keeps being right about.
 *
 * NOTES ON THE ENVIRONMENT, all learned the hard way in src/render/powerpoint.js:
 *  - PowerPoint is a SINGLE-INSTANCE automation server. Attach to a running one
 *    rather than starting a second, and only ever quit an app we started, or the
 *    user's own open presentation is closed underneath them.
 *  - Results are written to a UTF-8 FILE, never the console: the console codepage
 *    mangles Arabic on the way out and the text is exactly what we are checking.
 *  - Every property is read inside its own try: a shape with no text frame, a
 *    picture, a group and a placeholder all raise on different members, and one
 *    unguarded read loses the whole slide.
 *
 * Usage: node experiments/delivery/measure.js <deck.pptx> [--json out.json]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { powerPointAvailable } from "../../src/render/powerpoint.js";

const PS_MEASURE = String.raw`
$ErrorActionPreference = 'Stop'
$src = $args[0]
$out = $args[1]
$result = [ordered]@{ ok = $false; repaired = $null; error = $null; slideW = 0; slideH = 0; slides = @() }
$made = $false
try {
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
  catch { $app = New-Object -ComObject PowerPoint.Application; $made = $true }
  try { $app.DisplayAlerts = 1 } catch {}

  $pres = $app.Presentations.Open($src, $true, $false, $false)
  $result.ok = $true
  $result.repaired = $false
  $result.slideW = [math]::Round($pres.PageSetup.SlideWidth, 2)
  $result.slideH = [math]::Round($pres.PageSetup.SlideHeight, 2)

  $slides = New-Object System.Collections.ArrayList
  for ($i = 1; $i -le $pres.Slides.Count; $i++) {
    $slide = $pres.Slides.Item($i)
    $shapes = New-Object System.Collections.ArrayList

    for ($s = 1; $s -le $slide.Shapes.Count; $s++) {
      $sh = $slide.Shapes.Item($s)
      $e = [ordered]@{
        name = $sh.Name; type = [int]$sh.Type
        left = $null; top = $null; width = $null; height = $null
        hasText = $false; text = ''
        boundW = $null; boundH = $null; boundL = $null; boundT = $null
        lines = $null; paragraphs = $null
        wordWrap = $null; autoSize = $null
        mL = $null; mR = $null; mT = $null; mB = $null
        fontName = ''; fontSize = $null; bold = $null; italic = $null
        rtl = $null; rtlParas = $null; paraCount = $null; alignment = $null; spaceWithin = $null; spaceBefore = $null; spaceAfter = $null
      }
      try { $e.left = [math]::Round($sh.Left,2); $e.top = [math]::Round($sh.Top,2)
            $e.width = [math]::Round($sh.Width,2); $e.height = [math]::Round($sh.Height,2) } catch {}

      $tf = $null
      try { if ($sh.HasTextFrame -and $sh.TextFrame.HasText) { $tf = $sh.TextFrame } } catch {}
      if ($tf -ne $null) {
        $e.hasText = $true
        try { $e.text = $tf.TextRange.Text } catch {}
        # The REAL rendered extent, computed by the engine the reader will use.
        try { $e.boundW = [math]::Round($tf.TextRange.BoundWidth,2) } catch {}
        try { $e.boundH = [math]::Round($tf.TextRange.BoundHeight,2) } catch {}
        try { $e.boundL = [math]::Round($tf.TextRange.BoundLeft,2) } catch {}
        try { $e.boundT = [math]::Round($tf.TextRange.BoundTop,2) } catch {}
        try { $e.lines = [int]$tf.TextRange.Lines().Count } catch {}
        try { $e.paragraphs = [int]$tf.TextRange.Paragraphs().Count } catch {}
        try { $e.wordWrap = [int]$tf.WordWrap } catch {}
        try { $e.autoSize = [int]$tf.AutoSize } catch {}
        try { $e.mL = [math]::Round($tf.MarginLeft,2); $e.mR = [math]::Round($tf.MarginRight,2)
              $e.mT = [math]::Round($tf.MarginTop,2);  $e.mB = [math]::Round($tf.MarginBottom,2) } catch {}
        try { $e.fontName = $tf.TextRange.Font.Name } catch {}
        try { $e.fontSize = [math]::Round($tf.TextRange.Font.Size,2) } catch {}
        try { $e.bold = [int]$tf.TextRange.Font.Bold } catch {}
        try { $e.italic = [int]$tf.TextRange.Font.Italic } catch {}
        # TextFrame2 carries the paragraph properties TextFrame does not expose.
        try {
          $tf2 = $sh.TextFrame2
          $pf = $tf2.TextRange.ParagraphFormat
          # PER PARAGRAPH. Asking the whole TextRange returns 0 for every shape,
          # even where the package sets rtl="1" on all of them: the range spans
          # several paragraphs and answers for none of them.
          $rtlCount = 0; $paraCount = 0
          try {
            for ($p = 1; $p -le $tf2.TextRange.Paragraphs().Count; $p++) {
              $paraCount++
              if ([int]$tf2.TextRange.Paragraphs($p).ParagraphFormat.RightToLeft -ne 0) { $rtlCount++ }
            }
          } catch {}
          $e.rtlParas = $rtlCount
          $e.paraCount = $paraCount
          $e.rtl = [int]$pf.RightToLeft
          $e.alignment = [int]$pf.Alignment
          $e.spaceWithin = [math]::Round($pf.SpaceWithin,2)
          $e.spaceBefore = [math]::Round($pf.SpaceBefore,2)
          $e.spaceAfter = [math]::Round($pf.SpaceAfter,2)
        } catch {}
      }
      [void]$shapes.Add($e)
    }
    [void]$slides.Add([ordered]@{ index = $i; shapes = $shapes })
  }
  $result.slides = $slides
  $pres.Close()
  if ($made) { $app.Quit() }
}
catch {
  $result.error = $_.Exception.Message
  try { if ($pres) { $pres.Close() } } catch {}
  try { if ($made -and $app) { $app.Quit() } } catch {}
}
$json = $result | ConvertTo-Json -Depth 8 -Compress
[System.IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding($false)))
`;

/**
 * Measure a deck through PowerPoint. Read-only: the deck is opened, inspected and
 * closed without saving.
 *
 * @returns {{ok:boolean, error:string|null, slideW:number, slideH:number, slides:Array}}
 */
export function measureDeck(pptxPath, { timeoutMs = 600000 } = {}) {
  const abs = path.resolve(pptxPath);
  if (!fs.existsSync(abs)) throw new Error(`deck not found: ${abs}`);
  if (!powerPointAvailable()) return { ok: false, error: "powerpoint-unavailable", slides: [] };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-measure-"));
  try {
    const script = path.join(scratch, "_measure.ps1");
    const outFile = path.join(scratch, "_measure.json");
    fs.writeFileSync(script, PS_MEASURE, "utf8");
    execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, abs, outFile],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, cwd: scratch, maxBuffer: 128 * 1024 * 1024 });
    if (!fs.existsSync(outFile)) return { ok: false, error: "powerpoint-produced-no-result", slides: [] };
    return JSON.parse(fs.readFileSync(outFile, "utf8"));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- run directly ----------------------------------------------------------
// process.argv[1] is undefined when this module is imported from `node -e`, and
// pathToFileURL throws on it — which breaks every programmatic caller.
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const deck = process.argv[2];
  if (!deck) { console.error("usage: node experiments/delivery/measure.js <deck.pptx> [--json out.json]"); process.exit(2); }
  const r = measureDeck(deck);
  if (!r.ok) { console.error(`\n  MEASUREMENT FAILED: ${r.error}\n`); process.exit(1); }

  const text = r.slides.flatMap((s) => s.shapes.filter((x) => x.hasText));
  console.log(`\n${path.basename(deck)} — ${r.slides.length} slides, ${r.slideW} x ${r.slideH} pt`);
  console.log(`  shapes ${r.slides.reduce((n, s) => n + s.shapes.length, 0)} · with text ${text.length}`);

  const got = (k) => text.filter((t) => t[k] != null).length;
  console.log(`\n  properties PowerPoint answered on (of ${text.length} text shapes):`);
  for (const k of ["boundW", "boundH", "lines", "paragraphs", "wordWrap", "autoSize", "mL", "rtl", "alignment", "spaceWithin"]) {
    console.log(`     ${k.padEnd(12)} ${got(k)}`);
  }

  if (process.argv.includes("--json")) {
    const out = process.argv[process.argv.indexOf("--json") + 1] ?? "out/delivery/measure.json";
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(r, null, 2), "utf8");
    console.log(`\n  wrote ${out}`);
  }
  console.log("");
}
