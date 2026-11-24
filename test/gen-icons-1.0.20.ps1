param(
  [string]$Src = "C:\Users\SunmanXU\AppData\Local\Temp\musicsmx-logo\MusicSMX-icon-1024.png"
)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"
$root = "E:\AI相关\工作目录-个人\20261122-MusicSMX-Android\android\app\src\main\res"
$logo = [System.Drawing.Bitmap]::FromFile($Src)

function Save-Square([string]$dir, [string]$name, [int]$size, [bool]$round) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $bmp.SetResolution(72, 72)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  if ($round) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $path.AddEllipse($r)
    $g.SetClip($path)
  }
  $g.DrawImage($logo, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $g.Dispose()
  $dest = Join-Path (Join-Path $root $dir) $name
  $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  $dir/$name  ${size}x${size}"
}

function Save-Splash([string]$dir, [int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $bmp.SetResolution(72, 72)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::FromArgb(255, 26, 29, 38))
  # 图标牌大小：短边的 30%，且不超过长边的 40%
  $tile = [int]([Math]::Min($w, $h) * 0.30)
  if ($tile -gt [int]($w * 0.4)) { $tile = [int]($w * 0.4) }
  if ($tile -gt [int]($h * 0.4)) { $tile = [int]($h * 0.4) }
  $x = [int](($w - $tile) / 2); $y = [int](($h - $tile) / 2)
  $g.DrawImage($logo, (New-Object System.Drawing.Rectangle($x, $y, $tile, $tile)))
  $g.Dispose()
  $dest = Join-Path (Join-Path $root $dir) "splash.png"
  $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  $dir/splash.png  ${w}x${h} tile=$tile"
}

$dens = @{ "mipmap-mdpi" = 48; "mipmap-hdpi" = 72; "mipmap-xhdpi" = 96; "mipmap-xxhdpi" = 144; "mipmap-xxxhdpi" = 192 }
$fg = @{ "mipmap-mdpi" = 108; "mipmap-hdpi" = 162; "mipmap-xhdpi" = 243; "mipmap-xxhdpi" = 324; "mipmap-xxxhdpi" = 432 }

Write-Host "== 桌面图标（普通 / 圆形 / 自适应前景）"
foreach ($d in $dens.Keys) {
  $sz = $dens[$d]
  Save-Square $d "ic_launcher_v20.png" $sz $false
  Save-Square $d "ic_launcher_v20_round.png" $sz $true
  Save-Square $d "ic_launcher_foreground_v20.png" $fg[$d] $false
}

Write-Host "== 启动图"
$splashes = @(
  @{ d = "drawable"; w = 480; h = 320 },
  @{ d = "drawable-land-mdpi"; w = 480; h = 320 },
  @{ d = "drawable-land-hdpi"; w = 800; h = 480 },
  @{ d = "drawable-land-xhdpi"; w = 1280; h = 720 },
  @{ d = "drawable-land-xxhdpi"; w = 1600; h = 960 },
  @{ d = "drawable-land-xxxhdpi"; w = 1920; h = 1280 },
  @{ d = "drawable-port-mdpi"; w = 320; h = 480 },
  @{ d = "drawable-port-hdpi"; w = 480; h = 800 },
  @{ d = "drawable-port-xhdpi"; w = 720; h = 1280 },
  @{ d = "drawable-port-xxhdpi"; w = 960; h = 1600 },
  @{ d = "drawable-port-xxxhdpi"; w = 1280; h = 1920 }
)
foreach ($s in $splashes) { Save-Splash $s.d $s.w $s.h }

# 应用内 logo（左上角 .logo-icon）
$dest2 = "E:\AI相关\工作目录-个人\20261122-MusicSMX-Android\www\native\logo.png"
$small = New-Object System.Drawing.Bitmap(256, 256)
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g2.DrawImage($logo, (New-Object System.Drawing.Rectangle(0, 0, 256, 256)))
$g2.Dispose()
$small.Save($dest2, [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()
Write-Host "  www/native/logo.png 256x256"

$logo.Dispose()
Write-Host "DONE"
