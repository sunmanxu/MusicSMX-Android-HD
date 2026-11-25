# MusicSMX 安卓版（Capacitor 移植工程）

桌面版（`20261115-MusicSMX-重置版`，Electron）的安卓移植。**渲染层原样复用**（app.js 一行业务逻辑都没改），
Electron 外壳整体重写成 Android 原生桥。策略与验收标准见桌面版目录下的《安卓移植交接说明.md》。

- 工程根：`E:\AI相关\工作目录-个人\20261122-MusicSMX-Android`
- 包名：`cn.sunmanxu.musicsmx`　应用名：MusicSMX
- 桌面版目录只读参考，未做任何修改

## 仓库与发布

- 仓库：`https://github.com/sunmanxu/MusicSMX-Android-HD`
- **独立仓库**，不和桌面版 `sunmanxu/MusicSMX` 混用：桌面版 tag 是 `v*`（且 `release.yml` 见 `v*` 就打桌面包），
  安卓版走 `android-v*`；两套构建工具链（Electron vs Gradle）和产物（exe vs APK）也完全不同。
- APK **不进版本库**（`.gitignore` 里 `*.apk`），成品统一挂 Release；
- 首个 Release：`android-v1.0.20` → <https://github.com/sunmanxu/MusicSMX-Android-HD/releases/tag/android-v1.0.20>
  （资产 `MusicSMX-1.0.20-debug.apk`，约 4.8 MB，CI 构建、versionCode 21 / versionName 1.0.20）；
- **CI 只编译，不发布**（1.0.21 起）：runner 的 debug 签名每次临时生成，和真机上的签名不同，覆盖安装会失败，
  应用内更新也就没法用。所以 Release 里的 APK 一律由本机签名后上传：

  ```powershell
  cd android; .\gradlew.bat assembleDebug; cd ..
  Copy-Item android\app\build\outputs\apk\debug\app-debug.apk MusicSMX-<版本>-debug.apk
  pwsh -File scripts\publish-release.ps1          # 建/复用 android-v<版本> Release 并上传本机 APK
  ```

  `publish-release.ps1` 的 token 直接问 git 凭据管理器，不落文件。CI 的产物只留 workflow artifact，供编译验证留痕。
- 重跑 CI 的姿势：删远端 tag 再 force 重推

  ```powershell
  git push origin :refs/tags/android-v1.0.20
  git tag -f android-v1.0.20
  git push origin android-v1.0.20
  ```

- CI 踩过的三个坑（都已修好，改 workflow 时别退回去）：
  1. `android-actions/setup-android@v3` 在这台 runner 上装不起来 → 改成用镜像自带 `ANDROID_SDK_ROOT`，
     预写 `licenses/android-sdk-license`、`android-sdk-preview-license`，有 `cmdline-tools/latest/bin/sdkmanager` 才补装
     `platform-tools` / `platforms;android-36` / `build-tools;36.0.0`，没有就交给 AGP 自己下；
  2. **Node 必须是 22**：`@capacitor/cli` 的 `engines` 是 `>=22.0.0`，用 Node 20 会在 `npx cap sync android` 阶段直接失败；
  3. Job 日志接口对未登录请求返回 403，查失败只能看 `/actions/runs/{id}/jobs` 的 step 级结论 ——
     所以失败先按"哪一步"猜，别指望拉日志正文。
- 发布一条命令：

  ```powershell
  git tag android-v1.0.21
  git push origin android-v1.0.21
  ```

- 首次推送（GitHub 上还没建这个仓库时）：

  ```powershell
  # 先在网页新建同名空仓库 MusicSMX-Android-HD，不要勾 README / .gitignore（避免首次推送冲突）
  git push -u origin main
  ```

  本机 git 在 `C:\Program Files\Git\cmd`，凭据走 Git Credential Manager，首次 push 会弹浏览器登录 GitHub。
  直连 `github.com:443` 有时会失败（`api.github.com` 却正常），此时走本机代理：
  `git -c http.proxy=http://127.0.0.1:7890 push`

- 渲染层同步（从桌面版拉 `app.js` / `style.css`，默认只体检不写盘）：
  ```powershell
  pwsh -File scripts\sync-www.ps1            # 只看差异
  pwsh -File scripts\sync-www.ps1 -Apply     # 真覆盖（自动备份旧文件）
  ```

## 本地构建

```powershell
Set-Location E:\AI相关\工作目录-个人\20261122-MusicSMX-Android
npx cap sync android                      # 改了 www/ 之后必须先同步，否则 APK 里还是旧页面
Set-Location android
$env:JAVA_HOME="E:\AI相关\工具\jdk-21"
$env:ANDROID_HOME="E:\AI相关\工具\android-sdk"
.\gradlew.bat assembleDebug --console=plain
# 产物 android\app\build\outputs\apk\debug\app-debug.apk
```

装到真机：`adb -s <serial> install -r android\app\build\outputs\apk\debug\app-debug.apk`

## 目录结构

```
www/                       渲染层（从桌面版原样拷入）
├── app.js                 业务逻辑（12772 行，未改动）
├── index.html             只加了两个 <link>/<script> 标签
├── style.css              未改动
├── vendor/hls.min.js
└── native/
    ├── bridge.js          安卓桥：重造 window.mb 契约 + 媒体地址改写 + MediaSession 桩 + 安卓 UI 收敛
    └── android.css        手机补充样式（安全区、隐藏窗口控件、触屏手感）

android/app/src/main/java/cn/sunmanxu/musicsmx/
├── MainActivity.java     沉浸全屏、返回键退后台、通知权限
├── MusicBridgePlugin.java  window.mb 的原生实现（Capacitor 插件 MusicBridge）
├── SafLib.java           SAF 目录树 ⇄ 虚拟路径、遍历扫描、删除/重命名/复制/查重
├── TagReader.java        ID3v2/ID3v1、FLAC、Ogg(Vorbis/Opus)、MP4-m4a 标签 + 内嵌封面
├── StorageHelper.java    应用沙盒读写、封面/歌词缓存（.jpg / .lrc / .lrc.json 边车）
├── MediaServer.java      127.0.0.1 回环 HTTP，带 Range 的音频流（给 WebView 的 <audio> 用）
└── PlaybackService.java  前台服务 + 系统 MediaSession（通知栏/锁屏/耳机线控/拔耳机暂停）
```

## 现在能做什么（P1 + P2）

1. 首次启动点侧栏 `+` 选一个音乐目录（系统目录选择器 SAF），问「是否包含子文件夹」，曲库分批入库并显示进度；
2. 列表/搜索/排序/收藏/歌单/队列/回收站/歌词面板/均衡器——全部是桌面版原逻辑，直接可用；
3. 播放：进度条可拖动（Range 流），暂停/续播/上下首/倍速/随机，标签里的封面和标题歌手专辑正常显示；
4. 切到后台继续放：前台服务保活，通知栏与锁屏有上一首/播放暂停/下一首 + 进度，耳机线控生效，拔耳机自动暂停；
5. 重启后曲库、收藏、歌单、队列、上次播放位置都在（`filesDir/config.json` + `saf-roots.json`）。
6. **联网补齐元数据（1.0.2 起可用）**：自动取专辑封面、歌词（原文/翻译/逐字），跑「工具 → 自动修复」能联网校验标题/歌手/专辑并**回写 MP3 的 ID3 标签**、按「歌手 - 标题」改名；
7. **状态栏/刘海让位（1.0.2）**：内容容器按 `WindowInsets` 加内边距，横竖屏都不会再被系统时间压住；
8. **竖屏播放页（1.0.2）**：桌面版 ≤700px 会把全屏封面整块隐藏，安卓端改成「封面在上、标题歌手、歌词工具栏、歌词」的竖排，触屏上按钮常显不淡出。

## 关键设计（踩坑点，改之前先读）

**虚拟路径**：安卓没有 `E:\Music` 这种全局路径，SAF 给的是 `content://…/tree/primary%3AMusic`。
为了让「路径是全局主键」这条铁律成立（收藏/歌单/歌词偏移全按路径存），把 SAF 文档 ID 映射成对渲染层
看起来像普通绝对路径的字符串：

```
真实树 docId  primary:Music   ->  虚拟根路径  /内部存储/Music
真实文件 docId primary:Music/周杰伦/晴天.mp3  ->  /内部存储/Music/周杰伦/晴天.mp3
```

根 → 树 Uri 的对应关系落在 `filesDir/saf-roots.json`（同时用 `takePersistableUriPermission` 长期持有权限，
万一 json 丢了还能从系统的持久化权限里补回来）。因此同一文件跨会话路径恒定，收藏不会丢。

**音频怎么喂给 `<audio>`**：WebView 既读不了 `file:///` 虚拟路径，也连不了 `content://`
（媒体加载走 Chromium 自己的数据源，不经过 `shouldInterceptRequest`）。做法是：
`MediaServer` 在 `127.0.0.1` 开一个带 token 的本地 HTTP 服务，按 Range 从 SAF 流式吐字节；
`bridge.js` 只改 `HTMLMediaElement.prototype.src` 这一处（app.js 所有播放地址都经 `fileURL()`
转成 `file:///…`，这是唯一必经收口点），把虚拟路径换成 `http://127.0.0.1:<port>/a/<b64url(路径)>?k=token`。
所以进度条能拖、能续播，也不用把音频复制进沙盒。

**系统媒体控制**：桌面版的托盘/缩略图按钮/任务栏歌词在安卓没有对应物，语义替换为 MediaSession。
`bridge.js` 给渲染层造了一个 `navigator.mediaSession` 桩 + `MediaMetadata`，app.js 自己调
`setActionHandler('play'|'pause'|'nexttrack'…)` 注册的处理函数被完整捕获；通知栏/锁屏/耳机按下时，
`PlaybackService` 通过 `window.__mbMediaAction()` 把指令**回送给这些同一个处理函数**，
所以 `S.playing`、媒体键切换语义不会和界面脱节（`mediaKeyToggle` 那套逻辑原样生效）。

**标签解析**：不用 `MediaMetadataRetriever`（上千首会慢到不可接受），照 `src/metadata.js` 的解析思路
用 Java 重写：只读文件头部若干 KB，ID3v2.2/2.3/2.4 + ID3v1 兜底、FLAC VorbisComment/Picture、
Ogg(Opus/Vorbis) comment、MP4 ilst（含 `covr` 封面）。读不到就按 `歌手 - 歌名` 文件名兜底，与桌面一致。

**配置**：`mb.getConfig/setConfig` 是整份读写（渲染层「读出→改→整体写回」），桥里绝不做字段合并。

**分批扫描**：每批 20 个文件解析标签，批与批之间推 `done/total` 进度并 `Thread.yield()`，
避免上千首同步遍历把 WebView 顶死（桌面版老坑）。

**联网元数据（1.0.2）**：`www/native/online.js` 是桌面 `src/online.js` 的逐字移植（只换了三样东西）：
网络走原生 `httpFetch`（WebView 里 `fetch` 跨域会被 CORS 拦，抓别家 API 必须走原生）、
酷狗逐字歌词 KRC 的 XOR+inflate 走原生 `decryptKrc`（浏览器没有 zlib）、`fs/path` 变空实现
（封面/歌词落盘统一由 `mb.saveCover` / `mb.saveLyrics` 处理）。
匹配算法、QQ 封面 300/500/800 规格、`duration` 权重、`.lrc.json` 边车全部原样保留（这三处是定案）。

**写标签（1.0.2）**：桌面靠 node-id3 直接改文件；安卓文件在 SAF 后面，自己实现了 `Id3Writer`：
只替换 `TIT2/TPE1/TALB` 三个帧，**其它帧（含 APIC 内嵌封面）原样复制，音频字节整段平移不动**，
读不进的超 64MB 文件、非 MP3、v2.2 标签一律拒绝（回 `ok:false`），宁可不改也不写坏。
离线验证过：重写后音频段与原文逐字节相同。

## 还没做（按交接文档的阶段表）

- **P4 剩余**：格式转换（原版靠内嵌 ffmpeg，安卓端 `convertToMp3/convertFormat` 仍回 `ok:false`）；
  桌面小部件。写标签只做了 **MP3/ID3v2**（FLAC/OGG/M4A 回 `ok:false` 并提示，不去动人家的文件）。
- **批量下载 / 歌单导入**：`getDownloadLink`、`fetchPlaylist` 的桥接已经接好，但小体积下载与歌单落盘还没实测。
- 平板大屏播放页仍是桌面双列布局（能用，只是没专门为触屏重排）。

## 构建

工具链（本机已装好，与工程分开存放，避免污染工程）：
`E:\AI相关\工具\jdk-21`（OpenJDK 21）、`E:\AI相关\工具\android-sdk`（platform-36 / build-tools 36 / platform-tools）。
`android/local.properties` 已指向该 SDK。

