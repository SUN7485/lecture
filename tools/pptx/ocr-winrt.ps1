<#
  Offline Arabic + English OCR adapter for the PPTX fidelity gate.

  Contract (normal mode; JSON is read from stdin):
    {"sourcePath":"...png","powerPointPath":"...png","languages":["ara","eng"]}

  Success response (the `tokens` alias is retained for pptxFidelity.js):
    {
      "ok": true,
      "source": { "text": "...", "words": [...], "tokens": [...], "languagePasses": [...] },
      "powerPoint": { ... }
    }

  `-Preflight` emits one JSON report and verifies both native recognizers without
  reading stdin. This deliberately uses Windows.Media.Ocr only. It never falls
  back to a system Tesseract, an English-only engine, or guessed text.
#>

[CmdletBinding()]
param(
  [switch]$Preflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$script:ArabicTag = 'ar-SA'
$script:EnglishTag = 'en-US'
$script:RequiredTags = @($script:ArabicTag, $script:EnglishTag)
$script:AsTaskMethod = $null

function Write-Json {
  param([Parameter(Mandatory = $true)]$Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 32))
}

function New-OcrError {
  param(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message,
    $Details = $null
  )
  $exception = New-Object System.Exception($Message)
  $exception.Data['code'] = $Code
  if ($null -ne $Details) { $exception.Data['details'] = $Details }
  return $exception
}

function Get-ExceptionCode {
  param([System.Exception]$Exception)
  if ($null -ne $Exception -and $Exception.Data.Contains('code')) { return [string]$Exception.Data['code'] }
  return 'WINRT_OCR_FAILED'
}

function Get-ExceptionDetails {
  param([System.Exception]$Exception)
  if ($null -ne $Exception -and $Exception.Data.Contains('details')) { return $Exception.Data['details'] }
  return [ordered]@{ cause = [string]$Exception.Message }
}

function Write-Failure {
  param(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message,
    $Details = $null,
    [string]$Stage = 'ocr'
  )
  $error = [ordered]@{ code = $Code; message = $Message }
  if ($null -ne $Details) { $error.details = $Details }
  Write-Json ([ordered]@{ ok = $false; stage = $Stage; error = $error })
  exit 1
}

function Initialize-WinRt {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $script:StorageFileType = [Windows.Storage.StorageFile,Windows,ContentType=WindowsRuntime]
    $script:FileAccessModeType = [Windows.Storage.FileAccessMode,Windows,ContentType=WindowsRuntime]
    $script:RandomAccessStreamType = [Windows.Storage.Streams.IRandomAccessStream,Windows,ContentType=WindowsRuntime]
    $script:BitmapDecoderType = [Windows.Graphics.Imaging.BitmapDecoder,Windows,ContentType=WindowsRuntime]
    $script:SoftwareBitmapType = [Windows.Graphics.Imaging.SoftwareBitmap,Windows,ContentType=WindowsRuntime]
    $script:OcrEngineType = [Windows.Media.Ocr.OcrEngine,Windows,ContentType=WindowsRuntime]
    $script:OcrResultType = [Windows.Media.Ocr.OcrResult,Windows,ContentType=WindowsRuntime]
    $script:LanguageType = [Windows.Globalization.Language,Windows,ContentType=WindowsRuntime]
    $script:AsTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
      Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
        $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1
      } |
      Select-Object -First 1
    if ($null -eq $script:AsTaskMethod) {
      throw (New-OcrError 'WINRT_ASYNC_BRIDGE_UNAVAILABLE' 'Could not create a .NET task bridge for Windows Runtime OCR.')
    }
  } catch {
    if ($_.Exception.Data.Contains('code')) { throw }
    throw (New-OcrError 'WINRT_OCR_UNAVAILABLE' 'Windows.Media.Ocr is unavailable on this Windows installation.' ([ordered]@{ cause = $_.Exception.Message }))
  }
}

function Await-WinRt {
  param(
    [Parameter(Mandatory = $true)]$Operation,
    [Parameter(Mandatory = $true)][Type]$ResultType
  )
  try {
    $task = $script:AsTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
  } catch {
    throw (New-OcrError 'WINRT_ASYNC_OPERATION_FAILED' 'A Windows Runtime OCR operation failed.' ([ordered]@{ cause = $_.Exception.Message }))
  }
}

function New-Language {
  param([Parameter(Mandatory = $true)][string]$Tag)
  return [Activator]::CreateInstance($script:LanguageType, $Tag)
}

function Get-OcrEngine {
  param([Parameter(Mandatory = $true)][string]$Tag)
  $engine = $script:OcrEngineType::TryCreateFromLanguage((New-Language $Tag))
  if ($null -eq $engine) {
    throw (New-OcrError 'WINRT_OCR_LANGUAGE_UNAVAILABLE' "Windows OCR language package '$Tag' is not installed or cannot be initialized." ([ordered]@{ language = $Tag }))
  }
  return $engine
}

