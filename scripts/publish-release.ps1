# 发布安卓版 Release（APK 必须由本机签名，CI 的包不要用）
#
#   pwsh -File scripts\publish-release.ps1                 # 只打印本次会发什么（默认不发布）
#   pwsh -File scripts\publish-release.ps1 -Publish        # 真的发（问用户拿到明确同意再用这条）
#   pwsh -File scripts\publish-release.ps1 -Publish -NoteFile notes.md   # 手动指定发布说明
#
# 铁律（2026-11-25 用户明确要求）：
#   1) 只有用户说「更新到 GitHub」才允许发布 —— 所以这个脚本默认是「只看不发」，必须显式加 -Publish；
#   2) Release 说明里一定要写清这一版改了什么 —— 默认自动从 README 里抽出「## <版本号>」那一整段当说明。
#
# 做三件事：
#   1) 校对本机有没有 MusicSMX-<版本>-debug.apk
#   2) 建/复用 tag `android-v<版本>` 的 Release，说明取自 README 对应版本段
#   3) 删掉同名旧资产，再上传这次的 APK
#
# 为什么不用 CI 自动发布：runner 上的 debug 签名每次都是临时生成的，和真机上的签名不同，
# 覆盖安装会失败（应用内更新也就白搭）。所以发布这一步固定走本机签名包。
param(
    [switch]$Publish,
    [switch]$DryRun,
    [string]$NoteFile
)

$ErrorActionPreference = 'Stop'
$repo = 'sunmanxu/MusicSMX-Android-HD'
$root = Split-Path -Parent $PSScriptRoot
$gradle = Join-Path $root 'android\app\build.gradle'
$readme = Join-Path $root 'README.md'

$ver = (Select-String -Path $gradle -Pattern 'versionName\s+"([^"]+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
if (-not $ver) { throw "读不到 versionName：$gradle" }
$code = (Select-String -Path $gradle -Pattern 'versionCode\s+(\d+)' | Select-Object -First 1).Matches[0].Groups[1].Value
$tag  = "android-v$ver"
$apk  = Join-Path $root "MusicSMX-$ver-debug.apk"

Write-Host "版本 $ver (versionCode $code) → tag $tag"
if (-not (Test-Path $apk)) {
    throw "找不到 $apk —— 先构建：cd android; .\gradlew.bat assembleDebug"
}
$size = (Get-Item $apk).Length
Write-Host "APK: $apk  ($([math]::Round($size / 1MB, 2)) MB)"

# ---- 发布说明：优先 -NoteFile，否则从 README 里抽「## <版本号>」这一整段 ----
$notes = $null
if ($NoteFile -and (Test-Path $NoteFile)) {
    $notes = Get-Content -Path $NoteFile -Raw -Encoding UTF8
} elseif (Test-Path $readme) {
    $lines = Get-Content -Path $readme -Encoding UTF8
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^##\s+$([regex]::Escape($ver))") { $start = $i; break }
    }
    if ($start -ge 0) {
        $end = $lines.Count - 1
        for ($j = $start + 1; $j -lt $lines.Count; $j++) {
            if ($lines[$j] -match '^##\s+[0-9]') { $end = $j - 1; break }
        }
        $notes = (($lines[$start..$end] -join "`n").Trim() + "`n")
    }
}

if (-not $notes) {
    throw "README 里没有找到 $ver 的版本段 —— 先在 README 补一段「## $ver（日期）」写清这版改了什么，再发布"
}

Write-Host ""
Write-Host "==== 本次发布说明（将写进 Release）===="
Write-Host $notes
Write-Host "====================================="
Write-Host ""

if (-not $Publish -or $DryRun) {
    Write-Host "[未发布] 这只是预览。确认用户说过「更新到 GitHub」之后再跑：-Publish"
    Write-Host "[未发布] 届时将 POST /repos/$repo/releases  tag=$tag"
    Write-Host "[未发布]          POST /repos/$repo/releases/<id>/assets?name=$(Split-Path $apk -Leaf)"
    return
}

# ---- token：直接问 git 的凭据管理器，不落到文件、不打印 ----
$credText = ("protocol=https`nhost=github.com`n`n" | & 'C:\Program Files\Git\cmd\git.exe' credential fill 2>&1) -join "`n"
$token = ($credText -split "`n" | Where-Object { $_ -match '^password=' } | Select-Object -First 1) -replace '^password=', ''
if (-not $token) { throw 'GitHub token 拿不到：先在命令行 git push 一次，让凭据管理器存好' }
$headers = @{
    Authorization          = "Bearer $token"
    Accept                 = 'application/vnd.github+json'
    'User-Agent'           = 'MusicSMX-Android-Publish'
    'X-GitHub-Api-Version' = '2022-11-28'
}

$body = @{
    tag_name               = $tag
    target_commitish       = 'main'
    name                   = "MusicSMX Android $ver"
    draft                  = $false
    prerelease             = $false
    generate_release_notes = $false   # 说明由我们自己写（上面那段 README），不要让 GitHub 生成一堆无关条目
    body                   = $notes
}

# ---- 建 Release（已存在就复用）----
$rel = $null
try {
    $rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/releases" -Headers $headers `
        -Body ($body | ConvertTo-Json -Depth 4) -ContentType 'application/json'
    Write-Host "新 Release: $($rel.html_url)"
} catch {
    $msg = "$($_.ErrorDetails.Message)"
    if ($msg -match 'already_exists') {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers
        Write-Host "Release 已存在，复用: $($rel.html_url)"
        # 说明也一起更新成这次的
        Invoke-RestMethod -Method Patch -Uri "https://api.github.com/repos/$repo/releases/$($rel.id)" -Headers $headers `
            -Body (@{ body = $notes } | ConvertTo-Json -Depth 3) -ContentType 'application/json' | Out-Null
    } else {
        throw "创建 Release 失败: $msg"
    }
}

# ---- 删掉同名旧资产再传，避免 422 ----
foreach ($a in @($rel.assets)) {
    if ($a -and $a.name -eq (Split-Path $apk -Leaf)) {
        Write-Host "删除旧资产 $($a.name)"
        Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$repo/releases/assets/$($a.id)" -Headers $headers | Out-Null
    }
}

$uploadUrl = "https://uploads.github.com/repos/$repo/releases/$($rel.id)/assets?name=$([uri]::EscapeDataString((Split-Path $apk -Leaf)))"
$up = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers -ContentType 'application/vnd.android.package-archive' -InFile $apk
Write-Host "已上传: $($up.name)  ($([math]::Round($up.size / 1MB, 2)) MB)"
Write-Host "Release 页面: $($rel.html_url)"
