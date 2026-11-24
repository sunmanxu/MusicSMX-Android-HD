param([string]$Src = "C:\Users\SunmanXU\AppData\Local\Temp\musicsmx-logo\MusicSMX-icon-1024.png")
Add-Type -AssemblyName System.Drawing
$root = "E:\AI相关\工作目录-个人\20261122-MusicSMX-Android\android\app\src\main\res"
$logo = [System.Drawing.Bitmap]::FromFile($Src)
$fg = @{ "mipmap-mdpi" = 108; "mipmap-hdpi" = 162; "mipmap-xhdpi" = 243; "mipmap-xxhdpi" = 324; "mipmap-xxxhdpi" = 432 }
# 自适应前景：把整张图缩到画布的 70%（其余透明，底色由 ic_launcher_background 补 #1A1D26）。
# 直接铺满 108dp 会被系统遮罩切掉外圈，S 贴边看起来“傻大”；留出安全区后 S 约占牌高 46%。
foreach ($d in $fg.Keys) {
  $sz = $fg[$d]
  $inner = [int]($sz * 0.70)
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
  $bmp.SetResolution(72, 72)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $x = [int](($sz - $inner) / 2)
  $g.DrawImage($logo, (New-Object System.Drawing.Rectangle($x, $x, $inner, $inner)))
  $g.Dispose()
  $dest = Join-Path (Join-Path $root $d) "ic_launcher_foreground_v20.png"
  $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  $d foreground ${sz}px inner=$inner"
}
$logo.Dispose()
