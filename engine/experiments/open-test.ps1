$ErrorActionPreference = 'Continue'
$out = 'd:\pdf=ppt\out\matrix'
$ppt = New-Object -ComObject PowerPoint.Application
Get-ChildItem "$out\v*.pptx" | ForEach-Object {
  try {
    $p = $ppt.Presentations.Open($_.FullName, -1, 0, 0)
    Write-Host ("OK   " + $_.Name + "  slides=" + $p.Slides.Count)
    $p.Close()
  } catch {
    Write-Host ("FAIL " + $_.Name + " : " + $_.Exception.Message)
  }
}
$ppt.Quit()
