$ppt = New-Object -ComObject PowerPoint.Application
$p = $ppt.Presentations.Open('d:\pdf=ppt\out\matrix\v01-baseline-converter.pptx', -1, 0, 0)
($p | Get-Member) | Where-Object { $_.Name -match 'mbed|Font' } | Format-Table Name, MemberType
$p.Close()
$ppt.Quit()