```powershell
# 1) 改了 www/ 里的代码后先同步进 android 资源
npx cap sync android

# 2) 出包（工程路径含中文，已在 gradle.properties 里关掉 AGP 的非 ASCII 检查）
cd android
$env:JAVA_HOME="E:\AI相关\工具\jdk-21"
.\gradlew.bat assembleDebug        # 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

说明：本机 `services.gradle.org` 不通，`gradlew.bat` 首次会卡在下发行包。已改用本机缓存的
Gradle 8.14.3 直接构建（`~\.gradle\wrapper\dists\gradle-8.14.3-bin\…\bin\gradle.bat`）。
要恢复 `gradlew.bat`，把 `android/gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl`
换成国内镜像（如 `https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip`）即可。

正式包需要在 `android/app/build.gradle` 加 signingConfig（jks），再用 `assembleRelease`。

## 安装

`app-debug.apk` 直接传手机安装（debug 签名）。首次进入允许通知（要通知栏播放控制）；
点侧栏 `+` 授权音乐目录后才会看到歌曲。

## 无手机时的渲染层冒烟测试

`test/` 目录是一个只在电脑上跑的假原生壳：`mock-native.js` 伪造 `window.Capacitor`，
`index.html` 是从 `www/index.html` 改写来的副本（路径指到 `../www/`），`server.js` 是静态服务。
用来在没有真机的时候验证「渲染层 + 桥」这一半不会崩：

```powershell
node test/server.js           # 127.0.0.1:8123
# 另开一个窗口，浏览器打开 http://127.0.0.1:8123/test/index.html
```

已跑过的结论：`app.js` 零异常启动、曲库列表正常渲染、`navigator.mediaSession` 桩生效、
`file:///` → `http://127.0.0.1:<port>/a/<base64url>` 的地址改写对中文路径和含 `#` 的路径都正确。

## 模拟器实测（Android 14 / API 34，x86_64）

本机装了完整模拟器环境，专门用来验 Java 那一半：

- SDK：`E:\AI相关\工具\android-sdk`（emulator 37.3.10 + `system-images;android-34;google_apis;x86_64`）
- 加速：AEHD 内核驱动（`extras;google;Android_Emulator_Hypervisor_Driver`，`sc query aehd` 应为 RUNNING）
- AVD：`musicsmx`

```powershell
# 启动（无窗口，靠 adb 截图/操作）
& "E:\AI相关\工具\android-sdk\emulator\emulator.exe" -avd musicsmx -no-snapshot -gpu swiftshader_indirect
# 万一 userdata 镜像又报 "Image is not in qcow2 format"，加 -wipe-data 重建一次即可
```

实测结论（push 了 30 首真实 mp3，目录结构与 PC 端 `D:\SMX-音乐` 一致，全部在子文件夹里）：

| 项目 | 结果 |
| --- | --- |
| SAF 授权目录 + 递归扫描 | 通过，`scan ... found=30` |
| ID3 标签 / 内嵌封面 | 通过，歌名歌手专辑、封面都能出来 |
| 出声播放（本地 HTTP + Range） | 通过，MediaSession 位置持续推进，AudioFlinger 有活动 track |
| 通知栏播放控制 | 通过，3 个动作（上一首/暂停-播放/下一首）+ 媒体样式 |
| 耳机/蓝牙键、锁屏、媒体键 | 通过，keyevent 85 暂停/恢复、87 下一首都生效，meta 同步到系统 |
| 暂停后通知消失问题 | 已修：暂停也保留前台服务（否则 MediaSession 被销毁，耳机键失效） |

## 已修的坑（复现原因记录）

1. **「导入和 PC 端一样的文件夹却提示没有发现新曲目」** —— 根因是 `SafLib.Doc.isDir()` 判错：
   ExternalStorageProvider 给的 mime 是 `vnd.android.document/directory`，而代码判的是
   `endsWith(".directory")`（结尾其实是 `/directory`，没有点）。于是用户选的**目录被当成一个文件**，
   文件名又不是音频扩展名，`collect()` 一首都没收。改成按 `MIME_TYPE_DIR` 或 `/directory` 结尾判定，
   同一目录立刻扫出 30 首。为定位这类问题还加了 `scan` 的 `debug` 诊断（授权根、tree、docId、
   mime、子项样本），扫空时打进 logcat 并 `console.warn` 出来。
2. **暂停状态下媒体键无效** —— 服务只在 `playing=true` 时启动，暂停后服务被回收、MediaSession 消失。
   改为「有曲目且界面在前台」就启动前台服务，暂停保留通知与会话，媒体键随时可恢复播放。
3. 手机竖屏布局：底部播放栏是浮在列表上的设计，不能给列表加 `padding-bottom`（会打乱可见行窗口，
   末尾空一大块）；空状态说明文字改成可换行、收窄。viewport 补了 `viewport-fit=cover`。


## 1.0.3 这一轮（状态栏同色 / 顶部歌词 / 匹配率 / 按钮自检）

**系统栏同色**：原先主题是 `Theme.AppCompat.Light.DarkActionBar` 系，`MainActivity` 只做 insets 内边距、
不设 `statusBarColor`/`navigationBarColor`，让出来的那条就露出 decor 的浅底——这就是「上面任务栏灰白、
跟深色播放页不搭」的根因。现在三处一起改：`MainActivity.applyChromeColors(top,bottom,lightIcons)` 同时设
状态栏/导航栏/窗口底色并强制深色图标（`setAppearanceLightStatusBars/NavigationBars(false)`）；
`styles.xml` 的 `AppTheme.NoActionBar`/`NoActionBarLaunch` 补 `#ff12141a` + `windowLightStatusBar=false`；
渲染层每 2 秒采样一次 `#topbar/.topbar/.app/body` 的计算背景色（半透明就压到深底上算等效色），
有变化才推 `mb.setChromeColors`——所以切主题/透明背景时系统栏也跟着走。实测竖屏、横屏都是同色、图标白色。

**顶部歌词条**：安卓没有可写的任务栏，等价物只能是悬浮窗。`TopLyric.java` 用
`TYPE_APPLICATION_OVERLAY` 做一条 38dp 高的通栏（`FLAG_NOT_FOCUSABLE|FLAG_NOT_TOUCHABLE`，
实底 `#1a1d26` + 1px 底边线，15sp 白字单行省略），脱离 App 也常显。渲染层不新造 UI，
直接复用桌面版那套「词」按钮与歌词菜单：`off` 关闭、`桌面/任务栏` 都落到这条悬浮条。
细节三处：(a) 歌词条占住顶部 38dp，`MainActivity.setExtraTopPx()` 让 App 内容整体下移，不压搜索框；
(b) 当前句由 `bridge.js` 的 `currentLyric()` 自己按 `S.lyrics` + `audio.currentTime` + 偏移算，
不依赖播放页是否打开；(c) LRC 头部的「作词：/作曲：/编曲：…」是元信息行，`isLyricMeta()` 过滤，
不会当成歌词显示。授权不会在启动时甩给用户：首次启动 10 秒内静默等待，用户真点「词」才要
「显示在其他应用上层」权限，授权回来 4 秒内自动补挂。

**封面/歌词匹配率**：抽 30 首真实曲库定位，失败清单全是同一形状——`"陈奕迅" / "无条件 - 无条件"`、
`"Bazzi" / "Beautiful - Beautiful"`，即无标签文件的文件名是「歌手 - 标题 - 专辑」，
旧正则把专辑拼进了标题，标题分卡在 0.62 阈值下。两层修：原生 `guessFromName` 优先按「空格-空格」切三段，
第三段写进 `album`；`www/native/online.js` 加 `titleVariants()`（原样 / ` - ` 前段 / 去括号注记 /
去 feat. 署名 / 去注记后的前段），`searchCover`/`searchCoverCandidates`/`searchLyrics` 都补了第二轮变体重试
（变体不覆盖第一轮已拿到的原文）。离线抽样 30 首→30/30，扩到 60 首仍 60/60。

**配置自愈**：测试期间模拟器崩过，`config.json`/`config.json.bak` 都成了 0 字节，`folders` 丢失 →
启动后 0 首、背景退回半透明 → 整页变灰白。现在 `getConfig` 走
`config.json → .good → .tmp → .bak` 兜底链，`folders` 为空时按 `saf-roots.json` 自愈；
`setConfig` 拒写空内容、写 tmp 校验长度再 rename、成功后另存 `config.json.good`；
`MainActivity` 给 WebView 设 `0xFF12141A` 背景 + `android.css` 给 `html` 兜底色。

**按钮自检（WebView CDP 程序化点击，非截图点按）**：`adb shell input tap` 的坐标和页面 CSS 坐标错位
（WebView `screenY=136`、DPR≈2.748），点出来的结论不可信，改用
`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` + 零依赖 CDP 客户端
`test/cdp.js`（手写 WebSocket 握手，`Runtime.evaluate{awaitPromise,userGesture}`）。
覆盖并通过：排序菜单/排序键、工具菜单、个性化浮层、设置面板、搜索（30→2 首）、上一首/下一首、
循环模式、播放列表抽屉、歌词面板、均衡器、播放页原文/翻译/逐字、A+/A−、单双列、播放页返回、
列表单击选中/双击播放、收藏、侧栏分类、通知栏歌词同步。
自查结论里有几条**不是真 bug**，属于脚本口径问题，一并记下来省得下次再查：`#btn-fav`/`#btn-cover-mini`
这两个 id 不存在（真实是 `#pf-fav`、页脚 `#cover`）；翻译开关的真值在 `pf.lyricModes`（不是 `S.lyricsMode`）；
搜索清空是快照时序问题（清空后列表已回 30 首）；播放键偶发 `false` 是无用户手势 `play()` 被拒，
补 `mousedown` 后三态（`paused:false`→`true`→`false`）全对。

**遗留**：手机尺寸的横屏（≈800×350 CSS px）播放页偏挤，歌词和控件会互相压；平板/3:2 大屏（如用户截图）正常。
模拟器在 `swiftshader_indirect` 下连着跑 CDP 一个多小时会整机崩（`adb devices` 里消失），重启 AVD
数据保留，但每次重启后需要重新 `install -r` + 重做 `adb forward`。

### 1.0.3 补丁：触屏尺寸（图标/可点区/滚动条/进度条）

用户反馈「平板上图标太小点不准」「列表右侧那条拖动条太细、拖起来不跟手」。改的全在 `www/native/android.css`（§10–§13），没动桌面版骨架：

- **按钮与图标**：`.ctl` 从 32px → 38px、图标 20px（原 14/16）；播放键 46px、图标 24px；平板（≥900px 宽）再放大一档：按钮 44px、图标 23px、播放键 54px/28px。尺寸走 `--touch-ctl / --touch-icon / --touch-big` 三个变量，想再大只改变量。`.btns::before` 那个保持播放键居中的等宽占位也同步改了，播放键仍然几何居中。
- **列表滚动条**：9px → 18px（平板 22px），滑块视觉 12px、圆角 8px、颜色更淡（32% 透明度，拖动时 62%）；`touch-action:none` 关掉原生滚动抢占。`app.js` 里 `left` 是内联写死的 `right-9`，这里用 `left:auto !important; right:0 !important` 改掉，不用改共享的 app.js。
- **底部进度条**：轨道 3px → 5px，拖动点从「只有 hover 才露出」改成常显 14px；命中区用 `.seek::after` 上下各外扩 8px（视觉不增高，行高保持 14px——一开始直接把 `.seek` 调到 26px，横屏底栏被撑高、进度条被手势条压住了，已回退）。
- 音量条同样 5px 轨道 + 16px 滑块。

### 1.0.4：系统栏真融合 + 11 项触屏交互修复（versionCode 5）

用户一次性提了 11 条硬需求。改动落在 `MainActivity` / `TopLyric` / `MusicBridgePlugin` / `StorageHelper`
加 `www/native/bridge.js`、`www/native/android.css`；`www/app.js` 依旧逐字不动。

1. **状态栏那条深灰横条** —— 根因是原生给 `android.R.id.content` 加 insets padding，让出来的那一条永远是一块纯色。
   正解是 edge-to-edge：WebView 铺到状态栏底下，留白由网页自己加。
   踩坑：只调 `WindowCompat.setDecorFitsSystemWindows(false)` 没用 —— 实测 DecorView 仍自带 `padTop=136`（状态栏高度），
   内容区被裁到 2138。真正生效的是**把 `ViewCompat.setOnApplyWindowInsetsListener` 装在 DecorView 上并返回 insets**
   （装饰视图默认的 padding 逻辑就不再执行），配 `decor.setFitsSystemWindows(false)` + `requestApplyInsets`。
   之后 `decor padTop=0 / content 2340 / wvTop=0`，insets 经 `__mbInsets` 推给网页。
   单位坑：Java 推的是物理像素，网页要 CSS px —— `pushInsetsToWeb` 统一按 `density` 折成 dp（否则 136 被当成 136px，顶栏被顶到 240px 处）。
   `html` 背景改成 `var(--mb-chrome-bg)`（bridge 每次同步状态栏配色时写入同一个主题色）；播放页 `#player-full` 自己加 padding，
   `.pf-bg` 的 `inset:-40px` 把封面渐变一路铺到状态栏里，顶上不再是一条纯深灰。
2. **去掉均衡器、并入歌词调节** —— `#btn-eq` / `#pf-eq` 在捕获阶段拦掉（先于 app.js 的监听器，`stopPropagation` + `preventDefault`），
   改为弹「歌词调节」卡片。卡片里装的是**渲染层真实的那根 `.pf-spacing-panel`**（整节点搬进 `#mb-mix-body`，关掉再搬回原位），
   所以滑块拖动、数值记忆、每首歌单独的歌词延迟、字号缩放全走原版逻辑。播放页右侧那根竖轨在 Android 上藏掉
   （`#player-full .pf-spacing-panel{display:none}`），它原来会压住歌词和进度条。
3. **工具栏抽搐** —— `.pf-lyrics-toolbar` 原本是 `position:absolute; translateY(-100%)` 悬在歌词框上方，触屏常显后布局重算会插一帧。
   现在全宽度 `position:static` + 固定 42px 高 + `transition:none`（实测 toolbar top=326、歌词 top=367，不再重叠）。
