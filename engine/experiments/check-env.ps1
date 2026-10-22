try {
  $p = New-Object -ComObject PowerPoint.Application
  Write-Host ("PowerPoint COM OK: " + $p.Version)
  $p.Quit()
} catch { Write-Host ("PPT COM FAIL: " + $_.Exception.Message) }
Get-ChildItem C:\Windows\Fonts | Where-Object { $_.Name -match 'diodrum|cairo|lyon|amiri|noto|segoe' } | Select-Object Name
