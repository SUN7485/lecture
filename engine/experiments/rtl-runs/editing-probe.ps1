$ErrorActionPreference = 'Stop'
$src = $args[0]
$log = $args[1]
$out = [ordered]@{ ok = $false; file = $src; shapes = @(); error = $null }
$createdApp = $false
$stage = 'init'

function BoundsOf($tr2, $start, $len) {
  $c = $tr2.Characters($start, $len)
  return [ordered]@{ left = [math]::Round($c.BoundLeft, 2); width = [math]::Round($c.BoundWidth, 2) }
}

try {
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
  catch { $app = New-Object -ComObject PowerPoint.Application; $createdApp = $true }
  $stage = 'open'
  $pres = $app.Presentations.Open($src, $false, $false, $false)
  $slide = $pres.Slides.Item(1)

  $rows = New-Object System.Collections.ArrayList
  foreach ($shape in $slide.Shapes) {
    if (-not $shape.HasTextFrame) { continue }
    if ($shape.TextFrame.HasText -eq 0) { continue }
    $stage = "measure $($shape.Name)"
    $tr = $shape.TextFrame.TextRange
    $tr2 = $shape.TextFrame2.TextRange

    # Rendered extent of every RUN, in the order the package declares them.
    $runCount = $tr.Runs().Count
    $runs = New-Object System.Collections.ArrayList
    $pos = 1
    for ($i = 1; $i -le $runCount; $i++) {
      $run = $tr.Runs($i, 1)
      $len = $run.Length
      $b = BoundsOf $tr2 $pos $len
      [void]$runs.Add([ordered]@{ i = $i; start = $pos; len = $len; left = $b.left; width = $b.width })
      $pos += $len
    }

    # INSERTION AT A RUN BOUNDARY. Put a marker at the end of run 1 and read
    # where it lands, then undo by deleting it again. Two markers: a strong LTR
    # letter, and a NEUTRAL, which is the character class direction decides.
    $inserts = New-Object System.Collections.ArrayList
    if ($runCount -ge 2) {
      foreach ($marker in @('X', '-')) {
        $stage = "insert '$marker' in $($shape.Name)"
        $before = $tr.Text
        $boundary = $tr.Runs(1, 1).Length
        $tr.Runs(1, 1).InsertAfter($marker) | Out-Null
        $after = $shape.TextFrame.TextRange.Text
        $idx = $after.IndexOf($marker) + 1
        $b = BoundsOf $shape.TextFrame2.TextRange $idx 1
        [void]$inserts.Add([ordered]@{
          marker = $marker; boundary = $boundary; logicalIndex = $idx
          left = $b.left; width = $b.width
          textChanged = ($after.Length - $before.Length)
        })
        # remove it again so the next marker starts from the same string
        $shape.TextFrame.TextRange.Characters($idx, 1).Delete()
      }
    }

    [void]$rows.Add([ordered]@{
      name = $shape.Name; text = $tr.Text; runCount = $runCount
      runs = $runs; inserts = $inserts
    })
  }
  $out.shapes = $rows
  $stage = 'close'
  $pres.Close()
  if ($createdApp) { $app.Quit() }
  $out.ok = $true
}
catch {
  $out.error = "$stage - $($_.Exception.Message)"
  try { if ($pres) { $pres.Close() } } catch {}
  try { if ($createdApp -and $app) { $app.Quit() } } catch {}
}
[System.IO.File]::WriteAllText($log, ($out | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