4. **全屏键 / 音量条** —— `#pf-fs` 隐藏；`#pf-volume` 加长到 `clamp(170px,38vw,340px)`，轨道 6px、滑块 20px。
5. **底栏收藏键** —— `#btn-next` 后面插 `#mb-fav`（`.ctl` 尺寸，和专辑页 `#pf-fav` 同一套爱心，实心=已收藏），
   1.5 秒轮询同步状态，点了调渲染层自己的 `toggleFavorite()`。
6. **单击即播** —— `#track-list` 上挂捕获监听，行内单击 → `playAt(idx)`（占位/网络行跳过并提示）；同行再点因 `playAt` 有
   「同索引直接 return」不会打断。
7. **单击歌手/专辑进筛选** —— 同一个捕获监听识别 `.t-artist` / `.t-album`，`stopPropagation` 后调 `toggleTrackFilter()`
   （内部已 `pushNav()`），不再需要桌面版的双击。
8. **跳浏览器前确认** —— `mb.openExternal` 与 `window.open` 都包一层，先出 `#mb-confirm`（显示域名 + 留在 App / 去浏览器），
   确认才走原生 `openExternal`；返回键也能关掉它。
9. **回退层级** —— `window.__mbBack()` 逐层退：自己的面板（调节卡/确认框）→ 播放页 → 渲染层浮层（借 app.js 的 Esc 处理器，
   关不掉的再点它自己的关闭按钮）→ 筛选态 `clearTrackFilter()` → `navHistory` 的 `navBack()` → 都没有才 `'exit'`
   （`onBackPressed` 收到 exit 才 `moveTaskToBack`）。实测调节卡→播放页依次 handled，根页面 exit。
10. **启动不再全库重扫** —— 两份缓存落在 `files/`：`library-cache.json`（曲目表，落盘时逐条剥掉 `cover`）、
    `tag-index.json`（`path → size+mtime → 标题/歌手/专辑` 指纹）。`mb.scan` 首次调用带 `preferCache:true`：
    命中直接返回缓存（logcat `scan: served cached library, 30 tracks`），同时起后台线程重扫校正，
    只有增删改才写盘并 `emit('__libraryChanged')`（渲染层收到后走自己的 `refreshAllFolders()`），没变只打 `library unchanged`。
    `trackFrom()` 改走指纹：size/mtime 没变就不拆 ID3/FLAC（重扫真正慢的就是这一步）。
11. **顺手修的 bug** —— ①0 字节封面文件会让渲染层拼出 `data:image/jpeg;base64,` 空 data URL、界面上一张碎图标
    （`readCoverFile` 按"没有封面"返回，bridge 再兜一道过滤）；②顶部悬浮歌词条在「没有歌词文本」时也占 38dp，
    正好是状态栏下面那条空灰带 —— 现在没文本就 `INVISIBLE` 且不占位，歌词条本身也去掉 1px 描边；
    ③播放页底部控制区 grid 三列在手机宽度下右侧那组会**压到中间那组上面**（1.0.2 起的老问题），
    ≤820px 改成单列两行：第一行播放控制，第二行收藏/音量。

**关于「自动修复是不是每次启动都跑」**：查过 `app.js` 的启动流程 `init()` —— 只有 `mb.getConfig` →
`mb.scanLocalCache(封面/歌词缓存目录)` → `addPaths(cfg.folders,true)`，**没有**调 `autoFixAll()`；
自动修复只在工具菜单/按钮（`app.js:10326`）手动触发。所以「每次进软件都要修复」的观感，
其实来自「每次进软件都要重扫曲库」—— 就是第 10 条修掉的那个。

**已知取舍**：缓存里**不存内嵌封面**（单张最大 4MB，1380 首会把缓存撑到上百 MB）。缓存命中启动时曲目没有 `cover`，
封面由渲染层自己的封面缓存/联网补（`settings.autoCover` 那条链路）。真觉得"刚进软件封面空一下"难看，再加一份按 path 散装的封面文件缓存。

**验证**（模拟器 Android 14 / 1080×2340 / DPR 2.75）：insets 49/24/0/0 推到网页、顶栏 top=49；
播放页工具栏与歌词不重叠、音量 170px、`#pf-fs` 已隐藏；收藏键 42px 且在 `btn-next` 之后、点击能收藏；
单击行 `cur=2 / playing=true`；单击歌手 `filterField=artist` 且播放不中断；`__mbBack` 逐层 handled→exit；
外链确认框能开能关；`library-cache.json`(9966B) / `tag-index.json`(6011B) 已落盘，第二次启动走缓存。
截图：`test/v104-2-列表.png`、`test/v104-6-播放页.png`、`test/v104-8-播放页.png`、`test/v104-10-播放页调节.png`。


### 1.0.5：修「播放没声音」+ 返回层级彻底重做（versionCode 6）

这一轮只针对两条反馈，`www/app.js` 依旧逐字未改，改动全在原生插件与 `www/native/bridge.js`（另加 `index.html` 一个版本标签）。

**① 播放没有任何声音 —— 元凶是上一版留下的均衡器**

桌面版的 EQ 不是"调几个旋钮"，它是一张真的 Web Audio 图：`ensureEqChain()` 里 `createMediaElementSource(audio)`
把 `<audio>` 的输出接管到 `ctx.destination`。一旦这张图搭起来，**音频元素本身就不再直连扬声器**；
而 WebView 里的 `AudioContext` 默认停在 `suspended`（自动播放策略），于是「进度在走、波形在动、一点声没有」。
安卓版 1.0.4 已经删掉了均衡器界面，但老配置 `settings.eq.on` 还是 `true`，`init()` 里 `initEqFromSettings()`
照样会把这条静音的链搭起来——用户遇到的正是这个。三层防线：

1. **原生读配置时清掉**（`MusicBridgePlugin.sanitizeEq()`）：`getConfig` 发现 `settings.eq.on==true` 就改成
   `on:false / preamp:0 / preset:"flat" / gains 全 0`，并把改后的配置写回磁盘（logcat
   `MusicBridge: getConfig: 旧配置的均衡器已强制关闭（避免 AudioContext 静音）`，只修一次，下次启动就是干净的）。
2. **原生写配置时再拦一道**：`setConfig` 落盘前同样过 `sanitizeEq`，防止渲染层把 `on:true` 又写回来
   （实测：CDP 里硬写 `eq.on=true; saveConfig()`，磁盘上仍然是 `"eq":{"on":false…}`）。
3. **渲染层兜底**（`bridge.js` 的 `guardEqSilence()`，启动后 0 / 1.2s / 3s 各查一次）：万一配置没走过原生那道，
   就把内存里的 `eq.on/chainOn` 关成平坦 + 写回配置 + 一条 toast；已经搭起来的上下文不拆（拆了更没声），
   改为在**首次触摸屏幕**时 `ctx.resume()`。

实测（模拟器）：把设备 `files/config.json` 手改成 `"eq":{"on":true…}` 后重启 —— logcat 打出上面那条警告，
磁盘配置被改回 `on:false`，运行时 `eq.on=false / chainOn=false / eq.ctx=不存在`（链根本没搭，不存在静音路径）。

**② 从歌单/专辑页侧滑返回会退出软件**

先确认现象：**1.0.4 里「收藏视图」上按返回是真的退出**（CDP 里 `switchView("favorites")` 后 `__mbBack()` 返回 `exit`），
因为旧的 `__mbBack` 只认 `navHistory`——而它在重启后是空的，任何"不在 navHistory 里"的视图（收藏、文件夹、歌单、搜索、
多选、电台页）都会一路兜到"退出"。旧实现还有个致命的形状：整个函数一个 `try` 包到底，`return 'exit'` 在 `catch` 里，
**任何一层抛异常（比如 `#pf-close` 的处理器内部报错）都会被当成"到顶了"**，直接把用户踢出 App。重做后：

- 每一层独立 `try`，某层坏了只跳过那一层，兜底是 `'exit'` 只出现在函数最末尾（判断完所有层之后）。
- 层级：自己的面板（歌词调节/外链确认）→ **播放详情页**（`#pf-close`，并且 420ms 后再校验一次，防止它的
  `pf.open` 标记没跟上、点了没反应）→ 渲染层浮层（借 app.js 自己的 Esc 处理器 + 它自己的关闭按钮）→
  多选（`clearMultiSel` / `exitRadioMultiMode`）→ **非根视图归位** → `navHistory` 的 `navBack()` → `exit`。
- 「非根视图归位」（`appState()` + `goRootView()`）覆盖：搜索词、歌手/专辑筛选、收藏视图、文件夹、歌单、电台页。
  能复用 app.js 自己的入口就复用（`showAllMusicView()` 一次把收藏/文件夹/歌单/筛选全退掉、还带重渲染），
  不自己拼状态，免得又出"卡在筛选页"那种各写一份的问题。
- 原生 `MainActivity.onBackPressed` 从 `value.contains("exit")` 改成**只认精确的 `"exit"`**，
  JS 抛异常/返回 null 一律当"已处理"，logcat 留一行 `back -> "handled"` 方便下次定位。
- 顺带修 `appOverlayOpen()`：原来只看 `[hidden]` 属性，元素被 `display:none` 藏着也会被当成"有浮层"，
  返回键会被白白吞掉；改成逐个候选做 `isShown`（display/visibility 一起看）。

实测（模拟器，逐层）：收藏视图 `__mbBack()` → `handled` 且 `showFavorites` 变 `false`（改前是 `exit`）；
收藏视图里打开播放页 → 返回只关播放页、仍留在收藏视图；再按一次 → 回全部音乐；真机键 `KEYCODE_BACK` 在根页面才 `exit`。

**版本可辨识**：设置面板标题后面加了 `安卓 1.0.5` 小标签（`#mb-ver-chip`），`mb.version` 同步改成 `1.0.5-android`，
`build.gradle` 为 `versionCode 6 / versionName "1.0.5"`。

**顺带说明**：设备配置里 `volume` 只有 `0.05`（5%）也记一笔 —— 那是测试期拖动进度留下的，不是默认值；
真觉得"偶尔没声"，先看这条：设置里的音量条如果贴在 5% 附近，手机媒体音量又不高，听起来就和静音差不多。

### 1.0.6：小米平板 6S Pro 适配 + 返回层级真正生效 + 砍掉均衡器/歌词菜单（versionCode 7）

目标机改成小米平板 6S Pro（3048×2032，CSS ≈1524×1016，DPR 2），四条反馈逐条处理。

**① 去掉「歌词调节」按钮**
`#btn-eq`（底栏）与 `#pf-eq`（播放页）一起藏掉（`android.css` §23 `display:none !important`），
bridge 里原来"点击打开歌词调节卡片"的接管也一并撤掉。播放页中间组因此从 7 键变 6 键，
所以补了一个等宽隐形配重 `#mb-pf-spacer`，让「播放」重新落在窗口几何中心（实测 764px / 屏宽中点 762px）。

**② 平板比例下的专辑页：底部按钮不再重叠**
根因：桌面版 `.pf-controls` 是 grid 三列（左 1fr 空列 / 中间播放组 / 右侧收藏+静音+音量），
平板上右侧那组（收藏+静音+音量条≈470px）比 1fr 列还宽，被 `justify-end` 顶到中间组头上，
于是心形/静音/音量条全叠在「上一首/下一首」上。按平板写了两套（`android.css` §22、§24）：
- 横屏（≥900px + landscape）：中间组继续居中，右侧组改成 `position:absolute; right:` 贴右缘，几何上不可能相交；
  音量条 `#pf-volume.pf-volume` 用 `clamp(150px,17vw,300px)`（必须带 `!important` 才压得住 §15 那条 id+class 规则）；
  按钮放大到 46~64px、播放键 58~76px。
- 竖屏（≥900px + portrait）：宽度不够贴边，改成两行（第一行播放控制、第二行收藏+音量，音量条 45vw）。
实测（模拟器按 `wm size 3048x2032 / wm density 320` 复刻平板）：横屏 center 528–996 / right 1070–1448，
两者间隔 74px；竖屏两行不重叠。

**③ 侧滑返回还是会直接回桌面 —— 这次找到了真原因**
之前只实现 `onBackPressed()`。Android 13 起「侧滑返回」走的是 **OnBackInvokedDispatcher**，
App 没注册 `OnBackInvokedCallback`（且 Manifest 没开 `enableOnBackInvokedCallback`）时，
这次手势会被系统当成"结束 Activity"，不管在哪一层都是直接回桌面——这正好解释了"改了也没用"。
这一版：
- `AndroidManifest.xml` 加 `android:enableOnBackInvokedCallback="true"`（不写这个，注册的回调根本收不到事件）；
- `MainActivity.setupBackCallback()` 在 `onCreate` 里注册 `OnBackInvokedCallback`（API 33+），
  `onBackPressed()` 仍保留给旧系统，两条路都进同一个 `handleBack()`，并用 250ms 去抖防止 ROM 重复派发；
- 退出前的第二道闸：JS 里新增只读判断 `__mbAtRoot()`（播放页/浮层/筛选/搜索/收藏/歌单/多选/电台/未退干净的
  导航历史任意一条存在就返回 false），原生只有「网页说 exit **且** 已在根页面」才 `moveTaskToBack`，
  所以即使某层状态判断漏了，也不会把人踢出 App。
实测（`input keyevent KEYCODE_BACK`，logcat 会打 `MusicSMX: back(gesture) -> "handled"`）：
播放页 → 只关播放页、留在列表；设置面板 → 只关面板；收藏视图 → 回全部音乐；根页面 → `exit` 才回桌面。

**④ 「词」按钮精简成顶部悬浮歌词开关**
桌面版那套三档菜单（桌面/任务栏/关闭 + 字号/颜色/逐字/锁定）在平板上纯属噪音：现在点「词」= 开/关顶部悬浮歌词，
`#desktop-lyric-menu` 用 CSS 永久隐藏，bridge 在捕获阶段接管点击（`setDesktopLyricMode('taskbar'|'off')`），
按钮开着时显示主题色（`#btn-desktop-lyric.mb-top-on`）。

