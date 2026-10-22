$ErrorActionPreference = 'Stop'
$out = 'd:\pdf=ppt\out\matrix'
$ppt = New-Object -ComObject PowerPoint.Application

# v06: PowerPoint re-save with embedTrueTypeFonts attr already set in XML
$p = $ppt.Presentations.Open("$out\v06-powerpoint-embedded-segoe.pptx", 0, 0, 0)
$p.SaveAs("$out\v06-powerpoint-embedded-segoe.pptx")
$p.Close()
Write-Host 'v06 done'

# v09: PowerPoint re-save of converter baseline (its own font re-write path)
$p = $ppt.Presentations.Open("$out\v01-baseline-converter.pptx", 0, 0, 0)
$p.SaveAs("$out\v09-powerpoint-resaved-embed.pptx")
$p.Close()
Write-Host 'v09 done'

$ppt.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null


