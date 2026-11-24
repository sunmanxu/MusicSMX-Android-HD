Add-Type -AssemblyName System.Drawing
$logoPath = "C:\Users\SunmanXU\AppData\Local\Temp\musicsmx-logo\MusicSMX-icon-1024.png"
$root = "E:\AI相关\工作目录-个人\20261122-MusicSMX-Android\android\app\src\main\res"
$logoBmp = [System.Drawing.Bitmap]::FromFile($logoPath)
$LW = $logoBmp.Width; $LH = $logoBmp.Height
Write-Host "logo $LW x $LH"
$sAll = New-Object System.Drawing.Bitmap([int]$LW, [int]$LH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
$minX = $LW; $maxX = -1; $minY = $LH; $maxY = -1
for ($y = 0; $y -lt $LH; $y++) {
  for ($x = 0; $x -lt $LW; $x++) {
    $c = $logoBmp.GetPixel($x, $y)
    $orange = ($c.R -gt 70) -and ($c.R -gt ($c.B * 1.6)) -and ($c.R -gt ($c.G * 1.15))
    $a = 0
    if ($orange) { $a = [int]([Math]::Min(255, ($c.R - 60) * 2.2)); if ($a -lt 40) { $a = 0 } }
    if ($a -gt 0) {
      $sAll.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($a, $c.R, $c.G, $c.B))
      if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
$logoBmp.Dispose()
Write-Host "S bbox $minX,$minY -> $maxX,$maxY"
$SW = $maxX - $minX + 1; $SH = $maxY - $minY + 1
$sCrop = New-Object System.Drawing.Bitmap([int]$SW, [int]$SH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
$g0 = [System.Drawing.Graphics]::FromImage($sCrop)
$g0.DrawImage($sAll, (New-Object System.Drawing.Rectangle(0, 0, [int]$SW, [int]$SH)), (New-Object System.Drawing.Rectangle([int]$minX, [int]$minY, [int]$SW, [int]$SH)), [System.Drawing.GraphicsUnit]::Pixel)
$g0.Dispose(); $sAll.Dispose()
$BG = [System.Drawing.Color]::FromArgb(255, 26, 29, 38)
$dens = @{ "mipmap-mdpi" = 48; "mipmap-hdpi" = 72; "mipmap-xhdpi" = 96; "mipmap-xxhdpi" = 144; "mipmap-xxxhdpi" = 192 }
$fgd = @{ "mipmap-mdpi" = 108; "mipmap-hdpi" = 162; "mipmap-xhdpi" = 243; "mipmap-xxhdpi" = 324; "mipmap-xxxhdpi" = 432 }
function G([System.Drawing.Bitmap]$b) {
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g
}
foreach ($d in $dens.Keys) {
  $sz = [int]$dens[$d]
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
  $g = G $bmp
  $g.Clear([System.Drawing.Color]::Transparent)
  $r = [int]($sz * 0.23)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $r*2, $r*2, 180, 90)
  $p.AddArc($sz-$r*2-1, 0, $r*2, $r*2, 270, 90)
  $p.AddArc($sz-$r*2-1, $sz-$r*2-1, $r*2, $r*2, 0, 90)
  $p.AddArc(0, $sz-$r*2-1, $r*2, $r*2, 90, 90)
  $p.CloseFigure()
  $g.SetClip($p)
  $g.Clear($BG)
  $sh = [int]($sz * 0.46); $sw = [int]($sh * ($SW / $SH))
  $g.DrawImage($sCrop, (New-Object System.Drawing.Rectangle([int](($sz-$sw)/2), [int](($sz-$sh)/2), [int]$sw, [int]$sh)))
  $g.ResetClip()
  $pen = New-Object System.Drawing.Pen(([System.Drawing.Color]::FromArgb(60,255,255,255)), 1)
  $g.DrawPath($pen, $p); $pen.Dispose(); $g.Dispose()
  $bmp.Save((Join-Path (Join-Path $root $d) "ic_launcher_v20.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  $bmp2 = New-Object System.Drawing.Bitmap($sz, $sz, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
  $g2 = G $bmp2
  $g2.Clear([System.Drawing.Color]::Transparent)
  $pe = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pe.AddEllipse((New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)))
  $g2.SetClip($pe); $g2.Clear($BG)
  $sh2 = [int]($sz * 0.44); $sw2 = [int]($sh2 * ($SW / $SH))
  $g2.DrawImage($sCrop, (New-Object System.Drawing.Rectangle([int](($sz-$sw2)/2), [int](($sz-$sh2)/2), [int]$sw2, [int]$sh2)))
  $g2.ResetClip(); $g2.Dispose()
  $bmp2.Save((Join-Path (Join-Path $root $d) "ic_launcher_v20_round.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp2.Dispose()
}
foreach ($d in $fgd.Keys) {
  $sz = [int]$fgd[$d]
  $bmp3 = New-Object System.Drawing.Bitmap($sz, $sz, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
  $g3 = G $bmp3
  $g3.Clear([System.Drawing.Color]::Transparent)
  $sh3 = [int]($sz * 0.40); $sw3 = [int]($sh3 * ($SW / $SH))
  $g3.DrawImage($sCrop, (New-Object System.Drawing.Rectangle([int](($sz-$sw3)/2), [int](($sz-$sh3)/2), [int]$sw3, [int]$sh3)))
  $g3.Dispose()
  $bmp3.Save((Join-Path (Join-Path $root $d) "ic_launcher_foreground_v20.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp3.Dispose()
}
$sCrop.Dispose()
Write-Host DONE