顺带修的：顶部歌词条让位高度改成**实测**——`TopLyric` 记录 overlay 的真实底边（`bottomPx()`），
`extraTop = 底边 − 状态栏高度`，旋转/密度变化时 `remeasure()` 重算。
以前按 38dp 猜，在本机上 overlay 实际 y 比 status_bar 多出 97px，导致歌词条压住顶栏/返回键（竖屏截图可见）。

截图：`test/v106-7-平板列表.png`、`test/v106-8-平板播放页.png`、`test/v106-4-竖屏播放页.png`。


---

## 1.0.7（versionCode 8）— 顶部歌词条下线

**① 顶部那条「歌词条」整个去掉（用户："太丑了"）**
那条其实是原生悬浮窗（`TYPE_APPLICATION_OVERLAY`），贴在状态栏下面通栏一条灰带，
既压掉一条内容高度，又在深色界面里显出一块不搭的实底色。这一版直接把功能下线，不是"关掉开关"：

- `MusicBridgePlugin`：`topLyricShow` 一律不绘制并回 `shown:false`、`topLyricCanDraw` 回 `can:false`、
  `topLyricSet` 变成空操作、`show`/`hide` 都先 `TopLyric.hide()` 清掉残留窗口；`applyLyricTop()` 永久置 0。
  插件 `load()` 里启动就 `TopLyric.hide()` 兜底一次。
- `bridge.js`：`pushTopLyric` / `topLyricEnable` 全部改空实现，`setDesktopLyricMode` 永远回 `'off'` 并顺手调用
  `topLyricHide`；启动时把老配置里残留的 `settings.desktopLyric: 'taskbar'` 压成 `'off'`，不再请求悬浮窗权限。
- 顶部让位高度（`--mb-extra-top`）因此恒为 0：App 内容直接从状态栏下方开始，没有那条空白带。
  实测平板横屏 `extra=0px / #app paddingTop=59px`（只有状态栏），手机 `extra=0px / paddingTop=49px`。

**② 「词」按钮一并隐藏**
它唯一的作用就是开关那条歌词条，条没了按钮就是死键，所以 `#btn-desktop-lyric` 直接 `display:none`，
底栏右侧恢复成「队列 / 音量」两项（播放页里的 原文 / 翻译 / 逐字 歌词面板不受影响，仍可用）。

**验证**
- 平板（`wm size 3048x2032` + `wm density 320`）：列表页顶栏紧贴状态栏、无灰带；
  播放页底部按钮仍不重叠；`dumpsys window windows` 里已无本应用的 `APPLICATION_OVERLAY` 窗口（只剩 `MainActivity`）。
- 权限反向验证：`appops set ... SYSTEM_ALERT_WINDOW deny` 后功能照常，说明不再依赖悬浮窗权限。
- `mb.setDesktopLyricMode('taskbar')` 调用后仍然是 `desktopLyric='off'`、`--mb-extra-top=0px`。
- 手机尺寸（`wm size reset`，393×851）：布局无回归。
- 设置面板版本号显示「安卓 1.0.7」。

截图：`test/v107-1-平板列表.png`、`test/v107-2-平板播放页.png`、`test/v107-3-设置版本.png`、`test/v107-4-手机.png`。


---

## 1.0.8（versionCode 9）— 真机（小米平板 6S Pro）联调

设备实测参数（与模拟器差异要注意）：
- 串号 `473cafba`，Android 16 / API 36，物理分辨率 2032×3048（竖屏基准），density 400；
- 因此横屏 CSS 是 **1219×813、DPR 2.5**（不是之前按 `wm density 320` 假设的 1524×1016 / DPR 2）；
  ≥900px 的平板规则仍生效，但所有 clamp 值是按真实 vw 算的，比模拟器偏小一圈，视觉上没出问题。

**真机发现并修掉的问题：根页面残留一条导航历史，导致「回到根后还得多划一次才退出」**
现象：收藏/文件夹视图划一次 → 正确回到全部音乐，但此时 `navHistory` 还留着 1 条旧快照，
`__mbAtRoot()` 一直 false，于是再划一次只是把这条快照丢掉，第三下才退到桌面；
更糟的情况是历史里存的是「文件夹 A」，在根页面划返回会**又跳回文件夹 A**。

修法（`bridge.js` 的 `__mbBack` 第 6 步）：已经站在根页面（`appState()` 判断 view=music、
无收藏/文件夹/歌单/筛选/搜索/多选/电台多选）时，直接清空 `navHistory`/`navFuture` 再返回 `'exit'`，
不再 `navBack()` 跳回旧页面。真机复测：文件夹 → 划一次回根 → 再划一次直接退出，全程没有跳回。

**真机逐条验证（`adb` 直连，`input swipe` 从边缘划）**
- 播放页 → 划一次：只关播放页，`topResumedActivity` 仍是 `MainActivity`；
- 设置面板 → 划一次：只关面板；
- 收藏/文件夹视图 → 划一次：回全部音乐；
- 根页面 → 划一次：`back(gesture) -> "exit"`，退到桌面（真正的侧滑手势，不是 `keyevent`）；
- 播放页布局：播放键居中（794/1584）、底部一行不重叠、无顶部歌词条、`--mb-extra-top=0px`；
- 竖屏（813×1219）：两行控制布局，不重叠；
- 播放：`playAt(1)` 后 `audio.paused=false`、`currentTime` 递增、`MediaSession` 状态 `PLAYING`、
  通知栏 `channel=smx_playback` 标题跟随曲目；logcat 无 `FATAL`；
- 设置面板版本号显示「安卓 1.0.8」。

**顺带发现（未改动，等用户决定）**
曲库 1380 首里有 96 首是 `placeholder://qqmusic_…` 占位条目（没有本地文件，点了播不出），
侧栏显示「96 首缺失（占位）」。要清掉或默认隐藏的话说一声，我下一版处理。

截图：`test/d1-真机启动.png`、`test/d6-真机列表.png`、`test/d4-真机播放页.png`、`test/d5-真机竖屏.png`、`test/d2-侧滑后.png`。


---

## 1.0.9（versionCode 10）— 工具箱浮层返回、角落版本号、UI 精修

**① 工具箱点开的菜单侧滑回不去（真机反馈）**
根因：`appOverlayOpen()` 只认 `.modal / .theme-popover / .float-menu / .ctx-menu` 这几类，
工具箱的 `#batch-menu`（class 是 `.batch-menu`）根本没被登记，于是 `__mbBack` 判定"没有浮层"，
一路走到 `exit`——划一下就回桌面。修法：
- 新增 `POPUP_IDS` 白名单（设置 / 外观 / 工具箱 / 排序 / 歌词面板 / 播放队列 + 右键菜单家族 8 个）并补 `POPUP_SEL`（含 `.submenu`、`.menu-overlay`）；
- `closeAppOverlay()` 改成先调 app.js 自己的总闸 `closeAllFloatMenus()`（它本来就是互斥总闸），再补收 `queue-panel`(open class)、`lyrics-panel`、`settings-modal`、动态创建的歌单二级菜单（`playlistMenuEl`）与遮罩，最后 Esc 兜底。
真机复测：`#batch-menu` 打开时 `__mbAtRoot()` 为 false → 侧滑 `back(gesture) -> "handled"`、菜单收起、`topResumedActivity` 仍是 MainActivity、`atRoot` 回 true。

**② 角落版本号**
bridge 启动时往侧栏底部插 `#mb-corner-ver`（`position: sticky; bottom: 0`），文字「安卓 v1.0.9」，
11px、45% 透明、不挡点击；手机竖屏（≤700px，侧栏收起）自动隐藏。

**③ 列表页（歌单页）去掉「歌词」按钮与功能**
`#btn-lyrics` 与 `#lyrics-panel` 一起下线（CSS `display:none !important` + bridge 里 `aria-hidden`），
页脚右侧只剩「静音 + 音量」，音量条终于有位置加长。播放页里的 原文/翻译/逐字 保留（那是歌词主界面）。

**④ UI 精修（用户：按钮"傻大粗"）**，新增 `android.css` §25：
- 尺寸档整体收一档：`--touch-ctl` 42→36（平板 48→40）、图标 22→17（26→19）、播放键 50→44（60→50）；
  播放页 `.pf-ctl` 46~64 → 38~46，播放键 58~76 → 50~58，图标 28/34 → 20/24；
- 滑轨统一「4px 轨道 + 12px 拇指」：底栏进度条 5→4px、拇指 14→12px；底栏音量 5→4px、拇指 16→12px；
- 播放页音量条：长度 `clamp(200px, 24vw, 380px)`（竖屏 `clamp(240px, 52vw, 460px)`），
  粗细与页面里的进度条一致（4px），不再 6px/20px 拇指；
- 歌词工具栏按钮改成 28px 高圆角胶囊（原 32px 方块）；`.btn`（设置面板里的"检查更新/保存设置"）
  padding 收窄到 7×13、字号 12px；`.modal-close` 收成 26px 圆点。

**真机验证**
- 工具箱菜单 → 侧滑只收菜单，留在 App；根页面 → 侧滑 `exit` 回桌面；
- 横屏 1219×813：页脚只剩进度条与音量，音量条明显变长、变细；播放页音量条与进度条同为 4px；
- 竖屏 813×1219：两行布局，音量条 `52vw` 长，不重叠；
- 侧栏底部「安卓 v1.0.9」角标可见，设置面板里显示「安卓 1.0.9」。

截图：`test/e5-列表角标.png`、`test/e4-工具箱菜单.png`、`test/e7-精修播放页.png`、`test/e8-精修竖屏播放页.png`、`test/e6-设置面板.png`。

---

## 1.0.10 — 图标与电脑端统一

**改动**

- 图标不再是重新画的，直接复用桌面版原始素材
  `E:\AI相关\工作目录-个人\20261115-MusicSMX-重置版\build\icon.png`（1024×1024）：
  深蓝底（`#0C1F3D`）+ 橙色 S，与电脑端一模一样。
- 生成方式：先把原图按 22% 圆角做遮罩（原图四角是不透明的 `#1A1D26`，不裁掉会在
  launcher 上露出方角），再由这一张母版派生全部尺寸，保证各处图标完全同源：
  - `mipmap-{mdpi48,hdpi72,xhdpi96,xxhdpi144,xxxhdpi192}/ic_launcher.png`、`ic_launcher_round.png`
  - `mipmap-*/ic_launcher_foreground.png`（108dp 画布，logo 占 90% 居中留安全边）
  - `values/ic_launcher_background.xml` 由 `#FFFFFF` 改成 `#0C1F3D`
  - 11 个 `drawable*/splash.png` 重画为深蓝底 + 居中 logo（0.34×短边），启动画面不再突兀
- 版本号按惯例同步递增：`#mb-ver-chip`「安卓 1.0.10」、`mb.version = '1.0.10-android'`、
  `build.gradle` `versionCode 11 / versionName "1.0.10"`、侧栏角标「安卓 v1.0.10」。

**真机验证（小米平板 6S Pro `473cafba`）**

- 桌面 launcher 与 Dock 栏图标已是深蓝底橙色 S，与电脑端一致（`test/f1-桌面图标.png`、`test/f2-dock图标放大.jpg`）；
- 启动后侧栏左下角显示「安卓 v1.0.10」，曲库 1380 首与播放状态全部正常（`test/f3-启动后.png`）。

**包**

`MusicSMX-1.0.10-debug.apk`（6,009,316 B）

---

## 1.0.11 — 列表改「网易云」两行 + 版本号标 HD + 海报页音量条对齐

**改动**

1. **列表行改成两行（歌单页/全部音乐等所有列表）**
   原因：三列表格布局时，单击行的右侧空白很容易命中「歌手/专辑」单元格，
   一点专辑名就跳去筛选该专辑，想"点一下播这首"经常失败。
   现在：第一行是歌名（+缺失/音质徽标），第二行是 `歌手 · 专辑` 小字，
   缩在左侧，**右侧整块空出来都是该行自己的点击区**。
   - 网格：`30px | fit-content(150px) | 1fr`，两行；`t-index` 跨两行居中；
   - `t-title` 跨第 2~3 列（第一行），`t-artist` 第 2 列、`t-album` 第 3 列（第二行，
     都 `justify-self:start`，按内容宽度收缩，不再撑满）；
   - **行高仍然是 44px**：虚拟列表按 `ROW_H = 44`（app.js:1374）用固定 px 定位每行 top，
     改高会整体错行——这里只改内部排版，不动高度；
   - 表头 `#track-head` 从四列网格改成一行紧凑图例（`# 标题 歌手 专辑`，排序功能保留）。

2. **版本号标记「HD」，表示这是平板版本**
   - 侧栏角标：`安卓HD v1.0.11`（设置面板标题旁：`安卓HD 1.0.11`）；
   - `mb.version = '1.0.11-android'`、`build.gradle` `versionCode 12 / versionName "1.0.11"`。

3. **播放页（海报页）音量条长度对齐歌单页**
   - 从 `clamp(200px, 24vw, 380px)` 收到 `clamp(120px, 13vw, 190px)`，
     与页脚 `#volume` **完全同一个公式**；真机实测两者都是 158.5px；
   - 粗细仍为 4px（与播放页进度条一致），拇指 12px。

**真机验证（小米平板 6S Pro `473cafba`）**

