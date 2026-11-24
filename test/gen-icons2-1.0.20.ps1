param([string]$Src = "C:\Users\SunmanXU\AppData\Local\Temp\musicsmx-logo\MusicSMX-icon-1024.png")
Add-Type -AssemblyName System.Drawing
$root = "E:\AI相关\工作目录-个人\20261122-MusicSMX-Android\android\app\src\main\res"
$logo = [System.Drawing.Bitmap]::FromFile($Src)
$dens = @{ "mipmap-mdpi" = 48; "mipmap-hdpi" = 72; "mipmap-xhdpi" = 96; "mipmap-xxhdpi" = 144; "mipmap-xxxhdpi" = 192 }
$fg = @{ "mipmap-mdpi" = 108; "mipmap-hdpi" = 162; "mipmap-xhdpi" = 243; "mipmap-xxhdpi" = 324; "mipmap-xxxhdpi" = 432 }
function NewG([System.Drawing.Bitmap]$b) {
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  return $g
}
# 1) 普通图标：深底画布 + 82% 的图标牌（留出边距，S 大约占牌高 57%）
foreach ($d in $dens.Keys) {
  $sz = $dens[$d]
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
  $g = NewG $bmp
  $g.Clear([System.Drawing.Color]::FromArgb(255, 26, 29, 38))
  $inner = [int]($sz * 0.82)
  $x = [int](($sz - $inner) / 2)
  $g.DrawImage($logo, (New-Object System.Drawing.Rectangle($x, $x, $inner, $inner)))
  $g.Dispose()
  $bmp.Save((Join-Path (Join-Path $root $d) "ic_launcher_v20.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  $d legacy ${sz} inner=$inner"
}
# 2) 圆形图标：圆形裁切整张牌
foreach ($d in $dens.Keys) {
  $sz = $dens[$d]
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
  $g = NewG $bmp
  $g.Clear([System.Drawing.Color]::FromArgb(255, 26, 29, 38))
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddEllipse((New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)))
  $g.SetClip($p)
  $g.DrawImage($logo, (New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)))
  $g.Dispose()
  $bmp.Save((Join-Path (Join-Path $root $d) "ic_launcher_v20_round.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
# 3) 自适应前景：图缩到 58%（有些桌面会把前景再放大一圈，所以留足安全区）
foreach ($d in $fg.Keys) {
  $sz = $fg[$d]
  $inner = [int]($sz * 0.58)
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
  $g = NewG $bmp
  $x = [int](($sz - $inner) / 2)
  $g.DrawImage($logo, (New-Object System.Drawing.Rectangle($x, $x, $inner, $inner)))
  $g.Dispose()
  $bmp.Save((Join-Path (Join-Path $root $d) "ic_launcher_foreground_v20.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  $d foreground ${sz} inner=$inner"
}
$logo.Dispose()
Write-Host DONE