function Get-PreflightReport {
  $available = @($script:OcrEngineType::AvailableRecognizerLanguages | ForEach-Object { [string]$_.LanguageTag })
  $engines = @()
  foreach ($tag in $script:RequiredTags) {
    $engine = $null
    $failure = $null
    try { $engine = Get-OcrEngine $tag } catch { $failure = $_.Exception.Message }
    $engines += [ordered]@{
      language = $tag
      listedByWindows = ($available -contains $tag)
      engineCreated = ($null -ne $engine)
      error = $failure
    }
  }
  $missing = @($engines | Where-Object { -not $_.engineCreated } | ForEach-Object { $_.language })
  $report = [ordered]@{
    ok = ($missing.Count -eq 0)
    stage = 'preflight'
    provider = 'Windows.Media.Ocr'
    requiredLanguages = $script:RequiredTags
    availableRecognizerLanguages = $available
    maxImageDimension = [int]$script:OcrEngineType::MaxImageDimension
    engines = $engines
  }
  if ($missing.Count -gt 0) {
    $report.error = [ordered]@{
      code = 'WINRT_OCR_LANGUAGE_UNAVAILABLE'
      message = 'Windows Arabic and English OCR language packages are both required.'
      details = [ordered]@{ missingLanguages = $missing }
    }
  }
  return $report
}

function Read-Request {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) {
    throw (New-OcrError 'OCR_INPUT_INVALID' 'Expected a JSON request on stdin.')
  }
  try { $request = $raw | ConvertFrom-Json -ErrorAction Stop } catch {
    throw (New-OcrError 'OCR_INPUT_INVALID' 'Could not parse OCR JSON input.' ([ordered]@{ cause = $_.Exception.Message }))
  }
  if ($null -eq $request) { throw (New-OcrError 'OCR_INPUT_INVALID' 'OCR JSON input was empty.') }
  return $request
}

function Resolve-Languages {
  param($Request)
  $rawLanguages = @()
  if ($null -ne $Request.languages) { $rawLanguages = @($Request.languages) }
  if ($rawLanguages.Count -eq 0) { $rawLanguages = @('ara', 'eng') }
  $resolved = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($value in $rawLanguages) {
    $normal = ([string]$value).Trim().ToLowerInvariant()
    switch ($normal) {
      'ara' { [void]$resolved.Add($script:ArabicTag); break }
      'ar' { [void]$resolved.Add($script:ArabicTag); break }
      'ar-sa' { [void]$resolved.Add($script:ArabicTag); break }
      'eng' { [void]$resolved.Add($script:EnglishTag); break }
      'en' { [void]$resolved.Add($script:EnglishTag); break }
      'en-us' { [void]$resolved.Add($script:EnglishTag); break }
      default {
        throw (New-OcrError 'OCR_LANGUAGE_UNSUPPORTED' "Unsupported OCR language '$value'. This strict adapter requires Arabic and English." ([ordered]@{ language = $value }))
      }
    }
  }
  $missing = @($script:RequiredTags | Where-Object { -not $resolved.Contains($_) })
  if ($missing.Count -gt 0) {
    throw (New-OcrError 'OCR_LANGUAGE_PAIR_REQUIRED' 'Both Arabic and English OCR passes are required.' ([ordered]@{ missingLanguages = $missing }))
  }
  return $script:RequiredTags
}

function Resolve-ImagePath {
  param(
    $Value,
    [Parameter(Mandatory = $true)][string]$Field
  )
  $candidate = [string]$Value
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    throw (New-OcrError 'OCR_IMAGE_MISSING' "OCR request field '$Field' is required." ([ordered]@{ field = $Field }))
  }
  try { $fullPath = [System.IO.Path]::GetFullPath($candidate) } catch {
    throw (New-OcrError 'OCR_IMAGE_INVALID' "OCR request field '$Field' is not a valid path." ([ordered]@{ field = $Field; value = $candidate }))
  }
  if (-not [System.IO.File]::Exists($fullPath)) {
    throw (New-OcrError 'OCR_IMAGE_MISSING' "OCR image '$fullPath' does not exist." ([ordered]@{ field = $Field; path = $fullPath }))
  }
  return $fullPath
}

function Test-ArabicText {
  param([string]$Text)
  return $Text -match '[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]'
}

function Test-EnglishText {
  param([string]$Text)
  return $Text -match '[A-Za-z0-9]'
}

function Test-MeaningfulWord {
  param($Word)
  if ([string]::IsNullOrWhiteSpace([string]$Word.text)) { return $false }
  if ($Word.language -eq $script:ArabicTag) { return (Test-ArabicText $Word.text) }
  if ($Word.language -eq $script:EnglishTag) { return ((Test-EnglishText $Word.text) -and -not (Test-ArabicText $Word.text)) }
  return $false
}

