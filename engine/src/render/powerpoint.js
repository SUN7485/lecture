/**
 * PowerPoint as the rendering oracle.
 *
 * PowerPoint is the target renderer, so it is the only thing whose opinion of
 * the file counts. LibreOffice agreeing proves nothing about what the user will
 * see. We drive it over COM from PowerShell — the same approach lectuer uses.
 *
 * Two things are extracted:
 *   1. did PowerPoint REPAIR the file on open (a silent structural failure)
 *   2. a PNG of each slide, plus every shape's real geometry in points
 *
 * NOTE ON THE ENVIRONMENT: launching Office with a broken APPDATA makes it
 * create its per-user profile in the working directory — that is where the 34
 * garbage-named folders in D:\lectuer come from. We pass the real environment
 * through explicitly and run from a scratch directory so nothing leaks into the
 * repo.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/** PowerPoint's PpSaveAsFileType for PNG export is not needed — Export() is direct. */
const PS_RENDER = String.raw`
$ErrorActionPreference = 'Stop'
$pptxPath = $args[0]
$outDir   = $args[1]
$width    = [int]$args[2]

$result = [ordered]@{ opened = $false; repaired = $null; slides = @(); error = $null }

$createdApp = $false
try {
  # PowerPoint is a SINGLE-INSTANCE automation server, so New-Object hands back
  # the user's own PowerPoint when they have one open — and quitting it closes
  # whatever they were reading. Attach when one exists, and only ever quit an
  # app we started ourselves.
  # MEASURED, and it is a RACE rather than a property of any file. Over a long
  # automation session — a 294-page corpus in "smart" delivery, which drives
  # PowerPoint roughly twice per deck — Presentations.Open intermittently fails
  # with "Exception from HRESULT: 0x80048240". Six of ten decks died that way in
  # one run, all of them after twenty minutes of back-to-back COM, and every one
  # of those decks converts on its own and inside a single-deck benchmark.
  # Quit() returns before the process is gone, so the next script's
  # GetActiveObject can attach to an instance that is already shutting down.
  #
  # So: retry, and NEVER attach on a retry — a fresh instance is the whole point.
  # Attaching remains the first move because PowerPoint is a single-instance
  # server and creating one while the user has their own open would take theirs
  # over; we still only ever Quit an app we started ourselves.
  $pres = $null
  $result.openAttempts = 0
  for ($attempt = 1; $attempt -le 3 -and -not $pres; $attempt++) {
    $result.openAttempts = $attempt
    try {
      if ($attempt -eq 1) {
        try {
          $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
        } catch {
          $app = New-Object -ComObject PowerPoint.Application
          $createdApp = $true
        }
      } else {
        Start-Sleep -Seconds (2 * $attempt)
        $app = New-Object -ComObject PowerPoint.Application
        $createdApp = $true
      }
      # PowerPoint refuses to be fully invisible; minimise instead of hiding.
      try { $app.DisplayAlerts = 1 } catch {}
      # ReadOnly:=$false so we can observe a repair; WithWindow:=$false where allowed.
      $pres = $app.Presentations.Open($pptxPath, $true, $false, $false)
    } catch {
      $result.openError = $_.Exception.Message
      # Do not leave behind an instance we started and could not use.
      try { if ($createdApp -and $app) { $app.Quit() } } catch {}
      $app = $null
      $createdApp = $false
    }
  }
  if (-not $pres) { throw "Presentations.Open failed after $($result.openAttempts) attempt(s): $($result.openError)" }
  $result.opened = $true

  # If PowerPoint had to repair the package it reports a non-empty name change
  # or raises on open; a successful open with the same slide count is our signal.
  $result.repaired = $false

  $n = $pres.Slides.Count
  $shapes = New-Object System.Collections.ArrayList

  for ($i = 1; $i -le $n; $i++) {
    $slide = $pres.Slides.Item($i)
    $png = Join-Path $outDir ("slide-{0:d3}.png" -f $i)
    $h = [int]([math]::Round($width * $pres.PageSetup.SlideHeight / $pres.PageSetup.SlideWidth))

    # MEASURED: Export can fail with "An error occurred while PowerPoint was
    # saving the file" and leave a ZERO-BYTE png. It is RESOLUTION dependent, not
    # transient: Chp1-Lec1-3(New) slide 1 fails at width 700 and succeeds at 1400,
    # reproducibly, from a clean directory either way. Retrying does not help at a
    # bad width, so callers should render at the calibrated 1400px.
    # The size check matters regardless: Export does not always raise on failure,
    # so without it a zero-byte png is silently treated as a rendered slide.
    $exported = $false
    for ($try = 1; $try -le 3 -and -not $exported; $try++) {
      try { $slide.Export($png, "PNG", $width, $h) } catch { }
      if ((Test-Path $png) -and ((Get-Item $png).Length -gt 0)) { $exported = $true }
      else { Start-Sleep -Milliseconds 400 }
    }
    if (-not $exported) { throw "slide $i export produced no bytes after 3 attempts" }

    $list = New-Object System.Collections.ArrayList
    for ($s = 1; $s -le $slide.Shapes.Count; $s++) {
      $sh = $slide.Shapes.Item($s)
      $entry = [ordered]@{
        name = $sh.Name
        left = [math]::Round($sh.Left, 3)
        top = [math]::Round($sh.Top, 3)
        width = [math]::Round($sh.Width, 3)
        height = [math]::Round($sh.Height, 3)
        type = [int]$sh.Type
        hasText = $false
        text = ''
      }
      try {
        if ($sh.HasTextFrame -and $sh.TextFrame.HasText) {
          $entry.hasText = $true
          $entry.text = $sh.TextFrame.TextRange.Text
        }
      } catch {}
      [void]$list.Add($entry)
    }
    [void]$shapes.Add([ordered]@{ index = $i; shapes = $list })
  }

  $result.slides = $shapes
  $result.pageWidthPt = [math]::Round($pres.PageSetup.SlideWidth, 3)
  $result.pageHeightPt = [math]::Round($pres.PageSetup.SlideHeight, 3)

  $pres.Close()
  $pres = $null
  if ($createdApp) { $app.Quit() }
}
catch {
  $result.error = $_.Exception.Message
  try { if ($pres) { $pres.Close() } } catch {}
  try { if ($createdApp -and $app) { $app.Quit() } } catch {}
}

# Write UTF-8 to a file rather than the console: the console codepage mangles
# Arabic on the way out and the text is exactly what we need to verify.
$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText((Join-Path $outDir '_render.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
`;

