$ErrorActionPreference = 'Stop'
$src = $args[0]
$dst = $args[1]
$log = $args[2]
$out = [ordered]@{ ok = $false; applied = @(); error = $null; build = $null }
$createdApp = $false
$stage = 'init'
try {
  if (Test-Path $dst) { Remove-Item $dst -Force }
  try {
    $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
  } catch {
    $app = New-Object -ComObject PowerPoint.Application
    $createdApp = $true
  }
  $out.build = $app.Build
  $stage = 'open'
  $pres = $app.Presentations.Open($src, $false, $false, $false)

  $list = New-Object System.Collections.ArrayList
  $stage = 'apply run direction'
  foreach ($slide in $pres.Slides) {
    foreach ($shape in $slide.Shapes) {
      if (-not $shape.HasTextFrame) { continue }
      if ($shape.TextFrame.HasText -eq 0) { continue }
      $tr = $shape.TextFrame.TextRange
      # Late-bound COM has no usable .Item here; Runs(Start, Length) is the
      # documented indexer and returns the i-th run as its own TextRange.
      $count = $tr.Runs().Count
      for ($i = 1; $i -le $count; $i++) {
        $run = $tr.Runs($i, 1)
        $txt = $run.Text
        $isRtl = $false
        foreach ($ch in $txt.ToCharArray()) {
          $c = [int][char]$ch
          if (($c -ge 0x0590 -and $c -le 0x08FF) -or ($c -ge 0xFB1D -and $c -le 0xFEFF)) { $isRtl = $true; break }
        }
        $err = $null
        try { if ($isRtl) { $run.RtlRun() } else { $run.LtrRun() } } catch { $err = $_.Exception.Message }
        [void]$list.Add([ordered]@{
          shape = $shape.Name; run = $i; len = $txt.Length; rtl = $isRtl; error = $err
        })
      }
    }
  }
  $out.applied = $list
  $stage = 'save'
  $pres.SaveAs($dst, 24, 0)
  $pres.Close()
  if ($createdApp) { $app.Quit() }
  $out.ok = $true
}
catch {
  $out.error = "$stage - $($_.Exception.Message)"
  try { if ($pres) { $pres.Close() } } catch {}
  try { if ($createdApp -and $app) { $app.Quit() } } catch {}
}
$json = $out | ConvertTo-Json -Depth 5 -Compress
[System.IO.File]::WriteAllText($log, $json, (New-Object System.Text.UTF8Encoding($false)))
