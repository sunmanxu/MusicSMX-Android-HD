# 发布安卓版 Release（APK 必须由本机签名，CI 的包不要用）
#
#   pwsh -File scripts\publish-release.ps1                # 用当前 build.gradle 里的版本号
#   pwsh -File scripts\publish-release.ps1 -DryRun         # 只打印要做什么，不发请求
#
# 做三件事：
#   1) 校对本机有没有 MusicSMX-<版本>-debug.apk（没有就先 assembleDebug）
#   2) 建/复用 tag `android-v<版本>` 的 Release
#   3) 删掉同名旧资产，再上传这次的 APK
#
# 为什么不用 CI 自动发布：runner 上的 debug 签名每次都是临时生成的，和真机上的签名不同，
# 覆盖安装会失败（应用内更新也就白搭）。所以发布这一步固定走本机签名包。
param(
    [switch]$DryRun,
    [string]$NoteFile
)

$ErrorActionPreference = 'Stop'
$repo = 'sunmanxu/MusicSMX-Android-HD'
$root = Split-Path -Parent $PSScriptRoot
$gradle = Join-Path $root 'android\app\build.gradle'

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
    generate_release_notes = $true
}
if ($NoteFile -and (Test-Path $NoteFile)) { $body.body = Get-Content -Path $NoteFile -Raw -Encoding UTF8 }

if ($DryRun) {
    Write-Host "[dry-run] POST /repos/$repo/releases  tag=$tag"
    Write-Host "[dry-run] POST /repos/$repo/releases/<id>/assets?name=$(Split-Path $apk -Leaf)"
    return
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