- 横屏：列表每行两排文字，右侧空白可单击即播；播放页右侧音量条长度 158.5px = 页脚音量条；
- 竖屏 813×1219：两行布局正常，右侧同样留空；
- 角标显示「安卓HD v1.0.11」，设置面板显示「安卓HD 1.0.11」。

**包**

`MusicSMX-1.0.11-debug.apk`（6,010,328 B）
截图：`test/g1-两行列表.png`、`test/g2-两行-播放页.png`、`test/g3-竖屏两行.png`

---

## 1.0.12 — 列表左侧加缩略封面 + 页脚播放条改网易云式一排

**1. 列表每行最左边加专辑缩略封面**

三级取图（全部只留 96px 小图，不把原图塞进 WebView）：

- ① 已落盘的「专辑缩略图」：native `cache/thumbs/<md5(key)>.jpg`，key = `alb:歌手|专辑`，命中秒出；
- ② 文件内嵌封面：新增原生 `readThumb`（`MusicBridgePlugin`），解 ID3/FLAC/MP4 标签 →
  居中裁方 → 缩到 96px → JPEG(q78) 落盘（约 4KB/张），后台线程跑，不堵 UI；
- ③ 都没有才联网补（沿用 `S.settings.autoCover`），抓回来用 canvas 缩到 96px 再
  `saveThumb` 写回磁盘。**按「专辑」去重、并发压到 2**，一个专辑只抓一次，
  避免 1380 首把接口打爆；抓不到就留 ♪ 占位块。

实测这台机器的曲库几乎都是纯音频（抽样 24 首内嵌封面 0 首，只有个别 mp3 带图），
所以主要靠 ③ 联网按专辑补；已有的 25 张已落盘，重启后直接读盘。

**2. 页脚播放条改成网易云式一排**

原先是「按钮一行 + 进度条另起一行」上下两层；现在一排到底：

`[封面 + 歌名/歌手] [当前时间 —— 进度条 —— 总时长] [播放模式/上一首/播放/下一首/收藏/列表] [静音 + 音量]`

- `#player` 改三列 `240px | 1fr | 210px`，高 66px；
- `.controls` 内部改成两列网格：进度条占 1fr 列、按钮组靠右；去掉桌面上那个让播放键居中的隐形配重；
- 竖屏平板（700~900px）单独收窄：信息区 176px、音量区 158px、时间字号 9.5px。

**3. 版本号**：`安卓HD 1.0.12`（`versionCode 13`）

**真机验证（小米平板 6S Pro `473cafba`）**

- 横屏 1219×813：每行左封面 36px + 序号 + 两行文字；页脚一排，进度条横贯中段；
- 竖屏 813×1219：同样正常；重启后封面从磁盘缓存直接出图；
- 部分冷门专辑仍是 ♪ 占位（联网搜不到封面），不影响播放。

**包**

`MusicSMX-1.0.12-debug.apk`（6,074,930 B）
截图：`test/k1-横屏终态.png`、`test/k2-竖屏终态.png`、`test/h2-封面列.png`

---

## 1.0.13 — 歌单页缩略封面「加载速度」专项优化

**根因（不是接口慢，是我们自己把请求排成了队）**

`MusicBridgePlugin.httpFetch` 原来在**插件线程里同步**做阻塞式 `HttpURLConnection` 请求，
Capacitor 的插件方法是排队执行的 → 所有网络请求实际是**串行**。后果：

- `searchCoverFast` 号称「5 个源并发抢」，实际是一个源一个源排队跑，
  5 个源 25 个请求逐个过 → 单个专辑要等 6~8 秒，预算 3.2s 全部超时；
- 实测同一时刻发 5 首歌的快搜：第 1 首 1698ms 命中，其余 4 首全部 3200ms 超时；
- 于是「谁先发谁赢、后发的全超时」，冷启动 12 秒只出 5 张封面（可见 24 行）。

**改法**

1. **`httpFetch` 挪进独立线程**（`MusicBridgePlugin`）：请求在 `new Thread` 里跑，
   完成后 `call.resolve()`。这一改并发才真的并发——同样 5 首歌快搜，**总耗时 451ms、4/5 命中**。
2. **`online.js` 新增 `searchCoverFast(artist, title, budgetMs)`**：5 个封面源同轮并发竞速，
   谁先给出 `url/thumbUrl` 就用谁，不再让 iTunes 的超时独吞 6 秒（原来串行时它排第一）。
3. **只下小图**：直接用源给的 `thumbUrl`（200/300px），不再下 600~800 大图，
   canvas 居中裁方缩到 96px（约 4KB）再 `saveThumb` 落盘。
4. **落盘缓存 + 预取**：`cache/thumbs/<md5(专辑key)>.jpg` 命中直接出图；
   可见区之后 30 首涉及的专辑提前排队；行被扫到不足 2 次不排队（快速滑动不白花流量，
   停住后 350ms 补扫一次再取）。
5. **负缓存不再一票否决**：连失败 3 次才记「这专辑没封面」，7 天有效；
   单次网络抖动只算一次失败，下次照旧重试。
6. **诊断口**：`window.__coverSources`（各源单独测延迟）、
   `window.__thumbStats`（`ok / searchFail / dlFail / smallFail` + 最近 30 条失败 key）。

**实测（小米平板 6S Pro `473cafba`，清空 `cache/thumbs` 的冷启动）**

| 场景 | 1.0.12 | 1.0.13 |
|---|---|---|
| 冷启动 1.5s | 0~3 张 | 9 张 |
| 冷启动 4.5s | 5 张 | **22 张（可见 22 个专辑全出齐）** |
| 冷启动 12s | 5 张 | 22 张（另外后台预取了 47 张落盘） |
| 重开 App（有盘缓存） | 逐张补 | **进页面即 22 张** |

单专辑联网取图实测：搜索 500ms + 下小图 242ms。
冷启动整轮只失败 1 个专辑（`周杰伦|十一月的萧邦` 搜不到），其余全中。

**版本号**：`安卓HD 1.0.13`（`versionCode 14`），侧栏角标「安卓HD v1.0.13」。

**包**

`MusicSMX-1.0.13-debug.apk`（6,104,686 B）
截图：`test/m1-1.0.13-列表.png`

---

## 1.0.14 — 缩略图与页脚封面不一致 / 行内小按钮下线 / 海报页歌词放宽 + 沉浸全屏

**1. 「左下角有封面、列表里同一首却没图」**

两条封面链路本来就是各查各的：

- 页脚/海报页走 app.js 的老链路（按**单曲**联网搜，高潮是串行且有比较宽松的预算），
- 列表缩略图走 1.0.12 的专辑流水线（按**专辑**、2600ms 预算、失败还会进负缓存）。

所以一首歌可能在页脚出图、行里还是 ♪。修法三条：

- 行缩略图除了 `t.cover`、专辑磁盘缩略图，**再查 app.js 的 `S.coverCache`（path → dataUrl）**，
  这是页脚那张图最直接的来源；
- 拿到这张图时顺手 `downscale` 到 96px 当「本专辑缩略图」写盘，同一专辑的其他歌下次直接读盘；
- `scheduleThumbPass` 加了一条 2.5 秒的低频补扫：app.js 晚到的封面不会触发任何 DOM 变化，
  没有这条补扫行里就一直空着（实测补上后 24/24 行全部出图）。

**2. 歌单页每行右侧那 4 个隐藏小按钮去掉**
`.row-actions`（收藏 / 歌单 / 播放 / 下一首）整组 `display:none`。
平板是触屏，本来右侧空白就是「点这一行」的点击区，那 4 个按钮只会在滑动时被误触。
右下角那个「筛选/排序」浮动小圆钮属于全局功能，保留。

**3. 海报页歌词区域放大 + 三个开关上移**
- `.pf-lyrics-wrap` 原来的上限是 `clamp(420px, 44vw, 1100px)`，1219 宽下只有 536px，
  右边空一大片；改成 `max-width: none` 让它吃掉剩余宽度，实测从 **536px → 849px**；
- 左侧封面区 `max-width` 收到 40vw，不再抢宽度；
- 原文 / 翻译 / 逐字 三个开关整体再往上提 12px（`translateY(calc(-100% - 12px))`），
  和第一行歌词之间留出明显空隙。

**4. 海报页左下角新增全屏按钮（沉浸态）**
- 按钮插在 `.pf-controls` 第一列（`grid-column: 1`），不影响播放键的几何居中；34×34 圆角方块；
- 点一下进入 `#player-full.pf-immo`：顶栏返回键、歌名歌手、进度条、播放控制、音量、
  三个歌词开关全部收起，**只剩专辑封面 + 歌词**，封面放大到 `clamp(260px, 58vh, 640px)`、
  歌词区高度 `86vh`、歌词字号也放大一档（实测横屏封面 486px、歌词区 665×699）；
- 同步调用原生新方法 `setImmersiveBars(true)`，把系统状态栏和手势条一起隐藏
  （`WindowInsetsControllerCompat.hide(systemBars)`，上滑一次可临时浮出）；
- 退出方式三种：点左下角那颗键、侧滑返回（`__mbBack` 里先进「退沉浸」再进「关播放页」）、
  点歌词空白处；
- 竖屏（813×1219）沉浸态改「封面在上 420px、歌词在下」，修过一次横排导致的封面
  640px 宽把歌词挤出屏幕的问题。

**真机验证（小米平板 6S Pro `473cafba`，横屏 1219×813 / 竖屏 813×1219）**

- 列表：24/24 行出封面，行内 4 个按钮宽度 0（不可见也不可点）；
- 海报页常规：歌词区 849px（原 536px）、三个开关上移、左下角全屏键 34×34 在 (36,752)；
- 沉浸态横屏：系统栏隐藏，封面 486px + 歌词区 665×699，只有一颗退出键；
- 沉浸态竖屏（813×1219）：封面 420px 居中在上、歌词区 757×778 在下；
- 侧滑返回：第一下退沉浸（仍留在播放页）、第二下才关播放页，App 不退出；
- 版本号：`安卓HD 1.0.14`（`versionCode 15`），侧栏角标「安卓HD v1.0.14」。

**包**

`MusicSMX-1.0.14-debug.apk`（6,083,027 B）
截图：`test/n10-列表-1.0.14终态.png`、`test/n9-海报页-常规-1.0.14.png`、`test/n5-沉浸-稳态.png`、`test/n8-沉浸-竖屏-修后.png`

---

## 1.0.15 — 修正 1.0.14：歌词区还原、三个开关只在横屏上提、全屏键改纯线条

1.0.14 里我把「歌词范围大一些」理解成「把歌词区拉宽」（`max-width: none`，536px → 849px），
用户实际说的是横屏下的位置关系，改错了，这一版还原：

- **歌词区宽度还原**：`.pf-body` / `.pf-cover-col` / `.pf-lyrics-wrap` 的 1.0.14 覆盖全部撤掉，
  真机横屏实测回到 **536px（x=508）**，与 1.0.13 及之前一致；
- **三个开关只在横屏上提**：`@media (min-width: 900px) and (orientation: landscape)` 里
  `transform: translateY(calc(-100% - 22px))`（1.0.14 是 -12px），真机实测按钮区 top 从 176 → **131**，
  和第一行歌词之间空出约 40px；竖屏完全不动；
- **全屏键去掉底色**：`background: none`、`border: none`、`border-radius: 0`，
  图标从 17px 放大到 19px，平时 72% 白、按下/悬停变纯白 —— 就是一根简洁的线条图标，
  沉浸态里也不再垫那层浅色底；
- 沉浸态本身不受影响（封面 58vh、歌词区 86vh、系统栏隐藏、三种退出方式都照旧）。

**真机验证（横屏 1219×813）**

- 常规海报页：歌词区 536px、按钮 top=131、全屏键 `background-color: rgba(0,0,0,0)`、边框 0；
- 沉浸态：`player-full playing idle pf-immo`，歌词区 621×699，全屏键仍是透明线条；
- 版本号：`安卓HD 1.0.15`（`versionCode 16`），侧栏角标「安卓HD v1.0.15」。

**包**

`MusicSMX-1.0.15-debug.apk`（6,023,404 B）
截图：`test/n11-1.0.15-海报页.png`、`test/n12-1.0.15-沉浸.png`

---

## 1.0.16（2026-11-23）

用户这一轮提了三件事：海报页三个开关往上挪、桌面图标 S 太大、通知栏要有播放控制。

**1. 「原文 / 翻译 / 逐字」挪到歌词列正上方靠顶（横屏）**

- 用户圈的位置换算成 CSS 是 y≈54–84（横屏 1219×813），就在歌词列正上方、背键右侧。
- 第一次用 `transform: translateY(-105px)` 改的，真机量出来一点没动 —— 查 `document.styleSheets` 才发现 §25 有一条
  `.pf-lyrics-toolbar, .pf-lyrics-wrap .pf-lyrics-toolbar { … position: static !important; transform: none }`，
  `translateY` 被 `!important` 按死（1.0.15 那次「上提 22px」其实也没生效）。
- 最终改成负边距：`margin-top: -80px; margin-bottom: 80px`。牌面视觉上抬 80px，
  它在纵向流里的占位高度不变，所以**第一行歌词位置一点没动**（真机量：按钮 top 137 → **57**，歌词仍 171）。
- 只在 `@media (min-width: 900px) and (orientation: landscape)` 里生效，竖屏（813×1219）实测 margin 0、按钮 top=167，未被波及。

**2. 桌面图标重做（S 收小）**