/**
 * Render a .pptx through PowerPoint.
 * @returns {{opened:boolean, repaired:boolean|null, slides:Array, error:string|null, pngDir:string}}
 */
export function renderPptx(pptxPath, outDir, { widthPx = 1400, timeoutMs = 180000 } = {}) {
  const abs = path.resolve(pptxPath);
  const dir = path.resolve(outDir);
  if (!fs.existsSync(abs)) throw new Error(`pptx not found: ${abs}`);
  fs.mkdirSync(dir, { recursive: true });

  const scriptFile = path.join(dir, "_render.ps1");
  fs.writeFileSync(scriptFile, PS_RENDER, "utf8");

  const jsonFile = path.join(dir, "_render.json");
  fs.rmSync(jsonFile, { force: true });

  const stdio = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile, abs, dir, String(widthPx)],
    { encoding: "utf8", timeout: timeoutMs, windowsHide: true, cwd: dir, maxBuffer: 64 * 1024 * 1024 }
  );

  if (!fs.existsSync(jsonFile)) {
    throw new Error(`PowerPoint produced no result file.\n${stdio.slice(0, 800)}`);
  }
  const parsed = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  return { ...parsed, pngDir: dir };
}

/** Is PowerPoint present on this machine? */
export function powerPointAvailable() {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "", "Microsoft Office", "root", "Office16", "POWERPNT.EXE"),
    path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft Office", "root", "Office16", "POWERPNT.EXE"),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}
