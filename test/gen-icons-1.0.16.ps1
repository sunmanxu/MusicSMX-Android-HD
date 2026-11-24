Add-Type -AssemblyName System.Drawing

$res = "E:\AI相关\工作目录-个人\20261122-MusicSMX-Android\android\app\src\main\res"

# ---------- 1) 把「S」字形渲染成一张透明底的大图，量出真实像素边界 ----------
$CV = 300
$cvs = New-Object System.Drawing.Bitmap($CV, $CV)
$g = [System.Drawing.Graphics]::FromImage($cvs)
$g.Clear([System.Drawing.Color]::Transparent)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$font = New-Object System.Drawing.Font("Arial Black", 200, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0xFF, 0x6B, 0x3D))
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$fmt.Alignment = [System.Drawing.StringAlignment]::Near
$g.DrawString("S", $font, $brush, 10, 0, $fmt)
$g.Dispose()

$minX = $CV; $minY = $CV; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $CV; $y++) {
  for ($x = 0; $x -lt $CV; $x++) {
    if ($cvs.GetPixel($x, $y).A -gt 40) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
$glyphRect = New-Object System.Drawing.Rectangle($minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1))
$glyph = $cvs.Clone($glyphRect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$cvs.Dispose()
Write-Host "glyph box: $($glyph.Width)x$($glyph.Height)"

# 把字形缩放到指定高度（保持比例），返回 Bitmap
function Get-Glyph([int]$h) {
  $w = [int][Math]::Round($glyph.Width * $h / $glyph.Height)
  $out = New-Object System.Drawing.Bitmap([Math]::Max($w, 1), [Math]::Max($h, 1))
  $gg = [System.Drawing.Graphics]::FromImage($out)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gg.DrawImage($glyph, 0, 0, $out.Width, $out.Height)
  $gg.Dispose()
  return $out
}

# 圆角矩形路径；半径 = size * pct
function New-RoundRect([single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($w - $d, 0, $d, $d, 270, 90)
  $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
  $p.AddArc(0, $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# 画一块「歌单页左上角 logo」风格的小牌：深底 + 细白边 + 橙色 S
# $targetH = S 的实际高度占牌高的比例
function Save-Tile([string]$path, [int]$size, [single]$radiusPct, [bool]$circle, [single]$sRatio, [single]$insetPct) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $cx = [System.Drawing.Graphics]::FromImage($bmp)
  $cx.Clear([System.Drawing.Color]::Transparent)
  $cx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $cx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $cx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $inset = [single]($size * $insetPct)
  $w = [single]($size - 2 * $inset)
  $rect = New-Object System.Drawing.RectangleF($inset, $inset, $w, $w)

  $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0x1A, 0x1D, 0x26))
  if ($circle) {
    $cx.FillEllipse($fill, $rect)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(38, 255, 255, 255), [single]([Math]::Max(1, $size * 0.012)))
    $cx.DrawEllipse($pen, $rect)
    $pen.Dispose()
  } else {
    $path0 = New-RoundRect $w $w ([single]($w * $radiusPct))
    $cx.FillPath($fill, $path0)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(38, 255, 255, 255), [single]([Math]::Max(1, $size * 0.012)))
    $cx.DrawPath($pen, $path0)
    $pen.Dispose()
    $path0.Dispose()
  }
  $fill.Dispose()

  # S 不走满整块牌：高度只占牌高的 sRatio，视觉上「小一点、留白多一点」
  $sh = [int][Math]::Round($w * $sRatio)
  $sg = Get-Glyph $sh
  $sx = [int][Math]::Round($inset + ($w - $sg.Width) / 2)
  $sy = [int][Math]::Round($inset + ($w - $sg.Height) / 2)
  $cx.DrawImage($sg, $sx, $sy, $sg.Width, $sg.Height)
  $sg.Dispose()
  $cx.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  -> $([System.IO.Path]::GetFileName($path)) $size px"
}

# ---------- 2) 桌面图标：mdpi..xxxhdpi ----------
$dens = @{ "mdpi" = 48; "hdpi" = 72; "xhdpi" = 96; "xxhdpi" = 144; "xxxhdpi" = 192 }
foreach ($k in $dens.Keys) {
  $s = $dens[$k]
  Save-Tile "$res\mipmap-$k\ic_launcher.png" $s 0.23 $false 0.38 0
  Save-Tile "$res\mipmap-$k\ic_launcher_round.png" $s 0.5 $true 0.36 0
}

# ---------- 3) 自适应前景：只留 S 本身，背景色由 ic_launcher_background 提供 ----------
# 108dp 画布的安全区直径约 66dp，S 高 42dp 落在圆心，任何厂商遮罩形都不会切到
foreach ($k in $dens.Keys) {
  $s = [int][Math]::Round($dens[$k] * 108 / 48)   # 48->108 同比例放大
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $cx = [System.Drawing.Graphics]::FromImage($bmp)
  $cx.Clear([System.Drawing.Color]::Transparent)
  $cx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $cx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $sh = [int][Math]::Round($s * 34 / 108)
  $sg = Get-Glyph $sh
  $cx.DrawImage($sg, [int](($s - $sg.Width) / 2), [int](($s - $sg.Height) / 2), $sg.Width, $sg.Height)
  $sg.Dispose()
  $cx.Dispose()
  $bmp.Save("$res\mipmap-$k\ic_launcher_foreground.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  -> foreground $k $s px"
}

# ---------- 4) 启动图：沿用原尺寸，深底 + 居中小牌 ----------
$splashDirs = Get-ChildItem -Path $res -Directory -Filter "drawable*" | ForEach-Object { $_.FullName }
foreach ($d in $splashDirs) {
  $f = Join-Path $d "splash.png"
  if (-not (Test-Path $f)) { continue }
  $old = [System.Drawing.Image]::FromFile($f)
  $W = $old.Width; $H = $old.Height
  $old.Dispose()
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $cx = [System.Drawing.Graphics]::FromImage($bmp)
  $cx.Clear([System.Drawing.Color]::FromArgb(255, 0x1A, 0x1D, 0x26))
  $cx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $cx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $tile = [int][Math]::Round([Math]::Min($W, $H) * 0.30)
  $tmp = Join-Path $env:TEMP "smx-splash-tile.png"
  Save-Tile $tmp $tile 0.23 $false 0.38 0 | Out-Null
  $ti = [System.Drawing.Image]::FromFile($tmp)
  $cx.DrawImage($ti, [int](($W - $tile) / 2), [int](($H - $tile) / 2), $tile, $tile)
  $ti.Dispose()
  $cx.Dispose()
  $bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  -> $([System.IO.Path]::GetFileName($d)) splash $W x $H"
}

$glyph.Dispose()
Write-Host "done"