- 参照歌单页左上角 `.logo-icon`：深底 `#1A1D26` + 橙字 `#FF6B3D` + 细白边 + 圆角 ≈23%。
- scripts：`test/gen-icons-1.0.16.ps1`（System.Drawing 生成，先把 "S" 渲染到透明画布再量像素边界裁切，避免字体框偏心）。
- 产出：`mipmap-*/ic_launcher.png`（48/72/96/144/192，S 高 ≈ 46% 牌高）、`ic_launcher_round.png`（圆形，S 44%）、
  `ic_launcher_foreground.png`（108dp 画布，只放 S，高 42dp 落在安全区内）、`values/ic_launcher_background.xml` 改 `#1A1D26`、
  11 张 `drawable*/splash.png` 重画（深底 + 居中小牌，体积从 ~1.1MB 降到几十 KB，包体因此小了一点）。
- 踩坑：PowerShell 变量大小写不敏感，`$BIG`（画布尺寸）和 `$big`（Bitmap）撞成同一个变量，第二轮改名 `$CV` / `$cvs` 才跑通。

**3. 通知栏（下拉后的播放卡片）：喜欢 / 上一首 / 暂停 / 下一首 + 专辑缩略图 + 歌名**

- 之前只是 `NotificationCompat` 普通通知（3 个 Action），HyperOS 不认，下拉里显示成一条小通知，播放卡片被别的 App 占着。
- 改成 **`android.app.Notification.MediaStyle`**（API 26+，框架自带，不用加 `androidx.media` 依赖），
  `setMediaSession(mediaSession.getSessionToken())` + `setShowActionsInCompactView(...)`，低版本(24/25)保留原 Compat 分支。
- 关键一步：HyperOS 卡片那排按钮是照 **MediaSession 的 PlaybackState** 画的，光加 Notification Action 只会露出「上一首/暂停/下一首」三颗。
  加了 `PlaybackState.CustomAction("smx_like")` + `MediaSession.Callback.onCustomAction` 之后，卡片左侧才多出那颗心（实测 4 个按钮齐了）。
- 封面 + 歌名：`setLargeIcon(cover)` + MediaMetadata TITLE/ARTIST，并补了 `METADATA_KEY_DURATION` —— 之前进度条一直是 `00:00 / 00:00`，补上后正常显示 `02:00 / 04:30`。
- 渲染层：`pushMediaState` 增加 `liked`，并在当前曲没有联网封面时回落到专辑缩略图；`__mbMediaAction` 新增 `like` 分支 → `toggleFavorite` → 60ms 后重推状态。
- 实测：点卡片上的心，`isFavorite(path)` 从 false → true，App 内页脚那颗心同步变红；上一首/暂停/下一首均为系统标准动作。

**真机验证（小米平板 6S Pro，横屏 1219×813 / DPR 2.5）**

- 海报页：按钮 top=57（橙框位置）、歌词 top=171（未变）、竖屏不受影响；
- 通知卡片：封面缩略图 + 歌名 + 歌手 + 进度条 + 心/上一首/暂停/下一首；
- 桌面图标：深色小牌 + 居中小 S。

**包**

`MusicSMX-1.0.16-debug.apk`（5,054,408 B）
截图：`test/m1-1.0.16-海报页.png`、`test/mA-喜欢后.png`、`test/mB-dock.jpg`、`test/mC-竖屏海报.png`

---

## 1.0.17（2026-11-24）

**1. 点歌手 / 专辑格子＝播放这首，不再跳筛选**

- `installListClicks` 里原来那条「点歌手/专辑 → `toggleTrackFilter` 跳筛选」的分支删掉了，改成和点整行一样直接 `playAt(idx)`。
- 但只删不行：`app.js` 里 `.t-album` 自己挂了 click → `toggleTrackFilter`，`.t-artist` 挂的是 **dblclick** → `toggleTrackFilter`（app.js 不能改）。
  所以在我们这个**捕获阶段**监听里补 `stopPropagation()`，事件到不了行内那两个监听；再给 `track-list` 加一个捕获阶段的 `dblclick` 拦截，双击也不会跳页。
- 双击会被拆成两次 click，加 400ms 内同一行去重，避免「点一下就开始、第二下又暂停」自打架。
- 实测：点 `.t-artist` → `S.current` 22→1 正常播放；点 `.t-album` → 1→4 播放，列表条数不变、无筛选标签。

**2. 去掉列表顶上的「# 标题 歌手 专辑」**

- `#track-head` 整行 `display:none !important`（§29.1）。只留文字会变成一条空灰条，所以整行收掉；排序仍可用侧栏「排序」菜单。

**3. 通知卡片那颗心 ↔ 软件内收藏联动**

- 双向都通：通知卡片点「喜欢」→ `__mbMediaAction('like')` → `toggleFavorite` → 立刻重推状态；App 内点页脚的心 → 现在把 `window.toggleFavorite` 包了一层，60ms 内 `syncFavBtn()` + `pushMediaState(true)`，不用等 1.5s/3s 轮询。
- 卡片的图标会跟着变：**未收藏 = 空心、已收藏 = 实心**（HyperOS 会把图标染成白色，橙色染不过去，但实心/空心是对的）。实测截图 `test/x1-heart-before.png`（空心）→ `test/x3-heart-liked.png`（实心）；再点一次 → `isFavorite` 回到 false。

**真机验证**

- 列表页：表头消失、曲库 1380 首、角落「安卓HD v1.0.17」；
- 通知卡片：实心/空心随收藏切换。

**包**

`MusicSMX-1.0.17-debug.apk`（4,782,586 B）
截图：`test/n1-1.0.17-列表.png`、`test/n2-1.0.17-卡片已喜欢.jpg`、`test/x1-heart-before-crop.jpg`、`test/x3-crop.jpg`

---

## 1.0.18（2026-11-24）

用户两个反馈：①桌面图标看着没变；②打上花火的缩略图还是空的。

**1. 桌面图标：S 再收一档 + 换资源名绕过小米桌面缓存**

- 图标 S 比例：普通图标 46% → **36%**，圆形图标 44% → **36%**，自适应前景 42/108 → **31%**。
- 排查发现真机桌面上显示的还是**上一版**的图标比例（量下来 S/牌高 ≈ 46%），说明小米桌面把图标缓存住了：
  `pm disable`（SecurityException 不允许 shell 改）、`am broadcast PACKAGE_CHANGED`（被拦）都不通。
- 最终解法：**换一套新资源名**（`ic_launcher_v18` / `ic_launcher_v18_round` / `ic_launcher_foreground_v18` + 两个 `mipmap-anydpi-v26` 的 adaptive xml），
  Manifest 里 `android:icon` / `android:roundIcon` 指到新名字 —— 资源 ID 变了，桌面必须重新取图，缓存自然失效。
- 真机验证：点 Dock 里那个 S 打开的就是本 App（`mCurrentFocusedWindow = cn.sunmanxu.musicsmx`），S/牌高实测 ≈ **27–31%**（旧版是 46%）。

**2. 缩略图：打上花火那张「假黑胶」**

- 根因有两层：
  a) 有些源（酷狗/酷我）搜不到专辑时返回一张通用「黑胶唱片」占位图，我们把它当封面缩到 96px 存了盘；
  b) 行先把「专辑缩略图」画好了，后来 app.js 按单曲抓到的 **真封面** 到了也不重画（`paintThumb` 直接 return）。
- 修法：
  a) `albumKeyOf` 命名空间加版本前缀（`albv18:`），老的一批错误缩略图自然作废、重新抓；
  b) 新增 `looksLikeDefaultCover()`：缩到 32×32 判断「近白像素 > 12% 且中心亮度 < 110」——黑胶占位图实测 whiteFrac 0.20 / center 64，
     真封面 whiteFrac ≈ 0.01 / center ≈ 160。命中就换「精搜」（`searchCover`，走网易云）再抓一次，精搜也是占位图才认。
  c) 行内封面改成「**单曲真封面优先，后到也覆盖**」（`paintThumb(row, url, true)`），不再被旧的专辑缩略图锁死。
- 实测（1.0.18 首启 12 秒）：`__thumbStats = { ok: 50, searchFail: 1, defaultImg: 6 }`，6 张黑胶占位图全部被替换；
  列表里 **打上花火** 显示真封面、**又三郎** 也从黑胶换成了正确插画。

**真机验证**

- 版本号：`安卓HD v1.0.18`；
- 首个可见页面 7 行缩略图全部有图且正确。

**包**

`MusicSMX-1.0.18-debug.apk`（5,026,759 B）
截图：`test/s1-list-1.0.18.png`、`test/s4-icon-zoom.jpg`

---

## 1.0.19（2026-11-24）

用户反馈：**点一首歌之后，左下角的缩略图要等一秒才出来**。

**根因**

- `app.js` 的 `updateNowPlaying()` 只认 `track.cover` 字段；点歌时这个字段还是空的，于是先画一个渐变底 + ♪ 占位，
- 真封面要等 `fetchAndApplyCover()` 走完 `mb.fetchCover()`（联网）或读本地封面文件才赋值，`applyCover()` 再重画一次 —— 那 1 秒就是这段网络往返。
- 可列表那边其实早就把这首歌的专辑缩略图（96px，存在 `cache/thumbs`）抓好并画在行里了，白白浪费了。

**改法**（只动 `www/native/bridge.js`，`app.js` 一行没碰）

1. `knownCoverFor(t)` 按「单曲封面 → `S.coverCache` → `THUMB.mem` 专辑图 → 行里已画的那张」挑一张现成的；
2. `paintFooterCover()` 把这张直接贴进 `#cover`（打 `data-mb-fast=1` 标记）；`app.js` 的真封面晚到时会自己清空重画（`applyCover` 里 `textContent=''`），高分辨率照样覆盖上来；
3. 挂接点：包装 `window.updateNowPlaying`（切歌/上一首/下一首/通知栏控制全走它）+ 对 `#cover` 的 `MutationObserver` 兜底（任何路径画成占位都补一张）；
4. 连「连专辑图都还没有」的歌也不干等：`primeFooterThumb()` 把当前专辑插到缩略图队列最前面（不排队尾），通常几百毫秒内就有图，再被真封面替换。

**真机实测**（CDP 打点，`test/probe-footer.js`、`test/probe-footer2.js`）

- 点一首封面从未抓过的歌（idx 1「A Rusty Dream」）：`0ms` 就有图（`mb-fast=1`），约 240ms 后换成 600px 真封面；
- 点可见行里已有缩略图的歌（idx 4「雲を抜け風下へ私だけ」）：立即出图，230ms 精度升级；
- 之前同样的操作是「先渐变 ♪ 占位 ≈1s」。

`MusicSMX-1.0.19-debug.apk`；截图 `test/t1-1.0.19-列表.png`、`test/t1-footer-crop.jpg`

---

## 1.0.20（2026-11-24）

用户两件事：①把 `MusicSMX-icon-1024.png` 设为软件 logo；②《发如雪》这类歌抓不到专辑封面，希望多接几个源。

**1. 新 logo（桌面图标 / 启动图 / 应用内左上角）**

- 图标按「深底 `#1A1D26` 牌 + 橙色 S、S 约占牌高 46%」重做，S 是从用户给的 1024 PNG 里**抠出来的原字形**
  （背景是深蓝渐变、S 是橙，按 `R-B` 算软 alpha 抠图，渐变和细节都保留），不是重画。
- 生成：5 套 density 的 `ic_launcher_v20` / `ic_launcher_v20_round` / `ic_launcher_foreground_v20`（自适应前景只放 S，底色走 `@color/ic_launcher_background`），
  11 张启动图（深底 + 居中圆角牌 + S），应用内 `www/native/logo.png`（左上角 `.logo-icon` 由文字 S 换成图片），Manifest 指向 `ic_launcher_v20`。
- **踩坑**：一版直接把整张 1024 铺满自适应画布 → 系统遮罩把外圈裁掉，S 贴边「傻大」；一版缩到 58% → 出现牌中牌的双边框；
  最终走「只放 S + 纯色底」最干净。另 PowerShell 里 `$Src` 和 `$src` 大小写不敏感撞变量，导致像素循环读出乱码（图标一度变成几条橙色横条），
  改用 Pillow（`test/gen-icons-pil.py`）生成，一次过。
- 真机：Dock 图标已是新的渐变 S 牌，点开仍是本 App。

**2. 封面多源（发如雪这种）**

- 先查根因：三个旧源（iTunes / 网易云单曲 / 酷我单曲）对周杰伦全部落空，**QQ 和酷狗其实能拿到**封面；
  真正卡住的是**负缓存**——之前 3 次失败就把一张专辑封了 **7 天**，行里再也不会重试。
- 改动：
  1. **负面缓存**：存储键换 `mb_thumb_neg_v2`（老毒记录直接作废），有效期 7 天 → **12 小时**；
  2. **修好酷我单曲源**：它返回的是 Python 风格单引号 JSON（还夹 `None/True`），原来 `JSON.parse` 一直失败、这个源其实从没工作过 —— 加 `looseJsonParse()` 容错解析；
  3. **新增三个源**：**网易云专辑搜索**（`type=10`，单曲没版权时专辑库里还有）、**酷我专辑搜索**（`ft=album`，240px 图替换成 500px）、**360 图片兜底**（最后一档，要求标题含专辑/歌名 + ≥400px + 长宽比接近方形，宁缺勿滥）；
  4. 专辑级源需要专辑名：`fetchCover` 会先在本地曲库按「歌手+歌名」反查专辑再交给搜索，缩略图流水线也把 `album` 一起带下去。
- **顺手加了手动兜底**：**长按左下角封面 0.65s** = 重抓当前这首（清负缓存 + 清封面缓存 + 重新走一遍流程），以后遇到个别怪歌不用等 12 小时。
- 实测《发如雪》（周杰伦 / 十一月的萧邦，`.ogg`）：命中的是「酷我专辑」，`searchCoverFast` 3.2s 内返回，列表行与左下角都已显示正确封面；
  重装重启后仍在（磁盘缩略图已落盘）。

