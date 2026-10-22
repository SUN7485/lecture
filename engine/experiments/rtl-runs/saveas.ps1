$ErrorActionPreference = 'Stop'
$src = $args[0]
$dst = $args[1]
$log = $args[2]
$out = [ordered]@{ ok = $false; error = $null; build = $null }
$createdApp = $false
try {
  if (Test-Path $dst) { Remove-Item $dst -Force }
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
  catch { $app = New-Object -ComObject PowerPoint.Application; $createdApp = $true }
  $out.build = $app.Build
  $pres = $app.Presentations.Open($src, $false, $false, $false)
  $pres.SaveAs($dst, 24, 0)
  $pres.Close()
  if ($createdApp) { $app.Quit() }
  $out.ok = $true
}
catch {
  $out.error = $_.Exception.Message
  try { if ($pres) { $pres.Close() } } catch {}
  try { if ($createdApp -and $app) { $app.Quit() } } catch {}
}
[System.IO.File]::WriteAllText($log, ($out | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