function Normalise-WordText {
  param([string]$Text)
  return ([string]$Text).Normalize([System.Text.NormalizationForm]::FormC).Trim().ToLowerInvariant()
}

function Get-OverlapRatio {
  param($Left, $Right)
  $x1 = [Math]::Max([double]$Left.x, [double]$Right.x)
  $y1 = [Math]::Max([double]$Left.y, [double]$Right.y)
  $x2 = [Math]::Min([double]$Left.x + [double]$Left.w, [double]$Right.x + [double]$Right.w)
  $y2 = [Math]::Min([double]$Left.y + [double]$Left.h, [double]$Right.y + [double]$Right.h)
  $intersection = [Math]::Max(0, $x2 - $x1) * [Math]::Max(0, $y2 - $y1)
  $leftArea = [Math]::Max(1, [double]$Left.w * [double]$Left.h)
  $rightArea = [Math]::Max(1, [double]$Right.w * [double]$Right.h)
  return $intersection / [Math]::Min($leftArea, $rightArea)
}

function Remove-DuplicateWords {
  param([object[]]$Words)
  $deduplicated = New-Object System.Collections.Generic.List[object]
  foreach ($word in $Words) {
    $duplicate = $false
    for ($index = 0; $index -lt $deduplicated.Count; $index += 1) {
      $existing = $deduplicated[$index]
      $overlap = Get-OverlapRatio $existing $word
      if ((Normalise-WordText $existing.text) -eq (Normalise-WordText $word.text) -and $overlap -ge 0.6) {
        $duplicate = $true
        break
      }
      # A Latin-looking false positive from the English pass commonly occupies
      # exactly the same rectangle as an Arabic word from the Arabic pass.
      # Keep the language-specific Arabic token in that case; the raw passes
      # remain in the report and any remaining recognition error fails the DOM
      # comparison rather than being silently invented or substituted.
      if ($overlap -ge 0.75 -and $existing.language -ne $word.language) {
        $existingArabic = Test-ArabicText $existing.text
        $wordArabic = Test-ArabicText $word.text
        if ($existingArabic -and -not $wordArabic) {
          $duplicate = $true
          break
        }
        if ($wordArabic -and -not $existingArabic) {
          $deduplicated[$index] = $word
          $duplicate = $true
          break
        }
      }
    }
    if (-not $duplicate) { [void]$deduplicated.Add($word) }
  }
  return $deduplicated.ToArray()
}

function Order-WordsForReading {
  param([object[]]$Words)
  $candidates = @($Words | Sort-Object @{ Expression = { [double]$_.y + ([double]$_.h / 2.0) } }, @{ Expression = { [double]$_.x } })
  $lines = New-Object System.Collections.Generic.List[object]
  foreach ($word in $candidates) {
    $centerY = [double]$word.y + ([double]$word.h / 2.0)
    $line = if ($lines.Count -gt 0) { $lines[$lines.Count - 1] } else { $null }
    if ($null -eq $line -or [Math]::Abs($centerY - [double]$line.centerY) -gt [Math]::Max(6, ([double]$line.averageHeight + [double]$word.h) / 2.0 * 0.6)) {
      $line = [pscustomobject]@{ centerY = $centerY; averageHeight = [double]$word.h; words = (New-Object System.Collections.Generic.List[object]) }
      [void]$lines.Add($line)
    } else {
      $count = $line.words.Count
      $line.centerY = (($line.centerY * $count) + $centerY) / ($count + 1)
      $line.averageHeight = (($line.averageHeight * $count) + [double]$word.h) / ($count + 1)
    }
    [void]$line.words.Add($word)
  }
  $ordered = New-Object System.Collections.Generic.List[object]
  $lineIndex = 0
  foreach ($line in $lines) {
    $rtl = @($line.words | Where-Object { $_.language -eq $script:ArabicTag }).Count -gt 0
    $lineWords = if ($rtl) {
      @($line.words | Sort-Object @{ Expression = { [double]$_.x }; Descending = $true })
    } else {
      @($line.words | Sort-Object @{ Expression = { [double]$_.x } })
    }
    $wordIndex = 0
    foreach ($word in $lineWords) {
      [void]$ordered.Add([ordered]@{
        text = [string]$word.text
        x = [Math]::Round([double]$word.x, 3)
        y = [Math]::Round([double]$word.y, 3)
        w = [Math]::Round([double]$word.w, 3)
        h = [Math]::Round([double]$word.h, 3)
        language = [string]$word.language
        direction = if ($rtl) { 'rtl' } else { 'ltr' }
        lineIndex = $lineIndex
        wordIndex = $wordIndex
      })
      $wordIndex += 1
    }
    $lineIndex += 1
  }
  return $ordered.ToArray()
}