`MusicSMX-1.0.20-debug.apk`；截图 `test/u7-1.0.20-列表.png`、`test/u6-icon-zoom.jpg`

---

## 1.0.21（2026-11-25）

用户需求：设置里的「检查更新」别只弹"即将上线"，要能真的去 GitHub 看有没有新版本，然后下载、安装。

**做了什么**

- 设置面板底部那颗「检查更新」变成一套完整流程（`www/native/bridge.js` 里新增 `updateCenter`，`app.js` 一行没动）：
  1. 点一下 → 查 `api.github.com/repos/sunmanxu/MusicSMX-Android-HD/releases/latest`，按语义化版本号比较，
     状态行显示「发现新版本 vX.Y.Z（当前 …，安装包 4.8 MB）」或「已是最新版本」；
  2. 有新版时按钮自己变成「下载并安装」，下载时 4px 进度条 + 「下载中 42%（2.1 / 4.8 MB）」；
  3. 下载完先验「是不是本应用 / 签名是否一致」，都过了才交给系统安装器；不一致就明说，不进安装器白挨一句"未安装"；
  4. 没开「安装未知应用」时自动跳系统开关页，回来后按钮仍停在「继续安装」，点一下直接装。
- 原生侧新增 `Updater`（`android/.../Updater.java`）+ 插件方法 `updateCheck` / `updateDownload` / `updateInstall` /
  `updateOpenUninstall` / `updateOpenPage`；下载流式写到 `cache/updates/`，每 2% 通过 `__updateProgress` 事件推给网页；
  安装用已有的 FileProvider（`<包名>.fileprovider`，`file_paths.xml` 的 `cache-path "."` 已覆盖），只多一条 `REQUEST_INSTALL_PACKAGES` 权限。
- 版本号三处同步：`build.gradle` 22 / 1.0.21、设置里 chip「安卓HD 1.0.21」、`bridge.js` 的 `version: '1.0.21-android'`。

**发布口径随之改了（重要）**

- 之前 CI 推 tag 就自动发 Release，但 runner 的 debug 签名是**每次临时生成**的，和真机上装的本机签名不同 →
  应用内更新下下来的包装不上去。所以 1.0.21 起 **CI 只编译验证、只留 workflow artifact**，
  Release 的 APK 一律由本机签名后上传：`pwsh -File scripts\publish-release.ps1`。
- 1.0.20 那个 CI 资产同理：真机上点更新会命中「签名不一致」分支，属正常提示（要么卸载重装、要么走网页）。

**实测记录**

- `checkUpdate` 走真机 CDP：`{"tag":"android-v1.0.20","assets":[["MusicSMX-1.0.20-debug.apk",4999988]]}`，`api.github.com` 2~3.5s 返回；
  资产下载 302 到 `release-assets.githubusercontent.com`，Range 请求 206 正常 —— 下载链路通。
- UI：点按钮 → 状态行立刻变"正在查…"，失败时正确落到红字提示，按钮回「检查更新」，不会卡在「检查中…」。
- 安装：把 APK 塞进 `cache/updates/` 直接调 `mb.installUpdate` → `{"ok":true,"launched":true}`，系统安装器正常调起。
- 顺带发现一个**系统层坑**：重装后 MIUI 的「联网控制」把本应用的网络全拦了
  （`run-as cn.sunmanxu.musicsmx ping 20.205.243.168` → `sendmsg: Operation not permitted`，DNS 也解析不了），
  表现就是状态行红字「Unable to resolve host "api.github.com"」。这不是代码问题，要在
  手机管家 → 网络助手 → 联网控制 里把 MusicSMX 的 WLAN/数据打开。

`MusicSMX-1.0.21-debug.apk`（5,011,856 B）

**端到端实测（真机，1.0.21 装好后）**

- 为了能测「旧版 → 新版」，临时打了个 versionCode 21 / versionName 1.0.20 的测试包（代码就是 1.0.21，只是版本号报旧值），
  装上后点「检查更新」：`发现新版本 v1.0.21（当前 1.0.20，安装包 4.8 MB）`（1.5s 内出结果）；
- 再点一下：`下载中 43%（2.1 MB / 4.8 MB）` → 约 6 秒下完 → 签名校验通过（没走「签名不一致」分支）→ 系统安装器弹出
  `版本：1.0.20 -> 1.0.21`、`安装来源：MusicSMX`；
- MIUI 安装器三道拦：`正尝试安装应用` →`未查询到此应用 ICP 备案信息` → `未经小米安全审核（勾选已了解）`，
  点完「继续更新」后 `dumpsys package` 里 versionName 变成 **1.0.21** —— 全链路真的装上了；
- 收尾：重启 App，chip `安卓HD 1.0.21`、角标 `v1.0.21`，再点检查 → `已是最新版本（1.0.21，GitHub 上最新是 v1.0.21）`。
  截图 `test/v1-1.0.21-设置检查更新.png`。
- 版本号在测试期间改回 21/1.0.20，测完已还原成 22/1.0.21 并重新出包（5,011,856 B，与 Release 上的资产一致）。

## 1.0.22（2026-11-25）

用户反馈：列表里有些歌的专辑缩略图不会自己加载，必须点一下播放才刷新。同时定下两条发布纪律（见文末「发布规则」）。

**根因（不止一个，是五条叠在一起）**

1. `runThumbJob` 一次失败就把专辑塞进 `THUMB.dead`，本次运行永不再试 —— 只能等用户点播放，让 `app.js` 自己那条按「单曲」走的封面链路补上。这正是用户描述的「点了才刷新」。
2. `runThumbJob` 没有超时。`mb.readThumb` / `httpFetch` 任一步挂住 → `inflight` 不归还 → `pumpThumbs` 卡在并发上限不再派活 → 整屏缩略图集体停摆。
3. 负缓存 `mb_thumb_neg_v2`（12 小时、失败 ≥3 次）里囤着上一版留下的毒记录，升级后照样跳过。
4. **酷我图床的证书链在这台设备上和 PC 上都握手失败**（`img1~4.sycdn.kuwo.cn` 的 https 一律 SSL error，同一张图走 http 是 200）。快枪搜索经常先命中酷我，于是每次都在下载这一步挂掉 —— 实测 `dlFail` 占三成以上，全挂在这几个域名。
5. `prefetchAhead` 一次预取「可见区之后 30 首、队列上限 60」，滚动时把队列灌满，可见区那几十行反而排在预取后面等着 —— 表现就是「滚下去一片 ♪，等半天才出图」。

**做了什么（只改 `www/native/bridge.js` 和 `www/native/online.js`，`app.js` 一行没动）**

- 失败改成**退避重试**：最多 3 次，12s / 24s 两轮，第 2 次起走精搜（`searchCover` 的多源多变体）；3 次都空才进 `dead` + 负缓存。
- `runThumbJob` 加 22 秒**看门狗**：超时就当失败、归还 `inflight`，不会再让整个列表停摆。
- 负缓存键换 `mb_thumb_neg_v3`、窗口 6 小时 —— 旧毒记录整体作废；冷却期内 `syncRowCover` / `prefetchAhead` 都不再抢排队。
- 酷我 https 下载失败时**自动降级 http 重试一次**（`downloadCover`）。`dlFail` 从 30%+ 直接归零。
- **可见行优先**：行任务 `unshift` 到队头，预取任务排队尾；预取改成「用户停手 900ms 以上、队列里没活、只预 8 首、队列上限 10」。
- 并发 `THUMB.max` 4 → 8（下载不再空转后可以放开）。
- **揪假封面（1.0.18 白底判据的补强）**：源站搜不到封面会给一张通用唱片图，酷狗/酷我/网易云给的往往是同一张，且有的 `whiteFrac=0`、中心亮度 13，白底判据抓不住。新增「同一张缩略图出现在第二张不同专辑上 → 判为通用占位图」的指纹判据：这种图**先当弱图顶上行**（不落盘、标记 `THUMB.weak`），后台继续退避找真封面，找到后 `forceRepaintKey` 整块换掉。
- 新增兜底：某专辑试满 3 次仍无图时，顺带替它跑一次 `app.js` 的 `fetchAndApplyCover`（点播放走的就是这条路），拿到图会经 `S.coverCache` 回贴到行上 —— 等于「不点播放也能补图」。
- `THUMB_STATS` 增加 `genericImg` / `timeout` / `drop` 计数，方便真机上直接看卡在哪一步。

**真机实测（小米平板 6S Pro，全程不点歌、不播放；每轮先 `run-as rm -rf cache/thumbs` 清成冷缓存）**

- 冷启动首屏：21s 内 **25/25 行全部自动出图**（改之前是「一屏 ♪，点了才刷」）。
- 逐屏下滚（0 → 15% → 35% → 55% → 75%）：停 20s 的实时读数约 **20~30 / 33**，再等一到两轮退避（12s/24s）后补齐到 **33/33**；最慢的一屏约 1 分钟全满，全程没有点过任何一首歌。
- 滚动时不再出现「一片 ♪ 等半天」：任务按可见行优先派发，预取不再抢队。
- 假封面：改前截图里成片出现的「黑胶唱片图」（`Everything I Need` / `Call Me Maybe` / `Julien` / `Girls Like You` 同一张）已被识别为通用图并替换成真封面；见 `test/w3-1.0.22-弱图顶位.png`。
- 统计（一轮冷缓存滚屏）：`ok 843 / searchFail 235 / defaultImg 175 / genericImg 165 / dlFail 0 / timeout 0 / drop 275`。`drop` 里混着确实无封面源的专辑，这部分仍显示 ♪（宁可空着，也不贴假图）。

`MusicSMX-1.0.22-debug.apk`（versionCode 23 / 5,053,486 B）

**发布规则（2026-11-25 用户明确要求，写死在这里）**

- **只有用户明确说「更新到 GitHub」才允许推送 / 打 tag / 发 Release**；平时只在本机构建、本机装机自测，不碰远端。
- **每次发到 GitHub 必须写明这一版更新了什么**：`scripts/publish-release.ps1` 现在默认只打印预览（不发请求），加 `-Publish` 才真的发；
  发布说明自动从本 README 里抽「`## <版本号>`」那一整段，找不到这一段就报错停下（逼着每次写清改动）。
- CI（`.github/workflows/android-release.yml`）仍然只编译验证、只留 workflow artifact，不自动发 Release —— 签名必须本机。

## 1.0.23（2026-11-25）

用户要求：工具按钮里「自动修复」和「批量下载」合成一个，点自动修复的时候顺带把专辑封面和歌词也缓存下来。

**做了什么（仍然只改 `www/native/bridge.js`，`app.js` 一行没动）**

- 工具菜单里删掉「批量下载」那一项，「自动修复」改名为「自动修复 + 缓存封面歌词」，
  说明改成「联网校验/修复歌曲信息，修完接着把专辑封面和歌词缓存到本地（已缓存的自动跳过）」。菜单现在 5 项：
  自动修复 + 缓存封面歌词 / 批量转格式 / 导出缺失歌曲名单 / 检查重复歌曲 / 音乐库合并。
- 串联方式（`installToolboxMerge`）：`autoFixAll`（app.js 的全局函数）包一层，修完自动接着调 `startBatchDownload`；
  同时钩住 `showConfirm`：`startBatchDownload` 自己那次「批量下载」确认直接放过（用户刚在「自动修复确认」里点过确定，
  不该连弹两次）；反过来，如果用户在「自动修复确认」里点了取消，就不再往下走缓存 —— 不绕过他本人的确认。
- 两段进度条复用现成的：先 `autofix-bar`（已修复/无需/失败），再 `batchdl-bar`（封面/歌词/失败），不用重画 UI。
- 版本号三处同步：`build.gradle` 24 / 1.0.23、设置 chip「安卓HD 1.0.23」、`bridge.js` 的 `version: '1.0.23-android'`。

**真机实测（小米平板 6S Pro）**

- 菜单项核对：`['auto-fix 自动修复 + 缓存封面歌词','batch-mp3','export-missing','check-dupes','merge-libraries']`，
  `批量下载` 已不在列表里；见 `test/t1-1.0.23-工具箱合并.png`。
- 接线验证（不动任何音乐文件，`test/probe-toolbox-merge.js`）：
  ① 取消路径 —— 确认框返回 false 时 `batchDownloadCalls = 0`（不会偷偷下载）；
  ② 成功路径 —— 确认后 `batchDownloadCalls = 1`（真的接力去缓存）。
- 缓存能力（这条链路依赖的原生方法，真机逐项验证，以「王靖雯 - 不知所措」为例）：
  `mb.fetchCover` → 真封面 42,703 B；`mb.saveCover` → ok；`mb.fetchLyrics` → 1,238 字 LRC；`mb.saveLyrics` → ok。
  `S.settings.saveCover / saveLyrics` 都是 true，缓存会真的落盘。

`MusicSMX-1.0.23-debug.apk`（versionCode 24 / 5,016,748 B）

**发布规则（沿用 1.0.22 定下的口径，别忘）**

- **只有用户明确说「更新到 GitHub」才推送 / 打 tag / 发 Release**；平时只在本机构建、本机装机自测。
- **每次发到 GitHub 必须写明这一版更新了什么**：`scripts\publish-release.ps1` 默认只打印预览，加 `-Publish` 才真的发，
  发布说明自动从本 README 抽「`## <版本号>`」段，抽不到就报错。

## 1.0.24（2026-11-25）

用户问：自动修复会不会把「已经有缩略图和歌词」的歌再修一遍？那样太费时间。

