# Ask desktop PowerPoint what it thinks about a package's embedded fonts.
#
# This is the strongest single-machine proof that fonts travel: PowerPoint's own
# object model reports Fonts(i).Embedded for the faces carried inside the file.
# It is NOT the same thing as asserting rendered pixels — PowerPoint honours an
# embedded font for display and editing, but its Export/render path substitutes
# an installed face when the embedded one is not installed on this machine, so a
# COM-rendered PNG cannot show the embedded glyphs here.
#
# Emits one JSON object on stdout.
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'

function ConvertTo-Bool($value) { if ($value -eq 0) { $false } else { $true } }

$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Open($Path, $true, $false, $false)
  try {
    $fonts = @()
    for ($i = 1; $i -le $pres.Fonts.Count; $i++) {
      $f = $pres.Fonts.Item($i)
      $fonts += [ordered]@{
        name       = [string]$f.Name
        embedded   = ConvertTo-Bool $f.Embedded
        embeddable = ConvertTo-Bool $f.Embeddable
      }
    }
    $runs = @()
    $slide = $pres.Slides.Item(1)
    for ($s = 1; $s -le $slide.Shapes.Count; $s++) {
      $shape = $slide.Shapes.Item($s)
      if ($shape.HasTextFrame -eq -1) {
        if ($shape.TextFrame.HasText -eq -1) {
          $runs += [ordered]@{
            shape = [string]$shape.Name
            text  = [string]$shape.TextFrame.TextRange.Text
            font  = [string]$shape.TextFrame.TextRange.Font.Name
          }
        }
      }
    }
    [ordered]@{
      slides = $pres.Slides.Count
      fonts  = $fonts
      runs   = $runs
    } | ConvertTo-Json -Depth 6 -Compress
  } finally {
    $pres.Close()
  }
} finally {
  $ppt.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
}
