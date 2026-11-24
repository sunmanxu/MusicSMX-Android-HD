# 从桌面版仓库同步渲染层（可选，手工触发）
#
# 安卓这边的 www/ 是桌面版渲染层的一份"移植副本"：
#   - app.js / style.css 原则上应跟桌面版保持一致；
#   - www/index.html 多了 native/bridge.js、android.css、logo 这几个标签，**不能直接覆盖**；
#   - www/native/bridge.js、android.css、native/online.js 是安卓专属，桌面没有，也不要覆盖。
#
# 所以这里只同步"纯镜像"文件，并且在覆盖前先备份 + 打印 diff 统计。
# 用法：
#   pwsh -File scripts\sync-www.ps1              # 只体检，不写盘
#   pwsh -File scripts\sync-www.ps1 -Apply       # 真正覆盖
#
param(
  [string]$Desktop = "E:\AI相关\工作目录-个人\20261115-MusicSMX-重置版",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$www = Join-Path $root "www"

$map = @(
  @{ from = "src/renderer/app.js";    to = "app.js" },
  @{ from = "src/renderer/style.css"; to = "style.css" }
)

if (-not (Test-Path $Desktop)) { throw "桌面版目录不存在：$Desktop（用 -Desktop 指定正确路径）" }

foreach ($m in $map) {
  $src = Join-Path $Desktop ($m.from -replace '/', '\')
  $dst = Join-Path $www $m.to
  if (-not (Test-Path $src)) { Write-Host "[跳过] 桌面版没有 $($m.from)"; continue }
  if (-not (Test-Path $dst)) { Write-Host "[新增] $($m.to) 本地不存在" }

  $h1 = (Get-FileHash $src).Hash
  $h2 = if (Test-Path $dst) { (Get-FileHash $dst).Hash } else { "NONE" }
  $s1 = (Get-Item $src).Length
  $s2 = if (Test-Path $dst) { (Get-Item $dst).Length } else { 0 }

  if ($h1 -eq $h2) {
    Write-Host "[相同] $($m.to)  ($s2 B)"
    continue
  }

  Write-Host "[不同] $($m.to)  桌面 $s1 B / 安卓 $s2 B"
  Write-Host "       桌面 $h1"
  Write-Host "       安卓 $h2"
  if ($Apply) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmm"
    if (Test-Path $dst) { Copy-Item $dst "$dst.bak-$stamp" }
    Copy-Item $src $dst
    Write-Host "       -> 已覆盖（旧文件备份为 $(Split-Path -Leaf $dst).bak-$stamp）"
    Write-Host "       ⚠ 覆盖后务必重新跑真机回归：bridge.js 的 hook 依赖 app.js 的函数名与 DOM 结构。"
  }
}

if (-not $Apply) { Write-Host "`n（体检模式，未写盘。确认无误后加 -Apply 执行）" }