**查出来的结论：会，而且是双重浪费**

1. `app.js` 的 `autoFixAll` 只跳过三种歌：**占位缺失**、**已锁定**、**已修复过（`S.settings.fixedTracks`）**。
   「有没有缩略图 / 歌词」它根本不看 —— 那本来也不是它的判断依据。
2. 真正的坑：**「查完发现信息本来就对」的歌一条记录都不留**（只有 `fixedTracks` 才被记住）。
   于是每点一次自动修复，这批歌都要重新联网搜一遍。真机实测 331 ms/首，1373 首 ≈ **8 分钟**，而且是**每次都重来**。
3. 缓存那段同理：`startBatchDownload` 跳过靠的是 `S.coverCache`（内存，重启就空）和 `S.localCoverFiles`（启动时扫盘），
   而 `saveCover / saveLyrics` 存完不会往这两个表里补 —— 同一次运行里再点一次，会把刚下过的歌又下一遍。
   当前实测可跳过：封面只有 148/1373、歌词只有 32/1373。

**做了什么（仍然只改 `www/native/bridge.js`）**

- **自动修复本地记忆**：在 `mb.autoFixTrack` 前加一层记忆（`localStorage` 键 `mb_autofix_memo_v1`，按「歌手|歌名|专辑|时长」做指纹）：
  - 核对通过（`titleOk && artistOk && albumOk`）→ 记 30 天，期内**零网络**直接返回「无需修复」；
  - 一条都没搜到 → 只记 7 天（可能只是当时网络抖了），过期后自动再试；
  - 需要修复的**不记忆**（正常走修复 + 写标签 + `fixedTracks`），信息被手动改过后指纹变了，也会重新核对。
  - 记忆按 20 首 / 3 秒批量落盘，不是一首一写（1380 首全量序列化会把主线程拖住）。
- **缓存表补记**：`mb.saveCover` / `mb.saveLyrics` 成功后就往 `S.localCoverFiles` / `S.localLyricsFiles` 补 key（key 规则与 `app.js` 的 `safeKey` 完全一致）—— 同一次运行里再点一次，刚下过的会跳过。
- **循环里的干等压掉**：两段循环每首都固定 `setTimeout(200)`（app.js 为了不打断音频）。修复/缓存期间把 `200ms` 这一档压到 `30ms`，
  跑完立刻还原（只动这一档，其它定时器不受影响）。
- 版本号三处同步：`build.gradle` 25 / 1.0.24、设置 chip「安卓HD 1.0.24」、`bridge.js` 的 `version: '1.0.24-android'`。

**真机实测（小米平板 6S Pro，1478 首曲库 / 98 首占位）**

- 记忆生效：同一批 12 首第一次 12 次网络请求耗时 **4.4 s**，第二次 **0 ms / 12 次全命中**；重启 App 后记忆仍在（`memoSize=12`，命中 24）。
- 单首网络核对成本：40 首实测 **331 ms/首**（其中 3 首需修复、25 首本来就是对、12 首没搜到）。
- 本次点一次会处理多少（`test/probe-merge-cost.js` 实测，不含网络开销的纯统计）：
  自动修复 → 跳过占位 98 / 锁定 0 / 已修复 7，**需联网核对 1373**；
  缓存封面 → 可跳过 148，需下载 1225；缓存歌词 → 可跳过 32，需下载 1341。
- 换算：首次全库约 **8 分钟（修复）+ 20~30 分钟（缓存）**；**第二次起修复只剩 1373×30ms ≈ 40 秒且零网络**，
  缓存只补新歌（已落盘的按文件跳过）。

`MusicSMX-1.0.24-debug.apk`（versionCode 25 / 5,064,063 B）

## 1.0.25（2026-11-25）

用户观察：杀掉进程再打开播放器、翻动歌单的时候，机器上能看到在下载资源 —— 怀疑冷启动会把专辑封面重新下一遍。

**先取证，再下结论**

1. 冷启动后**不动**：`cache/thumbs` 磁盘已有 1181 个文件（5.0M），随机 25 个专辑 key 调 `mb.readThumb('',96,key)` **25/25 命中**；
2. 全库归集：**1297 个不同专辑，1108 个有磁盘缩略图、189 个没有**；
3. 逐屏下滚 6 个位置各停 15s：每屏 ready 约 28~33/33，网络下载（`__thumbStats.ok`）**累计只增 114 次**。

所以不是「整库重下一遍」，磁盘命中率约 85%。但确实有两层重复，冷启动必复发：

- **通用占位图指纹只在内存里**（`THUMB.fp`）。冷启动后第一张撞上通用唱片图（酷狗/酷我/网易云都塞同一张）的专辑会被当成"真封面"落盘，且别的专辑还得重新联网才能再认出它是通用图 → 每次启动抢到它的专辑可能不同，磁盘里混进假封面。
- **弱图不落盘**（1.0.22 的设计），`THUMB.mem` 冷启动又为空 → 那批"只有占位图/搜不到封面"的专辑**每次启动都要重新联网搜一遍**，搜到的还是同一张占位图。只有连败 3 次才写 `mb_thumb_neg_v3`（6h），过期后又来一轮。

**1.0.25 改法（仍只动 `www/native/bridge.js`）**

1. 通用图指纹落 `localStorage` 键 `mb_generic_fp_v1`（最多留 500 条，3 秒批量落盘）。冷启动 `loadGenericFps()` 先把它们灌回 `THUMB.fp`（值记为 `''`），**第一次见到就直接判弱**，不再等第二张专辑来撞，也不会被当强图落盘。
2. 弱图**也落盘**了，独立键 `<专辑key>|weak`（`thumbKey` 走 MD5，含 `|` 安全），并记 `localStorage` 键 `mb_thumb_weak_v1`（key → 时间戳，TTL 72h，超 1200 条按时间戳砍一半）。
3. `runThumbJob` 开头先看弱图记忆：命中就读盘 `<key>|weak` → 标 `THUMB.weak` → `done(url)`，`job.fromWeakMemo=true` 让本次**不再排 12s/24s 退避重试**（否则等于白记）。读不到（文件被系统清了）就清记忆、走原来的网络/文件流程。
4. 拿到真封面时顺手清掉弱图记忆，下次不用再查。
5. `THUMB_STATS` 加 `weakMemoHit`，另挂调试钩子 `window.__mbThumbState()`（weak/mem/fails/fp 计数）。

**实测（真机 小米平板 6S Pro，曲库 1478 首 / 1297 专辑）**

| 场景 | 结果 |
| --- | --- |
| 冷启动后整库从头扫到尾（24 屏 × 3s + 静置 20s，全程不点歌） | `searchCover` **4 次**、`downloadCover` **0 次**、歌词请求 **0 次**；`readThumb` 1635 次（全是本地磁盘） |
| 同上，第二次（另一次冷启动） | `ok` **0** 次网络下载，弱图记忆命中 2 次 |
| 磁盘缩略图 | 从 1181 涨到 1379 个（1.0.22~1.0.24 几轮测试自然补齐） |

结论：**磁盘有图就不联网，一张都不重下**；真正会重复联网的只剩"源站确实没有封面"的那一小批，1.0.25 之后它们 72 小时内也不会再去搜。

## 1.0.26（2026-11-25）

两件事：① 去掉缺失歌曲名上的删除线；② 给「抓不到封面」的专辑补更多下载源。

**① 缺失歌名的横线**

桌面版 `style.css` 里给 `.track-row.placeholder .t-title .txt` 加了 `text-decoration: line-through`（表示"文件缺失"）。
在 `android.css` 里覆盖成 `none` —— 安卓侧覆盖，桌面版下次同步 `style.css` 也不会把它带回来。

**② 更多封面源**

先查清旧链路到底坏在哪（2026-11-25 逐条实测）：

- `songsearch.kugou.com/song_search_v2` → 一律 `total=0`，等于酷狗单曲源**从来没出过结果**；
- `www.kugou.com/yy/html/api/album?album_id=` → 返回 `Access Deny !!!`；
- `imge.kugou.com/stdmusic/600/<FileHash>.jpg` → 不是封面地址（那个 hash 是音频的）；
- `musicbrainz.org` + `coverartarchive.org` → 503（限流），且中文流行命中率低，不做；
- 豆瓣 `douban.com/j/search` → 403。

换上的新源（都在 200ms 内返回，明文接口，设备可用）：

| 源 | 接口 | 拿图方式 |
| --- | --- | --- |
| 酷狗专辑（新） | `mobilecdn.kugou.com/api/v3/search/album` | 返回里的 `imgurl`，把 `{size}` 换成 400 |
| QQ 专辑（新） | `c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=` | album `mid` 套 `T002R500x500M000<mid>.jpg` |
| 酷狗单曲（重写） | `mobilecdn.kugou.com/api/v3/search/song` → `album/info` | `imgurl` 模板 |

外加三处匹配逻辑修复：

1. **专辑名完全一致就直接认**。古典/合辑的"歌手"字段是
   `Anne-Sophie Mutter _ Herbert von Karajan _ ...` 这种长串，跟库里歌手永远对不上，
   一刀切要求歌手匹配会把这些专辑全判死。
2. **单字歌名不再整条链路跑空**。`titleVariants()` 有"标题至少 2 个字"的过滤，
   「喂」「醒」「恋」这类单字歌名会得到空数组 → 封面链路一轮都不跑、当场返回 null。
   现在空数组时兜一个原样标题。
3. **专辑名是「未知专辑」时不走专辑库和 360 图片**。360 是按关键词捞图的，
   实测给「科普知识 / My Soul」捞回一张街景照片 —— 宁可不放图，也不放一张错的。

**实测（真机，曲库 1478 首 / 1297 个专辑）**

- 抓不到图的专辑：**189 → 23 → 8**（1.0.22～1.0.25 几轮滚屏自然补齐了大部分，1.0.26 再补 15 个）；
- 拿残存的 23 个硬骨头逐个跑：新链路 **20/23 命中**，老链路只有 4/23；
- 剩下的 8 个：3 个是「未知专辑」（有意留空占位，避免抓错图），
  5 个是源站确实没有（美波 / Kawakiwoameku、Machine Gun Kelly / Bright_ The Album、
  Vitamin String Quartet / Merry Go Round of Life、Anne-Sophie Mutter / Vivaldi 四季、
  A Rusty Dream / 未知专辑）。
- 无谓联网没回潮：冷启动全库扫一遍仍只有个位数搜索请求，磁盘缩略图 1397 个。

**其它**：`window.__coverSources` 里多挂了 `kugouAlbum` / `qqSmartbox`，真机上可逐个源单独打点测延迟。

## 1.0.27（2026-11-25）

用户要求：点「顺序播放（列表循环）」之后要先进**随机播放**，再到**单曲循环**。

桌面版 `app.js` 里写死 `const MODE_ORDER = ['list', 'one', 'shuffle']` —— 是 `const`，从外面改不了，
而 `app.js` 又是纯镜像文件（改了下次同步就被覆盖）。所以这一版仍在 `bridge.js` 里做：

1. 重写一份 `mbCycleMode()`，顺序 `list → shuffle → one → list`；进入随机时照旧 `buildShuffleOrder(true)` 立刻洗牌，
   然后 `renderModeBtn()` 换图标、`toast` 提示、`saveConfig()` 存盘、播放列表面板开着就重排。
2. 把它挂到 `window.cycleMode` 上（app.js 的 `cycleMode` 是顶层函数声明，就是全局属性，内部再调 `cycleMode()`
   会解析到这个新函数 → 托盘小窗 / 媒体键那条 `cycle-mode` 路径自动一起变）。
3. 两个按钮 `#btn-mode`（歌单页页脚）和 `#pf-mode`（播放页）在加载时 `addEventListener('click', cycleMode)`
   **把旧函数值抄走了**，所以克隆节点替换 + 重新绑定（`data-mb-mode-bound` 防重复）。

**真机实测**

| 操作 | 结果 |
| --- | --- |
| 连点 4 次页脚按钮（起始 shuffle） | `shuffle → one → list → shuffle → one`，图标/提示同步，进随机时洗牌 1478 首 |
| 播放页 `#pf-mode` | 走同一套顺序（`one → list`） |
| 杀进程重启 | 模式正确恢复（`list` + 「播放模式：列表循环」） |
| 版本角标 | `安卓HD 1.0.27` |

## 1.0.28（2026-11-25）

**① 左上角 logo → 安卓版仓库**

`app.js` 里给 `#logo-home` 绑的是桌面版仓库 `https://github.com/sunmanxu/MusicSMX`（`mb.openExternal`），
安卓版点进去会跑到隔壁仓库。这一版在 `bridge.js` 里克隆 `#logo-home` 换掉那个 handler，
改跳 **`https://github.com/sunmanxu/MusicSMX-Android-HD`**，并用 `nativeCall('openExternal')` 直接拉起系统浏览器
（不走 `mb.openExternal` 的那层"确认跳转"弹窗，点一下就开）。悬停标题改成「打开 GitHub 上的安卓版仓库」。

**② 仓库简介**

`sunmanxu/MusicSMX-Android-HD` 之前确实没写简介。已通过 GitHub API 补上：

- 简介：`MusicSMX 安卓/平板版（Capacitor 壳 + 复用桌面渲染层）：本地音乐播放器，SAF 曲库、通知栏控制、封面与歌词多源自动补全。桌面版见 sunmanxu/MusicSMX`
- Topics：`music-player, android, capacitor, webview, local-music, tablet`

**真机实测**：点 logo → `com.android.browser` 起来，地址栏是 `github.com/sunmanxu/MusicSMX-Android-HD`；
版本角标 `安卓HD 1.0.28`。