function Get-LanguagePass {
  param(
    [Parameter(Mandatory = $true)]$Bitmap,
    [Parameter(Mandatory = $true)][string]$LanguageTag
  )
  $engine = Get-OcrEngine $LanguageTag
  try {
    $result = Await-WinRt ($engine.RecognizeAsync($Bitmap)) $script:OcrResultType
  } catch {
    if ($_.Exception.Data.Contains('code')) { throw }
    throw (New-OcrError 'OCR_RECOGNITION_FAILED' "Windows OCR failed for '$LanguageTag'." ([ordered]@{ language = $LanguageTag; cause = $_.Exception.Message }))
  }
  $words = New-Object System.Collections.Generic.List[object]
  $lineIndex = 0
  foreach ($line in @($result.Lines)) {
    $wordIndex = 0
    foreach ($word in @($line.Words)) {
      $text = [string]$word.Text
      if (-not [string]::IsNullOrWhiteSpace($text)) {
        $rect = $word.BoundingRect
        [void]$words.Add([ordered]@{
          text = $text
          x = [Math]::Round([double]$rect.X, 3)
          y = [Math]::Round([double]$rect.Y, 3)
          w = [Math]::Round([double]$rect.Width, 3)
          h = [Math]::Round([double]$rect.Height, 3)
          language = $LanguageTag
          rawLineIndex = $lineIndex
          rawWordIndex = $wordIndex
        })
      }
      $wordIndex += 1
    }
    $lineIndex += 1
  }
  return [ordered]@{
    language = $LanguageTag
    text = [string]$result.Text
    words = $words.ToArray()
  }
}

function Recognize-Image {
  param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][string[]]$Languages
  )
  $file = Await-WinRt ($script:StorageFileType::GetFileFromPathAsync($ImagePath)) $script:StorageFileType
  $readMode = [System.Enum]::Parse($script:FileAccessModeType, 'Read')
  $stream = Await-WinRt ($file.OpenAsync($readMode)) $script:RandomAccessStreamType
  $bitmap = $null
  try {
    $decoder = Await-WinRt ($script:BitmapDecoderType::CreateAsync($stream)) $script:BitmapDecoderType
    $width = [int]$decoder.PixelWidth
    $height = [int]$decoder.PixelHeight
    $maxDimension = [int]$script:OcrEngineType::MaxImageDimension
    if ($width -gt $maxDimension -or $height -gt $maxDimension) {
      throw (New-OcrError 'OCR_IMAGE_TOO_LARGE' "OCR image dimensions ${width}x${height} exceed Windows OCR's ${maxDimension}px limit." ([ordered]@{ path = $ImagePath; width = $width; height = $height; maxImageDimension = $maxDimension }))
    }
    $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) $script:SoftwareBitmapType
    $passes = @($Languages | ForEach-Object { Get-LanguagePass $bitmap $_ })
    $meaningful = @($passes | ForEach-Object { $_.words } | Where-Object { Test-MeaningfulWord $_ })
    $words = @(Order-WordsForReading (Remove-DuplicateWords $meaningful))
    return [ordered]@{
      text = (($words | ForEach-Object { $_.text }) -join ' ')
      words = $words
      tokens = $words
      languagePasses = $passes
      image = [ordered]@{ path = $ImagePath; width = $width; height = $height }
    }
  } catch {
    if ($_.Exception.Data.Contains('code')) { throw }
    throw (New-OcrError 'OCR_IMAGE_READ_FAILED' "Windows OCR could not read '$ImagePath'." ([ordered]@{ path = $ImagePath; cause = $_.Exception.Message; stack = $_.ScriptStackTrace }))
  } finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

try {
  Initialize-WinRt
  $preflightReport = Get-PreflightReport
  if ($Preflight) {
    Write-Json $preflightReport
    if (-not $preflightReport.ok) { exit 1 }
    exit 0
  }
  if (-not $preflightReport.ok) {
    Write-Failure $preflightReport.error.code $preflightReport.error.message $preflightReport.error.details 'preflight'
  }
  $request = Read-Request
  $languages = Resolve-Languages $request
  $sourcePath = Resolve-ImagePath $request.sourcePath 'sourcePath'
  $powerPointPath = Resolve-ImagePath $request.powerPointPath 'powerPointPath'
  $source = Recognize-Image $sourcePath $languages
  $powerPoint = Recognize-Image $powerPointPath $languages
  Write-Json ([ordered]@{
    ok = $true
    stage = 'ocr'
    provider = 'Windows.Media.Ocr'
    languages = $languages
    source = $source
    powerPoint = $powerPoint
  })
} catch {
  $exception = $_.Exception
  Write-Failure (Get-ExceptionCode $exception) $exception.Message (Get-ExceptionDetails $exception) ($(if ($Preflight) { 'preflight' } else { 'ocr' }))
}
