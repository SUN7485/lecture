param(
  [Parameter(Mandatory = $true)][string]$PptxPath,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [ValidateRange(1, 32767)][int]$Width = 1900,
  [ValidateRange(1, 32767)][int]$Height = 1300,
  [string]$PowerPointPidFile = ''
)

$ErrorActionPreference = 'Stop'
$app = $null
$presentation = $null
$initialPowerPointPids = @(
  Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }
)

function Write-RendererResult([hashtable]$result) {
  # One compact JSON line makes the Node caller resilient to incidental
  # PowerShell/Office diagnostics on the other streams.
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
}

function Get-OwnedPowerPointPid([object]$application) {
  try {
    Start-Sleep -Milliseconds 150
    $candidates = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue |
      Where-Object { $initialPowerPointPids -notcontains $_.Id })
    if ($candidates.Count -eq 0) { return $null }

    $handle = [Int64]0
    try { $handle = [Int64]$application.HWND } catch {}
    if ($handle -ne 0) {
      $byHandle = @($candidates | Where-Object { [Int64]$_.MainWindowHandle -eq $handle })
      if ($byHandle.Count -gt 0) { return [int]$byHandle[0].Id }
    }
    # The process did not exist before this invocation, so this fallback stays
    # scoped to the COM instance we just created rather than a user's session.
    return [int](($candidates | Sort-Object StartTime -Descending | Select-Object -First 1).Id)
  } catch {
    return $null
  }
}

function Save-OwnedPowerPointPid([object]$application) {
  if ([string]::IsNullOrWhiteSpace($PowerPointPidFile)) { return $null }
  $ownedPowerPointProcessId = Get-OwnedPowerPointPid $application
  if ($null -ne $ownedPowerPointProcessId) {
    $pidDirectory = Split-Path -Parent $PowerPointPidFile
    if ($pidDirectory) { New-Item -ItemType Directory -Force -Path $pidDirectory | Out-Null }
    Set-Content -LiteralPath $PowerPointPidFile -Value $ownedPowerPointProcessId -NoNewline -Encoding ascii
  }
  return $ownedPowerPointProcessId
}

function Get-PngDimensions([string]$imagePath) {
  Add-Type -AssemblyName System.Drawing
  $image = [System.Drawing.Image]::FromFile($imagePath)
  try {
    return @{ width = [int]$image.Width; height = [int]$image.Height }
  } finally {
    $image.Dispose()
  }
}

try {
  if (-not (Test-Path -LiteralPath $PptxPath)) {
    throw "PPTX candidate does not exist: $PptxPath"
  }
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

  $app = New-Object -ComObject PowerPoint.Application
  $powerPointPid = Save-OwnedPowerPointPid $app
  # PowerPoint itself is the renderer.  Open read-only and without a document
  # window, then call Presentation.Export rather than SaveAs so every PNG has
  # the fixed fidelity-gate dimensions (1900×1300 by default).
  $presentation = $app.Presentations.Open((Resolve-Path -LiteralPath $PptxPath).Path, $false, $true, $false)
  $presentation.Export((Resolve-Path -LiteralPath $OutputDir).Path, 'PNG', $Width, $Height)

  $presentation.Close()
  $presentation = $null
  $app.Quit()
  $app = $null

  $images = @(
    Get-ChildItem -LiteralPath $OutputDir -Filter '*.png' -File |
      Sort-Object @{ Expression = {
        $match = [regex]::Match($_.BaseName, '(\d+)(?!.*\d)')
        if ($match.Success) { [int]$match.Value } else { [int]::MaxValue }
      } }, Name |
      ForEach-Object { $_.FullName }
  )
  if ($images.Count -eq 0) { throw 'PowerPoint did not produce PNG slide renders.' }

  $sizes = @()
  foreach ($imagePath in $images) {
    $size = Get-PngDimensions $imagePath
    $sizes += @{ path = $imagePath; width = $size.width; height = $size.height }
    if ($size.width -ne $Width -or $size.height -ne $Height) {
      throw "PowerPoint exported $([IO.Path]::GetFileName($imagePath)) at $($size.width)x$($size.height), expected ${Width}x${Height}."
    }
  }
  Write-RendererResult @{ ok = $true; images = $images; width = $Width; height = $Height; pptPid = $powerPointPid; sizes = $sizes }
}
catch {
  Write-RendererResult @{ ok = $false; stage = 'render'; error = $_.Exception.Message; width = $Width; height = $Height }
  exit 1
}
finally {
  # Always close the exact COM objects created by this script.  If PowerShell
  # itself is killed on a timeout, the Node caller uses PowerPointPidFile to
  # terminate this owned process tree without touching a user's existing deck.
  if ($presentation) { try { $presentation.Close() } catch {} }
  if ($app) { try { $app.Quit() } catch {} }
}
