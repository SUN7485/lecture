<#
  Host-only smoke test for tools/pptx/ocr-winrt.ps1.

  Examples:
    powershell -NoProfile -ExecutionPolicy Bypass -File test/ocr-winrt-smoke.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File test/ocr-winrt-smoke.ps1 -ImagePath verify-030-lec34.png

  The preflight must pass only on a Windows host with both ar-SA and en-US OCR
  language components. It intentionally is not part of npm test, because a
  missing language component is a valid machine-preflight failure.
#>

[CmdletBinding()]
param(
  [string]$ImagePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$adapter = Join-Path $PSScriptRoot '..\tools\pptx\ocr-winrt.ps1'
$adapter = [System.IO.Path]::GetFullPath($adapter)
if (-not (Test-Path -LiteralPath $adapter -PathType Leaf)) { throw "OCR adapter is missing: $adapter" }

function Invoke-Adapter {
  param([string[]]$Arguments, [string]$InputJson = $null)
  if ($null -eq $InputJson) {
    $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $adapter @Arguments 2>&1
  } else {
    $output = $InputJson | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $adapter @Arguments 2>&1
  }
  $exitCode = $LASTEXITCODE
  $line = @($output | Where-Object { $_ -and $_.ToString().Trim() } | Select-Object -Last 1)[0]
  if ($null -eq $line) { throw "OCR adapter returned no JSON (exit $exitCode)." }
  try { $json = $line.ToString() | ConvertFrom-Json -ErrorAction Stop } catch { throw "OCR adapter returned invalid JSON: $line" }
  if ($exitCode -ne 0 -or -not $json.ok) { throw "OCR adapter failed: $($json.error.code) $($json.error.message)" }
  return $json
}

$preflight = Invoke-Adapter @('-Preflight')
if ($preflight.provider -ne 'Windows.Media.Ocr') { throw 'Expected Windows.Media.Ocr provider.' }
if (@($preflight.engines | Where-Object { -not $_.engineCreated }).Count -ne 0) { throw 'Arabic and English OCR engines were not both created.' }

if ($ImagePath) {
  $resolvedImage = [System.IO.Path]::GetFullPath($ImagePath)
  if (-not (Test-Path -LiteralPath $resolvedImage -PathType Leaf)) { throw "Image not found: $resolvedImage" }
  $request = @{ sourcePath = $resolvedImage; powerPointPath = $resolvedImage; languages = @('ara', 'eng') } | ConvertTo-Json -Compress
  $result = Invoke-Adapter @() $request
  foreach ($side in @($result.source, $result.powerPoint)) {
    if ($null -eq $side.words -or $null -eq $side.tokens) { throw 'OCR response lacks word/token geometry.' }
    foreach ($word in @($side.words)) {
      if ($null -eq $word.x -or $null -eq $word.y -or $null -eq $word.w -or $null -eq $word.h) { throw 'OCR word lacks a bounding box.' }
    }
  }
  $preflight | Add-Member -NotePropertyName imageSmoke -NotePropertyValue ([ordered]@{ imagePath = $resolvedImage; sourceWords = @($result.source.words).Count; powerPointWords = @($result.powerPoint.words).Count })
}

$preflight | ConvertTo-Json -Depth 12
