'use strict';
/* MusicBuddy 渲染层 */

// ---- 预检查：preload 是否正常加载 ----
if (typeof window.__preloadError !== 'undefined') {
  document.body.innerHTML = '<div style="padding:20px;color:#fff;background:#222;font-family:monospace;white-space:pre-wrap;">' +
    '❌ Preload 脚本加载失败！\n\n' +
    '错误信息：\n' + window.__preloadError +
    '</div>';
  throw new Error('Preload failed: ' + window.__preloadError);
}
if (typeof window.mb === 'undefined') {
  document.body.innerHTML = '<div style="padding:20px;color:#fff;background:#222;font-family:monospace;white-space:pre-wrap;">' +
    '❌ window.mb 不存在！\n\n' +
    'Preload 脚本可能没有执行，或者 contextBridge 失败。\n' +
    '__preloadOk = ' + typeof window.__preloadOk + '\n' +
    '__preloadError = ' + typeof window.__preloadError +
    '</div>';
  throw new Error('window.mb is undefined');
}

// ---- 错误收集（自检 & 白屏诊断） ----
window.__errs = [];
window.addEventListener('error', (e) => {
  window.__errs.push(String(e.message) + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
  showErrors();
});
window.addEventListener('unhandledrejection', (e) => {
  window.__errs.push('Promise: ' + String(e.reason));
  showErrors();
});

// ---- 静态预模糊背景（Canvas 预渲染，消除实时 CSS 模糊的 CPU 开销） ----
// 2026-11-18 第三次返工。目标只有一条：看起来像「封面的大半径高斯模糊」，
// 且**不能有色彩阶梯**。三条铁律：
//   ① 模糊必须是真高斯（这里 3 次 box blur 的浮点近似）。不用 ctx.filter:blur()：
//      那是固定 3-pass box 实现，半径一大就在平滑渐变上留下方块状台阶。
//   ② 不能在小图上放大上屏。旧版把 28px 的图放大 20 倍，双线性插值出的曲面是「折线面」，
//      肉眼看到的就是一片多边形色块（用户说的「很不平滑」）。
//      现在模糊在 480 上算、放大到 960 上屏，2560 屏最多再放大 2.7 倍。
//   ③ 色彩分级（饱和/对比/压暗）必须先在浮点里算完，最后一步才量化成 8bit，
//      量化时每像素加 TPDF 抖动（±1 LSB）把台阶打散。CSS 那层 filter 因此撤掉：
//      在已经量化的 8bit 图上再拉开对比度，只会把台阶放得更明显。
const blurredBgCache = new Map();
const BLUR_CACHE_MAX = 10;
const BG_WORK = 480;        // 模糊计算分辨率（正方形，cover 裁切也在这里做）
const BG_OUT = 960;         // 上屏纹理边长
const BG_SIGMA_RATIO = 0.058; // 高斯 σ / 边长 ≈ 旧版 640px 上 blur(34px) 的手感

// 逐级减半：直接一步缩到很小会混叠（细节被暴力丢弃后变成麻点），
// 每级都缩一半等于连续做低通，最后得到一张干净的降采样图。
function downsampleProgressive(img, target) {
  let w = img.naturalWidth || img.width || target;
  let h = img.naturalHeight || img.height || target;
  let canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  while (w > target || h > target) {
    const nw = Math.max(target, Math.round(w / 2));
    const nh = Math.max(target, Math.round(h / 2));
    const next = document.createElement('canvas');
    next.width = nw; next.height = nh;
    const nctx = next.getContext('2d');
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(canvas, 0, 0, nw, nh);
    canvas = next; w = nw; h = nh;
  }
  return canvas;
}

// 横向 / 纵向 box 模糊：滑动窗口 + 边界复制，浮点累加。
// 连做 3 次（两个方向交替）得到的就是近似高斯 —— 曲面是连续二次的，不会出现台阶。
function boxBlurH(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w * 3;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let k = -r; k <= r; k++) {
      const x = k < 0 ? 0 : (k >= w ? w - 1 : k);
      const p = row + x * 3;
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2];
    }
    for (let x = 0; x < w; x++) {
      const o = row + x * 3;
      dst[o] = s0 * inv; dst[o + 1] = s1 * inv; dst[o + 2] = s2 * inv;
      const xo = x - r < 0 ? 0 : (x - r >= w ? w - 1 : x - r);
      const xi = x + r + 1 >= w ? w - 1 : (x + r + 1 < 0 ? 0 : x + r + 1);
      const po = row + xo * 3, pi = row + xi * 3;
      s0 += src[pi] - src[po];
      s1 += src[pi + 1] - src[po + 1];
      s2 += src[pi + 2] - src[po + 2];
    }
  }
}
function boxBlurV(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  const stride = w * 3;
  for (let x = 0; x < w; x++) {
    const col = x * 3;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let k = -r; k <= r; k++) {
      const y = k < 0 ? 0 : (k >= h ? h - 1 : k);
      const p = y * stride + col;
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2];
    }
    for (let y = 0; y < h; y++) {
      const o = y * stride + col;
      dst[o] = s0 * inv; dst[o + 1] = s1 * inv; dst[o + 2] = s2 * inv;
      const yo = y - r < 0 ? 0 : (y - r >= h ? h - 1 : y - r);
      const yi = y + r + 1 >= h ? h - 1 : (y + r + 1 < 0 ? 0 : y + r + 1);
      const po = yo * stride + col, pi = yi * stride + col;
      s0 += src[pi] - src[po];
      s1 += src[pi + 1] - src[po + 1];
      s2 += src[pi + 2] - src[po + 2];
    }
  }
}

function buildBlurredBackground(img) {
  const sq = BG_WORK;
  const small = downsampleProgressive(img, sq);
  const sw = small.width, sh = small.height;

  // cover 裁切成正方形：多画 2%，上屏再被 drift 动画平移 1% 也不会漏边
  const work = document.createElement('canvas');
  work.width = sq; work.height = sq;
  const wctx = work.getContext('2d');
  wctx.fillStyle = '#000';
  wctx.fillRect(0, 0, sq, sq);
  wctx.imageSmoothingEnabled = true;
  wctx.imageSmoothingQuality = 'high';
  const cs = Math.max(sq / sw, sq / sh) * 1.02;
  wctx.drawImage(small, (sq - sw * cs) / 2, (sq - sh * cs) / 2, sw * cs, sh * cs);

  const src = wctx.getImageData(0, 0, sq, sq);
  const data = src.data;
  const n = sq * sq;
  const buf = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    buf[i * 3] = data[j]; buf[i * 3 + 1] = data[j + 1]; buf[i * 3 + 2] = data[j + 2];
  }

  // 真高斯：3 组「横+纵」box，等效 σ ≈ r
  const sigma = BG_SIGMA_RATIO * sq;
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const tmp = new Float32Array(buf.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(buf, tmp, sq, sq, r);
    boxBlurV(tmp, buf, sq, sq, r);
  }

  // 颜色分级 → 抖动 → 量化。顺序不能换：
  // 分级放在浮动里算（saturate 1.45 → contrast 1.02 → 亮度 0.42×0.72），
  // 量化前加 TPDF 噪声（两次均匀分布之和，±1 LSB），这才叫「抖开色带」。
  const SAT = 1.45, CON = 1.02, BRI = 0.42 * 0.72;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let rr = buf[i * 3], gg = buf[i * 3 + 1], bb = buf[i * 3 + 2];
    const lum = 0.213 * rr + 0.715 * gg + 0.072 * bb;
    rr = lum + (rr - lum) * SAT;
    gg = lum + (gg - lum) * SAT;
    bb = lum + (bb - lum) * SAT;
    // TPDF 抖动：三角分布、峰值 ±1 LSB，正好覆盖一个灰阶的量化边界
    const d0 = Math.random() + Math.random() - 1;
    const d1 = Math.random() + Math.random() - 1;
    const d2 = Math.random() + Math.random() - 1;
    rr = ((rr - 127.5) * CON + 127.5) * BRI + d0;
    gg = ((gg - 127.5) * CON + 127.5) * BRI + d1;
    bb = ((bb - 127.5) * CON + 127.5) * BRI + d2;
    data[j] = rr < 0 ? 0 : (rr > 255 ? 255 : rr + 0.5) | 0;
    data[j + 1] = gg < 0 ? 0 : (gg > 255 ? 255 : gg + 0.5) | 0;
    data[j + 2] = bb < 0 ? 0 : (bb > 255 ? 255 : bb + 0.5) | 0;
    data[j + 3] = 255;
  }
  wctx.putImageData(src, 0, 0);

  // 2 倍双三次放大：图已经是 σ=28 的低频图，放大不会引入折线，只是让上屏更细腻
  const out = document.createElement('canvas');
  out.width = BG_OUT; out.height = BG_OUT;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(work, 0, 0, BG_OUT, BG_OUT);

  // PNG 无损：WebP / JPEG 的有损块正是「马赛克」的直接来源
  return out.toDataURL('image/png');
}

function getBlurredBackground(imageUrl) {
  return new Promise((resolve) => {
    if (!imageUrl) { resolve(''); return; }
    if (blurredBgCache.has(imageUrl)) {
      // 命中也刷新一次顺序（简易 LRU：切歌多了不能无限攒 dataURL）
      const hit = blurredBgCache.get(imageUrl);
      blurredBgCache.delete(imageUrl);
      blurredBgCache.set(imageUrl, hit);
      resolve(hit);
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const dataUrl = buildBlurredBackground(img);
        if (blurredBgCache.size >= BLUR_CACHE_MAX) {
          blurredBgCache.delete(blurredBgCache.keys().next().value);
        }
        blurredBgCache.set(imageUrl, dataUrl);
        resolve(dataUrl);
      } catch (e) {
        console.error('预模糊失败:', e);
        resolve(imageUrl); // 失败时回退到原图
      }
    };
    img.onerror = () => resolve(imageUrl);
    img.src = imageUrl;
  });
}

// 把错误显示在页面顶部
function showErrors() {
  let bar = document.getElementById('error-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'error-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#ff4444;color:#fff;padding:10px 16px;font-family:monospace;font-size:12px;max-height:40vh;overflow-y:auto;white-space:pre-wrap;';
    document.body.appendChild(bar);
  }
  bar.textContent = '⚠️ JS 错误 (' + window.__errs.length + '):\n' + window.__errs.slice(0, 10).join('\n---\n');
  bar.style.display = 'block';
}

const $ = (id) => document.getElementById(id);
const audio = $('audio');

// 打开模态框的唯一入口：同 z-index 的弹窗按 DOM 顺序叠，DOM 里靠前的会被靠后的盖住，
// 于是「查重面板里点删除」弹出的批量删除窗被查重面板压在下面，看起来像点了没反应。
// 打开时按当前已开弹窗数抬高 z-index（层级随嵌套深度递增），关闭不用管（下次重开会重算）。
function showModal(id) {
  const el = typeof id === 'string' ? $(id) : id;
  if (!el) return null;
  const openCount = document.querySelectorAll('.modal:not([hidden])').length;
  el.style.zIndex = String(3000 + openCount * 10);
  el.hidden = false;
  return el;
}

// 扫描状态条显示/隐藏（统一处理 hidden 属性，避免不显示）
function showScanStatus() {
  const el = $('scan-status');
  if (!el) return;
  el.hidden = false;
  el.style.display = 'flex';
}
function hideScanStatus() {
  const el = $('scan-status');
  if (!el) return;
  el.hidden = true;
  el.style.display = 'none';
}

// ---- 状态 ----
const S = {
  tracks: [],          // 全部曲目
  view: [],            // 当前可见（过滤 + 排序后）
  folders: new Map(),  // root -> count
  activeFolder: null,  // null = 全部
  current: -1,         // 在 S.tracks 中的下标
  playHistory: [],     // 播放历史（索引数组），用于随机模式下的上一首
  historyIndex: -1,    // 当前在历史中的位置
  shuffleOrder: [],    // 随机模式的播放顺序（路径数组，Fisher-Yates 洗牌；存路径不存下标，曲目重排不失效）
  shufflePos: -1,      // 当前曲在 shuffleOrder 中的位置
  playing: false,
  mode: 'list',        // list | one | shuffle
  volume: 0.05,
  muted: false,
  audioOutputDevice: '', // 选中的音频输出设备 ID
  pinnedAudioDevices: [], // 置顶的音频输出设备 ID 数组
  durations: new Map(),// path -> 秒
  sortKey: 'addedTime',
  sortDir: -1,
  savedTrackOrder: null,  // 保存的导入歌单顺序（路径数组）
  savedPlaylistName: '',  // 保存的歌单名称
  importedTrackOrder: null, // 导入的歌单原始顺序（路径数组），用于切换排序后恢复
  importedPlatform: '',   // 导入的歌单平台（qqmusic/netease）
  importedPlaylistName: '', // 导入的歌单名称
  importedPlaylistHistory: [], // 导入过的歌单历史 [{id, name, platform, songs, importedTime, source}]
  // 当前歌单的来源（记住链接后可以一键刷新，不用再手动导一次）
  // { type: 'url', url, platform } 或 { type: 'file', name }
  importedPlaylistSource: null,
  keyword: '',
  filterField: null,  // 'artist' | 'album' | null，点击歌手/专辑筛选
  filterValue: '',    // 筛选的值
  selectedIdx: -1,    // 单击选中的行（仅视觉选中，双击才播放）
  multiSel: new Set(), // 多选集合（存 track 对象，Ctrl/Shift 点选；单选时也有 1 个）
  selAnchor: null,    // Shift 范围选择的锚点（track 对象）
  // 收藏与歌单
  favorites: new Set(),    // 收藏的歌曲路径集合
  playlists: [],           // 歌单数组 [{id, name, tracks: [path...]}]
  activePlaylist: null,    // 当前查看的歌单 ID，null=全部音乐
  showFavorites: false,    // 是否显示收藏列表
  // 回收站
  recycleBin: [],          // 回收站数组 [{path, title, artist, album, deletedAt}]
  // 设置
  settings: {
    autoCover: true,
    autoLyrics: true,
    saveCover: true,
    saveLyrics: true,
    cachePath: '',
    wordLyrics: false,  // 逐字歌词（卡拉OK填充）：默认关，整行一起点亮
    lyricScale: 1,      // 全屏歌词字号倍率
    // 歌词同步微调（秒，正数=歌词提前显示）。lyricOffset 只代表"当前这首"的实时值，
    // 真正持久化的是下面的 lyricOffsets[path]，切歌时按歌曲路径各自取值 —— 每首歌单独记住自己的调速。
    lyricOffset: 0,
    lyricOffsets: {},   // 歌曲路径 -> 该曲的歌词偏移秒数
    accent: '#ff6b3d',  // 主题强调色
    bgTheme: '#12141a', // 主题底色（界面背景）
    // 海报底色模式（2026-11-19 引入，2026-11-20 起为默认）：播放时主界面罩一层模糊海报氛围光。
    // bgMode: poster=海报氛围 / solid=纯色；旧配置兼容见 posterBgOn()。
    bgMode: 'poster',
    posterIntensity: 1,    // 海报氛围强度 0~1：氛围层（模糊海报）的浓度，默认拉满
    uiTransparency: 1,     // 界面透明度 0~1：界面表面透明占比，0=全实心 100=最透，默认拉满
    // 旧配置兼容：老版本只有一个 posterBgOpacity 同时管氛围层和表面透明度，
    // 读取时没有新键就按旧值迁移（见 applyPosterBgSetting / posterIntensityVal）。
    closeToTray: true,  // 点关闭按钮时最小化到托盘（false = 直接退出）
    // 默认就开任务栏歌词（用户 2026-11-18 要求）：任务栏那一条是常驻可见的位置，
    // 开箱即用不用先去菜单里找；桌面悬浮窗反而会盖在壁纸/别的窗口上。
    desktopLyric: 'taskbar', // 桌面歌词：off | desktop（悬浮窗） | taskbar（贴任务栏）
    lyricClickThrough: true, // 悬浮/任务栏歌词默认鼠标穿透（不挡桌面操作）
    lyricStyle: null,   // 悬浮/任务栏歌词外观（逐字/翻译/颜色/背景/描边），主进程持唯一真源
    lyricTaskbarHinted: false, // 是否已提示过「任务栏歌词可拖动 / 右键设置」
    // 悬浮 / 任务栏歌词的字号与文字透明度：**两套独立**（2026-11-18 要求）。
    // 桌面悬浮窗浮在壁纸上、地方大，字小一点更秀气；任务栏只有 40px 高，
    // 字小了完全看不清，默认反而要放大。以前两个模式共用一个值，
    // 调好桌面再去开任务栏就得重调一遍，而且两边互相覆盖。
    lyricScales: { desktop: 0.7, taskbar: 1.4 },     // 0.3 ~ 1.8
    lyricOpacities: { desktop: 0.5, taskbar: 0.5 },  // 0.1 ~ 1
    fixedTracks: {},  // 已自动修复的歌曲路径 -> 修复时间戳
    lockedTracks: {},  // 已锁定的歌曲路径 -> 锁定时间戳（自动修复时跳过）
    renameOnEdit: true,  // 修改歌曲信息时同时把文件名改为所选格式（勾选框默认态，记住用户选择）
    renameFormat: 'artist-title-album', // 重命名文件名格式：artist-title-album | title-artist-album | artist-album-title（记住用户选择）
    syncFillAlbum: true,   // 三合一同步窗口：补全缺失专辑 勾选默认态（记住用户选择）
    syncRename: true,      // 三合一同步窗口：同步至源文件名 勾选默认态
    syncWriteTags: true,   // 三合一同步窗口：写入文件标签 勾选默认态
    syncScopeAll: false,   // 三合一同步窗口：默认仅处理右键这一首；勾选「修改全部歌曲」才处理全库（记住用户选择）
    // 「歌单来源」窗口里三行输入框的内容（qq / netease / auto）。
    // 单独存一份、跟当前导入来源分开：这样两个平台可以同时记住链接，
    // 歌单在平台上更新了直接点那行的「刷新」；重启也不清空（2026-11-19 用户要求）。
    playlistSourceUrls: { qq: '', netease: '', auto: '' },
    // 右键「联网查看」解析结果的缓存：键 = 平台|目标|歌手|专辑(或歌名)，值 = {url, platform, label, at}。
    // 同一个歌手/专辑第二次点就是零延迟，不用再联网（2026-11-19）。
    onlineLinkCache: {}
  },
  // 播放队列（路径数组，手动排队，优先于列表顺序播放）
  queue: [],
  // 歌词
  lyrics: [],          // 解析后的歌词行 [{time, text, ttext, rtext, words}]
  lyricsCache: new Map(), // path -> {lrc, tlyric, rlyric, source} 文本缓存
  lyricSource: '',     // 当前歌词来源标记（网易云音乐/QQ音乐/... /本地/手动导入），显示在歌词头部徽章
  lyricsMode: 'orig',  // orig=原文, trans=翻译, roma=音译
  coverCache: new Map(),   // path -> dataUrl 缓存
  // 正在请求封面的 path 集合。以前是一个全局布尔：A 还在联网时切到 B，
  // B 的请求会被直接挡掉，等 A 的图回来又盖到 B 的界面上 —— 就是「偶尔封面不匹配」。
  fetchingCover: new Set(),
  fetchingCoverP: new Map(), // path -> 进行中的取封面 Promise（被去重挡掉的请求挂在后面等结果）
  coverRetryAt: new Set(),   // 已安排补抓的 path（本轮播放每首只补一次，失败不无限重试）
  fetchingLyrics: false,
  // 本地缓存文件列表（启动时扫描）
  localCoverFiles: new Map(), // key(artist-title小写) -> 文件路径
  localLyricsFiles: new Map(), // key(artist-title小写) -> 文件路径
  // 电台
  currentView: 'music',    // music | radio
  radioFilter: 'all',      // all | 国内 | 国外 | 音乐 | 新闻 | recent | fav
  radioViewMode: 'list',   // grid | list（默认列表，用户可随时切回卡片）
  currentRadio: null       // 当前播放的电台
};

// 电台列表 DOM 是否已失效（离开电台视图会清空列表，回来时按它决定是否重渲染）
let radioListDirty = true;
// 本次会话是否已经触发过「打开电台页自动检测」
let radioAutoChecked = false;
// 批量检测的令牌：离开电台视图就 +1，正在跑的检测据此提前收工（不再继续发请求）
let radioCheckToken = 0;

// ---- 全屏播放界面状态 ----
const pf = {
  open: false,
  lyrics: [],
  activeIdx: -1,
  lastActiveEl: null,      // 上一次高亮的歌词行 DOM（只切换它，避免遍历全部行）
  userScrollUntil: 0,      // 用户手动滚动后暂停自动跟随的时间点
  lyricModes: ['orig'],  // 选中的歌词模式，支持多选：orig, trans, roma
  bgIndex: 0,  // 当前显示的背景层索引（0=a, 1=b）
  spacingSingle: 1.0,  // 单歌词行间距倍率
  spacingDouble: 1.25  // 双歌词行间距倍率
};

// ---- 电台数据 ----
const RADIO_STATIONS = [
  { name: "音乐之声（CNR-3）", category: '国内', subcat: '音乐', url: 'http://ngcdn001.cnr.cn/live/yyzs/index.m3u8', desc: '中央人民广播电台音乐频率', color: '#c62828', pinned: false },
  { name: "上海动感101", category: '国内', subcat: '音乐', url: 'https://lhttp.qingting.fm/live/274/64k.mp3', desc: '上海动感101 FM101.7 流行音乐', color: '#1565c0', pinned: false },
  { name: "上海经典音乐广播", category: '国内', subcat: '音乐', url: 'https://lhttp.qingting.fm/live/267/64k.mp3', desc: '上海经典音乐广播 古典/轻音乐', color: '#6a1b9a', pinned: false },
  { name: "上海经典金曲 FM103.7", category: '国内', subcat: '音乐', url: 'https://lhttp-hw.qtfm.cn/live/273/64k.mp3', desc: '上海经典金曲广播 老歌金曲', color: '#00838f', pinned: false },
  { name: "北京音乐广播", category: '国内', subcat: '音乐', url: 'https://lhttp.qtfm.cn/live/332/64k.mp3', desc: '北京音乐广播 FM97.4', color: '#2e7d32', pinned: false },
  { name: "广东音乐之声", category: '国内', subcat: '音乐', url: 'https://lhttp.qtfm.cn/live/1260/64k.mp3', desc: '广东音乐之声 FM99.3', color: '#ef6c00', pinned: false },
  { name: "广东城市之声", category: '国内', subcat: '音乐', url: 'https://lhttp.qtfm.cn/live/469/64k.mp3', desc: '广东城市之声 FM103.6', color: '#ad1457', pinned: false },
  { name: "怀集音乐之声", category: '国内', subcat: '音乐', url: 'https://lhttp.qingting.fm/live/4804/64k.mp3', desc: '广东怀集音乐广播，曲库更新快', color: '#5e35b1', pinned: false },
  { name: "清晨音乐台", category: '国内', subcat: '音乐', url: 'https://lhttp.qtfm.cn/live/4915/64k.mp3', desc: '轻音乐/纯音乐，适合清晨与办公', color: '#1e88e5', pinned: false },
  { name: "两广之声音乐台", category: '国内', subcat: '音乐', url: 'https://lhttp.qtfm.cn/live/20500149/64k.mp3', desc: '粤语流行与华语经典', color: '#0097a7', pinned: false },
  { name: "顺德音乐之声", category: '国内', subcat: '音乐', url: 'https://lhttp.qtfm.cn/live/20500150/64k.mp3', desc: '佛山顺德音乐广播', color: '#43a047', pinned: false },
  { name: "云梦音乐台", category: '国内', subcat: '音乐', url: 'https://lhttp.qtfm.cn/live/20500187/64k.mp3', desc: '华语流行音乐', color: '#f4511e', pinned: false },
  { name: "星空电台", category: '国内', subcat: '音乐', url: 'https://lhttp-hw.qtfm.cn/live/5022379/64k.mp3', desc: '独立/民谣/华语新歌', color: '#8e24aa', pinned: false },
  { name: "MY FM 全国音乐频道", category: '国内', subcat: '音乐', url: 'https://lhttp.qingting.fm/live/20194/64k.mp3', desc: 'MY FM 流行音乐频道', color: '#3949ab', pinned: false },
  { name: "90.7 mixfm", category: '国内', subcat: '音乐', url: 'https://lhttp.qingting.fm/live/15318146/64k.mp3', desc: '都市流行音乐电台', color: '#d81b60', pinned: false },
  { name: "AsiaFM 亚洲音乐台", category: '国内', subcat: '音乐', url: 'https://lhttp.qingting.fm/live/4581/64k.mp3', desc: '亚洲流行音乐', color: '#00897b', pinned: false },
  { name: "AsiaFM 亚洲经典台", category: '国内', subcat: '音乐', url: 'https://lhttp.qingting.fm/live/5021912/64k.mp3', desc: '八九十年代经典老歌', color: '#5c6bc0', pinned: false },
  { name: "江苏经典流行音乐广播", category: '国内', subcat: '音乐', url: 'https://lhttp.qtfm.cn/live/4938/64k.mp3', desc: '江苏经典流行 FM97.5', color: '#7cb342', pinned: false },
  { name: "经典105 山东经典音乐", category: '国内', subcat: '音乐', url: 'http://audiolive302.iqilu.com/sdradioShenghuo/sdradio04/playlist.m3u8', desc: '山东经典音乐广播 FM105', color: '#a1887f', pinned: false },
  { name: "CCTV-15 音乐", category: '国内', subcat: '音乐', url: 'https://piccpndali.v.myalicdn.com/audio/cctv15_2.m3u8', desc: '央视音乐频道伴音', color: '#283593', pinned: false },
  { name: "中国之声（CNR-1）", category: '国内', subcat: '新闻', url: 'http://ngcdn001.cnr.cn/live/zgzs/index.m3u8', desc: '中央人民广播电台新闻综合频率', color: '#c62828', pinned: false },
  { name: "经济之声（CNR-2）", category: '国内', subcat: '新闻', url: 'http://ngcdn001.cnr.cn/live/jjzs/index.m3u8', desc: '中央人民广播电台经济频率', color: '#1565c0', pinned: false },
  { name: "第一财经", category: '国内', subcat: '新闻', url: 'https://lhttp.qingting.fm/live/276/64k.mp3', desc: '上海第一财经广播 FM97.7', color: '#6a1b9a', pinned: false },
  { name: "上海新闻广播", category: '国内', subcat: '新闻', url: 'https://lhttp.qingting.fm/live/270/64k.mp3', desc: '上海人民广播电台新闻频率', color: '#00838f', pinned: false },
  { name: "上海东广新闻资讯", category: '国内', subcat: '新闻', url: 'https://lhttp.qingting.fm/live/275/64k.mp3', desc: '东广新闻资讯广播 FM90.9', color: '#2e7d32', pinned: false },
  { name: "北京新闻广播", category: '国内', subcat: '新闻', url: 'https://lhttp.qtfm.cn/live/339/64k.mp3', desc: '北京新闻广播 FM100.6', color: '#ef6c00', pinned: false },
  { name: "广东交通之声", category: '国内', subcat: '新闻', url: 'https://lhttp.qtfm.cn/live/1262/64k.mp3', desc: '广东交通之声 FM105.2 路况资讯', color: '#ad1457', pinned: false },
  { name: "江苏新闻广播", category: '国内', subcat: '新闻', url: 'http://lzlive.vojs.cn/5Fo8mMX/92/live.m3u8', desc: '江苏新闻广播 FM93.7', color: '#5e35b1', pinned: false },
  { name: "环球资讯广播", category: '国内', subcat: '新闻', url: 'http://sk.cri.cn/905.m3u8', desc: '中国国际广播电台环球资讯', color: '#1e88e5', pinned: false },
  { name: "CRI 中文环球", category: '国内', subcat: '新闻', url: 'http://sk.cri.cn/hyhq.m3u8', desc: '中国国际广播电台中文环球', color: '#0097a7', pinned: false },
  { name: "安徽小说评书广播", category: '国内', subcat: '新闻', url: 'https://lhttp.qtfm.cn/live/1951/64k.mp3', desc: '评书/小说/有声阅读', color: '#43a047', pinned: false },
  { name: "Radio Paradise", cn: '天堂电台', category: '国外', subcat: '音乐', url: 'https://stream.radioparadise.com/aac-320', desc: '美国独立音乐电台，无广告，有损 320k AAC', color: '#f4511e', pinned: false },
  { name: "Radio Paradise Rock", cn: '天堂摇滚分频', category: '国外', subcat: '音乐', url: 'https://stream.radioparadise.com/rock-320', desc: 'Radio Paradise 摇滚分频', color: '#8e24aa', pinned: false },
  { name: "Radio Paradise Mellow", cn: '天堂舒缓分频', category: '国外', subcat: '音乐', url: 'https://stream.radioparadise.com/mellow-320', desc: 'Radio Paradise 舒缓分频', color: '#3949ab', pinned: false },
  { name: "SomaFM Groove Salad", cn: '律动沙拉', category: '国外', subcat: '音乐', url: 'https://ice1.somafm.com/groovesalad-128-mp3', desc: '氛围电子 / 缓拍', color: '#d81b60', pinned: false },
  { name: "SomaFM Drone Zone", cn: '长音地带', category: '国外', subcat: '音乐', url: 'https://ice1.somafm.com/dronezone-128-mp3', desc: '氛围 drone / 环境音', color: '#00897b', pinned: false },
  { name: "SomaFM Lush", cn: '迷醉女声', category: '国外', subcat: '音乐', url: 'https://ice1.somafm.com/lush-128-mp3', desc: '感性女声电子', color: '#5c6bc0', pinned: false },
  { name: "SomaFM DEF CON", cn: '黑客大会', category: '国外', subcat: '音乐', url: 'https://ice1.somafm.com/defcon-128-mp3', desc: '黑客大会电子音乐', color: '#7cb342', pinned: false },
  { name: "SomaFM Indie Pop", cn: '独立流行', category: '国外', subcat: '音乐', url: 'https://ice1.somafm.com/indiepop-128-mp3', desc: '独立流行', color: '#a1887f', pinned: false },
  { name: "SomaFM Folk Forward", cn: '新民谣', category: '国外', subcat: '音乐', url: 'https://ice1.somafm.com/folkfwd-128-mp3', desc: '民谣 / 独立民谣', color: '#283593', pinned: false },
  { name: "SomaFM Boot Liquor", cn: '乡村烈酒', category: '国外', subcat: '音乐', url: 'https://ice1.somafm.com/bootliquor-128-mp3', desc: '美式乡村 / 牛仔', color: '#c62828', pinned: false },
  { name: "SomaFM Secret Agent", cn: '秘密特工', category: '国外', subcat: '音乐', url: 'https://ice1.somafm.com/secretagent-128-mp3', desc: '复古间谍片配乐风', color: '#1565c0', pinned: false },
  { name: "SomaFM Deep Space One", cn: '深空一号', category: '国外', subcat: '音乐', url: 'https://ice1.somafm.com/deepspaceone-128-mp3', desc: '深空氛围电子', color: '#6a1b9a', pinned: false },
  { name: "KEXP 90.3 FM", cn: '西雅图独立台', category: '国外', subcat: '音乐', url: 'https://kexp-mp3-128.streamguys1.com/kexp128.mp3', desc: '西雅图独立/另类摇滚', color: '#00838f', pinned: false },
  { name: "WQXR 古典音乐", category: '国外', subcat: '音乐', url: 'https://stream.wqxr.org/wqxr', desc: '纽约公共古典音乐电台', color: '#2e7d32', pinned: false },
  { name: "Radio Swiss Jazz", cn: '瑞士爵士台', category: '国外', subcat: '音乐', url: 'http://stream.srg-ssr.ch/m/rsj/mp3_128', desc: '瑞士爵士电台，无广告无主持', color: '#ef6c00', pinned: false },
  { name: "Radio Swiss Classic", cn: '瑞士古典台', category: '国外', subcat: '音乐', url: 'http://stream.srg-ssr.ch/m/rsc_de/mp3_128', desc: '瑞士古典音乐电台', color: '#ad1457', pinned: false },
  { name: "Classic FM", cn: '英国古典台', category: '国外', subcat: '音乐', url: 'https://media-ssl.musicradio.com/ClassicFM', desc: '英国经典古典音乐电台', color: '#5e35b1', pinned: false },
  { name: "Heart UK", cn: '英国流行台', category: '国外', subcat: '音乐', url: 'https://media-ssl.musicradio.com/HeartUK', desc: '英国流行音乐电台', color: '#1e88e5', pinned: false },
  { name: "Capital FM", cn: '伦敦流行台', category: '国外', subcat: '音乐', url: 'https://media-ssl.musicradio.com/CapitalUK', desc: '英国热门流行音乐', color: '#0097a7', pinned: false },
  { name: "MANGORADIO", cn: '德国电子台', category: '国外', subcat: '音乐', url: 'https://mangoradio.stream.laut.fm/mangoradio', desc: '德国电子/舞曲', color: '#43a047', pinned: false },
  { name: "Classic Vinyl HD", cn: '黑胶经典', category: '国外', subcat: '音乐', url: 'https://icecast.walmradio.com:8443/classic', desc: '黑胶质感的经典老歌', color: '#f4511e', pinned: false },
  { name: "1.FM Cafe Radio", cn: '咖啡馆轻爵士', category: '国外', subcat: '音乐', url: 'http://strm112.1.fm/caferadio_mobile_mp3', desc: '咖啡馆爵士/轻音乐', color: '#8e24aa', pinned: false },
  { name: "Radio Meuh", cn: '法国独立台', category: '国外', subcat: '音乐', url: 'http://radiomeuh.ice.infomaniak.ch/radiomeuh-128.mp3', desc: '法国独立电子', color: '#3949ab', pinned: false },
  { name: "La Grosse Radio Reggae", cn: '雷鬼台', category: '国外', subcat: '音乐', url: 'http://hd.lagrosseradio.info/lagrosseradio-reggae-192.mp3', desc: '雷鬼音乐', color: '#d81b60', pinned: false },
  { name: "La Grosse Radio Metal", cn: '金属台', category: '国外', subcat: '音乐', url: 'http://hd.lagrosseradio.info/lagrosseradio-metal-192.mp3', desc: '金属乐', color: '#00897b', pinned: false },
  { name: "Rai Radio Classica", cn: '意大利古典台', category: '国外', subcat: '音乐', url: 'http://icestreaming.rai.it/5.mp3', desc: '意大利国家台古典音乐', color: '#5c6bc0', pinned: false },
  { name: "Kiss FM Ukraine", cn: '乌克兰流行台', category: '国外', subcat: '音乐', url: 'http://online.kissfm.ua/KissFM', desc: '乌克兰流行舞曲', color: '#7cb342', pinned: false },
  { name: "BBC World Service", cn: '英国广播国际台', category: '国外', subcat: '新闻', url: 'http://stream.live.vc.bbcmedia.co.uk/bbc_world_service', desc: 'BBC 国际新闻广播', color: '#a1887f', pinned: false },
  { name: "NPR News", cn: '美国公共电台', category: '国外', subcat: '新闻', url: 'https://npr-ice.streamguys1.com/live.mp3', desc: '美国国家公共广播电台', color: '#283593', pinned: false },
];

// ---- 模式图标 ----
const MODE_ICONS = {
  list: {
    title: '播放模式：列表循环',
    svg: '<svg viewBox="0 0 24 24" fill="none"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  },
  one: {
    title: '播放模式：单曲循环',
    svg: '<svg viewBox="0 0 24 24" fill="none"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><text x="9" y="15.5" font-size="9" fill="currentColor" font-family="sans-serif" font-weight="700">1</text></svg>'
  },
  shuffle: {
    title: '播放模式：随机播放',
    // 两条"S 形"交叉箭头：左右两端都是水平尾巴，箭头朝右，线条更细更圆，
    // 比原来那种整根对角线交叉的"纯 X"柔和得多（参考网易云的形状）。
    svg: '<svg viewBox="0 0 24 24" fill="none">'
      + '<path d="M3 6.6h3.6c1.5 0 2.9.8 3.7 2l4.1 6.9c.8 1.2 2.2 2 3.7 2h1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M3 17.5h3.6c1.5 0 2.9-.8 3.7-2l4.1-6.9c.8-1.2 2.2-2 3.7-2h1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M17.6 4.1 20.1 6.6 17.6 9.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M17.6 15 20.1 17.5 17.6 20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg>'
  }
};
const MODE_ORDER = ['list', 'one', 'shuffle'];
const MODE_NAME = { list: '列表循环', one: '单曲循环', shuffle: '随机播放' };

// ---- 工具 ----
function fileURL(p) {
  // encodeURI 不会编码 #，需手动替换为 %23，否则文件名含 # 时会被当作 URL 片段标识符
  return 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23');
}
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

// 逐字歌词开关：默认关（整行一起点亮），开启后才有卡拉OK式单字推进
function wordLyricsOn() {
  return S.settings.wordLyrics === true;
}

// ---------- 收藏与歌单工具函数 ----------
function toggleFavorite(path) {
  if (S.favorites.has(path)) {
    S.favorites.delete(path);
    toast('已取消收藏');
  } else {
    S.favorites.add(path);
    toast('已添加到收藏');
  }
  saveConfig();
  renderSidebar();
  renderList();
  reportPlayerState();  // 收藏状态变了，同步给托盘小窗的红心
}

function isFavorite(path) {
  return S.favorites.has(path);
}

function createPlaylist(name, parentId = null) {
  const id = 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  S.playlists.push({ id, name, tracks: [], parentId: parentId || null });
  saveConfig();
  renderSidebar();
  return id;
}

// 某个歌单下面挂的直属子歌单
function childPlaylists(parentId) {
  return S.playlists.filter(p => (p.parentId || null) === parentId);
}
// 该歌单自己 + 所有后代的 id（删歌单、统计数量、聚合曲目都用它）
function playlistWithDescendants(id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) {
    childPlaylists(ids[i]).forEach(c => ids.push(c.id));
  }
  return ids;
}
// 歌单（含子歌单）里的曲目：父歌单的视图会带上子歌单的歌，避免点开父歌单是空的
function playlistTracksDeep(id) {
  const ids = playlistWithDescendants(id);
  const seen = new Set();
  const out = [];
  ids.forEach(pid => {
    const pl = S.playlists.find(p => p.id === pid);
    if (!pl) return;
    (pl.tracks || []).forEach(path => {
      if (seen.has(path)) return;
      seen.add(path);
      out.push(path);
    });
  });
  return out;
}

function deletePlaylist(id) {
  // 连子孙一起删，避免留下找不到父级的孤儿歌单
  const ids = playlistWithDescendants(id);
  S.playlists = S.playlists.filter(p => !ids.includes(p.id));
  if (ids.includes(S.activePlaylist)) {
    S.activePlaylist = null;
    S.showFavorites = false;
  }
  saveConfig();
  renderSidebar();
  renderList();
}

function renamePlaylist(id, newName) {
  const pl = S.playlists.find(p => p.id === id);
  if (pl) {
    pl.name = newName;
    saveConfig();
    renderSidebar();
  }
}

function addToPlaylist(playlistId, path) {
  const pl = S.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  const list = (Array.isArray(path) ? path : [path]).filter(Boolean);
  let n = 0;
  list.forEach(p => {
    if (!pl.tracks.includes(p)) { pl.tracks.push(p); n++; }
  });
  if (n) {
    saveConfig();
    toast('已添加到歌单：' + pl.name + (list.length > 1 ? `（${n} 首）` : ''));
    if (S.activePlaylist === playlistId) renderList();
  } else {
    toast('所选歌曲均已在歌单中');
  }
}


// ---------- 播放队列 ----------
// S.queue 存路径数组，便于持久化；播放时再按路径找 track
function addToQueue(paths, front = false) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (list.length === 0) return 0;
  for (const p of list) {
    const exist = S.queue.indexOf(p);
    if (exist >= 0) S.queue.splice(exist, 1);
  }
  if (front) S.queue.unshift(...list);
  else S.queue.push(...list);
  renderQueuePanel();
  saveConfig();
  return list.length;
}

function removeFromQueue(index) {
  if (index < 0 || index >= S.queue.length) return;
  S.queue.splice(index, 1);
  renderQueuePanel();
  saveConfig();
}

function clearQueue() {
  S.queue = [];
  renderQueuePanel();
  saveConfig();
}

function updateQueueBadge() {
  const badge = $('queue-count');
  if (!badge) return;
  const n = S.queue.length;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.style.display = n > 0 ? '' : 'none';
}

// 播放列表滚动跟随：面板刚打开 / 当前曲变了才定位，别把正在翻列表的用户拽回去
let queueScrollPending = true;
let queueLastCurPath = null;

function renderQueuePanel() {
  const listEl = $('queue-list');
  const emptyEl = $('queue-empty');
  if (!listEl) return;
  updateQueueBadge();
  const panel = $('queue-panel');
  $('queue-total').textContent = S.tracks.length > 0 ? `(${S.tracks.length})` : '';
  // 面板没开只刷徽章，不重建 DOM（playAt/nextTrack 每次都会路过，曲库上千首全量重建太贵）
  if (panel && panel.hidden) return;
  // 路径 -> track 映射（列表里可能有已被删除的歌，直接跳过）
  const byPath = new Map();
  S.tracks.forEach(t => byPath.set(t.path, t));
  const curPath = S.current >= 0 && S.tracks[S.current] ? S.tracks[S.current].path : null;

  // ----「播放顺序」小节：随机=洗牌顺序，其余=曲库顺序；只读行，点击即播 ----
  const poRows = [];
  playOrderPaths().forEach((path) => {
    const t = byPath.get(path);
    if (t) poRows.push({ path, t });
  });

  // ----「接下来播放」小节：手动队列（入口已删，旧配置可能残留），行保留拖拽/删除/单击播放 ----
  const rows = [];
  S.queue.forEach((path, index) => {
    const t = byPath.get(path);
    if (!t) return;
    rows.push({ path, t, index });
  });

  if (rows.length === 0 && poRows.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  let poHtml = `<div class="queue-section-title">播放顺序<span class="qs-count">(${poRows.length})</span></div>`;
  for (const { t } of poRows) {
    const isCur = curPath !== null && t.path === curPath;
    const cls = 'queue-item po-item' + (isCur ? ' current' : '') + (t.isPlaceholder ? ' placeholder' : '');
    const tag = isCur ? '正在播放' : (t.isPlaceholder ? '缺失' : '');
    poHtml += `<div class="${cls}" data-path="${escapeHtml(t.path)}">`
      + `<div class="queue-item-main"><div class="queue-item-title">${escapeHtml(t.title || t.name || '未知歌曲')}</div>`
      + `<div class="queue-item-sub">${escapeHtml([t.artist, t.album].filter(Boolean).join(' · '))}</div></div>`
      + (tag ? `<span class="po-tag">${tag}</span>` : '')
      + `</div>`;
  }
  listEl.innerHTML = poHtml;
  const poTitleEl = listEl.firstElementChild;

  if (rows.length > 0) {
    const secTitle = document.createElement('div');
    secTitle.className = 'queue-section-title';
    secTitle.innerHTML = `接下来播放<span class="qs-count">(${rows.length})</span>`;
    listEl.insertBefore(secTitle, poTitleEl);
  }
  rows.forEach(({ t, index }) => {
    const item = document.createElement('div');
    item.className = 'queue-item' + (S.current >= 0 && S.tracks[S.current] && S.tracks[S.current].path === t.path ? ' current' : '');
    item.draggable = true;
    item.dataset.index = String(index);
    item.innerHTML = `
      <span class="queue-grip">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
      </span>
      <div class="queue-item-main">
        <div class="queue-item-title"></div>
        <div class="queue-item-sub"></div>
      </div>
      <button class="queue-remove" title="从队列移除">×</button>
    `;
    item.querySelector('.queue-item-title').textContent = t.title || t.name || '未知歌曲';
    item.querySelector('.queue-item-sub').textContent = [t.artist, t.album].filter(Boolean).join(' · ');
    item.addEventListener('click', (e) => {
      if (e.target.closest('.queue-remove')) return;
      const idx = S.queue.indexOf(t.path);
      if (idx >= 0) S.queue.splice(idx, 1);
      const i = S.tracks.findIndex(x => x.path === t.path);
      if (i >= 0) {
        playAt(i);
        renderQueuePanel();
        saveConfig();
      }
    });
    item.querySelector('.queue-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromQueue(S.queue.indexOf(t.path));
    });
    // 拖拽排序
    item.addEventListener('dragstart', (e) => {
      dragQueueIndex = S.queue.indexOf(t.path);
      item.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragQueueIndex)); } catch (err) {}
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      document.querySelectorAll('.queue-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const to = S.queue.indexOf(t.path);
      if (dragQueueIndex < 0 || to < 0 || dragQueueIndex === to) return;
      const [moved] = S.queue.splice(dragQueueIndex, 1);
      S.queue.splice(to, 0, moved);
      dragQueueIndex = -1;
      renderQueuePanel();
      saveConfig();
    });
    listEl.insertBefore(item, poTitleEl);
  });

  // 当前曲自动滚进可视区（不用 scrollIntoView，约束 42：会连带滚外层主窗口）
  if (curPath !== null && (queueScrollPending || curPath !== queueLastCurPath)) {
    const curEl = listEl.querySelector('.po-item.current');
    if (curEl) {
      const listBox = listEl.getBoundingClientRect();
      const rowBox = curEl.getBoundingClientRect();
      listEl.scrollTop += (rowBox.top - listBox.top) - listEl.clientHeight / 3;
    }
  }
  queueScrollPending = false;
  queueLastCurPath = curPath;
}

let dragQueueIndex = -1;

// 歌词面板与播放列表抽屉都是 right/bottom:88px 的固定浮层，同时打开会叠在一起
// 互相遮挡。统一约定：开一个就把另一个收起来（20261118 反馈）。
function closeQueuePanel() {
  const panel = $('queue-panel');
  if (!panel || !panel.classList.contains('open')) return;
  panel.classList.remove('open');
  setTimeout(() => { if (!panel.classList.contains('open')) panel.hidden = true; }, 240);
}

function closeLyricsPanel() {
  const panel = $('lyrics-panel');
  if (panel && !panel.hidden) panel.hidden = true;
  if ($('btn-lyrics')) $('btn-lyrics').classList.remove('active');
}

function toggleQueuePanel(force) {
  const panel = $('queue-panel');
  if (!panel) return;
  const show = typeof force === 'boolean' ? force : !panel.classList.contains('open');
  if (!show) { closeQueuePanel(); return; }
  // 同一个角落只留一个浮层
  closeLyricsPanel();
  const dlm = $('desktop-lyric-menu');
  if (dlm) dlm.hidden = true;
  panel.hidden = false;
  queueScrollPending = true; // 打开时把当前曲滚进可视区
  renderQueuePanel();
  // 先去掉 hidden 再触发过渡
  requestAnimationFrame(() => panel.classList.add('open'));
}

$('btn-queue').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleQueuePanel();
});
// 全屏播放页的队列按钮（抽屉 z-index 已提到 1100，所以能盖在全屏页之上）
const pfQueueBtn = $('pf-queue');
if (pfQueueBtn) {
  pfQueueBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleQueuePanel();
  });
}
$('btn-queue-close').addEventListener('click', () => toggleQueuePanel(false));
$('btn-queue-clear').addEventListener('click', async () => {
  if (S.queue.length === 0) { toast('「接下来播放」已经是空的'); return; }
  const ok = await showConfirm('清空「接下来播放」', `确定要清空「接下来播放」中的 ${S.queue.length} 首歌吗？播放顺序列表不受影响。`);
  if (ok) { clearQueue(); toast('已清空「接下来播放」'); }
});
// 播放顺序行：事件委托（上千行不能逐个挂监听），点击立即播放
$('queue-list').addEventListener('click', (e) => {
  const item = e.target.closest('.po-item');
  if (!item || !item.dataset.path) return;
  const i = S.tracks.findIndex(t => t.path === item.dataset.path);
  if (i < 0) return;
  if (S.tracks[i].isPlaceholder) { toast('本地无此歌曲，无法播放'); return; }
  playAt(i);
  renderQueuePanel();
});

// 桃心 SVG 图标
const HEART_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
const HEART_OUTLINE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
const PLAYLIST_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';

// 显示歌单选择菜单（trackPath 可以是单个路径或路径数组，多选批量加歌单共用）
let playlistMenuEl = null;
function showPlaylistMenu(e, trackPath) {
  // 关闭已有的菜单
  if (playlistMenuEl) {
    playlistMenuEl.remove();
    playlistMenuEl = null;
  }

  const menu = document.createElement('div');
  menu.className = 'context-menu playlist-menu';
  // 先设置位置为 (0,0) 并隐藏，获取实际尺寸
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';

  if (S.playlists.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ctx-item disabled';
    empty.textContent = '暂无歌单，请先创建';
    menu.appendChild(empty);
  } else {
    // 子歌单用「└ 」前缀缩进，和侧边栏层级对得上
    const ordered = [];
    const pushTree = (parentId, depth) => {
      S.playlists
        .filter(p => (p.parentId || null) === parentId)
        .forEach(p => {
          ordered.push({ pl: p, depth });
          pushTree(p.id, depth + 1);
        });
    };
    pushTree(null, 0);
    // 孤儿歌单兜底（父级已不存在）
    S.playlists.forEach(p => {
      if (p.parentId && !S.playlists.some(q => q.id === p.parentId) && !ordered.some(o => o.pl.id === p.id)) {
        ordered.push({ pl: p, depth: 0 });
      }
    });
    ordered.forEach(({ pl, depth }) => {
      const item = document.createElement('div');
      item.className = 'ctx-item';
      item.textContent = (depth > 0 ? '　└ ' : '') + pl.name + ' (' + playlistTracksDeep(pl.id).length + ')';
      item.addEventListener('click', () => {
        addToPlaylist(pl.id, trackPath);
        menu.remove();
        playlistMenuEl = null;
      });
      menu.appendChild(item);
    });
  }

  const divider = document.createElement('div');
  divider.className = 'ctx-divider';
  menu.appendChild(divider);

  const newItem = document.createElement('div');
  newItem.className = 'ctx-item';
  newItem.textContent = '+ 新建歌单';
  newItem.addEventListener('click', async () => {
    const name = await showInput('输入歌单名称：', '新歌单');
    if (name && name.trim()) {
      const id = createPlaylist(name.trim());
      addToPlaylist(id, trackPath);
    }
    menu.remove();
    playlistMenuEl = null;
  });
  menu.appendChild(newItem);

  document.body.appendChild(menu);
  playlistMenuEl = menu;

  // 边界检测：避免菜单超出窗口边缘
  const menuWidth = menu.offsetWidth || 180;
  const menuHeight = menu.offsetHeight || 200;
  let x = e.clientX;
  let y = e.clientY;
  // X 坐标：超出右边缘则向左调整
  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 5;
  }
  if (x < 0) x = 5;
  // Y 坐标：超出下边缘则向上弹出
  if (y + menuHeight > window.innerHeight) {
    y = e.clientY - menuHeight;
    if (y < 0) y = 5;
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.visibility = 'visible';

  // 点击其他地方关闭菜单
  setTimeout(() => {
    document.addEventListener('click', closePlaylistMenu, { once: true });
  }, 0);
}

function closePlaylistMenu() {
  if (playlistMenuEl) {
    playlistMenuEl.remove();
    playlistMenuEl = null;
  }
}
// 音质标记：根据文件扩展名判断音质等级
const LOSSLESS_EXTS = ['flac', 'wav', 'ape', 'alac', 'dsf', 'dff', 'tta', 'wv'];
function getQualityInfo(path) {
  if (!path) return null;
  const ext = path.split('.').pop().toLowerCase();
  if (LOSSLESS_EXTS.includes(ext)) {
    return { label: '无损', cls: 'q-lossless', title: '无损音质' };
  }
  if (['mp3', 'aac', 'm4a', 'ogg', 'opus', 'wma'].includes(ext)) {
    return { label: 'HQ', cls: 'q-hq', title: '高品质有损' };
  }
  return null;
}
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
let toastTimer = null;
let searchTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

// ---- 配置持久化（防抖） ----
let cfgTimer = null;
// 完整配置快照：**所有**要落盘的字段都必须在这里。
// 以前 beforeunload 只写了 folders/volume/settings 几个键，而主进程 set-config 是整份覆盖，
// 于是每次关窗都把歌单/收藏/导入顺序/当前排序从 config 里抹掉 —— 表现就是「重开软件排序被打回默认」。
function buildConfigData() {
  const configData = {
    folders: [...S.folders.keys()],
    volume: S.volume,
    muted: S.muted,
    audioOutputDevice: S.audioOutputDevice,
    mode: S.mode,
    lastTrack: S.current >= 0 ? S.tracks[S.current].path : null,
    lastPos: audio.currentTime || 0,
    settings: S.settings,
    // 全屏歌词显示偏好：下次启动保持上次选择的原文/翻译/音译与行间距
    lyricDisplay: {
      modes: pf.lyricModes,
      spacingSingle: pf.spacingSingle,
      spacingDouble: pf.spacingDouble
    },
    favorites: [...S.favorites],
    playlists: S.playlists,
    recycleBin: S.recycleBin,
    pinnedAudioDevices: S.pinnedAudioDevices,
    queue: S.queue
  };
  // 单独保存导入的歌单顺序（不依赖当前排序模式，避免切换排序后丢失导入顺序）
  if (S.importedTrackOrder && S.importedTrackOrder.length > 0) {
    // 根据导入的路径顺序，从当前 S.tracks 中提取完整的歌曲对象（包括占位/缺失歌曲）
    const pathToTrack = new Map();
    S.tracks.forEach(t => pathToTrack.set(t.path, t));
    const importedTracks = [];
    S.importedTrackOrder.forEach(p => {
      if (pathToTrack.has(p)) {
        const t = pathToTrack.get(p);
        importedTracks.push({
          path: t.path,
          title: t.title,
          artist: t.artist,
          album: t.album,
          duration: t.duration,
          addedTime: t.addedTime,
          root: t.root,
          isPlaceholder: t.isPlaceholder || false,
          isMissing: t.isMissing || false,
          missingSince: t.missingSince || null,
          qqmusicId: t.qqmusicId || null,
          qqmusicMid: t.qqmusicMid || null
        });
      }
    });
    configData.importedTracks = importedTracks;
    configData.importedPlatform = S.importedPlatform || 'qqmusic';
    configData.importedPlaylistName = S.importedPlaylistName || '';
  } else {
    configData.importedTracks = null;
    configData.importedPlatform = null;
    configData.importedPlaylistName = null;
  }
  // 持久化缺失歌曲条目（文件消失但保留供对照找回），重启/刷新后不丢
  configData.missingTracks = S.tracks
    .filter(t => t.isMissing)
    .map(t => ({
      path: t.path,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: t.duration || 0,
      addedTime: t.addedTime,
      root: t.root,
      missingSince: t.missingSince || null,
      qqmusicId: t.qqmusicId || null,
      qqmusicMid: t.qqmusicMid || null
    }));
  // 保存当前排序模式（下次打开保持上次的排列顺序）
  configData.currentSortKey = S.sortKey;
  configData.currentSortDir = S.sortDir;
  // 保存导入歌单历史
  configData.importedPlaylistHistory = S.importedPlaylistHistory;
  // 记住歌单来源链接：下次想更新歌单直接点「刷新歌单顺序」
  configData.importedPlaylistSource = S.importedPlaylistSource || null;
  return configData;
}

function saveConfig() {
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(async () => {
    try { await mb.setConfig(buildConfigData()); } catch (e) { /* 静默 */ }
  }, 600);
}

// 关窗/退出前的最后一份：必须整份写，不能只写几个键（否则等于删数据）
function flushConfigNow() {
  try { mb.setConfig(buildConfigData()); } catch (e) { /* 静默 */ }
}

// ---- 曲目列表渲染 ----
// ---------- 歌手/专辑筛选的在线歌曲补全（2026-11-20）----------
// 双击歌手名 / 点击专辑名筛选后：本地歌曲排前面，后面追加对应的网络歌曲（灰色行）。
// 只用于展示与右键跳平台试听/复制歌名，不可播放、不参与统计。
let onlineExtras = [];          // 当前筛选目标的网络歌曲 [{title,artist,album,source}]
let onlineExtrasField = null;   // 这批结果属于哪个筛选维度（'artist' | 'album'）
let onlineExtrasValue = null;   // 这批结果属于哪个歌手/专辑（换筛选就作废）
let onlineExtrasToken = 0;      // 竞态令牌：快速切换筛选时丢弃过期结果
const onlineSearchCache = new Map(); // 'artist|值' -> 结果（本次会话内缓存，重复筛选秒出）
const songKeyLoose = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

async function loadOnlineExtras(field, value) {
  if (!value || (field !== 'artist' && field !== 'album')) return;
  onlineExtrasField = field;
  onlineExtrasValue = value;
  onlineExtras = [];
  const token = ++onlineExtrasToken;
  renderList(); // 先把上一个筛选的灰色行刷掉
  const cacheKey = field + '|' + value;
  let results = onlineSearchCache.get(cacheKey);
  if (!results) {
    const fetcher = field === 'artist' ? window.mb.searchArtistOnline : window.mb.searchAlbumOnline;
    try {
      results = (fetcher ? await fetcher(value) : []) || [];
    } catch (e) { results = []; }
    if (token !== onlineExtrasToken) return; // 等待期间换了筛选：丢弃
    // 剔除本地已有的同首歌（歌名+歌手归一化后相同），别让列表里出现两条一样的
    const localKeys = new Set(
      S.tracks.filter(t => t[field] === value && !t.isPlaceholder)
        .map(t => songKeyLoose(t.title + '@' + t.artist))
    );
    results = results.filter(r => !localKeys.has(songKeyLoose(r.title + '@' + r.artist)));
    // 专辑筛选：专辑名搜索会混进其他歌手的同名专辑/翻唱（用户反馈「专辑与歌手对应不上」），
    // 按本地这张专辑实际出现的歌手做宽松匹配过滤；本地全是占位（没有歌手信息）时不过滤。
    if (field === 'album') {
      const localArtists = [...new Set(
        S.tracks.filter(t => t.album === value && !t.isPlaceholder && t.artist)
          .map(t => t.artist)
      )];
      if (localArtists.length) {
        results = results.filter(r => localArtists.some(a => artistLooseMatch(a, r.artist)));
      }
    }
    onlineSearchCache.set(cacheKey, results);
  }
  if (token !== onlineExtrasToken) return;
  onlineExtras = results.map(r => Object.assign({}, r, { isOnline: true }));
  // 渲染条件：筛选驱动（filterField 匹配）或搜索驱动（主曲库无筛选时也算——
  // 搜歌手推送没有 filterField，不放宽这里结果加载完永远不重渲染）
  if ((S.filterField === field && S.filterValue === value) || !S.filterField) renderList();
}

function clearOnlineExtras() {
  if (onlineExtrasField === null && !onlineExtras.length) return;
  onlineExtrasField = null;
  onlineExtrasValue = null;
  onlineExtras = [];
  onlineExtrasToken++;
}

// ---------- 主页搜索的在线歌曲推送（2026-11-20）----------
// 搜索关键词在本地一首都匹配不上时，拿关键词搜 QQ/网易云，把结果以灰色行
// 追加在空结果下面；单击灰色行直接跳对应平台试听（createOnlineTrackRow）。
let searchExtras = [];            // 当前关键词的网络搜索结果
let searchExtrasKeyword = null;   // 这批结果属于哪个关键词（换词作废）
let searchExtrasToken = 0;        // 竞态令牌
let searchExtrasTimer = 0;        // 防抖：连续输入只发最后一次请求
const SEARCH_EXTRAS_DELAY = 600;  // 输入停稳 600ms 才发网络请求
const searchExtrasCache = new Map(); // 关键词 -> 结果（本次会话缓存）

function clearSearchExtras() {
  clearTimeout(searchExtrasTimer);
  if (searchExtrasKeyword === null && !searchExtras.length) return;
  searchExtrasKeyword = null;
  searchExtras = [];
  searchExtrasToken++;
}

async function loadSearchExtras(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return;
  searchExtrasKeyword = kw;
  searchExtras = [];
  const token = ++searchExtrasToken;
  let results = searchExtrasCache.get(kw);
  if (!results) {
    try {
      results = (window.mb.searchSongsOnline ? await window.mb.searchSongsOnline(kw) : []) || [];
    } catch (e) { results = []; }
    if (token !== searchExtrasToken) return;
    // 本地其实有这首的（写法差异导致关键词没匹配上）就别推网络版
    results = results.filter(r => !S.tracks.some(t => sameSongLoose(t, r)));
    searchExtrasCache.set(kw, results);
  }
  if (token !== searchExtrasToken) return;
  searchExtras = results.map(r => Object.assign({}, r, { isOnline: true }));
  if (S.keyword.trim() === kw) renderList();
}

// 识别「在搜歌手」：关键词命中本地某歌手名时返回该歌手，命中多个时取本地曲目最多的那个。
// 精确匹配（归一化后相等）优先于包含关系；只看歌手字段，不碰歌名/专辑。
function findSearchedArtist(kw, list) {
  if (!kw || kw.length < 2) return null;
  const nkw = normalizeStr(kw);
  if (!nkw) return null;
  const counts = new Map();
  for (const t of list) {
    if (!t || t.isOnline || !t.artist || t.isPlaceholder) continue;
    counts.set(t.artist, (counts.get(t.artist) || 0) + 1);
  }
  let looseBest = null, looseBestN = 0;
  for (const [artist, n] of counts) {
    const na = normalizeStr(artist);
    if (!na) continue;
    if (na === nkw) return artist;               // 全名精确命中，直接用
    if ((na.includes(nkw) || nkw.includes(na)) && n > looseBestN) {
      looseBest = artist;                        // 包含命中（"周杰"→周杰伦），取本地曲目最多的
      looseBestN = n;
    }
  }
  return looseBest;
}

// 识别「在搜专辑」：逻辑与歌手版一致，只看专辑字段
function findSearchedAlbum(kw, list) {
  if (!kw || kw.length < 2) return null;
  const nkw = normalizeStr(kw);
  if (!nkw) return null;
  const counts = new Map();
  for (const t of list) {
    if (!t || t.isOnline || !t.album || t.isPlaceholder) continue;
    counts.set(t.album, (counts.get(t.album) || 0) + 1);
  }
  let looseBest = null, looseBestN = 0;
  for (const [album, n] of counts) {
    const na = normalizeStr(album);
    if (!na) continue;
    if (na === nkw) return album;
    if ((na.includes(nkw) || nkw.includes(na)) && n > looseBestN) {
      looseBest = album;
      looseBestN = n;
    }
  }
  return looseBest;
}

// 识别「在搜歌名」：关键词出现在本地某首歌的歌名里（歌手/专辑都没命中时兜底）
function findSearchedSongTitle(kw, list) {
  if (!kw || kw.length < 2) return false;
  const nkw = normalizeStr(kw);
  if (!nkw) return false;
  return list.some(t => t && !t.isOnline && t.title && normalizeStr(t.title).includes(nkw));
}

function computeView() {
  const kw = S.keyword.trim().toLowerCase();
  // 歌单视图：父歌单连带子歌单的曲目一起显示（Set 只建一次，避免每首歌遍历一遍）
  const plPaths = S.activePlaylist ? new Set(playlistTracksDeep(S.activePlaylist)) : null;
  let list = S.tracks.filter((t) => {
    if (!t || !t.path) return false;
    // 收藏视图筛选
    if (S.showFavorites && !S.favorites.has(t.path)) return false;
    // 歌单视图筛选
    if (S.activePlaylist) {
      if (!plPaths || !plPaths.has(t.path)) return false;
    }
    if (S.activeFolder && t.root !== S.activeFolder) return false;
    // 歌手/专辑筛选
    if (S.filterField === 'artist' && t.artist !== S.filterValue) return false;
    if (S.filterField === 'album' && t.album !== S.filterValue) return false;
    // 缺失筛选（统计区「X 首缺失（占位）」右键进入）：占位 + 文件缺失保留条目都算「丢失」
    if (S.filterField === 'missing' && !t.isPlaceholder) return false;
    if (!kw) return true;
    return t.title.toLowerCase().includes(kw)
      || t.artist.toLowerCase().includes(kw)
      || t.album.toLowerCase().includes(kw);
  });
  if (S.sortKey) {
    const k = S.sortKey, dir = S.sortDir;
    if (k === 'qqmusic') {
      // QQ音乐导入排序：保持 S.tracks 的原始顺序（导入时已重新排列）
      // 不做任何排序操作
    } else if (k === 'shuffle') {
      // 随机排序（Fisher-Yates 洗牌）
      list = [...list];
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    } else if (k === 'addedTime') {
      // 按添加时间排序（dir=1 升序旧→新，dir=-1 降序新→旧）
      list = [...list].sort((a, b) => {
        const x = a.addedTime || 0;
        const y = b.addedTime || 0;
        return (x - y) * dir;
      });
    } else {
      list = [...list].sort((a, b) => {
        let x = k === 'duration' ? (S.durations.get(a.path) || 0) : a[k];
        let y = k === 'duration' ? (S.durations.get(b.path) || 0) : b[k];
        if (typeof x === 'string') { x = x.toLowerCase(); y = String(y).toLowerCase(); }
        return (x > y ? 1 : x < y ? -1 : 0) * dir;
      });
    }
  }
  // 歌手/专辑筛选追加网络歌曲（灰色行，排本地后面；搜索关键字同样过滤它们）
  if ((S.filterField === 'artist' || S.filterField === 'album')
    && onlineExtrasField === S.filterField && onlineExtrasValue === S.filterValue && onlineExtras.length) {
    let extras = onlineExtras;
    if (kw) {
      extras = extras.filter(t => (t.title || '').toLowerCase().includes(kw)
        || (t.artist || '').toLowerCase().includes(kw)
        || (t.album || '').toLowerCase().includes(kw));
    }
    list = list.concat(extras);
  }
  // 主页搜索推送：关键词在本地一首都匹配不上时，追加 QQ/网易云的网络搜索结果（灰色行）。
  // 只在主曲库视图生效（歌手/专辑/缺失筛选下有自己的补全逻辑，不混入）。
  if (kw && !S.filterField && list.length === 0) {
    if (searchExtrasKeyword === kw && searchExtras.length) {
      list = list.concat(searchExtras);
    } else if (searchExtrasKeyword !== kw) {
      // 输入停稳再发请求：computeView 每次敲字都会进来，靠防抖挡住高频搜索
      clearTimeout(searchExtrasTimer);
      searchExtrasTimer = setTimeout(() => loadSearchExtras(kw), SEARCH_EXTRAS_DELAY);
    }
  } else if (!kw && searchExtrasKeyword !== null) {
    clearSearchExtras();
  }
  // 搜索推送（主曲库视图）：
  //  · 本地零命中 → 关键词推送（QQ/网易云按关键词搜）
  //  · 歌手名命中 → 该歌手的网络歌曲
  //  · 专辑名命中 → 该专辑的网络歌曲（自带歌手过滤，翻唱不混入）
  //  · 歌名命中   → 同名歌的其他资源（本地已有版本会被 sameSongLoose 剔除，
  //                留下的是其他歌手/平台的版本）
  if (kw && !S.filterField && list.length > 0) {
    const searchedArtist = findSearchedArtist(kw, list);
    if (searchedArtist) {
      // 注意：判断只看 field/value 是否匹配，不看 onlineExtras.length —— loadOnlineExtras
      // 开头会 renderList，靠长度判断会在「已加载但为空」时无限重触发。
      if (onlineExtrasField === 'artist' && onlineExtrasValue === searchedArtist) {
        if (onlineExtras.length) {
          // 与当前列表去重（搜部分歌手名时本地可能混有别的歌手的歌），只追加本地没有的
          const seen = new Set(list.map(t => songKeyLoose(t.title + '@' + t.artist)));
          list = list.concat(onlineExtras.filter(t => !seen.has(songKeyLoose(t.title + '@' + t.artist))));
        }
      } else {
        loadOnlineExtras('artist', searchedArtist); // 异步加载，回来后 renderList 自动接上
      }
    } else {
      const searchedAlbum = findSearchedAlbum(kw, list);
      if (searchedAlbum) {
        if (onlineExtrasField === 'album' && onlineExtrasValue === searchedAlbum) {
          if (onlineExtras.length) {
            const seen = new Set(list.map(t => songKeyLoose(t.title + '@' + t.artist)));
            list = list.concat(onlineExtras.filter(t => !seen.has(songKeyLoose(t.title + '@' + t.artist))));
          }
        } else {
          loadOnlineExtras('album', searchedAlbum);
        }
      } else if (findSearchedSongTitle(kw, list)) {
        // 歌名推送复用 searchExtras 设施；append 分支看 searchExtrasKeyword 防
        // 「加载中」重触发（与 artist 分支同一套防重入模式），600ms 防抖挡高频输入
        if (searchExtrasKeyword === kw) {
          if (searchExtras.length) {
            const seen = new Set(list.map(t => songKeyLoose(t.title + '@' + t.artist)));
            list = list.concat(searchExtras.filter(t => !seen.has(songKeyLoose(t.title + '@' + t.artist))));
          }
        } else {
          clearTimeout(searchExtrasTimer);
          searchExtrasTimer = setTimeout(() => loadSearchExtras(kw), SEARCH_EXTRAS_DELAY);
        }
      }
    }
  } else if (!kw && searchExtrasKeyword !== null) {
    clearSearchExtras();
  }
  S.view = list;
}

// 优化：只更新播放行的类名，避免重新渲染整个列表导致闪烁
function updatePlayingRow(prevIdx, curIdx) {
  const wrap = $('track-list');
  if (!wrap) return;
  
  // 移除上一行的类名
  if (prevIdx >= 0) {
    const prevRow = wrap.querySelector(`.track-row[data-idx="${prevIdx}"]`);
    if (prevRow) {
      prevRow.classList.remove('current', 'playing');
    }
  }
  
  // 添加当前行的类名
  if (curIdx >= 0) {
    const curRow = wrap.querySelector(`.track-row[data-idx="${curIdx}"]`);
    if (curRow) {
      curRow.classList.add('current');
      if (S.playing) curRow.classList.add('playing');
    }
    // 虚拟滚动下当前行可能不在DOM中：滚动到附近时 createTrackRow 会自动带上正确状态，无需全量重渲染
  }
}

// ---- 虚拟滚动：大量歌曲时只渲染可视窗口内的行，避免DOM节点过多导致滚动卡顿 ----
const ROW_H = 44;              // 行高，与 CSS .track-row 一致
const VIRTUAL_THRESHOLD = 300; // 超过该数量启用虚拟滚动
const OVERSCAN = 8;            // 视口外预渲染行数，快速滚动时不露白
let virtualState = null;       // { wrap, view, n, cur, rows: Map<idx, row> }
let virtualScrollRaf = 0;

function renderList() {
  computeView();
  queueMicrotask(updateBackToTop); // 列表重建后刷新「回到顶部」按钮状态
  const wrap = $('track-list');
  const cur = S.current >= 0 ? S.tracks[S.current] : null;
  const n = S.view.length;
  $('empty-state').style.display = n ? 'none' : 'flex';
  // 搜索无本地结果时的空状态文案：别再喊人「添加文件夹」，提示正在联网搜索
  // （results 到了会重渲染列表，文案用完即换回）
  const emptyMain = document.querySelector('#empty-state .empty-main');
  const emptyDim = document.querySelector('#empty-state .empty-dim');
  if (emptyMain && emptyDim) {
    if (!n && S.keyword.trim()) {
      emptyMain.textContent = '本地曲库没有匹配「' + S.keyword.trim() + '」';
      emptyDim.textContent = searchExtrasKeyword === S.keyword.trim() && searchExtras.length
        ? '以下是网络搜索结果，单击可直接跳转平台试听'
        : '正在联网搜索 QQ音乐 / 网易云，稍候自动显示…';
    } else {
      emptyMain.textContent = '还没有音乐';
      emptyDim.textContent = '点击此处或左上角「全部音乐」旁的 ＋ 添加文件夹，也可以直接把音乐文件 / 文件夹拖进窗口';
    }
  }
  renderStats();
  if (!n) {
    virtualState = null;
    wrap.classList.remove('virtual');
    wrap.textContent = '';
    updateTrackScrollbar();
    return;
  }

  // 少于阈值：常规渲染，保证小列表的响应速度
  if (n <= VIRTUAL_THRESHOLD) {
    virtualState = null;
    wrap.classList.remove('virtual');
    wrap.textContent = '';
    const frag = document.createDocumentFragment();
    S.view.forEach((t, i) => {
      frag.appendChild(createTrackRow(t, i, cur));
    });
    wrap.appendChild(frag);
    updateTrackScrollbar();
    return;
  }

  // 大量歌曲：虚拟滚动，DOM中只保留可视窗口内的行
  wrap.classList.add('virtual');
  wrap.textContent = '';
  const spacer = document.createElement('div');
  spacer.id = 'track-list-spacer';
  // 用 spacer 高度还原原容器的上下 padding（上4 下20），撑出滚动高度
  spacer.style.height = (4 + n * ROW_H + 20) + 'px';
  wrap.appendChild(spacer);
  virtualState = { wrap, view: S.view, n, cur, rows: new Map() };
  renderVirtualWindow();
  updateTrackScrollbar();
}

// 渲染当前可视窗口内的行（含上下缓冲行）
function renderVirtualWindow() {
  const st = virtualState;
  if (!st) return;
  const wrap = st.wrap;
  const sc = wrap.scrollTop;
  const vh = wrap.clientHeight || 600;
  const first = Math.max(0, Math.floor(sc / ROW_H) - OVERSCAN);
  const last = Math.min(st.n - 1, Math.ceil((sc + vh) / ROW_H) + OVERSCAN);

  // 移除已离开窗口的行
  for (const [idx, row] of st.rows) {
    if (idx < first || idx > last) {
      row.remove();
      st.rows.delete(idx);
    }
  }
  // 补充进入窗口的行
  for (let i = first; i <= last; i++) {
    if (st.rows.has(i)) continue;
    const row = createTrackRow(st.view[i], i, st.cur);
    row.style.top = (4 + i * ROW_H) + 'px';
    st.rows.set(i, row);
    wrap.appendChild(row);
  }
}

// 把指定曲目所在行滚动到可视区域（兼容虚拟滚动：行未渲染时定位容器滚动位置）
function scrollTrackIntoView(fullIdx, smooth = false) {
  const wrap = $('track-list');
  if (!wrap) return;
  // 行已在DOM中：直接滚动该行
  const row = wrap.querySelector(`.track-row[data-idx="${fullIdx}"]`);
  if (row) {
    row.scrollIntoView(smooth ? { behavior: 'smooth', block: 'center' } : { block: 'nearest' });
    return;
  }
  if (!virtualState) return;
  const i = S.view.findIndex((t) => t === S.tracks[fullIdx]);
  if (i < 0) return;
  const top = 4 + i * ROW_H;
  const vh = wrap.clientHeight;
  if (smooth) {
    smoothScrollTo(wrap, Math.max(0, top - (vh - ROW_H) / 2));
  } else {
    let target;
    if (top < wrap.scrollTop) target = top;
    else if (top + ROW_H > wrap.scrollTop + vh) target = top - (vh - ROW_H);
    else return; // 已可见，无需滚动
    // 强制瞬时滚动，避免 CSS scroll-behavior: smooth 把切歌时的定位变成动画
    const prev = wrap.style.scrollBehavior;
    wrap.style.scrollBehavior = 'auto';
    wrap.scrollTop = Math.max(0, target);
    wrap.style.scrollBehavior = prev;
  }
  // 立即刷新窗口，避免等下一次scroll事件才渲染
  if (virtualScrollRaf) { cancelAnimationFrame(virtualScrollRaf); virtualScrollRaf = 0; }
  renderVirtualWindow();
}

// 手动平滑滚动（虚拟滚动下行未渲染时，scrollIntoView 无法定位）
function smoothScrollTo(wrap, target) {
  const start = wrap.scrollTop;
  const delta = target - start;
  if (Math.abs(delta) < 2) return;
  // 手动逐帧滚动期间禁用 CSS smooth，避免每帧赋值再次触发动画
  const prev = wrap.style.scrollBehavior;
  wrap.style.scrollBehavior = 'auto';
  const dur = 250;
  const t0 = performance.now();
  const ease = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    wrap.scrollTop = start + delta * ease(p);
    if (p < 1) requestAnimationFrame(step);
    else wrap.style.scrollBehavior = prev;
  };
  requestAnimationFrame(step);
}

// 列表悬浮按钮组：定位当前歌曲 + 回到顶部。电台视图 / 空列表时都隐藏。不影响播放状态。
function updateFloatButtons() {
  const topBtn = $('back-to-top');
  const locBtn = $('locate-current-float');
  const wrap = $('track-list');
  const unavailable = !wrap || wrap.style.display === 'none' || !S.view || !S.view.length;
  if (unavailable) {
    if (topBtn) topBtn.classList.remove('show');
    if (locBtn) locBtn.classList.remove('show');
    return;
  }
  // 回到顶部：滚动一段距离后才出现
  if (topBtn) topBtn.classList.toggle('show', wrap.scrollTop > 240);
  // 定位当前歌曲：只要有当前播放曲目就常驻显示
  const hasCurrent = S.current >= 0 && S.tracks[S.current] && !S.tracks[S.current].isPlaceholder;
  if (locBtn) locBtn.classList.toggle('show', !!hasCurrent);
}
// 兼容旧调用点（scroll / renderList / switchView）
const updateBackToTop = updateFloatButtons;

// 定位到当前播放歌曲：滚动到当前行 + 高亮闪烁（播放栏 #btn-locate 与悬浮按钮共用）
function locateCurrentTrack() {
  if (S.current < 0) { toast('请先播放一首歌曲'); return; }
  scrollTrackIntoView(S.current, true);
  // 等待平滑滚动到位后高亮闪烁（虚拟滚动下当前行可能刚被渲染）
  setTimeout(() => {
    const row = document.querySelector('.track-row.current');
    if (!row) return;
    row.style.transition = 'background 0.3s';
    row.style.background = 'var(--accent-soft)';
    setTimeout(() => { row.style.background = ''; }, 600);
    setTimeout(() => {
      row.style.background = 'var(--accent-soft)';
      setTimeout(() => { row.style.background = ''; }, 300);
    }, 300);
  }, 300);
}
$('back-to-top').addEventListener('click', () => {
  const wrap = $('track-list');
  if (wrap) wrap.scrollTo({ top: 0, behavior: 'smooth' });
});
$('locate-current-float').addEventListener('click', locateCurrentTrack);

// 滚动节流：用 rAF 合并高频 scroll 事件
$('track-list').addEventListener('scroll', () => {
  updateBackToTop();
  updateTrackScrollbar();
  if (!virtualState || virtualScrollRaf) return;
  virtualScrollRaf = requestAnimationFrame(() => {
    virtualScrollRaf = 0;
    renderVirtualWindow();
  });
}, { passive: true });

// ---------- 主列表自绘滚动条（2026-11-22 用户要求「更长、更透明」） ----------
// 虚拟列表 scrollHeight 数万 px，原生 thumb 只剩几像素，CSS 无法拉长 →
// 隐藏原生（CSS #track-list::-webkit-scrollbar width:0），这里画一个 fixed
// overlay：thumb 保底 72px、颜色更透明；支持拖拽、轨道点击跳转、滚轮转发。
const trackSb = document.createElement('div');
trackSb.id = 'track-scrollbar';
const trackSbThumb = document.createElement('div');
trackSbThumb.className = 'tsb-thumb';
trackSb.appendChild(trackSbThumb);
document.body.appendChild(trackSb);
let trackSbDrag = null; // { dy, prevBehavior }

function trackSbHidden() {
  const list = $('track-list');
  // offsetParent 为 null = 容器自身或祖先 display:none（电台视图等）
  return !list || !list.offsetParent || list.scrollHeight <= list.clientHeight + 1;
}

function updateTrackScrollbar() {
  const list = $('track-list');
  if (!list) return;
  if (trackSbHidden()) {
    if (trackSb.style.display !== 'none') trackSb.style.display = 'none';
    return;
  }
  const r = list.getBoundingClientRect();
  trackSb.style.display = 'block';
  trackSb.style.left = Math.round(r.right - 9) + 'px';
  trackSb.style.top = Math.round(r.top) + 'px';
  trackSb.style.height = Math.round(r.height) + 'px';
  // thumb 长度 = 视口占比 × 轨道，保底 72px（这就是「更长」的来源）
  const thumbH = Math.max(72, Math.min(r.height, Math.round((list.clientHeight / list.scrollHeight) * r.height)));
  const maxScroll = list.scrollHeight - list.clientHeight;
  const progress = maxScroll > 0 ? list.scrollTop / maxScroll : 0;
  trackSbThumb.style.height = thumbH + 'px';
  trackSbThumb.style.top = Math.round(progress * (r.height - thumbH)) + 'px';
}

function trackSbApplyThumb(topPx) {
  const list = $('track-list');
  const h = trackSb.getBoundingClientRect().height;
  const thumbH = trackSbThumb.offsetHeight;
  const maxTop = Math.max(1, h - thumbH);
  const clamped = Math.max(0, Math.min(maxTop, topPx));
  trackSbThumb.style.top = clamped + 'px';
  const maxScroll = list.scrollHeight - list.clientHeight;
  // thumb 被保底拉长后端点仍精确：进度线性映射到滚动范围
  if (maxScroll > 0) list.scrollTop = (clamped / maxTop) * maxScroll;
}

trackSb.addEventListener('pointerdown', (e) => {
  const list = $('track-list');
  if (!list || trackSbHidden()) return;
  e.preventDefault();
  const r = trackSb.getBoundingClientRect();
  const thumbH = trackSbThumb.offsetHeight;
  const thumbTop = parseFloat(trackSbThumb.style.top) || 0;
  const inThumb = e.clientY >= r.top + thumbTop && e.clientY <= r.top + thumbTop + thumbH;
  // 点在 thumb 上：从当前位置拖；点在轨道上：thumb 中心对准点击处并继续拖
  trackSbDrag = { dy: inThumb ? (e.clientY - r.top - thumbTop) : thumbH / 2, prevBehavior: list.style.scrollBehavior };
  if (!inThumb) trackSbApplyThumb(e.clientY - r.top - thumbH / 2);
  trackSb.classList.add('dragging');
  trackSb.setPointerCapture(e.pointerId);
  // 拖拽期间禁用 CSS smooth，避免每次 scrollTop 赋值都变成动画
  list.style.scrollBehavior = 'auto';
});
trackSb.addEventListener('pointermove', (e) => {
  if (!trackSbDrag) return;
  trackSbApplyThumb(e.clientY - trackSb.getBoundingClientRect().top - trackSbDrag.dy);
});
function trackSbEndDrag(e) {
  if (!trackSbDrag) return;
  const list = $('track-list');
  list.style.scrollBehavior = trackSbDrag.prevBehavior || '';
  trackSbDrag = null;
  trackSb.classList.remove('dragging');
  try { trackSb.releasePointerCapture(e.pointerId); } catch (_) { /* 已释放 */ }
}
trackSb.addEventListener('pointerup', trackSbEndDrag);
trackSb.addEventListener('pointercancel', trackSbEndDrag);
// 鼠标停在滚动条上时滚轮也能滚列表（原生滚动条才有这个行为）
trackSb.addEventListener('wheel', (e) => {
  const list = $('track-list');
  if (!list) return;
  e.preventDefault();
  list.scrollTop += e.deltaY;
}, { passive: false });
window.addEventListener('resize', updateTrackScrollbar);

// 创建单行元素（抽离出来，同步和分批渲染共用）
// 网络歌曲行（灰色、不可播放）：右键弹菜单跳 QQ/网易云试听或复制歌名
let onlineCtxTrack = null;
function createOnlineTrackRow(t) {
  const row = document.createElement('div');
  row.className = 'track-row online-row';
  const srcLabel = t.source === 'qqmusic' ? 'QQ音乐' : '网易云音乐';

  const cIndex = document.createElement('div');
  cIndex.className = 't-index';
  cIndex.textContent = '♪';
  cIndex.title = '网络歌曲（本地未下载）';

  const cTitle = document.createElement('div');
  cTitle.className = 't-title';
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = t.title;
  txt.title = t.title;
  const badge = document.createElement('span');
  // 来源徽标取代灰色「在线」框：淡绿底 QQ音乐 / 淡红底 网易云（用户指定配色）
  badge.className = 'online-badge ' + (t.source === 'netease' ? 'ne' : 'qq');
  badge.textContent = t.source === 'netease' ? '网易云' : 'QQ音乐';
  badge.title = '来自' + srcLabel + '的搜索结果，单击可跳转试听';
  cTitle.append(txt, badge);

  const cArtist = document.createElement('div');
  cArtist.className = 't-artist';
  cArtist.textContent = t.artist;

  const cAlbum = document.createElement('div');
  cAlbum.className = 't-album';
  cAlbum.textContent = t.album || '';

  row.append(cIndex, cTitle, cArtist, cAlbum);
  // 单击直接跳对应平台试听：结果自带 source（qqmusic/netease），不用再右键选平台
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    openPlatformPage(t.source === 'netease' ? 'netease' : 'qqmusic', 'song', t);
  });
  row.addEventListener('dblclick', (e) => e.stopPropagation());
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeAllFloatMenus();
    onlineCtxTrack = t;
    showOnlineTrackMenu(e);
  });
  return row;
}

function showOnlineTrackMenu(e) {
  const menu = $('online-track-menu');
  menu.hidden = false;
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const w = menu.offsetWidth || 200;
  const h = menu.offsetHeight || 140;
  let x = e.clientX;
  if (x + w > window.innerWidth) x = window.innerWidth - w - 5;
  if (x < 0) x = 5;
  let y = e.clientY;
  if (y + h > window.innerHeight) y = e.clientY - h;
  if (y < 0) y = 5;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.visibility = 'visible';
}

// 网络歌曲菜单项：跳平台试听（悬停预热，与歌单右键同一套缓存）+ 复制歌名
document.querySelectorAll('#online-track-menu .ctx-item').forEach((item) => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    $('online-track-menu').hidden = true;
    const t = onlineCtxTrack;
    if (!t) return;
    const action = item.dataset.action;
    if (action === 'online-qqmusic' || action === 'online-netease') {
      openPlatformPage(action === 'online-qqmusic' ? 'qqmusic' : 'netease', 'song', t);
    } else if (action === 'copy-online-title') {
      (async () => {
        const name = t.title || '';
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(name);
          } else {
            const ta = document.createElement('textarea');
            ta.value = name;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          }
          toast('已复制歌名：' + name);
        } catch (err) { toast('复制失败'); }
      })();
    } else if (action === 'get-download') {
      // 免费下载链接：双平台精确匹配后取播放直链；免费→复制链接，会员→提示
      (async () => {
        toast('正在获取免费下载链接…');
        let r = null;
        try {
          r = window.mb.getDownloadLink ? await window.mb.getDownloadLink(t.artist, t.title, t.duration || 0) : null;
        } catch (err) { r = null; }
        if (r && r.ok && r.url && !r.trial) {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(r.url);
            }
            toast('已复制' + r.platform + '免费下载链接' + (r.br ? '（' + Math.round(r.br / 1000) + 'kbps）' : ''));
          } catch (err) {
            toast(r.platform + '有免费下载链接，但复制剪贴板失败');
          }
        } else if (r && r.ok && r.trial) {
          toast(r.platform + '：该歌只有试听片段（会员资源），没有完整免费链接');
        } else if (r && r.vip) {
          toast('会员歌曲，无法免费获取下载链接');
        } else {
          toast('没获取到免费下载链接（可能已下架或匹配失败）');
        }
      })();
    }
  });
  item.addEventListener('mouseenter', () => {
    const a = item.dataset.action;
    if (onlineCtxTrack && (a === 'online-qqmusic' || a === 'online-netease')) {
      resolveOnlineData(a === 'online-qqmusic' ? 'qqmusic' : 'netease', 'song', onlineCtxTrack);
    }
  });
});

function createTrackRow(t, i, cur) {
  // 网络歌曲行（歌手筛选追加的灰色行）：独立构建，不可播放
  if (t.isOnline) return createOnlineTrackRow(t);
  const isPlaceholder = t.isPlaceholder === true;
  const row = document.createElement('div');
  row.className = 'track-row' + (cur === t ? ' current' : '') + (cur === t && S.playing ? ' playing' : '') + (isPlaceholder ? ' placeholder' : '');
  row.dataset.idx = S.tracks.indexOf(t);

  const cIndex = document.createElement('div');
  cIndex.className = 't-index';
  const eq = document.createElement('span');
  eq.className = 'eq';
  eq.innerHTML = '<i></i><i></i><i></i>';
  const idxNum = document.createElement('span');
  idxNum.className = 'idx-num';
  idxNum.textContent = S.tracks.indexOf(t) + 1;
  cIndex.append(eq, idxNum);

  const cTitle = document.createElement('div');
  cTitle.className = 't-title';
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = t.title;
  txt.title = t.title;
  cTitle.append(txt);
  // 占位/缺失歌曲添加"缺失"标签
  if (isPlaceholder) {
    const missingBadge = document.createElement('span');
    missingBadge.className = 'missing-badge';
    missingBadge.textContent = '缺失';
    missingBadge.title = t.isMissing
      ? ('文件缺失（原路径：' + (t.path || '') + '），条目保留供对照找回')
      : '本地无此歌曲，仅为QQ音乐歌单占位';
    cTitle.append(missingBadge);
  }
  // 音质标记
  const qBadge = document.createElement('span');
  qBadge.className = 'quality-badge ' + (getQualityInfo(t.path)?.cls || '');
  qBadge.textContent = getQualityInfo(t.path)?.label || '';
  qBadge.title = getQualityInfo(t.path)?.title || '';
  if (getQualityInfo(t.path)) cTitle.append(qBadge);
  if (S.settings.fixedTracks && S.settings.fixedTracks[t.path]) {
    const fixedBadge = document.createElement('span');
    fixedBadge.className = 'fixed-badge';
    fixedBadge.title = '已自动修复';
    fixedBadge.innerHTML = '✓';
    cTitle.append(fixedBadge);
  }
  if (S.settings.lockedTracks && S.settings.lockedTracks[t.path]) {
    const lockBadge = document.createElement('span');
    lockBadge.className = 'lock-badge';
    lockBadge.title = '已锁定（自动修复时跳过）';
    lockBadge.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" fill="currentColor"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    cTitle.append(lockBadge);
  }

  const cArtist = document.createElement('div');
  cArtist.className = 't-artist';
  cArtist.textContent = t.artist;
  cArtist.title = t.artist + '（双击查看该歌手的全部音乐）';
  // 单击只选中整行（不阻止冒泡），双击才筛选 —— 避免翻列表时误进筛选页
  cArtist.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    toggleTrackFilter('artist', t.artist);
  });
  const cAlbum = document.createElement('div');
  cAlbum.className = 't-album';
  cAlbum.textContent = t.album;
  cAlbum.title = t.album + '（点击筛选该专辑，自动联网补齐其余歌曲）';
  cAlbum.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTrackFilter('album', t.album);
  });

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  
  if (isPlaceholder) {
    // 占位/缺失歌曲：只显示一个"缺失"提示按钮，禁用所有操作
    const btnMissing = document.createElement('button');
    btnMissing.className = 'row-missing-btn';
    btnMissing.title = t.isMissing ? '文件缺失，无法播放（条目保留供对照找回）' : '本地无此歌曲，无法播放';
    btnMissing.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16" r="1" fill="currentColor"/></svg>';
    btnMissing.addEventListener('click', (e) => {
      e.stopPropagation();
      toast(t.isMissing ? '文件缺失，无法播放（可导出缺失名单对照找回）' : '本地无此歌曲，无法播放');
    });
    actions.append(btnMissing);
  } else {
    // 正常歌曲：显示收藏、歌单、播放、下一首按钮
    // 收藏按钮
    const btnFav = document.createElement('button');
    btnFav.className = 'row-fav-btn' + (isFavorite(t.path) ? ' faved' : '');
    btnFav.title = isFavorite(t.path) ? '取消收藏' : '收藏';
    btnFav.innerHTML = isFavorite(t.path) ? HEART_SVG : HEART_OUTLINE_SVG;
    btnFav.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(t.path);
    });
    // 歌单按钮
    const btnPlaylist = document.createElement('button');
    btnPlaylist.className = 'row-playlist-btn';
    btnPlaylist.title = '添加到歌单';
    btnPlaylist.innerHTML = PLAYLIST_SVG;
    btnPlaylist.addEventListener('click', (e) => {
      e.stopPropagation();
      showPlaylistMenu(e, t.path);
    });
    const btnPlay = document.createElement('button');
    btnPlay.title = '播放';
    btnPlay.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
    btnPlay.addEventListener('click', (e) => { e.stopPropagation(); playAt(S.tracks.indexOf(t)); });
    const btnNext = document.createElement('button');
    btnNext.title = '下一首播放';
    btnNext.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 5v14l9-7zM16 5h2v14h-2zM13 9l3 3-3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btnNext.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = S.tracks.indexOf(t);
      if (S.current >= 0 && idx !== S.current + 1) {
        S.tracks.splice(idx, 1);
        S.tracks.splice(S.current + 1, 0, t);
        renderList();
        toast('已添加到下一首播放');
      }
    });
    actions.append(btnFav, btnPlaylist, btnPlay, btnNext);
  }

  row.append(cIndex, cTitle, cArtist, cAlbum, actions);
  const rowIdx = S.tracks.indexOf(t);
  if (S.multiSel.has(t) || S.selectedIdx === rowIdx) row.classList.add('selected');
  // 单击只选中，不播放：避免翻列表时误点打断正在听的歌（双击才播）
  // Ctrl+点击 多选/取消，Shift+点击 范围选
  row.addEventListener('click', (e) => setSelectedRow(rowIdx, e));
  row.addEventListener('dblclick', (e) => {
    // 行内按钮（收藏/歌单/播放/下一首）双击不该触发整行播放
    if (e.target.closest('.row-actions, .t-artist, .t-album')) return;
    if (t.isPlaceholder) {
      toast('本地无此歌曲，无法播放');
      return;
    }
    playAt(rowIdx);
  });
  return row;
}

// 选中行：只切类名，不重渲染（大数据集下重渲染会明显卡顿）
// 修饰键：Ctrl=增减选，Shift=范围选（按当前视图顺序），无修饰=单选（清掉多选）
function setSelectedRow(idx, e) {
  const t = S.tracks[idx];
  if (!t) return;
  const ctrl = e && (e.ctrlKey || e.metaKey);
  const shift = e && e.shiftKey;
  if (shift && S.selAnchor && S.view.includes(S.selAnchor) && S.view.includes(t)) {
    const a = S.view.indexOf(S.selAnchor);
    const b = S.view.indexOf(t);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (!ctrl) S.multiSel.clear();
    for (let i = lo; i <= hi; i++) S.multiSel.add(S.view[i]);
    S.selectedIdx = idx;
  } else if (ctrl) {
    if (S.multiSel.has(t)) {
      S.multiSel.delete(t);
      if (S.selectedIdx === idx) {
        const last = [...S.multiSel].pop();
        S.selectedIdx = last !== undefined ? S.tracks.indexOf(last) : -1;
      }
    } else {
      S.multiSel.add(t);
      S.selectedIdx = idx;
    }
    S.selAnchor = t;
  } else {
    S.multiSel.clear();
    S.multiSel.add(t);
    S.selectedIdx = idx;
    S.selAnchor = t;
  }
  refreshSelectionClasses();
  renderStats();
}

// 只刷新选中态类名（虚拟滚动下行可能不在 DOM，安全跳过）
function refreshSelectionClasses() {
  document.querySelectorAll('.track-row.selected').forEach(el => {
    const i = parseInt(el.dataset.idx, 10);
    const tr = S.tracks[i];
    if (!tr || !S.multiSel.has(tr)) el.classList.remove('selected');
  });
  S.multiSel.forEach(tr => {
    const i = S.tracks.indexOf(tr);
    if (i < 0) return;
    const row = document.querySelector(`.track-row[data-idx="${i}"]`);
    if (row) row.classList.add('selected');
  });
}

// 多选快捷批量操作后的清理：把已不在曲库里的对象从多选集合剔掉
function pruneMultiSel() {
  const live = new Set(S.tracks);
  S.multiSel.forEach(t => { if (!live.has(t)) S.multiSel.delete(t); });
  if (S.selAnchor && !live.has(S.selAnchor)) S.selAnchor = null;
}

// ---------- 鼠标侧键导航：后退 / 前进 ----------
// 和资源管理器一致：侧下键（X1 / button 3）= 后退，侧上键（X2 / button 4）= 前进。
// 只有「后退过」才有前进记录，所以侧上键正好用来撤销误触的后退。
// 这里记的是「页面」而不是播放历史：文件夹 / 歌单 / 收藏 / 筛选 / 搜索 / 电台视图。
const navHistory = [];   // 每项是进入下一级之前的页面快照
const navFuture = [];    // 后退时暂存的页面，前进时逐步放回

function navSnapshot() {
  return {
    view: S.currentView,
    folder: S.activeFolder,
    playlist: S.activePlaylist,
    favorites: !!S.showFavorites,
    filterField: S.filterField,
    filterValue: S.filterValue,
    keyword: S.keyword || '',
    scroll: $('track-list') ? $('track-list').scrollTop : 0
  };
}

// 在「即将离开当前页面」之前调用，把当前页压入历史
function pushNav() {
  const snap = navSnapshot();
  const last = navHistory[navHistory.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(snap)) return;
  navHistory.push(snap);
  navFuture.length = 0;                 // 产生新导航后，旧的前进链作废（和标准浏览器一致）
  if (navHistory.length > 60) navHistory.shift();
}

function applyNavSnapshot(s) {
  S.currentView = s.view;
  S.activeFolder = s.folder;
  S.activePlaylist = s.playlist;
  S.showFavorites = s.favorites;
  S.filterField = s.filterField;
  S.filterValue = s.filterValue;
  S.keyword = s.keyword || '';
  // 灰色网络歌曲行跟着筛选走：后退/前进回到歌手/专辑筛选时重新加载（有会话缓存，秒出）
  if ((S.filterField === 'artist' || S.filterField === 'album') && S.filterValue) {
    loadOnlineExtras(S.filterField, S.filterValue);
  } else clearOnlineExtras();
  const searchEl = $('search');
  if (searchEl) searchEl.value = S.keyword;
  const clearBtn = $('search-clear');
  if (clearBtn) clearBtn.hidden = !S.keyword;
  switchView(s.view);                   // 内部会 renderList / renderRadioList
  renderSidebar();
  renderFolders();
  const listEl = $('track-list');
  if (listEl && s.view === 'music') {
    // #track-list 的 CSS 是 scroll-behavior:smooth —— 直接赋 scrollTop 会
    // 播一段「从顶滑到底」的动画（2026-11-19 反馈）。后退/前进要的是瞬时定位：
    // 临时把 behavior 切成 auto，落位后再恢复。
    const prev = listEl.style.scrollBehavior;
    listEl.style.scrollBehavior = 'auto';
    listEl.scrollTop = s.scroll || 0;
    listEl.style.scrollBehavior = prev;
  }
}

function navBack() {
  if (!navHistory.length) return false;
  navFuture.push(navSnapshot());        // 当前页存进前进链，供误触后恢复
  applyNavSnapshot(navHistory.pop());
  return true;
}

function navForward() {
  if (!navFuture.length) return false;  // 没后退过就没有前进，静默忽略
  navHistory.push(navSnapshot());
  applyNavSnapshot(navFuture.pop());
  return true;
}

// 弹窗/菜单打开时不响应侧键，免得误触把背后的页面换了
function navModalOpen() {
  const nodes = document.querySelectorAll('[id$="-modal"], [id$="-menu"], [id$="-popover"]');
  for (const el of nodes) {
    if (!el.hidden && getComputedStyle(el).display !== 'none' && el.style.visibility !== 'hidden') return true;
  }
  return false;
}

// 歌手/专辑筛选的唯一入口：所有进入/退出都走这里，避免状态各写一份导致卡在筛选页。
function clearTrackFilter(silent) {
  if (!S.filterField && !S.filterValue) return false;
  pushNav();
  S.filterField = null;
  S.filterValue = '';
  clearOnlineExtras(); // 灰色网络歌曲行只属于歌手/专辑筛选，退出就撤
  renderList();
  if (!silent) toast('已退出筛选');
  return true;
}
function toggleTrackFilter(field, value) {
  if (!value) return;
  if (S.filterField === field && S.filterValue === value) { clearTrackFilter(); return; }
  pushNav();
  S.filterField = field;
  S.filterValue = value;
  // 歌手/专辑筛选都追加网络歌曲；缺失筛选一律不带
  if (field === 'artist' || field === 'album') loadOnlineExtras(field, value); else clearOnlineExtras();
  renderList();
  toast('已筛选' + (field === 'artist' ? '歌手：' : '专辑：') + value);
}

function renderStats() {
  const total = S.tracks.length;
  const missingCount = S.tracks.filter(t => t.isMissing).length;
  const placeholderCount = S.tracks.filter(t => t.isPlaceholder && !t.isMissing).length;
  const realCount = total - missingCount - placeholderCount;
  let parts = ['<b>' + realCount + '</b> 首曲目'];
  if (missingCount > 0) {
    parts.push('<span style="color: #ff9800;">' + missingCount + ' 首文件缺失（条目保留）</span>');
  }
  if (placeholderCount > 0) {
    // 半透明红：信息弱化但可读，太扎眼（#f44336 全饱和）会抢主内容的视觉焦点
    parts.push('<span id="placeholder-stat" style="color: rgba(244, 67, 54, 0.55); cursor: context-menu;" title="右键可删除全部占位条目">' + placeholderCount + ' 首缺失（占位）</span>');
  }
  parts.push('<b>' + S.folders.size + '</b> 个文件夹');
  // 多选状态：Ctrl/Shift 多选后显示，点击 ✕ 清除
  if (S.multiSel.size > 1) {
    parts.push('<span class="filter-tag" id="multi-sel-tag" role="button" title="点击清除多选（ESC 也可）">已选 ' + S.multiSel.size + ' 首 ✕ 清除</span>');
  }
  // 显示筛选状态
  if (S.filterField && S.filterValue) {
    const fieldName = S.filterField === 'artist' ? '歌手' : '专辑';
    const label = S.filterField === 'missing'
      ? '筛选：缺失歌曲 ✕ 退出'
      : '筛选' + fieldName + '：' + S.filterValue + ' ✕ 退出';
    parts.push('<span class="filter-tag" id="filter-tag" role="button" title="点击退出筛选">' + label + '</span>');
  }
  $('stats').innerHTML = parts.join('<br>');
  // 绑定筛选标签点击事件
  const filterTag = $('filter-tag');
  if (filterTag) {
    filterTag.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTrackFilter();
    });
  }
  const multiTag = $('multi-sel-tag');
  if (multiTag) {
    multiTag.addEventListener('click', (e) => {
      e.stopPropagation();
      clearMultiSel();
    });
  }
}

// 清除多选：回到无选中状态（单选的 active 行也一并清掉）
function clearMultiSel() {
  S.multiSel.clear();
  S.selAnchor = null;
  S.selectedIdx = -1;
  refreshSelectionClasses();
  renderStats();
}

// ---------- 电台功能 ----------
function switchView(view) {
  // 进入电台页时同步「正在播放」条
  if (view === 'radio' && typeof updateRadioNowBar === 'function') updateRadioNowBar();
  S.currentView = view;
  // 更新导航项状态
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === view);
  });
  // 切换视图显示
  if (view === 'radio') {
    $('radio-view').style.display = '';
    $('track-head').style.display = 'none';
    $('track-list').style.display = 'none';
    $('empty-state').style.display = 'none';
    $('music-library-section').style.display = 'none';
    hideScanStatus(); // 切换到电台时隐藏扫描进度
    updateFloatButtons(); // 电台视图下两个悬浮按钮都隐藏
    updateTrackScrollbar(); // 列表已隐藏，收掉自绘滚动条
    renderRadioList();
    // 第一次真正打开电台页才静默检测各台可播状态（不打开就不发请求、不加载 hls.js）
    if (!radioAutoChecked) {
      radioAutoChecked = true;
      setTimeout(() => {
        // 进来又马上走了：撤销本次，等下次进入再测
        if (S.currentView !== 'radio') { radioAutoChecked = false; return; }
        try { checkAllRadios(true); } catch (e) { console.error('自动检测电台失败:', e); }
      }, 600);
    }
  } else {
    $('radio-view').style.display = 'none';
    releaseRadioViewResources(); // 离开电台视图就放掉电台专用 DOM / 解码器
    $('track-head').style.display = '';
    $('track-list').style.display = '';
    $('empty-state').style.display = S.tracks.length === 0 ? '' : 'none';
    $('music-library-section').style.display = '';
    // 切换回音乐库时，如果还在扫描就显示扫描进度
    if (isScanning) {
      showScanStatus();
    }
    renderList();
  }
}

// 电台多选模式
let radioMultiMode = false;
const selectedRadioNames = new Set();
function updateRadioMultiCount() {
  $('radio-multi-count').textContent = `已选 ${selectedRadioNames.size} 个`;
}
function enterRadioMultiMode() {
  radioMultiMode = true;
  selectedRadioNames.clear();
  $('radio-multi-bar').hidden = false;
  $('btn-radio-multi').classList.add('active');
  updateRadioMultiCount();
  renderRadioList();
}
function exitRadioMultiMode() {
  radioMultiMode = false;
  selectedRadioNames.clear();
  $('radio-multi-bar').hidden = true;
  $('btn-radio-multi').classList.remove('active');
  renderRadioList();
}
// ---------- 电台台标 / 最近播放 ----------
// 台标：站点首字 + 站点色底（没有指定色就用名字哈希出来的色相）
function radioLogoHTML(station, cls) {
  const name = station.name || '?';
  // 英文名取首字母，中文名取首字
  const ch = /[A-Za-z]/.test(name.charAt(0)) ? name.charAt(0).toUpperCase() : name.charAt(0);
  const color = station.color || `hsl(${hashHue(name + (station.url || ''))}, 52%, 42%)`;
  return `<div class="${cls} radio-logo" style="--logo:${color}">${escapeHtml(ch)}</div>`;
}

// 电台显示名：英文原名为主（加粗），中文译名作小字副行；国内台没有 cn 就只显示原名。
// 注意 station.name 本身不能改——收藏/最近/顶置全部按 name 匹配，改了会丢数据。
function radioNameHTML(station) {
  const badge = station.custom ? '<span class="custom-badge">自定义</span>' : '';
  if (!station.cn) return escapeHtml(station.name) + badge;
  return `<span class="rn-en">${escapeHtml(station.name)}</span>`
    + `<span class="rn-cn">${escapeHtml(station.cn)}</span>` + badge;
}

const RADIO_RECENT_KEY = 'radio_recent';
function loadRecentRadios() {
  try {
    const arr = JSON.parse(localStorage.getItem(RADIO_RECENT_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
  } catch (e) { return []; }
}
function pushRecentRadio(station) {
  try {
    let arr = loadRecentRadios().filter(n => n !== station.name);
    arr.unshift(station.name);
    if (arr.length > 12) arr = arr.slice(0, 12);
    localStorage.setItem(RADIO_RECENT_KEY, JSON.stringify(arr));
  } catch (e) { /* ignore */ }
}

// ---------- 电台收藏 ----------
// 只存电台名（电台本体在 RADIO_STATIONS / localStorage radio_custom 里），改名会自动失效
const RADIO_FAV_KEY = 'radio_fav';
function loadFavoriteRadios() {
  try {
    const arr = JSON.parse(localStorage.getItem(RADIO_FAV_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
  } catch (e) { return []; }
}
function saveFavoriteRadios(names) {
  try { localStorage.setItem(RADIO_FAV_KEY, JSON.stringify(names)); } catch (e) { /* ignore */ }
}
function isFavoriteRadio(name) {
  return loadFavoriteRadios().includes(name);
}
// 切换收藏，返回切换后的状态（true = 已收藏）
function toggleFavoriteRadio(station) {
  const names = loadFavoriteRadios();
  const i = names.indexOf(station.name);
  let on;
  if (i >= 0) { names.splice(i, 1); on = false; } else { names.unshift(station.name); on = true; }
  saveFavoriteRadios(names);
  station.fav = on;
  toast(on ? `已收藏：${station.name}` : `已取消收藏：${station.name}`);
  renderRadioList();
  return on;
}

// 电台「正在播放」条
function updateRadioNowBar() {
  const bar = $('radio-nowbar');
  if (!bar) return;
  const st = S.currentRadio;
  if (!st) { bar.hidden = true; return; }
  bar.hidden = false;
  const logo = $('radio-nowbar-logo');
  const color = st.color || `hsl(${hashHue(st.name + (st.url || ''))}, 52%, 42%)`;
  logo.className = 'radio-nowbar-logo radio-logo';
  logo.style.setProperty('--logo', color);
  logo.textContent = /[A-Za-z]/.test(st.name.charAt(0)) ? st.name.charAt(0).toUpperCase() : st.name.charAt(0);
  $('radio-nowbar-name').textContent = st.cn ? `${st.name}（${st.cn}）` : st.name;
  $('radio-nowbar-sub').textContent = `${st.category} · ${st.subcat}${st.desc ? ' · ' + st.desc : ''}`;
}

// 停止收听电台
function stopRadio() {
  destroyHls();
  audio.pause();
  try { audio.removeAttribute('src'); audio.load(); } catch (e) { /* ignore */ }
  S.currentRadio = null;
  S.playing = false;
  setPlaying(false);
  // 恢复进度条交互与文案
  $('seek').style.pointerEvents = '';
  $('seek-fill').style.width = '0%';
  $('cur-time').textContent = '0:00';
  $('dur-time').textContent = '0:00';
  $('now-title').textContent = '未在播放';
  setNowSub('—', '');
  updateRadioNowBar();
  renderRadioList();
  updateMediaSessionMeta();
  toast('已停止收听');
}

function renderRadioList() {
  const grid = $('radio-list');
  // 不在电台视图就不建节点（离开时列表已被清空），只记脏：避免后台反复重建几十个卡片
  if (S.currentView !== 'radio') { radioListDirty = true; return; }
  grid.innerHTML = '';
  const favNames = loadFavoriteRadios();
  // 排序/筛选统一走 getFilteredRadios()，保证和键盘上下切台、右键「播放」顺序一致
  const filtered = getFilteredRadios();
  // 空态（「收藏 / 最近」首次点进去时最容易为空）
  const emptyEl = $('radio-empty');
  if (emptyEl) {
    const heartSVG = `<svg class="radio-empty-icon" width="44" height="44" viewBox="0 0 24 24" fill="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const clockSVG = `<svg class="radio-empty-icon" width="44" height="44" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const emptyMsgs = {
      fav: [heartSVG, '还没有收藏的电台', '在电台卡片上点心形图标，或右键选择「收藏电台」'],
      recent: [clockSVG, '还没有听过的电台', '收听任意电台后会自动出现在这里，最多保留最近 12 个']
    };
    const msg = emptyMsgs[S.radioFilter];
    if (msg && filtered.length === 0) {
      emptyEl.innerHTML = `${msg[0]}<div class="radio-empty-title">${msg[1]}</div><div class="radio-empty-sub">${msg[2]}</div>`;
      emptyEl.hidden = false;
    } else {
      emptyEl.hidden = true;
      emptyEl.innerHTML = '';
    }
  }
  const isListView = S.radioViewMode === 'list';
  grid.className = isListView ? 'radio-list' : 'radio-grid';
  // 生成状态点 HTML
  function statusDot(station) {
    const status = station.status || 'unknown';
    const color = status === 'ok' ? '#4caf50' : status === 'error' ? '#f44336' : '#666';
    const title = status === 'ok' ? '可播放' : status === 'error' ? '播放失败' : '未测试';
    return `<span class="radio-status-dot" style="background:${color}" title="${title}"></span>`;
  }
  filtered.forEach((station) => {
    const isPlaying = S.currentRadio && S.currentRadio.url === station.url;
    const isFav = favNames.includes(station.name);
    const favBtnHTML = `<button class="radio-fav-btn${isFav ? ' on' : ''}" title="${isFav ? '取消收藏' : '收藏电台'}" aria-pressed="${isFav}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;
    const card = document.createElement('div');
    card.className = (isListView ? 'radio-list-item' : 'radio-card') + (isPlaying ? ' playing' : '') + (station.pinned ? ' pinned' : '');
    // 自定义卡片背景
    if (station.bgColor) {
      card.style.background = station.bgColor;
    }
    if (isListView) {
      // 列表视图
      card.innerHTML = `
        ${radioLogoHTML(station, 'radio-list-icon')}
        <div class="radio-list-info">
          <div class="radio-list-name">${radioNameHTML(station)}</div>
          <div class="radio-list-desc">${station.desc}</div>
        </div>
        <div class="radio-list-cat">${station.category} · ${station.subcat}</div>
        ${statusDot(station)}
        ${favBtnHTML}
        <button class="radio-pin-btn" title="${station.pinned ? '取消顶置' : '顶置'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${station.pinned ? 'currentColor' : 'none'}"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </button>
        <div class="radio-card-playing-indicator"><span></span><span></span><span></span></div>
      `;
    } else {
      // 卡片视图
      card.innerHTML = `
        ${statusDot(station)}
        ${radioLogoHTML(station, 'radio-card-icon')}
        <div class="radio-card-name-row">
          <button class="radio-pin-btn inline-pin ${station.pinned ? 'pinned' : ''}" title="${station.pinned ? '取消顶置' : '顶置'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${station.pinned ? 'currentColor' : 'none'}"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
          </button>
          <div class="radio-card-name">${radioNameHTML(station)}</div>
          <div class="radio-card-actions">
            ${favBtnHTML}
            ${station.custom ? `<button class="radio-delete-btn" title="删除电台">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>` : ''}
          </div>
        </div>
        <div class="radio-card-cat">${station.category} · ${station.subcat}</div>
        <div class="radio-card-desc">${station.desc}</div>
        <div class="radio-card-playing-indicator"><span></span><span></span><span></span></div>
      `;
    }
    // 多选模式：添加复选框和选中状态
    if (radioMultiMode) {
      card.classList.add('multi-select');
      if (selectedRadioNames.has(station.name)) card.classList.add('selected');
      const cb = document.createElement('div');
      cb.className = 'radio-checkbox';
      cb.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      card.insertBefore(cb, card.firstChild);
    }
    card.addEventListener('click', (e) => {
      // 多选模式：切换选中状态
      if (radioMultiMode) {
        e.stopPropagation();
        if (selectedRadioNames.has(station.name)) {
          selectedRadioNames.delete(station.name);
          card.classList.remove('selected');
        } else {
          selectedRadioNames.add(station.name);
          card.classList.add('selected');
        }
        updateRadioMultiCount();
        return;
      }
      // 点击顶置/收藏/删除按钮不触发播放
      if (e.target.closest('.radio-pin-btn') || e.target.closest('.radio-delete-btn') || e.target.closest('.radio-fav-btn')) return;
      playRadio(station);
    });
    // 电台右键菜单（所有电台都支持，删除仅自定义电台可用）
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showRadioContextMenu(e, station);
    });
    // 收藏按钮事件
    const favBtn = card.querySelector('.radio-fav-btn');
    if (favBtn) {
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavoriteRadio(station);
      });
    }
    // 顶置按钮事件（支持多个按钮）
    const pinBtns = card.querySelectorAll('.radio-pin-btn');
    pinBtns.forEach(pinBtn => {
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        station.pinned = !station.pinned;
        saveRadioPins();
        renderRadioList();
        toast(station.pinned ? `已顶置：${station.name}` : `已取消顶置：${station.name}`);
      });
    });
    // 删除按钮事件
    const delBtn = card.querySelector('.radio-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`确定要删除自定义电台「${station.name}」吗？`)) {
          deleteCustomRadio(station);
        }
      });
    }
    grid.appendChild(card);
  });
  radioListDirty = false;
}

// 保存顶置状态
function saveRadioPins() {
  const pins = RADIO_STATIONS.filter(s => s.pinned).map(s => s.name);
  try {
    localStorage.setItem('radio_pins', JSON.stringify(pins));
  } catch (e) {}
}
// 加载顶置状态
function loadRadioPins() {
  try {
    const pins = JSON.parse(localStorage.getItem('radio_pins') || '[]');
    RADIO_STATIONS.forEach(s => { s.pinned = pins.includes(s.name); });
  } catch (e) {}
}
loadRadioPins();

// 自定义电台加载和保存
function loadCustomRadios() {
  try {
    const custom = JSON.parse(localStorage.getItem('radio_custom') || '[]');
    custom.forEach(r => {
      r.custom = true;
      RADIO_STATIONS.push(r);
    });
  } catch (e) {}
}
function saveCustomRadios() {
  try {
    const custom = RADIO_STATIONS.filter(s => s.custom);
    localStorage.setItem('radio_custom', JSON.stringify(custom));
  } catch (e) {}
}
// 已删除的内置电台（按名称记录，启动时过滤）
let deletedRadioNames = [];
function loadDeletedRadios() {
  try {
    deletedRadioNames = JSON.parse(localStorage.getItem('radio_deleted') || '[]');
    // 从内置电台中过滤掉已删除的
    for (let i = RADIO_STATIONS.length - 1; i >= 0; i--) {
      if (!RADIO_STATIONS[i].custom && deletedRadioNames.includes(RADIO_STATIONS[i].name)) {
        RADIO_STATIONS.splice(i, 1);
      }
    }
  } catch (e) {}
}
function saveDeletedRadios() {
  try {
    localStorage.setItem('radio_deleted', JSON.stringify(deletedRadioNames));
  } catch (e) {}
}
loadCustomRadios();
loadDeletedRadios();

// 检测单个电台是否可播放
function checkRadioStation(station, timeout = 8000) {
  const isM3u8 = station.url.toLowerCase().includes('.m3u8');
  // m3u8 检测才需要 hls.js，按需拉一次；拉不到就退化成直接给 src（多半会判为不可用）
  const ready = (isM3u8 && !window.Hls) ? loadHls().catch(() => null) : Promise.resolve();
  return ready.then(() => new Promise((resolve) => {
    const tempAudio = new Audio();
    tempAudio.preload = 'none';
    tempAudio.volume = 0;
    let hls = null;
    let finished = false;
    // 每个临时解码器用完必须彻底释放（destroy + 摘 src + 解监听），
    // 否则一轮「检测全部」会攒下几十个 Hls 实例 / MSE 缓冲 / 直播连接
    const done = (ok) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      tempAudio.removeEventListener('canplay', onSuccess);
      tempAudio.removeEventListener('loadedmetadata', onSuccess);
      tempAudio.removeEventListener('error', onError);
      if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
      try {
        tempAudio.pause();
        tempAudio.removeAttribute('src');
        tempAudio.load();
      } catch (e) {}
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeout);
    const onSuccess = () => done(true);
    const onError = () => done(false);
    tempAudio.addEventListener('canplay', onSuccess);
    tempAudio.addEventListener('loadedmetadata', onSuccess);
    tempAudio.addEventListener('error', onError);
    if (isM3u8 && window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: false, lowLatencyMode: true });
      hls.loadSource(station.url);
      hls.attachMedia(tempAudio);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        tempAudio.play().then(onSuccess).catch(onError);
      });
      hls.on(Hls.Events.ERROR, (e, data) => {
        if (data.fatal) onError();
      });
    } else {
      tempAudio.src = station.url;
      tempAudio.play().then(() => {}).catch(() => {});
    }
  }));
}

// 一键检测所有电台（并发检测，每组 4 个）
let checkingRadios = false;
async function checkAllRadios(silent = false) {
  if (checkingRadios) { if (!silent) toast('正在检测中，请稍候...'); return; }
  checkingRadios = true;
  const btn = $('btn-radio-check');
  const originalText = btn ? btn.innerHTML : '';
  if (!silent && btn) {
    btn.innerHTML = '<span class="spin"></span> 检测中...';
    btn.disabled = true;
  }
  let okCount = 0, failCount = 0, doneCount = 0;
  const CONCURRENCY = 4; // 并发数
  // 静默检测只测「本次会话还没测过」的台：中途离开电台页会中断，下次进场接着测剩下的
  const targets = silent ? RADIO_STATIONS.filter(s => !s.status) : RADIO_STATIONS;
  const total = targets.length;
  const myToken = radioCheckToken;
  // 分批并发检测
  for (let i = 0; i < total; i += CONCURRENCY) {
    if (radioCheckToken !== myToken) break; // 用户离开电台页了，剩下的不测了
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(station =>
      checkRadioStation(station, 5000).then(ok => ({ station, ok }))
    ));
    results.forEach(({ station, ok }) => {
      station.status = ok ? 'ok' : 'error';
      if (ok) okCount++; else failCount++;
      doneCount++;
    });
    scheduleRadioListRender(); // 一批一次重渲染太多，节流到 ~250ms（只为了让状态点刷新）
    // 更新按钮显示进度
    if (!silent && btn) {
      btn.innerHTML = `<span class="spin"></span> 检测中 ${doneCount}/${total}`;
    }
  }
  if (!silent && btn) {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
  checkingRadios = false;
  if (!silent) {
    toast(`检测完成：可播放 ${okCount} 个，不可播放 ${failCount} 个`);
  }
}

// ---- 电台 HLS 实例 ----
let hlsInstance = null;
function destroyHls() {
  if (hlsInstance) {
    try { hlsInstance.destroy(); } catch (e) {}
    hlsInstance = null;
  }
}

// ---- hls.js 按需加载 / 空闲卸载 ----
// 电台是低频功能，618KB 的 hls.js 没必要每次启动都解析：真正要播/检测 m3u8 时才注入，
// 长时间不碰电台再把它摘掉（摘之前必须没有实例在跑，否则会打断播放）。
let hlsLoadP = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsLoadP) return hlsLoadP;
  hlsLoadP = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/hls.min.js';
    s.dataset.hls = '1';
    s.onload = () => {
      hlsLoadP = null;
      if (window.Hls) resolve(window.Hls);
      else reject(new Error('hls.js 初始化失败'));
    };
    s.onerror = () => { hlsLoadP = null; reject(new Error('hls.js 加载失败')); };
    document.head.appendChild(s);
  });
  return hlsLoadP;
}
let hlsIdleTimer = null;
function unloadHls() {
  // 有实例/在检测/正在听电台/正在加载时绝对不能摘
  if (hlsInstance || checkingRadios || S.currentRadio || hlsLoadP) return;
  clearTimeout(hlsIdleTimer);
  hlsIdleTimer = null;
  document.querySelectorAll('script[data-hls]').forEach(el => el.remove());
  try { delete window.Hls; } catch (e) { window.Hls = undefined; }
}
function scheduleHlsIdleUnload() {
  clearTimeout(hlsIdleTimer);
  const tick = () => {
    hlsIdleTimer = null;
    // 期间又回电台视图了就不摘
    if (S.currentView === 'radio') return;
    // 还在检测 / 还在听 / 正在加载：等一会儿再看，别把播放打断
    if (hlsInstance || checkingRadios || S.currentRadio || hlsLoadP) {
      hlsIdleTimer = setTimeout(tick, 15000);
      return;
    }
    unloadHls();
  };
  hlsIdleTimer = setTimeout(tick, 60000);
}

// 检测过程中状态点在变，全量重建 60 张卡片没必要：节流成 ~250ms 一次
let radioRenderTimer = null;
function scheduleRadioListRender() {
  if (radioRenderTimer) return;
  radioRenderTimer = setTimeout(() => {
    radioRenderTimer = null;
    renderRadioList();
  }, 250);
}

// 离开电台视图时释放电台专用资源（列表 DOM 是纯派生的，下次进场重渲染即可）
function releaseRadioViewResources() {
  const grid = $('radio-list');
  if (grid) grid.innerHTML = '';
  const emptyEl = $('radio-empty');
  if (emptyEl) { emptyEl.hidden = true; emptyEl.innerHTML = ''; }
  radioListDirty = true;
  radioCheckToken++; // 后台批量检测提前收工
  // 检测被打断：下次再进电台页接着测剩下的，不用从头再来
  if (checkingRadios) radioAutoChecked = false;
  if (!S.currentRadio) destroyHls(); // 没在听电台就把解码器也放掉
  scheduleHlsIdleUnload();
}

// 获取当前筛选和排序后的电台列表（用于上一首/下一首切换相邻电台）
function getFilteredRadios() {
  const favNames = loadFavoriteRadios();
  const statusRank = { ok: 0, unknown: 1, error: 2 };
  const sorted = [...RADIO_STATIONS].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    // 收藏紧跟在顶置之后
    const fa = favNames.includes(a.name), fb = favNames.includes(b.name);
    if (fa !== fb) return fa ? -1 : 1;
    const ra = statusRank[a.status || 'unknown'] ?? 1;
    const rb = statusRank[b.status || 'unknown'] ?? 1;
    if (ra !== rb) return ra - rb;
    return 0;
  });
  return sorted.filter(s => {
    if (S.radioFilter === 'all') return true;
    if (S.radioFilter === 'recent') return loadRecentRadios().includes(s.name);
    if (S.radioFilter === 'fav') return favNames.includes(s.name);
    if (S.radioFilter === '国内' || S.radioFilter === '国外') return s.category === S.radioFilter;
    return s.subcat === S.radioFilter;
  });
}

async function playRadio(station) {
  // 停止当前音乐播放
  audio.pause();
  destroyHls();
  S.current = -1;
  S.playing = false;
  // 判断是否是 m3u8 流
  const isM3u8 = station.url.toLowerCase().endsWith('.m3u8') || station.url.includes('.m3u8');
  // m3u8 才需要 hls.js，动态拉一把（普通 mp3 电台完全不碰这个库）
  if (isM3u8 && !window.Hls) {
    try {
      await loadHls();
    } catch (e) {
      station.status = 'error';
      renderRadioList();
      toast('电台组件加载失败：' + (e?.message || '未知错误'));
      return;
    }
  }
  const playSuccess = () => {
    S.currentRadio = station;
    S.playing = true;
    station.status = 'ok';
    setPlaying(true);
    // 更新显示
    $('now-title').textContent = station.cn ? `${station.name}（${station.cn}）` : station.name;
    setNowSub(station.category + ' · ' + station.subcat + ' 电台', '');
    $('cover').innerHTML = `<div style="width:100%;height:100%;background:${station.color};display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff;">${station.name.charAt(0)}</div>`;
    // 隐藏进度条（电台直播无时长）
    $('seek').style.pointerEvents = 'none';
    $('seek-fill').style.width = '0%';
    $('cur-time').textContent = '直播';
    $('dur-time').textContent = '';
    pushRecentRadio(station);
    renderRadioList();
    updateMediaSessionMeta();
    syncPlayerStateToShell();
    updateRadioNowBar();
    toast('正在播放：' + station.name);
  };
  const playFail = (e) => {
    toast('电台播放失败：' + (e?.message || '未知错误'));
    station.status = 'error';
    S.currentRadio = null;
    destroyHls(); // 失败也要拆掉解码器，否则 hlsInstance 常驻、空闲卸载会被挡住
    setPlaying(false);
    renderRadioList();
  };
  if (isM3u8 && window.Hls && Hls.isSupported()) {
    // 使用 hls.js 播放 m3u8
    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30,
      // 禁用缓存，避免 ERR_CACHE_OPERATION_NOT_SUPPORTED
      xhrSetup: function(xhr, url) {
        xhr.setRequestHeader('Cache-Control', 'no-cache');
        xhr.setRequestHeader('Pragma', 'no-cache');
      }
    });
    hlsInstance.loadSource(station.url);
    hlsInstance.attachMedia(audio);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      audio.play().then(playSuccess).catch(playFail);
    });
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        console.error('HLS 错误:', data);
        // 尝试恢复
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          try { hlsInstance.startLoad(); } catch(e) {}
        }
        playFail(new Error(data.details || 'HLS 播放失败'));
      }
    });
  } else {
    // 直接播放 MP3/AAC 流
    audio.src = station.url;
    audio.play().then(playSuccess).catch(playFail);
  }
}

// 导航项点击
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const view = item.dataset.view;
    if (view === 'favorites') {
      showFavoritesView();
    } else {
      // 切换到 music 或 radio 时清除收藏/歌单筛选
      if (view === 'music') {
        showAllMusicView();
      } else if (view === 'radio' && S.currentView !== 'radio') {
        pushNav();
      }
      switchView(view);
    }
  });
});

// 新建歌单按钮
$('add-playlist-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const name = await showInput('输入歌单名称：', '新歌单');
  if (name && name.trim()) {
    createPlaylist(name.trim());
  }
});

// 电台分类筛选
document.querySelectorAll('.radio-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.radio-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.radioFilter = btn.dataset.cat;
    renderRadioList();
  });
});

// 电台视图切换（卡片/列表）
document.querySelectorAll('.radio-view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.radio-view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.radioViewMode = btn.dataset.view;
    renderRadioList();
  });
});

// 停止收听
$('btn-radio-stop').addEventListener('click', stopRadio);

// 一键检测所有电台
$('btn-radio-check').addEventListener('click', checkAllRadios);

// 添加自定义电台
$('btn-radio-add').addEventListener('click', () => {
  editingRadioStation = null;
  $('radio-add-title').textContent = '添加自定义电台';
  $('btn-save-radio-add').textContent = '添加电台';
  $('radio-add-name').value = '';
  $('radio-add-url').value = '';
  $('radio-add-desc').value = '';
  showModal('radio-add-modal');
  setTimeout(() => $('radio-add-name').focus(), 100);
});
// 电台多选模式
$('btn-radio-multi').addEventListener('click', () => {
  if (radioMultiMode) exitRadioMultiMode();
  else enterRadioMultiMode();
});
$('btn-radio-multi-cancel').addEventListener('click', exitRadioMultiMode);
$('btn-radio-select-all').addEventListener('click', () => {
  const visible = document.querySelectorAll('.radio-card, .radio-list-item');
  if (selectedRadioNames.size === visible.length) {
    selectedRadioNames.clear();
  } else {
    RADIO_STATIONS.forEach(s => selectedRadioNames.add(s.name));
  }
  updateRadioMultiCount();
  renderRadioList();
});
$('btn-radio-delete-selected').addEventListener('click', () => {
  if (selectedRadioNames.size === 0) { toast('请先选择要删除的电台'); return; }
  if (!confirm(`确定要删除选中的 ${selectedRadioNames.size} 个电台吗？`)) return;
  const toDelete = RADIO_STATIONS.filter(s => selectedRadioNames.has(s.name));
  toDelete.forEach(s => deleteCustomRadio(s));
  exitRadioMultiMode();
  toast(`已删除 ${toDelete.length} 个电台`);
});
document.querySelectorAll('[data-close="radio-add"]').forEach(el => {
  el.addEventListener('click', () => {
    $('radio-add-modal').hidden = true;
    editingRadioStation = null;
    // 重置弹窗标题和按钮文本
    $('radio-add-title').textContent = '添加自定义电台';
    $('btn-save-radio-add').textContent = '添加电台';
  });
});
$('btn-save-radio-add').addEventListener('click', () => {
  const name = $('radio-add-name').value.trim();
  const url = $('radio-add-url').value.trim();
  const category = $('radio-add-category').value;
  const subcat = $('radio-add-subcat').value;
  const desc = $('radio-add-desc').value.trim();
  if (!name) { toast('请输入电台名称'); return; }
  if (!url) { toast('请输入流地址'); return; }
  if (editingRadioStation) {
    // 编辑模式：更新现有电台
    editingRadioStation.name = name;
    editingRadioStation.url = url;
    editingRadioStation.category = category;
    editingRadioStation.subcat = subcat;
    editingRadioStation.desc = desc || '自定义电台';
    editingRadioStation.status = 'unknown';
    saveCustomRadios();
    renderRadioList();
    $('radio-add-modal').hidden = true;
    editingRadioStation = null;
    toast('已保存修改：' + name);
    return;
  }
  // 新增模式
  const colors = ['#c62828', '#1565c0', '#6a1b9a', '#00838f', '#2e7d32', '#ef6c00', '#ad1457', '#4527a0', '#00695c', '#ff8f00'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const newStation = {
    name, category, subcat, url, desc: desc || '自定义电台',
    color, pinned: false, custom: true, status: 'unknown'
  };
  RADIO_STATIONS.push(newStation);
  saveCustomRadios();
  renderRadioList();
  $('radio-add-modal').hidden = true;
  toast('已添加自定义电台：' + name);
});

// 删除自定义电台（右键菜单）
function deleteCustomRadio(station) {
  const idx = RADIO_STATIONS.indexOf(station);
  if (idx >= 0) {
    RADIO_STATIONS.splice(idx, 1);
    // 内置电台记录到已删除列表，持久化
    if (!station.custom && !deletedRadioNames.includes(station.name)) {
      deletedRadioNames.push(station.name);
      saveDeletedRadios();
    }
    saveCustomRadios();
    renderRadioList();
    toast('已删除电台：' + station.name);
  }
}

// 当前右键的电台
let ctxRadioStation = null;

// 显示电台右键菜单
function showRadioContextMenu(e, station) {
  ctxRadioStation = station;
  closeAllFloatMenus();
  const menu = $('radio-context-menu');
  // 收藏项文案随当前收藏状态切换
  const favLabel = menu.querySelector('.ctx-fav-label');
  if (favLabel) favLabel.textContent = isFavoriteRadio(station.name) ? '取消收藏' : '收藏电台';
  // 所有电台都显示删除选项
  const deleteItem = menu.querySelector('[data-action="radio-delete"]');
  if (deleteItem) deleteItem.style.display = '';
  menu.hidden = false;
  // 定位菜单
  const menuWidth = menu.offsetWidth || 160;
  const menuHeight = menu.offsetHeight || 150;
  let x = e.clientX;
  let y = e.clientY;
  if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 5;
  if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 5;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

// 隐藏电台右键菜单
function hideRadioContextMenu() {
  $('radio-context-menu').hidden = true;
  ctxRadioStation = null;
}

// 点击其他地方隐藏右键菜单
document.addEventListener('click', (e) => {
  if (!e.target.closest('#radio-context-menu')) {
    hideRadioContextMenu();
  }
});

// 右键菜单项点击
document.querySelectorAll('#radio-context-menu .ctx-item').forEach(item => {
  item.addEventListener('click', () => {
    const action = item.dataset.action;
    const station = ctxRadioStation;
    hideRadioContextMenu();
    if (!station) return;
    if (action === 'radio-fav') {
      toggleFavoriteRadio(station);
    } else if (action === 'radio-edit') {
      openRadioEditModal(station);
    } else if (action === 'radio-bg') {
      openRadioBgModal(station);
    } else if (action === 'radio-delete') {
      if (confirm(`确定要删除电台「${station.name}」吗？`)) {
        deleteCustomRadio(station);
      }
    }
  });
});

// 编辑电台弹窗
let editingRadioStation = null;
function openRadioEditModal(station) {
  editingRadioStation = station;
  $('radio-add-title').textContent = '编辑电台';
  $('btn-save-radio-add').textContent = '保存修改';
  $('radio-add-name').value = station.name;
  $('radio-add-category').value = station.category;
  $('radio-add-subcat').value = station.subcat;
  $('radio-add-url').value = station.url;
  $('radio-add-desc').value = station.desc || '';
  showModal('radio-add-modal');
  setTimeout(() => $('radio-add-name').focus(), 100);
}

// 自定义卡片背景弹窗
let bgRadioStation = null;
function openRadioBgModal(station) {
  bgRadioStation = station;
  $('radio-bg-custom').value = station.bgColor || '#1a1d26';
  showModal('radio-bg-modal');
}
document.querySelectorAll('[data-close="radio-bg"]').forEach(el => {
  el.addEventListener('click', () => { $('radio-bg-modal').hidden = true; bgRadioStation = null; });
});
// 预设颜色按钮
document.querySelectorAll('.bg-color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!bgRadioStation) return;
    bgRadioStation.bgColor = btn.dataset.color;
    saveCustomRadios();
    renderRadioList();
    $('radio-bg-modal').hidden = true;
    bgRadioStation = null;
    toast('已应用卡片背景');
  });
});
// 自定义颜色
$('btn-apply-custom-bg').addEventListener('click', () => {
  if (!bgRadioStation) return;
  bgRadioStation.bgColor = $('radio-bg-custom').value;
  saveCustomRadios();
  renderRadioList();
  $('radio-bg-modal').hidden = true;
  bgRadioStation = null;
  toast('已应用自定义背景');
});
// 恢复默认背景
$('btn-reset-bg').addEventListener('click', () => {
  if (!bgRadioStation) return;
  delete bgRadioStation.bgColor;
  saveCustomRadios();
  renderRadioList();
  $('radio-bg-modal').hidden = true;
  bgRadioStation = null;
  toast('已恢复默认背景');
});

function renderFolders() {
  const ul = $('folder-list');
  ul.textContent = '';
  const all = document.createElement('li');
  all.className = 'folder-item' + (S.activeFolder === null ? ' active' : '');
  all.innerHTML = '<span class="fname">全部音乐</span>';
  // 刷新按钮（2026-11-22 用户要求：放在计数左边，即 刷新 → 数字）
  const refreshAll = document.createElement('button');
  refreshAll.className = 'frefresh';
  refreshAll.title = '刷新全部音乐';
  refreshAll.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M23 4v6h-6M1 20v-6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  refreshAll.addEventListener('click', (e) => { e.stopPropagation(); refreshAllFolders(); });
  const allCnt = document.createElement('span');
  allCnt.className = 'fcount';
  allCnt.textContent = S.tracks.length;
  all.append(refreshAll, allCnt);
  all.addEventListener('click', () => {
    pushNav();
    S.activeFolder = null;
    S.showFavorites = false;
    S.activePlaylist = null;
    S.filterField = null;
    S.filterValue = '';
    renderSidebar();
    renderFolders();
    renderList();
  });
  ul.appendChild(all);

  for (const [root, count] of S.folders) {
    const li = document.createElement('li');
    li.className = 'folder-item' + (S.activeFolder === root ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = root.split(/[\\/]/).pop() || root;
    name.title = root;
    const cnt = document.createElement('span');
    cnt.className = 'fcount';
    cnt.textContent = count;
    // 刷新按钮
    const refresh = document.createElement('button');
    refresh.className = 'frefresh';
    refresh.title = '刷新此文件夹';
    refresh.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M23 4v6h-6M1 20v-6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    refresh.addEventListener('click', (e) => { e.stopPropagation(); refreshSingleFolder(root); });
    li.append(name, refresh, cnt);
    li.addEventListener('click', () => {
      pushNav();
      S.activeFolder = root;
      S.showFavorites = false;
      S.activePlaylist = null;
      S.filterField = null;
      S.filterValue = '';
      renderSidebar();
      renderFolders();
      renderList();
    });
    // 右键 = 移除该文件夹（2026-11-22 用户反馈：× 按钮改为右键菜单入口）
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAllFloatMenus();
      showFolderCtxMenu(e.clientX, e.clientY, root);
    });
    ul.appendChild(li);
  }
}

// ---------- 文件夹刷新功能 ----------
let refreshRemovedExpanded = false;

// ---------- 缺失歌曲持久保留 ----------
// 文件消失的歌曲不再删除，而是打上 isMissing（同时挂 isPlaceholder 以复用缺失徽章/
// 禁播/批量跳过等既有逻辑），保留完整信息供用户对照找回；文件恢复后刷新自动找回。
function makeMissingTrack(saved) {
  return {
    path: saved.path,
    title: saved.title || '未知歌曲',
    artist: saved.artist || '未知歌手',
    album: saved.album || '',
    duration: saved.duration || 0,
    addedTime: saved.addedTime || Date.now(),
    root: saved.root || '__missing__',
    isPlaceholder: true,
    isMissing: true,
    missingSince: saved.missingSince || Date.now(),
    qqmusicId: saved.qqmusicId || null,
    qqmusicMid: saved.qqmusicMid || null,
    cover: null
  };
}
// 歌手名宽松比较：剔除括号注释（(ダラコ)、（feat. X）等），按 / 、 & 等拆多歌手，
// 任一歌手相同即算同一歌手——"DAOKO" ≈ "Daoko (ダラコ) / 米津玄師 (よねづけんし)"。
// 歌手名写法不统一曾导致同一首歌出现"缺失占位 + 已有文件"两条且真实文件被甩出歌单位置。
function normArtistParts(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw || raw === '未知歌手') return [];
  return raw.toLowerCase()
    .replace(/[（(［\[【][^）)］\]】]*[）)］\]】]/g, ' ')
    .split(/[/、・,&×+;；|，,]|\s+(?:featuring|feat|ft)\.?\s+/)
    .map(p => p.replace(/[\s\-_~`'"!！?？.。:：]/g, ''))
    .filter(Boolean);
}
function artistLooseMatch(a, b) {
  const A = normArtistParts(a), B = normArtistParts(b);
  if (!A.length && !B.length) return true;
  if (!A.length || !B.length) return false;
  return A.some(x => B.indexOf(x) >= 0);
}
// 同一首歌判定：歌名规范化后相同 + 歌手宽松匹配（专辑/版本差异不算，例：初回限定盤 vs 通常盤）
function sameSongMeta(a, b) {
  if (!a || !b || !a.title || !b.title) return false;
  return normalizeStr(a.title) === normalizeStr(b.title) && artistLooseMatch(a.artist, b.artist);
}
// 歌名里的注释分两类：
//   · 与音频无关的说明：影视剧名、（春雪）这类副标题、Explicit、单曲盘信息 → 去掉再比
//   · 不同音频的版本：Live / Remix / 伴奏 / Inst. / 加速版 → **保留**，否则现场版会被错配到录音室版
const LYRIC_TITLE_VERSION_RE = /(live|remix|remaster|inst\b|instrumental|伴奏|dj|mix|acoustic|unplugged|翻唱|cover|demo|现场|演唱会|片段|剪辑|加速|慢速|降调|升调|\d(?:\.\d+)?x\b)/i;
function looseTitleOf(title) {
  return normalizeStr(String(title || '').replace(
    /[（(［\[【]([^）)］\]】]*)[）)］\]】]/g,
    (m, inner) => (LYRIC_TITLE_VERSION_RE.test(inner) ? m : '')
  ));
}
// 宽松同曲判定：去注释歌名相同 + 歌手宽松匹配。
// QQ 歌单/本地文件名对同一首歌的写法经常不一致（「봄눈 (春雪)」vs「봄눈 (Spring Snow)」、
// 「Frankenstein (Explicit)」vs「Frankenstein」），只按精确歌名比会判成"缺失"，
// 于是曲库里明明有却显示缺失。所有"找到同一首歌"的地方统一用这一条。
function sameSongLoose(a, b) {
  if (!a || !b || !a.title || !b.title) return false;
  const x = looseTitleOf(a.title), y = looseTitleOf(b.title);
  if (!x || !y || x !== y) return false;
  return artistLooseMatch(a.artist, b.artist);
}
// 占位/缺失条目是否已被真实文件"顶掉"：曲库里已有同首歌的可播放文件
function isFulfilledEntry(t) {
  if (!t || !t.isPlaceholder) return false;
  return S.tracks.some(r => r !== t && !r.isPlaceholder && sameSongLoose(r, t));
}
// 找回匹配：先按原路径精确匹配（文件原位找回），再按歌名+歌手宽松匹配（改名/移动/歌手写法不统一后找回）
function findRecoverMatch(t) {
  const pathKey = (t.path || '').toLowerCase();
  if (pathKey && pathKey.indexOf('placeholder://') !== 0) {
    const byPath = S.tracks.findIndex(p => p.isMissing && (p.path || '').toLowerCase() === pathKey);
    if (byPath >= 0) return byPath;
  }
  const metaMatch = (p) => (p.isMissing || p.isPlaceholder) && sameSongLoose(p, t);
  let idx = S.tracks.findIndex(p => p.isMissing && metaMatch(p));
  if (idx >= 0) return idx;
  return S.tracks.findIndex(metaMatch);
}
// 找回替换：占位/缺失条目换真实文件，保留原位置；
// 必须同步歌单顺序表里的旧占位路径，否则重启后找回的歌会丢掉歌单位置
function replacePlaceholderAt(idx, t, fallbackTime) {
  const oldPath = S.tracks[idx].path;
  t.addedTime = S.tracks[idx].addedTime || fallbackTime;
  S.tracks[idx] = t;
  if (S.importedTrackOrder && S.importedTrackOrder.length > 0) {
    const oi = S.importedTrackOrder.indexOf(oldPath);
    if (oi >= 0) S.importedTrackOrder[oi] = t.path;
  }
}
// 把文件消失的歌曲整批标记为「缺失」（条目保留，供对照找回）
function markMissingTracks(gonePaths) {
  const goneSet = new Set(gonePaths.map(p => p.toLowerCase()));
  let marked = 0;
  S.tracks.forEach(t => {
    if (goneSet.has((t.path || '').toLowerCase()) && !t.isMissing) {
      t.isMissing = true;
      t.isPlaceholder = true; // 复用缺失徽章 / 禁播 / 批量跳过
      t.missingSince = Date.now();
      marked++;
    }
  });
  // 当前播放的歌已缺失：停止播放（条目保留）
  const cur = S.current >= 0 ? S.tracks[S.current] : null;
  if (cur && cur.isMissing) {
    audio.pause();
    S.current = -1;
    S.playing = false;
    setPlaying(false);
    $('now-title').textContent = '未播放';
    setNowSub('', '');
    $('cover').innerHTML = '';
  }
  return marked;
}

// 刷新单个文件夹
async function refreshSingleFolder(root) {
  if (isScanning) { toast('正在扫描中，请稍候'); return; }
  const myScan = ++scanCount;
  isScanning = true;
  showScanStatus();
  $('scan-text').textContent = '刷新中…';
  const sb = $('scan-bar'); if (sb) sb.style.width = '0%';
  try {
    // 记录刷新前该文件夹下的歌曲（排除占位/缺失歌曲）
    const beforePaths = new Set(S.tracks.filter(t => t.root === root && !t.isPlaceholder).map(t => t.path.toLowerCase()));
    // 重新扫描（与启动装载一致：递归扫描，否则子文件夹歌曲会被误判丢失）
    const tracks = await mb.scan([root], true);
    if (myScan !== scanCount) return;
    // 计算新增和减少（排除占位/缺失歌曲）
    const afterPaths = new Set(tracks.map(t => t.path.toLowerCase()));
    const addedTracks = tracks.filter(t => !beforePaths.has(t.path.toLowerCase()));
    const removedPaths = S.tracks.filter(t => t.root === root && !t.isPlaceholder && !afterPaths.has(t.path.toLowerCase())).map(t => t.path);
    // 扫描结果为空但原有歌曲：大概率是磁盘/网络盘未挂载，保留原条目不做标记
    if (removedPaths.length > 0 && afterPaths.size === 0 && beforePaths.size > 0) {
      isScanning = false;
      hideScanStatus();
      toast('扫描结果为空（磁盘可能未挂载），已保留原有条目');
      return;
    }
    // 文件消失的歌曲：标记为「缺失」保留条目（供对照找回），不再移入回收站/删除
    if (removedPaths.length > 0) {
      markMissingTracks(removedPaths);
    }
    // 添加新增的歌曲（push到底部，保证添加序号最大；排序显示时新→旧会排在顶部）
    // 如果新增歌曲和某个占位/缺失歌曲匹配（优先原路径，其次歌名+歌手），替换原条目而不是新增
    const now = Date.now();
    const realAdded = [];
    addedTracks.forEach((t, i) => {
      t.addedTime = now + i;
      // 查找匹配的占位/缺失歌曲（文件找回）
      const placeholderIdx = findRecoverMatch(t);
      if (placeholderIdx >= 0) {
        // 替换占位/缺失歌曲，保留原位置（并同步歌单顺序表旧路径）
        replacePlaceholderAt(placeholderIdx, t, now + i);
      } else {
        S.tracks.push(t);
        realAdded.push(t);
      }
    });
    // 更新文件夹计数
    S.folders.set(root, S.tracks.filter(t => t.root === root).length);
    // 新增歌曲处理：歌单顺序模式下叠顶并保持排序；其他模式沿用「切添加时间让新歌在顶部」
    if (realAdded.length > 0) {
      if (S.sortKey === 'qqmusic' || S.sortKey === 'netease') {
        stackNewTracksOnTop(realAdded);
      } else {
        S.sortKey = 'addedTime';
        S.sortDir = -1;
        updateSortLabel();
      }
    }
    // 渲染
    isScanning = false;
    renderFolders();
    renderList();
    hideScanStatus();
    saveConfig();
    // 显示结果弹窗
    showRefreshResult(realAdded.length, removedPaths.length, removedPaths, root.split(/[\\/]/).pop() || root);
  } catch (e) {
    window.__errs.push('refresh: ' + e);
    toast('刷新失败：' + e);
    isScanning = false;
    hideScanStatus();
  }
}

// 刷新全部音乐
async function refreshAllFolders() {
  if (isScanning) { toast('正在扫描中，请稍候'); return; }
  if (S.folders.size === 0) { toast('请先添加音乐文件夹'); return; }
  const myScan = ++scanCount;
  isScanning = true;
  showScanStatus();
  $('scan-text').textContent = '刷新中…';
  const sb = $('scan-bar'); if (sb) sb.style.width = '0%';
  try {
    // 记录刷新前所有歌曲（排除占位/缺失歌曲）
    const beforePaths = new Set(S.tracks.filter(t => !t.isPlaceholder).map(t => t.path.toLowerCase()));
    // 重新扫描所有文件夹（递归，与启动装载一致）
    const folderPaths = Array.from(S.folders.keys());
    const tracks = await mb.scan(folderPaths, true);
    if (myScan !== scanCount) return;
    // 计算新增和减少（排除占位/缺失歌曲）
    const afterPaths = new Set(tracks.map(t => t.path.toLowerCase()));
    const addedTracks = tracks.filter(t => !beforePaths.has(t.path.toLowerCase()));
    const removedPaths = S.tracks.filter(t => !t.isPlaceholder && !afterPaths.has(t.path.toLowerCase())).map(t => t.path);
    // 扫描结果为空但原有歌曲：大概率是磁盘/网络盘未挂载，保留原条目不做标记
    if (removedPaths.length > 0 && afterPaths.size === 0 && beforePaths.size > 0) {
      isScanning = false;
      hideScanStatus();
      toast('扫描结果为空（磁盘可能未挂载），已保留原有条目');
      return;
    }
    // 文件消失的歌曲：标记为「缺失」保留条目（供对照找回），不再移入回收站/删除
    if (removedPaths.length > 0) {
      markMissingTracks(removedPaths);
    }
    // 添加新增的歌曲（push到底部，保证添加序号最大；排序显示时新→旧会排在顶部）
    // 如果新增歌曲和某个占位/缺失歌曲匹配（优先原路径，其次歌名+歌手），替换原条目而不是新增
    const now = Date.now();
    const realAdded = [];
    addedTracks.forEach((t, i) => {
      t.addedTime = now + i;
      // 查找匹配的占位/缺失歌曲（文件找回）
      const placeholderIdx = findRecoverMatch(t);
      if (placeholderIdx >= 0) {
        // 替换占位/缺失歌曲，保留原位置（并同步歌单顺序表旧路径）
        replacePlaceholderAt(placeholderIdx, t, now + i);
      } else {
        S.tracks.push(t);
        realAdded.push(t);
      }
    });
    // 更新所有文件夹计数
    S.folders.forEach((_, root) => {
      S.folders.set(root, S.tracks.filter(t => t.root === root).length);
    });
    // 新增歌曲处理：歌单顺序模式下叠顶并保持排序；其他模式沿用「切添加时间让新歌在顶部」
    if (realAdded.length > 0) {
      if (S.sortKey === 'qqmusic' || S.sortKey === 'netease') {
        stackNewTracksOnTop(realAdded);
      } else {
        S.sortKey = 'addedTime';
        S.sortDir = -1;
        updateSortLabel();
      }
    }
    // 渲染
    isScanning = false;
    renderFolders();
    renderList();
    hideScanStatus();
    saveConfig();
    // 显示结果弹窗
    showRefreshResult(realAdded.length, removedPaths.length, removedPaths, '全部音乐');
  } catch (e) {
    window.__errs.push('refresh: ' + e);
    toast('刷新失败：' + e);
    isScanning = false;
    hideScanStatus();
  }
}

// 显示刷新结果弹窗
function showRefreshResult(added, removed, removedPaths, folderName) {
  $('refresh-result-title').textContent = '刷新完成 - ' + folderName;
  let summary = '';
  if (added > 0) {
    summary += '<div style="color: #4caf50;">✓ 新增 ' + added + ' 首歌曲</div>';
  } else {
    summary += '<div style="color: var(--text-dim);">未发现新增歌曲</div>';
  }
  if (removed > 0) {
    summary += '<div style="color: #ff9800;">⚠ ' + removed + ' 首歌曲文件缺失（条目已保留，可对照找回）</div>';
  } else {
    summary += '<div style="color: var(--text-dim);">未发现减少的歌曲</div>';
  }
  $('refresh-result-summary').innerHTML = summary;
  // 减少的歌曲列表
  if (removed > 0 && removedPaths && removedPaths.length > 0) {
    $('refresh-removed-section').hidden = false;
    const listEl = $('refresh-removed-list');
    listEl.innerHTML = removedPaths.map(p => {
      const fileName = p.split(/[\\/]/).pop() || p;
      return '<div style="padding: 3px 0; border-bottom: 1px solid var(--border);" title="' + p + '">' + fileName + '</div>';
    }).join('');
    // 默认展开
    refreshRemovedExpanded = true;
    $('refresh-removed-list').style.display = 'block';
    $('refresh-removed-arrow').style.transform = 'rotate(180deg)';
  } else {
    $('refresh-removed-section').hidden = true;
  }
  showModal('refresh-result-modal');
}

// 减少歌曲列表展开/收起
document.addEventListener('click', (e) => {
  if (e.target.closest('#refresh-removed-toggle')) {
    refreshRemovedExpanded = !refreshRemovedExpanded;
    $('refresh-removed-list').style.display = refreshRemovedExpanded ? 'block' : 'none';
    $('refresh-removed-arrow').style.transform = refreshRemovedExpanded ? 'rotate(180deg)' : 'rotate(0deg)';
  }
});

// 刷新结果弹窗关闭
document.querySelectorAll('[data-close="refresh-result"]').forEach(el => {
  el.addEventListener('click', () => { $('refresh-result-modal').hidden = true; });
});

// ---------- 回收站功能 ----------
const RECYCLE_BIN_DAYS = 7; // 回收站保留7天

// 添加歌曲到回收站
function addToRecycleBin(tracks) {
  const now = Date.now();
  tracks.forEach(t => {
    // 避免重复添加
    if (!S.recycleBin.some(r => r.path.toLowerCase() === t.path.toLowerCase())) {
      S.recycleBin.push({
        path: t.path,
        title: t.title || t.path.split(/[\\/]/).pop() || t.path,
        artist: t.artist || '',
        album: t.album || '',
        deletedAt: now
      });
    }
  });
  cleanupRecycleBin();
  renderRecycleBin();
  saveConfig();
}

// 清理超过7天的回收站记录
function cleanupRecycleBin() {
  const cutoff = Date.now() - RECYCLE_BIN_DAYS * 24 * 60 * 60 * 1000;
  const before = S.recycleBin.length;
  S.recycleBin = S.recycleBin.filter(r => r.deletedAt >= cutoff);
  if (S.recycleBin.length !== before) {
    renderRecycleBin();
    saveConfig();
  }
}

// 从回收站移除单条
function removeFromRecycleBin(path) {
  S.recycleBin = S.recycleBin.filter(r => r.path !== path);
  renderRecycleBin();
  saveConfig();
}

// 清空回收站
function clearRecycleBin() {
  S.recycleBin = [];
  renderRecycleBin();
  saveConfig();
  toast('回收站已清空');
}

// 渲染回收站分区
function renderRecycleBin() {
  const section = $('recycle-bin-section');
  if (!section) return;
  cleanupRecycleBin();
  const count = S.recycleBin.length;
  const countEl = $('recycle-bin-count');
  if (countEl) countEl.textContent = count;
  const listEl = $('recycle-bin-list');
  if (!listEl) return;
  listEl.textContent = '';
  if (count === 0) {
    const empty = document.createElement('div');
    empty.className = 'recycle-empty';
    empty.textContent = '回收站为空';
    listEl.appendChild(empty);
    return;
  }
  // 按删除时间倒序
  const sorted = [...S.recycleBin].sort((a, b) => b.deletedAt - a.deletedAt);
  sorted.forEach(item => {
    const li = document.createElement('li');
    li.className = 'recycle-item';
    li.title = '单击播放 | ' + item.path;
    const date = new Date(item.deletedAt);
    const dateStr = (date.getMonth() + 1) + '/' + date.getDate() + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    li.innerHTML = '<span class="recycle-title">' + (item.title || '未知') + '</span><span class="recycle-date">' + dateStr + '</span>';
    // 单击 = 播放（2026-11-22 用户要求回收站支持播放）
    li.addEventListener('click', () => { playRecycleItem(item); });
    // 右键菜单
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ctxRecycleItem = item;
      closeAllFloatMenus();
      const menu = $('recycle-context-menu');
      menu.hidden = false;
      // 边界检测
      menu.style.visibility = 'hidden';
      menu.style.left = '0px';
      menu.style.top = '0px';
      const menuWidth = menu.offsetWidth || 180;
      const menuHeight = menu.offsetHeight || 120;
      let x = e.clientX;
      if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 5;
      if (x < 0) x = 5;
      let y = e.clientY;
      if (y + menuHeight > window.innerHeight) {
        y = e.clientY - menuHeight;
        if (y < 0) y = 5;
      }
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      menu.style.visibility = 'visible';
    });
    listEl.appendChild(li);
  });
}

// 回收站右键菜单当前项目
let ctxRecycleItem = null;

// 回收站条目播放（2026-11-22 用户要求支持播放）：
// 所有播放机制（歌词/封面/媒体键/上一首下一首/队列）都建立在 S.tracks 之上，
// 曲库外裸播会破坏这些不变量，所以：已在曲库 → 曲库内播；不在曲库 → 重扫该文件
// 恢复到曲库顶部再播。回收站记录保留不清（恢复流程会提示"已在列表"并顺手清掉，
// 或 7 天自动清理）。文件已被删掉的才拒绝。
async function playRecycleItem(item) {
  try {
    if (window.mb && window.mb.fileExists) {
      const exists = await window.mb.fileExists(item.path);
      if (!exists) { toast('文件已不存在，无法播放'); return; }
    }
  } catch (e) {}
  const libIdx = S.tracks.findIndex(t => t.path.toLowerCase() === item.path.toLowerCase());
  if (libIdx >= 0) { playAt(libIdx); return; }
  try {
    const folder = item.path.replace(/[\\/][^\\/]+$/, '');
    const tracks = await mb.scan([folder], false);
    const found = tracks.find(t => t.path.toLowerCase() === item.path.toLowerCase());
    if (!found) { toast('未找到该歌曲文件，无法播放'); return; }
    found.addedTime = Date.now();
    S.tracks.unshift(found);
    if (S.folders.has(folder)) S.folders.set(folder, S.folders.get(folder) + 1);
    else S.folders.set(folder, 1);
    renderFolders();
    renderList();
    saveConfig();
    playAt(0);
    toast('已回到曲库并播放：' + (found.title || item.title || ''));
  } catch (e) {
    toast('播放失败：' + (e && e.message || e));
  }
}

// 点击外部关闭回收站右键菜单
document.addEventListener('click', (e) => {
  if (!e.target.closest('#recycle-context-menu')) {
    $('recycle-context-menu').hidden = true;
  }
});

// 回收站右键菜单操作
document.querySelectorAll('#recycle-context-menu .ctx-item').forEach(item => {
  item.addEventListener('click', () => {
    const action = item.dataset.action;
    $('recycle-context-menu').hidden = true;
    if (action === 'recycle-restore' && ctxRecycleItem) {
      restoreFromRecycleBin(ctxRecycleItem);
    } else if (action === 'recycle-delete' && ctxRecycleItem) {
      removeFromRecycleBin(ctxRecycleItem.path);
    } else if (action === 'recycle-clear') {
      clearRecycleBin();
    }
    ctxRecycleItem = null;
  });
});

// 从回收站恢复歌曲
async function restoreFromRecycleBin(item) {
  // 检查文件是否还存在
  try {
    if (window.mb && window.mb.fileExists) {
      const exists = await window.mb.fileExists(item.path);
      if (!exists) {
        toast('文件已不存在，无法恢复');
        return;
      }
    }
  } catch (e) {}
  // 检查是否已在播放列表中
  if (S.tracks.some(t => t.path.toLowerCase() === item.path.toLowerCase())) {
    toast('该歌曲已在播放列表中');
    removeFromRecycleBin(item.path);
    return;
  }
  // 重新扫描该文件，添加到播放列表顶部
  try {
    const folder = item.path.replace(/[\\/][^\\/]+$/, '');
    const tracks = await mb.scan([folder], false);
    const found = tracks.find(t => t.path.toLowerCase() === item.path.toLowerCase());
    if (found) {
      found.addedTime = Date.now();
      S.tracks.unshift(found); // 添加到顶部
      // 更新文件夹计数
      if (S.folders.has(folder)) {
        S.folders.set(folder, S.folders.get(folder) + 1);
      } else {
        S.folders.set(folder, 1);
      }
      removeFromRecycleBin(item.path);
      renderList();
      renderFolders();
      toast('已恢复：' + (item.title || item.path));
    } else {
      toast('未找到该歌曲文件，无法恢复');
    }
  } catch (e) {
    toast('恢复失败：' + e.message);
  }
}

// 回收站分区展开/收起
let recycleBinExpanded = false;
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#recycle-bin-toggle');
  if (toggle) {
    recycleBinExpanded = !recycleBinExpanded;
    $('recycle-bin-list').style.display = recycleBinExpanded ? 'block' : 'none';
    $('recycle-bin-arrow').style.transform = recycleBinExpanded ? 'rotate(90deg)' : 'rotate(0deg)';
  }
});

// ---- 收藏与歌单左侧栏渲染 ----
function renderSidebar() {
  // 收藏数量
  // 收藏数量：只统计实际在歌曲库中的歌曲（文件被删除/移动的不计入）
  const favCount = S.tracks.filter(t => S.favorites.has(t.path)).length;
  const favItem = $('sidebar-favorites');
  if (favItem) {
    favItem.querySelector('.fcount').textContent = favCount;
    favItem.classList.toggle('active', S.showFavorites);
  }

  // 歌单列表（支持一层子歌单：父歌单下面缩进显示子歌单）
  const plUl = $('playlist-list');
  if (!plUl) return;
  plUl.textContent = '';
  const inLib = new Set(S.tracks.map(t => t.path));

  const renderOne = (pl, depth, ancestors) => {
    const li = document.createElement('li');
    li.className = 'folder-item playlist-item'
      + (S.activePlaylist === pl.id ? ' active' : '')
      + (depth > 0 ? ' child' : '');
    li.dataset.playlistId = pl.id;
    li.style.setProperty('--pl-depth', String(depth));

    const kids = childPlaylists(pl.id);
    // 有子歌单时前面放一个小文件夹标记，纯视觉提示层级
    if (kids.length > 0) {
      const mark = document.createElement('span');
      mark.className = 'pl-branch';
      mark.textContent = '▾';
      li.appendChild(mark);
    }

    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = pl.name;
    name.title = pl.name + (kids.length ? `（含 ${kids.length} 个子歌单）` : '');

    const cnt = document.createElement('span');
    cnt.className = 'fcount';
    // 歌单歌曲数量：只统计实际在歌曲库中的歌曲（含子歌单）
    cnt.textContent = playlistTracksDeep(pl.id).filter(p => inLib.has(p)).length;

    // 不再有 × 按钮：删除/重命名/新建子歌单全部走右键菜单
    li.append(name, cnt);
    li.addEventListener('click', () => {
      pushNav();
      S.activePlaylist = pl.id;
      S.showFavorites = false;
      S.activeFolder = null;
      S.filterField = null;
      S.filterValue = '';
      renderSidebar();
      renderFolders();
      renderList();
    });
    // 右键：编辑 / 重命名 / 删除 / 新建子歌单
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showPlaylistItemMenu(e, pl, ancestors);
    });
    plUl.appendChild(li);

    kids.forEach(k => renderOne(k, depth + 1, ancestors.concat([pl.id])));
  };

  // 只从顶层开始递归，孤儿（父级已不存在）自动当顶层处理
  const ids = new Set(S.playlists.map(p => p.id));
  S.playlists
    .filter(p => !p.parentId || !ids.has(p.parentId))
    .forEach(p => renderOne(p, 0, []));
}

// 歌单右键菜单：重命名 / 新建子歌单 / 删除
let plItemMenuEl = null;
function closePlaylistItemMenu() {
  if (plItemMenuEl) { plItemMenuEl.remove(); plItemMenuEl = null; }
}
function showPlaylistItemMenu(e, pl, ancestors) {
  closePlaylistItemMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu playlist-menu';
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';

  const title = document.createElement('div');
  title.className = 'ctx-item disabled pl-menu-title';
  title.textContent = pl.name;
  menu.appendChild(title);

  const mkItem = (label, cls, fn) => {
    const it = document.createElement('div');
    it.className = 'ctx-item' + (cls ? ' ' + cls : '');
    it.textContent = label;
    it.addEventListener('click', () => { closePlaylistItemMenu(); fn(); });
    menu.appendChild(it);
    return it;
  };

  mkItem('重命名', '', async () => {
    const newName = await showInput('重命名歌单：', pl.name);
    if (newName && newName.trim() && newName.trim() !== pl.name) {
      renamePlaylist(pl.id, newName.trim());
      toast('已重命名为「' + newName.trim() + '」');
    }
  });

  // 子歌单只做一层，避免无限套娃把侧边栏搞乱
  const depth = (ancestors || []).length;
  if (depth < 1) {
    mkItem('新建子歌单', '', async () => {
      const name = await showInput('子歌单名称：', '新子歌单');
      if (name && name.trim()) {
        createPlaylist(name.trim(), pl.id);
        toast('已创建子歌单「' + name.trim() + '」');
      }
    });
  } else {
    const sub = mkItem('新建子歌单（仅支持一层）', 'disabled', () => toast('子歌单只支持一层'));
    sub.style.cursor = 'default';
  }

  const sep = document.createElement('div');
  sep.className = 'ctx-divider';
  menu.appendChild(sep);

  const del = document.createElement('div');
  del.className = 'ctx-item';
  del.style.color = '#f44336';
  del.textContent = '删除歌单';
  del.addEventListener('click', async () => {
    closePlaylistItemMenu();
    const kids = childPlaylists(pl.id);
    const msg = kids.length
      ? `确定删除歌单「${pl.name}」吗？它的 ${kids.length} 个子歌单会一起删除。`
      : `确定删除歌单「${pl.name}」吗？（不会删除磁盘上的歌曲文件）`;
    const ok = await showConfirm('删除歌单', msg);
    if (ok) {
      deletePlaylist(pl.id);
      toast('歌单已删除');
    }
  });
  menu.appendChild(del);

  document.body.appendChild(menu);
  plItemMenuEl = menu;

  const w = menu.offsetWidth || 180;
  const h = menu.offsetHeight || 160;
  let x = e.clientX, y = e.clientY;
  if (x + w > window.innerWidth) x = window.innerWidth - w - 5;
  if (x < 0) x = 5;
  if (y + h > window.innerHeight) {
    y = e.clientY - h;
    if (y < 0) y = 5;
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.visibility = 'visible';

  setTimeout(() => {
    document.addEventListener('click', closePlaylistItemMenu, { once: true });
    document.addEventListener('contextmenu', closePlaylistItemMenu, { once: true });
  }, 0);
}

// 切换到收藏视图
function showFavoritesView() {
  pushNav();
  S.showFavorites = true;
  S.activePlaylist = null;
  S.activeFolder = null;
  S.filterField = null;
  S.filterValue = '';
  renderSidebar();
  renderFolders();
  renderList();
}

// 切换到全部音乐视图
function showAllMusicView() {
  pushNav();
  S.showFavorites = false;
  S.activePlaylist = null;
  S.activeFolder = null;
  S.filterField = null;
  S.filterValue = '';
  renderSidebar();
  renderFolders();
  renderList();
}

// ---- 播放控制 ----
function playAt(idx, pos) {
  if (idx < 0 || idx >= S.tracks.length) return;
  // 占位歌曲无法播放
  if (S.tracks[idx].isPlaceholder) {
    toast('本地无此歌曲，无法播放');
    return;
  }
  // 点击当前正在播放的歌曲时不做任何修改（保持播放进度和状态）
  if (idx === S.current && !S.currentRadio) return;
  // 记录上一个播放的索引，用于更新类名
  const prevIdx = S.current;
  // 清除电台状态
  if (S.currentRadio) {
    S.currentRadio = null;
    destroyHls();
    // 电台模式把进度条禁用了，切回本地歌曲要恢复
    const seekBar = $('seek');
    if (seekBar) seekBar.style.pointerEvents = '';
    if (typeof renderRadioList === 'function') renderRadioList();
    if (typeof updateRadioNowBar === 'function') updateRadioNowBar();
  }
  // 添加到播放历史（如果不是通过历史回退播放的）
  if (S.historyIndex === -1 || S.playHistory[S.historyIndex] !== idx) {
    // 截断历史（如果之前回退过）
    if (S.historyIndex >= 0 && S.historyIndex < S.playHistory.length - 1) {
      S.playHistory = S.playHistory.slice(0, S.historyIndex + 1);
    }
    S.playHistory.push(idx);
    // 限制历史长度
    if (S.playHistory.length > 200) S.playHistory.shift();
    S.historyIndex = S.playHistory.length - 1;
  }
  S.current = idx;
  // 随机模式下同步洗牌位置：点播/队列播放后，「下一首」继续沿洗牌顺序走
  if (S.mode === 'shuffle') {
    const p = S.shuffleOrder.indexOf(S.tracks[idx].path);
    if (p >= 0) S.shufflePos = p;
  }
  // 每首歌各自的歌词偏移：切歌时立刻换成这首存的（没存过就是 0）
  loadLyricOffsetForTrack();
  const t = S.tracks[idx];
  audio.src = fileURL(t.path);
  audio.load();
  audio.currentTime = 0;
  if (pos > 0) {
    const onMeta = () => { audio.currentTime = pos; audio.removeEventListener('loadedmetadata', onMeta); };
    audio.addEventListener('loadedmetadata', onMeta);
  }
  audio.play().then(() => setPlaying(true)).catch((err) => {
    // AbortError 是播放被新的 load 请求中断，不算错误
    if (err && err.name === 'AbortError') return;
    setPlaying(false);
  });
  updateNowPlaying();
  // 优化：只更新播放行的类名，避免重新渲染整个列表导致闪烁
  updatePlayingRow(prevIdx, idx);
  // 播放列表面板开着时同步「正在播放」高亮（点播/上一首/切歌都走这里）
  {
    const qp = $('queue-panel');
    if (qp && !qp.hidden) renderQueuePanel();
  }
  saveConfig();

  // 自动获取封面和歌词
  const curTrack = S.tracks[S.current];
  if (curTrack) {
    // 重置歌词
    S.lyrics = [];
    $('lyrics-body').innerHTML = '<div class="lyrics-empty">正在获取歌词...</div>';
    // 同步重置全屏歌词
    if (pf.open) {
      $('pf-lyrics').innerHTML = '<div class="pf-lyric-empty">正在获取歌词...</div>';
      $('pf-lyrics').classList.remove('multi-col');
      $('pf-lyrics').style.removeProperty('--lyric-cols');
      pf.lyrics = [];
      pf.activeIdx = -1;
      pf.lastActiveEl = null;
    }
    if (S.settings.autoCover && !curTrack.cover) {
      fetchAndApplyCover(curTrack, true);
    }
    if (S.settings.autoLyrics) {
      fetchAndApplyLyrics(curTrack, true);
    }
  }
}

function setPlaying(p) {
  S.playing = p;
  $('ic-play').style.display = p ? 'none' : '';
  $('ic-pause').style.display = p ? '' : 'none';
  const row = document.querySelector('.track-row.current');
  if (row) row.classList.toggle('playing', p);
  // 同步全屏播放界面
  if (pf && pf.open) {
    $('player-full').classList.toggle('playing', p);
    $('pf-ic-play').style.display = p ? 'none' : 'block';
    $('pf-ic-pause').style.display = p ? 'block' : 'none';
  }
  // 系统媒体控制：任务栏缩略图按钮 + 系统媒体浮层
  syncPlayerStateToShell();
  syncDesktopLyric();
  // 队列面板开着时刷新"当前播放"高亮
  const qp = $('queue-panel');
  if (qp && qp.classList.contains('open')) renderQueuePanel();
}

// ---------- 音量渐变 + 统一的播放/暂停入口 ----------
// 暂停时直接 pause 会让声音"断崖"消失，这里用 220ms 渐降；恢复播放时从 0 渐升回目标音量。
let fadeRaf = 0;
function targetVolume() {
  return S.muted ? 0 : Math.max(0, Math.min(1, S.volume));
}
function stopVolumeFade() {
  if (fadeRaf) { cancelAnimationFrame(fadeRaf); fadeRaf = 0; }
}
function fadeVolumeTo(target, dur, done) {
  stopVolumeFade();
  const from = audio.volume;
  const to = Math.max(0, Math.min(1, target));
  // 隐藏到托盘 / 最小化时 requestAnimationFrame 不再触发，渐变永远走不到 p=1，
  // done 不回调 → 「托盘状态下按媒体键暂停无效」「恢复播放却没声音（音量卡在 0）」。
  // 看不见的时候不需要渐变，直接一步到位。
  if (dur <= 0 || document.hidden || Math.abs(to - from) < 0.005) {
    audio.volume = to;
    if (done) done();
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    // p 必须夹到 [0,1]：rAF 传的 now 是「本帧开始时间」，可能早于上面刚取的 t0，
    // 于是 (now - t0) 为负，算出的音量变成 -0.01 这种负数 → 设置 volume 直接抛
    // IndexSizeError（控制台能看到，且那一次渐变失效）。别去掉这个夹取。
    const raw = (now - t0) / dur;
    const p = raw < 0 ? 0 : (raw > 1 ? 1 : raw);
    audio.volume = Math.max(0, Math.min(1, from + (to - from) * p));
    if (p < 1) {
      fadeRaf = requestAnimationFrame(step);
    } else {
      fadeRaf = 0;
      audio.volume = to;
      if (done) done();
    }
  };
  fadeRaf = requestAnimationFrame(step);
}

// 暂停淡出开始时间：淡出要 220ms 才真正 audio.pause()，这期间 audio.paused 还是 false。
// 媒体键连按 / 淡出中再按播放时，靠这个时间戳把「正在淡出」当成已暂停处理。
let pauseFadingSince = 0;

function pausePlayback(fade = true) {
  if (audio.paused) { setPlaying(false); return; }
  const finish = () => {
    pauseFadingSince = 0;
    audio.pause();
    stopVolumeFade();
    // 复位音量：否则下次播放会从 0 开始且没人拉起
    audio.volume = targetVolume();
    setPlaying(false);
  };
  if (!fade) { finish(); return; }
  pauseFadingSince = Date.now();
  fadeVolumeTo(0, 220, finish);
}

function resumePlayback() {
  if (!audio.src && !S.currentRadio) return;
  // 淡出还没走完就又按播放：先把音量拉回目标值，之后按「已经在播」处理
  if (pauseFadingSince) {
    pauseFadingSince = 0;
    stopVolumeFade();
    audio.volume = targetVolume();
  }
  if (!audio.paused) { setPlaying(true); return; }
  // 均衡器启用中：确保音频链接好、AudioContext 恢复（autoplay 策略下可能 suspended）
  if (eq.on) {
    ensureEqChain();
    if (eq.ctx && eq.ctx.state === 'suspended') eq.ctx.resume().catch(() => {});
  }
  stopVolumeFade();
  audio.volume = 0;
  const up = () => fadeVolumeTo(targetVolume(), 260);
  const p = audio.play();
  setPlaying(true);
  if (p && typeof p.then === 'function') {
    p.then(up).catch(() => { audio.volume = targetVolume(); setPlaying(false); });
  } else {
    up();
  }
}

// 播放键 / 媒体键 / 托盘按钮统一走这里
function togglePlayback() {
  if (!S.currentRadio && S.current < 0) {
    if (S.view.length) playAt(S.tracks.indexOf(S.view[0]));
    return;
  }
  if (audio.paused || pauseFadingSince) resumePlayback();
  else pausePlayback();
}

// 媒体键入口（全局快捷键 + MediaSession 两条路都汇到这里）：
// 一次按键可能同时被全局快捷键和 Chromium 的媒体键处理收到，400ms 内只认一次，
// 否则会「暂停+立刻恢复」看起来像没反应。
let lastMediaKeyAt = 0;
function mediaKeyToggle() {
  const now = Date.now();
  if (now - lastMediaKeyAt < 400) return;
  lastMediaKeyAt = now;
  togglePlayback();
}

// 上/下一首入口（全局快捷键 + MediaSession 两条路都汇到这里）：
// 同一次按键可能两边都收到，400ms 内只认一次，否则一次按键跳两首。
let lastMediaStepAt = 0;
function mediaKeyStep(dir) {
  const now = Date.now();
  if (now - lastMediaStepAt < 400) return;
  lastMediaStepAt = now;
  if (dir === 'next') nextTrack(false);
  else prevTrack();
}

// ---------- 系统媒体控制（Windows 任务栏 / 媒体键 / 媒体浮层） ----------
// 上报完整播放状态给主进程：任务栏缩略图按钮 + 托盘右键迷你窗共用。
// 封面来源与 updateMediaSessionMeta 一致（左下角 #cover 的 img.src），保证小窗和主界面同一张图。
function reportPlayerState() {
  try {
    if (!window.mb || typeof mb.updatePlayerState !== 'function') return;
    const radio = S.currentRadio;
    const t = (!radio && S.current >= 0) ? S.tracks[S.current] : null;
    const title = radio ? radio.name : (t ? t.title : '未在播放');
    const artist = radio ? (radio.category + ' · ' + radio.subcat + ' 电台') : (t ? (t.artist || '') : '');
    let cover = '';
    if (!radio) {
      const img = $('cover') && $('cover').querySelector('img');
      if (img && img.src && /^data:image/.test(img.src) && img.src.length < 900000) cover = img.src;
    }
    mb.updatePlayerState({
      playing: !!S.playing,
      title, artist, cover,
      volume: Math.max(0, Math.min(1, S.volume)),
      muted: !!S.muted,
      mode: S.mode,
      fav: !!(t && S.favorites.has(t.path)),   // 小窗红心用
      lyric: (S.settings.desktopLyric || 'off') !== 'off'  // 小窗歌词键激活态用
    });
  } catch (e) { /* ignore */ }
}
// 播放/暂停变化时的上报（任务栏图标 + 小窗）
function syncPlayerStateToShell() {
  reportPlayerState();
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = S.playing ? 'playing' : 'paused';
  } catch (e) { /* ignore */ }
}

let lastPositionStateAt = 0;
// 更新系统媒体浮层显示的歌名/歌手/封面
function updateMediaSessionMeta() {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  try {
    const radio = S.currentRadio;
    const t = (!radio && S.current >= 0) ? S.tracks[S.current] : null;
    const title = radio ? radio.name : (t ? t.title : 'MusicSMX');
    const artist = radio
      ? (radio.category + ' · ' + radio.subcat + ' 电台')
      : (t ? (t.artist || '未知艺术家') : '');
    const album = t ? (t.album || '') : '';
    const artwork = [];
    // 封面：dataURL 直接给，系统浮层支持就显示，不支持会自动忽略
    const coverSrc = (() => {
      if (radio) return '';
      const img = $('cover') && $('cover').querySelector('img');
      if (img && img.src && img.src.length < 900000) return img.src;
      return '';
    })();
    if (coverSrc) artwork.push({ src: coverSrc, sizes: '512x512', type: 'image/jpeg' });
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });
    navigator.mediaSession.playbackState = S.playing ? 'playing' : 'paused';
  } catch (e) { /* ignore */ }
}

// 媒体键 / 系统浮层的控制按钮 → 播放器
function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (action, handler) => { try { ms.setActionHandler(action, handler); } catch (e) { /* 不支持就跳过 */ } };
  // 媒体键 / 系统浮层：必须走统一入口，否则暂停后 S.playing 不同步，
  // mediaSession.playbackState 还停在 'playing'，Windows 下次按键仍然发 pause，
  // 表现就是"播放/暂停键只能暂停、按不回来"。
  // 现在 play / pause 都走 mediaKeyToggle：不信任系统给的意图，按 audio.paused 真值切。
  set('play', () => mediaKeyToggle());
  set('pause', () => mediaKeyToggle());
  set('stop', () => pausePlayback(false));
  set('previoustrack', () => mediaKeyStep('prev'));
  set('nexttrack', () => mediaKeyStep('next'));
  set('seekto', (d) => {
    if (d && typeof d.seekTime === 'number' && isFinite(audio.duration)) {
      audio.currentTime = d.seekTime;
    }
  });
  set('seekbackward', (d) => {
    audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10));
  });
  set('seekforward', (d) => {
    const max = isFinite(audio.duration) ? audio.duration : 1e9;
    audio.currentTime = Math.min(max, audio.currentTime + ((d && d.seekOffset) || 10));
  });
}

// 系统浮层的进度条（每秒最多一次，避免频繁跨进程调用）
function updateMediaSessionPosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const now = Date.now();
  if (now - lastPositionStateAt < 1000) return;
  lastPositionStateAt = now;
  if (!isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      playbackRate: audio.playbackRate || 1
    });
  } catch (e) { /* ignore */ }
}

// 页脚左下角副行（歌手 · 专辑）拆分写入：专辑为空时把分隔点一并藏掉。
// 拆成两个可点元素是为了「点击跳网页详情」（2026-11-21 用户要求）。
function setNowSub(artist, album) {
  $('now-artist').textContent = artist || '—';
  const al = (album || '').trim();
  $('now-album').textContent = al;
  $('now-sep').hidden = !al || !(artist || '').trim() || artist === '—';
  $('now-album').hidden = !al;
}

function updateNowPlaying() {
  queueMicrotask(updateFloatButtons); // 当前曲目变化时刷新「定位到当前歌曲」按钮
  const t = S.current >= 0 ? S.tracks[S.current] : null;
  if (!t) {
    $('now-title').textContent = '未在播放';
    setNowSub('—', '');
    reportPlayerState();
    return;
  }
  $('now-title').textContent = t.title;
  // 底部播放栏音质标记
  const oldBadge = $('now-title').querySelector('.quality-badge');
  if (oldBadge) oldBadge.remove();
  const qInfo = getQualityInfo(t.path);
  if (qInfo) {
    const badge = document.createElement('span');
    badge.className = `quality-badge ${qInfo.cls}`;
    badge.textContent = qInfo.label;
    badge.title = qInfo.title;
    $('now-title').appendChild(badge);
  }
  setNowSub(t.artist, t.album);
  const cover = $('cover');
  cover.textContent = '';
  if (t.cover) {
    const img = document.createElement('img');
    img.src = t.cover;
    cover.appendChild(img);
  } else {
    const hue = hashHue(t.title + t.artist);
    cover.style.background = 'linear-gradient(135deg, hsl(' + hue + ', 45%, 38%), hsl(' + ((hue + 60) % 360) + ', 45%, 25%))';
    const fb = document.createElement('span');
    fb.className = 'cover-fallback';
    fb.textContent = '♪';
    fb.style.color = 'rgba(255,255,255,0.85)';
    cover.appendChild(fb);
  }
  // 滚动到当前行（虚拟滚动下自动定位容器滚动位置）
  if (S.current >= 0) scrollTrackIntoView(S.current);

  // 海报底色模式：切歌立即同步（有封面用封面色，没封面先清掉氛围层等封面晚到再补）
  if (posterBgOn()) {
    const t = S.current >= 0 ? S.tracks[S.current] : null;
    if (t && t.cover) {
      getBlurredBackground(t.cover).then(u => setPosterBackground(u)).catch(() => {});
    } else {
      setPosterBackground(null);
    }
  }

  // 同步全屏播放界面
  if (pf && pf.open) updatePlayerFull();

  updateMediaSessionMeta();
  reportPlayerState();
}

// ---------- 联网获取封面 ----------
// 封面属于「异步晚到」的资源：联网要 1~3 秒，用户往往已经切歌了。
// 判据统一用 path 比对（重扫曲库后 track 对象会换新的，但 path 不变）。
function isCurrentTrack(track) {
  if (!track) return false;
  const cur = S.current >= 0 ? S.tracks[S.current] : null;
  if (!cur) return false;
  if (cur === track) return true;
  return !!track.path && cur.path === track.path;
}

// 封面补抓：当前曲取封面失败（网络抖动 / 同一首的重复请求被去重挡掉后那次又失败）
// 时，8 秒后自动补一次，不用切歌再切回来（2026-11-19 用户反馈右下角小窗海报缺失不自动刷新）。
function scheduleCoverRetry(track) {
  if (!isCurrentTrack(track)) return;
  if (track.cover || S.coverCache.has(track.path)) return;
  if (S.fetchingCover.has(track.path)) return;
  const key = track.path;
  if (S.coverRetryAt.has(key)) return;   // 每首每轮只补一次，别对死链无限重试
  S.coverRetryAt.add(key);
  setTimeout(() => {
    S.coverRetryAt.delete(key);
    if (!isCurrentTrack(track)) return;
    if (track.cover || S.coverCache.has(track.path)) return;
    if (S.fetchingCover.has(track.path)) return;
    fetchAndApplyCover(track, true);
  }, 8000);
}

async function fetchAndApplyCover(track, silent = false) {
  if (!track) return;
  if (S.coverCache.has(track.path)) {
    const dataUrl = S.coverCache.get(track.path);
    track.cover = dataUrl; // 确保 track.cover 字段被设置
    applyCover(track, dataUrl);
    return;
  }
  // 同一首只请求一次；不同曲目各自的请求互不阻塞（以前用全局布尔会饿死新歌的请求）
  if (S.fetchingCover.has(track.path)) {
    // 请求已经在路上：挂到它后面，若它没带封面回来且这首歌还是当前曲，安排补抓
    const inflight = S.fetchingCoverP.get(track.path);
    if (inflight && inflight.then) inflight.then(() => scheduleCoverRetry(track)).catch(() => {});
    return;
  }
  S.fetchingCover.add(track.path);
  const request = (async () => {
    // 检查本地缓存文件
    const coverKey = `${track.artist} - ${track.title}`.toLowerCase().replace(/[\\/:*?"<>|]/g, '_').trim();
    if (S.localCoverFiles.has(coverKey) && window.mb && window.mb.readCoverFile) {
      try {
        const res = await window.mb.readCoverFile(S.localCoverFiles.get(coverKey));
        if (res.ok && res.dataUrl) {
          S.coverCache.set(track.path, res.dataUrl);
          track.cover = res.dataUrl;
          applyCover(track, res.dataUrl);
          return;
        }
      } catch (e) {
        console.error('读取本地封面失败:', e);
      }
    }
    const res = await mb.fetchCover(track.artist, track.title);
    if (res.ok && res.dataUrl) {
      S.coverCache.set(track.path, res.dataUrl);
      track.cover = res.dataUrl;
      applyCover(track, res.dataUrl);
      // 保存到文件
      if (S.settings.saveCover) {
        const saveDir = S.settings.cachePath || '';
        await mb.saveCover(res.dataUrl, saveDir, track.artist, track.title);
      }
      if (!silent) toast('已获取专辑封面' + (res.info?.source ? `（${res.info.source}）` : ''));
    } else if (!silent) {
      toast('未找到封面（已尝试多个来源）');
    }
  })();
  S.fetchingCoverP.set(track.path, request);
  try {
    await request;
  } catch (e) {
    if (!silent) toast('获取封面失败：' + e.message);
  } finally {
    S.fetchingCover.delete(track.path);
    S.fetchingCoverP.delete(track.path);
    // 没拿到封面且还是当前曲 → 8 秒后自动补抓一次
    scheduleCoverRetry(track);
  }
}

function applyCover(track, dataUrl) {
  if (!track || !dataUrl) return;
  track.cover = dataUrl;
  // 关键守卫：只有「当前正在播的那首」才允许刷界面。
  // 否则上一首的请求晚到、或在列表里右键给别的歌取封面，都会把不属于当前歌的图
  // 贴到左下角播放栏和全屏海报上（用户反馈的「缩略图跟实际海报不匹配」）。
  if (!isCurrentTrack(track)) return;
  const cover = $('cover');
  cover.textContent = '';
  cover.style.background = '';
  const img = document.createElement('img');
  img.src = dataUrl;
  cover.appendChild(img);
  // 同步更新全屏播放界面
  if (pf.open) {
    const pfCover = $('pf-cover');
    const oldImg = pfCover.querySelector('img');
    if (!oldImg || oldImg.getAttribute('src') !== dataUrl) {
      const newImg = document.createElement('img');
      newImg.style.opacity = '0';
      newImg.style.transition = 'opacity 0.3s ease';
      newImg.onload = () => {
        if (oldImg && oldImg.parentNode === pfCover) {
          pfCover.removeChild(oldImg);
        }
        const placeholder = pfCover.querySelector('.pf-cover-fallback');
        if (placeholder) placeholder.remove();
        newImg.style.opacity = '1';
      };
      newImg.src = dataUrl;
      pfCover.appendChild(newImg);
    }
    // 使用预模糊背景（双层交叉淡入淡出）
    getBlurredBackground(dataUrl).then(blurredUrl => {
      if (isCurrentTrack(track)) setPFBackground(blurredUrl);
    });
  }
  // 海报底色模式：封面晚到时同步全窗口氛围层（开关关着时 setPosterBackground 直接 return）
  if (posterBgOn() && isCurrentTrack(track)) {
    getBlurredBackground(dataUrl).then(u => setPosterBackground(u)).catch(() => {});
  }
  // 封面可能比歌曲信息晚到，补一次系统媒体浮层的封面 + 托盘小窗封面
  updateMediaSessionMeta();
  reportPlayerState();
}


// ---------- 联网获取歌词 ----------
// 缓存歌词自检：[ti:] 标签与曲目名对不上就视为错配缓存（旧版匹配 bug 曾把
// 《谢绝推销你的爱》存成《你的爱》的缓存），直接丢弃重新联网获取。
function normLrcTag(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/g, '')
    .replace(/[\s\u3000·・\.。,，、;；:：!！?？'"'"“”‘’\-—_~`|/\\+&×]/g, '')
    .trim();
}
function lrcTitleMatches(lrcText, title) {
  const m = String(lrcText || '').match(/\[ti:([^\]]+)\]/i);
  if (!m) return true;   // 没有 [ti:] 标签无法校验，信任缓存
  const a = normLrcTag(title), b = normLrcTag(m[1]);
  if (!a || !b) return true;
  return a === b;        // 只认归一化后相等，宁可重取也不给错词
}
function trackDurationSec(track) {
  const d = Number(track && track.duration);
  if (d > 0) return d;
  const m = S.durations && S.durations.get(track && track.path);
  return Number(m) > 0 ? Number(m) : 0;
}
// 歌词来源徽章：统一入口（S.lyricSource + 头部 chip 一起更新）
function setLyricSourceLabel(label, srcKey) {
  S.lyricSource = srcKey || '';
  const el = $('lyrics-title');
  if (el) el.textContent = label || '歌词';
}
// 渲染歌词数据时同步来源徽章（缓存对象带 source 字段，切歌回来也能写明来源）
function applyLyricSourceFromData(data, suffix) {
  const src = data && data.source ? data.source : (data && data.lrc ? '本地' : '');
  if (!src) return;
  setLyricSourceLabel('歌词 · ' + src + (suffix || ''), src);
}
// ---------- 跨源翻译补全 ----------
// 有些英文歌当前词源只有原文没有译文，但其他词源有：自动逐源找译文并对齐时间轴补上
const TRANS_FILL_ORDER = ['网易云音乐', 'QQ音乐', '酷狗音乐', '酷我音乐'];
const transFilling = new Set();   // 正在补翻译的 path，防重复触发

// 把另一源的译文时间轴对齐到当前原文（±500ms 就近吸附，对不上的行丢弃）
function alignTlyricToLrc(lrc, tlyric) {
  if (!lrc || !tlyric) return '';
  const origTimes = [...parseLrcMap(lrc).keys()].map(Number).sort((a, b) => a - b);
  if (!origTimes.length) return '';
  const out = [];
  for (const [tkey, txt] of parseLrcMap(tlyric)) {
    const t = Number(tkey);
    let best = origTimes[0], bestDiff = Math.abs(origTimes[0] - t);
    for (const ot of origTimes) {
      const d = Math.abs(ot - t);
      if (d < bestDiff) { bestDiff = d; best = ot; }
    }
    if (bestDiff <= 0.5) {
      const min = Math.floor(best / 60);
      const sec = (best % 60).toFixed(2).padStart(5, '0');
      out.push(`[${String(min).padStart(2, '0')}:${sec}]${txt}`);
    }
  }
  return out.join('\n');
}

async function autoFillTranslation(track, lyricsData) {
  if (!track || !track.path || !lyricsData || !lyricsData.lrc) return;
  if (lyricsData.tlyric && lyricsData.tlyric.trim()) return;
  if (transFilling.has(track.path)) return;
  transFilling.add(track.path);
  try {
    for (const src of TRANS_FILL_ORDER) {
      if (src === lyricsData.source) continue;
      try {
        const res = await mb.fetchLyricsFromSource(src, track.artist, track.title, trackDurationSec(track));
        if (!res || !res.ok || !res.tlyric || !res.tlyric.trim()) continue;
        const aligned = alignTlyricToLrc(lyricsData.lrc, res.tlyric);
        if (!aligned.trim()) continue;   // 时间轴对不齐就试下一个源
        const merged = Object.assign({}, lyricsData, { tlyric: aligned });
        S.lyricsCache.set(track.path, merged);
        // 只有还在显示这首歌时才动 UI（用户可能早已切歌）
        const cur = S.tracks[S.current];
        if (cur && cur.path === track.path) {
          renderLyrics(merged);
          applyLyricSourceFromData(merged, '（翻译补全）');
          updateLyricsModeButtons();
          if (pf && pf.open) renderPFLyrics(parseLyrics(merged));
        }
        if (S.settings.saveLyrics) {
          await mb.saveLyrics(merged, S.settings.cachePath || '', track.artist, track.title,
            { songName: res.info?.songName || track.title, artist: res.info?.artist || track.artist });
        }
        toast(`已自动补全翻译（${src}）`);
        return;
      } catch (e) { /* 这个源失败就试下一个 */ }
    }
  } finally {
    transFilling.delete(track.path);
  }
}

async function fetchAndApplyLyrics(track, silent = false) {
  if (!track || S.fetchingLyrics) return false;
  if (S.lyricsCache.has(track.path)) {
    const cached = S.lyricsCache.get(track.path);
    renderLyrics(cached);
    applyLyricSourceFromData(cached);
    // 缓存里没有译文的，后台悄悄跨源补（不阻塞显示）
    if (!(cached.tlyric && cached.tlyric.trim())) autoFillTranslation(track, cached);
    return true;
  }
  // 检查本地缓存文件
  const lyricsKey = `${track.artist} - ${track.title}`.toLowerCase().replace(/[\\/:*?"<>|]/g, '_').trim();
  if (S.localLyricsFiles.has(lyricsKey) && window.mb && window.mb.readLyricsFile) {
    try {
      const res = await window.mb.readLyricsFile(S.localLyricsFiles.get(lyricsKey));
      if (res.ok && res.lrc && lrcTitleMatches(res.lrc, track.title)) {
        // 边车里存过这首的歌词调速：配置里按路径没记过才采用 —— 文件挪位置/换盘也能找回
        if (typeof res.offset === 'number' && Math.abs(res.offset) > 0.001) {
          const m = lyricOffsetsMap();
          if (!(track.path in m)) {
            m[track.path] = Math.round(res.offset * 10) / 10;
            S.settings.lyricOffset = m[track.path];
            applyLyricOffset();
          }
        }
        // 边车（.lrc.json）存在时会带上 tlyric/rlyric/yrc，这样逐字和音译不会因为走缓存就消失
        const lyricsData = {
          lrc: res.lrc,
          tlyric: res.tlyric || '',
          rlyric: res.rlyric || '',
          yrc: res.yrc || '',
          source: '本地'
        };
        S.lyricsCache.set(track.path, lyricsData);
        renderLyrics(lyricsData);
        applyLyricSourceFromData(lyricsData);
        updateLyricsModeButtons();
        // 本地歌词没有翻译时，异步尝试网络获取有翻译的歌词
        (async () => {
          try {
            const netRes = await mb.fetchLyrics(track.artist, track.title, trackDurationSec(track));
            if (netRes.ok && netRes.lrc && netRes.tlyric && netRes.tlyric.trim().length > 0) {
              // 网络获取到有翻译的歌词，更新缓存和显示
              const newLyricsData = {
                lrc: netRes.lrc,
                tlyric: netRes.tlyric,
                rlyric: netRes.rlyric || '',
                yrc: netRes.yrc || '',
                source: netRes.info?.source || ''
              };
              S.lyricsCache.set(track.path, newLyricsData);
              renderLyrics(newLyricsData);
              applyLyricSourceFromData(newLyricsData, '（翻译补全）');
              updateLyricsModeButtons();
              if (S.settings.saveLyrics) {
                await mb.saveLyrics(newLyricsData, S.settings.cachePath || '', track.artist, track.title,
                  { songName: netRes.info?.songName || track.title, artist: netRes.info?.artist || track.artist });
              }
            }
          } catch (e) {
            console.error('自动获取翻译歌词失败:', e);
          }
        })();
        return true;
      }
    } catch (e) {
      console.error('读取本地歌词失败:', e);
    }
  }
  S.fetchingLyrics = true;
  try {
    const res = await mb.fetchLyrics(track.artist, track.title, trackDurationSec(track));
    if (res.ok && res.lrc) {
      const lyricsData = {
        lrc: res.lrc,
        tlyric: res.tlyric || '',
        rlyric: res.rlyric || '',
        yrc: res.yrc || '',
        source: res.info?.source || ''
      };
      S.lyricsCache.set(track.path, lyricsData);
      renderLyrics(lyricsData);
      // 显示歌词来源
      applyLyricSourceFromData(lyricsData);
      updateLyricsModeButtons();
      // 保存到文件：把翻译/音译/逐字一起写进边车，否则下次命中缓存就只剩纯文本
      if (S.settings.saveLyrics) {
        const saveDir = S.settings.cachePath || '';
        await mb.saveLyrics(
          { lrc: res.lrc, tlyric: res.tlyric || '', rlyric: res.rlyric || '', yrc: res.yrc || '' },
          saveDir, track.artist, track.title,
          { songName: res.info?.songName || track.title, artist: res.info?.artist || track.artist }
        );
      }
      if (!silent) toast('已获取歌词' + (res.info?.source ? `（${res.info.source}）` : ''));
      // 命中的词源没有译文（常见于英文歌）：后台跨源找译文补上
      if (!(lyricsData.tlyric && lyricsData.tlyric.trim())) autoFillTranslation(track, lyricsData);
      return true;
    } else if (!silent) {
      toast('未找到歌词（已尝试多个来源）');
    }
    return false;
  } catch (e) {
    if (!silent) toast('获取歌词失败：' + e.message);
    return false;
  } finally {
    S.fetchingLyrics = false;
  }
}

// 从指定来源获取歌词并更新显示
// 「有词优先」：指定来源没歌词时自动改用聚合搜索，切到有歌词的词源
async function fetchLyricsFromSource(source, track) {
  if (!track) { track = S.tracks[S.current]; }
  if (!track) return;
  // 清除缓存，强制重新获取
  S.lyricsCache.delete(track.path);
  S.fetchingLyrics = true;
  try {
    const res = await mb.fetchLyricsFromSource(source, track.artist, track.title, trackDurationSec(track));
    if (res.ok && res.lrc) {
      const lyricsData = {
        lrc: res.lrc,
        tlyric: res.tlyric || '',
        rlyric: res.rlyric || '',
        yrc: res.yrc || '',
        source: res.info?.source || source
      };
      S.lyricsCache.set(track.path, lyricsData);
      renderLyrics(lyricsData);
      applyLyricSourceFromData(lyricsData);
      updateLyricsModeButtons();
      // 同步全屏歌词
      if (pf && pf.open) {
        renderPFLyrics(parseLyrics(lyricsData));
      }
      toast(`已从${source}获取歌词`);
      // 指定词源没有译文：后台跨源找译文补上（保留当前词源的原文）
      if (!(lyricsData.tlyric && lyricsData.tlyric.trim())) autoFillTranslation(track, lyricsData);
      // 保存到文件：把翻译/音译/逐字一起写进边车，否则下次命中缓存就只剩纯文本
      if (S.settings.saveLyrics) {
        const saveDir = S.settings.cachePath || '';
        await mb.saveLyrics(
          { lrc: res.lrc, tlyric: res.tlyric || '', rlyric: res.rlyric || '', yrc: res.yrc || '' },
          saveDir, track.artist, track.title,
          { songName: res.info?.songName || track.title, artist: res.info?.artist || track.artist }
        );
      }
    } else {
      // 指定来源没有歌词：自动切到有歌词的词源（聚合搜索，有翻译的优先）
      const fb = await mb.fetchLyrics(track.artist, track.title, trackDurationSec(track));
      if (fb.ok && fb.lrc) {
        const lyricsData = {
          lrc: fb.lrc,
          tlyric: fb.tlyric || '',
          rlyric: fb.rlyric || '',
          yrc: fb.yrc || '',
          source: fb.info?.source || ''
        };
        S.lyricsCache.set(track.path, lyricsData);
        renderLyrics(lyricsData);
        applyLyricSourceFromData(lyricsData);
        updateLyricsModeButtons();
        if (pf && pf.open) {
          renderPFLyrics(parseLyrics(lyricsData));
        }
        toast(`「${source}」无歌词，已自动切换至「${lyricsData.source || '其他词源'}」`);
        if (S.settings.saveLyrics) {
          const saveDir = S.settings.cachePath || '';
          await mb.saveLyrics(
            { lrc: fb.lrc, tlyric: fb.tlyric || '', rlyric: fb.rlyric || '', yrc: fb.yrc || '' },
            saveDir, track.artist, track.title,
            { songName: fb.info?.songName || track.title, artist: fb.info?.artist || track.artist }
          );
        }
      } else {
        toast(`${source}未找到歌词`);
      }
    }
  } catch (e) {
    toast('获取歌词失败：' + e.message);
  } finally {
    S.fetchingLyrics = false;
  }
}

// 歌词区域右键菜单（切换来源）
function showLyricsSourceMenu(e) {
  e.preventDefault();
  e.stopPropagation();
  if (S.current < 0) { toast('请先播放歌曲'); return; }
  openLyricsSourceMenu(e.clientX, e.clientY);
}
// 打开歌词来源菜单并标记当前来源（chip 点击 / 右键歌词区共用）
function openLyricsSourceMenu(x, y) {
  const menu = $('lyrics-source-menu');
  menu.hidden = false;
  menu.querySelectorAll('.ctx-item[data-source]').forEach(item => {
    item.classList.toggle('lyric-src-active', item.dataset.source === (S.lyricSource || 'auto'));
  });
  const mx = Math.min(x, window.innerWidth - 200);
  const my = Math.min(y, window.innerHeight - 260);
  menu.style.left = mx + 'px';
  menu.style.top = my + 'px';
}
$('lyrics-body').addEventListener('contextmenu', showLyricsSourceMenu);
// 来源徽章：点击弹出切源菜单，右键同样可以
const lyricsHead = document.querySelector('.lyrics-head');
if (lyricsHead) lyricsHead.addEventListener('contextmenu', showLyricsSourceMenu);
const srcChip = $('lyrics-title');
if (srcChip) {
  srcChip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (S.current < 0) { toast('请先播放歌曲'); return; }
    const r = srcChip.getBoundingClientRect();
    openLyricsSourceMenu(r.left, r.bottom + 4);
  });
}
// 全屏歌词区域也支持右键切换来源
if ($('pf-lyrics')) {
  $('pf-lyrics').addEventListener('contextmenu', showLyricsSourceMenu);
}
if ($('pf-lyrics-wrap')) {
  $('pf-lyrics-wrap').addEventListener('contextmenu', showLyricsSourceMenu);
}
// 点击其他地方关闭歌词来源菜单
document.addEventListener('click', (e) => {
  if (!e.target.closest('#lyrics-source-menu') && !e.target.closest('#lyrics-title')) {
    $('lyrics-source-menu').hidden = true;
  }
});
// 歌词来源菜单项点击
document.querySelectorAll('#lyrics-source-menu .ctx-item[data-source]').forEach(item => {
  item.addEventListener('click', () => {
    const source = item.dataset.source;
    $('lyrics-source-menu').hidden = true;
    if (source === 'auto') {
      // 自动模式：清缓存走聚合搜索（多源按「有翻译 > 有歌词」优先）
      const track = S.current >= 0 ? S.tracks[S.current] : null;
      if (!track) return;
      S.lyricsCache.delete(track.path);
      fetchAndApplyLyrics(track, false);
      return;
    }
    fetchLyricsFromSource(source);
  });
});
// 选择本地歌词文件
const localLyricsItem = document.querySelector('#lyrics-source-menu .ctx-item[data-action="load-local-lyrics"]');
if (localLyricsItem) {
  localLyricsItem.addEventListener('click', async () => {
    $('lyrics-source-menu').hidden = true;
    try {
      if (window.mb && window.mb.pickLyricsFile) {
        const result = await window.mb.pickLyricsFile();
        if (result && result.content) {
          const data = { lrc: result.content, tlyric: '', rlyric: '', yrc: '', source: '本地文件' };
          renderLyrics(data);
          if (S.current >= 0) S.lyricsCache.set(S.tracks[S.current].path, data);
          applyLyricSourceFromData(data);
          updateLyricsModeButtons();
          toast('已加载本地歌词: ' + result.path.split(/[\\/]/).pop());
        }
      } else {
        toast('当前环境不支持选择本地歌词文件');
      }
    } catch (e) {
      toast('加载本地歌词失败: ' + e.message);
    }
  });
}

// ---------- 歌词解析：LRC 行级 + KRC/YRC 逐字 ----------
// 把 LRC 文本解析成 时间键(3位小数) -> 文本 的映射
function parseLrcMap(text) {
  const map = new Map();
  if (!text) return map;
  const lines = text.split(/\r?\n/);
  const timeRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of lines) {
    const txt = line.replace(timeRe, '').trim();
    if (!txt) continue;
    let m;
    timeRe.lastIndex = 0;
    while ((m = timeRe.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
      const time = min * 60 + sec + ms / 1000;
      map.set(time.toFixed(3), txt);
    }
  }
  return map;
}

// 解析逐字歌词（酷狗 KRC / 网易云 YRC），返回 Map<行起始ms, {dur, words:[{t,d,w}]}>
//   KRC: [行起始ms,行时长]<字相对ms,字时长,0>字<...>字
//   YRC: [行起始ms,行时长](字绝对ms,字时长,0)字(...)字
function parseWordLyrics(yrcText) {
  const map = new Map();
  if (!yrcText || (!yrcText.includes('<') && !yrcText.includes('('))) return map;
  const tagRe = /[<(](\d+),(\d+)(?:,\d+)?[>)]/g;
  for (const raw of yrcText.split(/\r?\n/)) {
    const line = raw.trim();
    const lm = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lm) continue;
    const lineStart = parseInt(lm[1], 10);
    const lineDur = parseInt(lm[2], 10);
    const body = lm[3];
    const words = [];
    tagRe.lastIndex = 0;
    let prevEnd = 0;      // 上一个标签结束位置（正文起点）
    let pending = null;   // 上一个标签（对应它后面的正文）
    let tm;
    while ((tm = tagRe.exec(body)) !== null) {
      const isAbs = tm[0][0] === '(';
      const start = parseInt(tm[1], 10);
      const dur = parseInt(tm[2], 10);
      if (pending) {
        const text = body.slice(prevEnd, tm.index);
        if (text) {
          words.push({
            t: (isAbs ? pending.start : lineStart + pending.start) / 1000,
            d: pending.dur / 1000,
            w: text
          });
        }
      }
      pending = { start, dur, isAbs };
      prevEnd = tagRe.lastIndex;
    }
    if (pending && prevEnd < body.length) {
      const text = body.slice(prevEnd);
      if (text) {
        words.push({
          t: (pending.isAbs ? pending.start : lineStart + pending.start) / 1000,
          d: pending.dur / 1000,
          w: text
        });
      }
    }
    if (words.length > 0) map.set(lineStart, { dur: lineDur, words });
  }
  return map;
}

// 把逐字数据挂到行级歌词上（时间对不齐时按最近的行容差 150ms 匹配）
function attachWordsToLines(lines, wordMap) {
  if (!lines || lines.length === 0 || !wordMap || wordMap.size === 0) return lines;
  const keys = [...wordMap.keys()].sort((a, b) => a - b);
  for (const line of lines) {
    const target = Math.round(line.time * 1000);
    let lo = 0, hi = keys.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] <= target) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    let pick = -1;
    if (best >= 0 && Math.abs(keys[best] - target) <= 150) pick = best;
    else if (best + 1 < keys.length && Math.abs(keys[best + 1] - target) <= 150) pick = best + 1;
    if (pick >= 0) line.words = wordMap.get(keys[pick]).words;
  }
  return lines;
}

// 统一入口：lyricsData = { lrc, tlyric, rlyric, yrc }，返回排序后的行数组
function parseLyrics(lyricsData) {
  if (!lyricsData) return [];
  if (typeof lyricsData === 'string') lyricsData = { lrc: lyricsData, tlyric: '', rlyric: '' };
  const origMap = parseLrcMap(lyricsData.lrc);
  const transMap = parseLrcMap(lyricsData.tlyric);
  const romaMap = parseLrcMap(lyricsData.rlyric);
  const allTimes = new Set([...origMap.keys(), ...transMap.keys(), ...romaMap.keys()]);
  const result = [];
  for (const tkey of allTimes) {
    result.push({
      time: parseFloat(tkey),
      text: origMap.get(tkey) || '',
      ttext: transMap.get(tkey) || '',
      rtext: romaMap.get(tkey) || ''
    });
  }
  result.sort((a, b) => a.time - b.time);
  // 逐字歌词（有就挂上，没有则后面按行时长补一份等比时间轴）
  attachWordsToLines(result, parseWordLyrics(lyricsData.yrc));
  // 真实的逐字数据只有一部分歌有（网易云 yrc、酷狗 krc 都属于"动态歌词"，老歌/冷门歌大多没有），
  // 这里给没有的歌按行时长把字均分一下 —— 不然同一份曲库里有的歌扫光、有的歌只有整行变色，观感断层。
  if (wordLyricsOn()) synthWordTimings(result);
  return result;
}

// 把一行切成"扫光"用的最小单位：中文/标点一个字一块，英文数字整词一块，空白粘在前一块后面
// 保证 tokens.join('') === 原文，拼接回去不会改变歌词文本
function tokenizeLyricText(text) {
  const tokens = [];
  let buf = '';
  const isLatin = ch => /[A-Za-z0-9'’\-_]/.test(ch);
  for (const ch of Array.from(text || '')) {
    if (isLatin(ch)) { buf += ch; continue; }
    if (buf) { tokens.push(buf); buf = ''; }
    if (/\s/.test(ch)) {
      if (tokens.length) tokens[tokens.length - 1] += ch;
      else if (buf) buf += ch;
      else tokens.push(ch);
      continue;
    }
    tokens.push(ch);
  }
  if (buf) tokens.push(buf);
  return tokens;
}

// 没有逐字数据时，用「本行到下一行」的时长把字均分出一份时间轴
function synthWordTimings(lines) {
  if (!lines || !lines.length) return lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.words && line.words.length) continue;   // 有真实数据就别动
    const tokens = tokenizeLyricText(line.text);
    if (!tokens.length) continue;
    const start = line.time;
    const nextT = lines[i + 1] ? lines[i + 1].time : start + 3;
    const gap = Math.max(0.4, nextT - start);
    const weight = tokens.reduce((n, t) => n + Math.max(1, t.trim().length), 0);
    // 每字约 0.32s：短句不会一闪而过，长句也不会拖到下一行还没扫完
    const total = Math.max(0.6, Math.min(gap * 0.95, weight * 0.32));
    let t = start;
    line.words = tokens.map(tok => {
      const d = (Math.max(1, tok.trim().length) / weight) * total;
      const item = { t, d, w: tok, synth: true };
      t += d;
      return item;
    });
  }
  return lines;
}

// 解析并渲染歌词（支持多版本：原文/翻译/音译）
function renderLyrics(lyricsData) {
  // 歌词重新渲染时清空DOM缓存和高亮索引
  lyricLinesCache = null;
  lastLyricActiveIdx = -1;
  const body = $('lyrics-body');
  // 兼容旧的字符串参数
  if (typeof lyricsData === 'string') {
    lyricsData = { lrc: lyricsData, tlyric: '', rlyric: '' };
  }
  if (!lyricsData || !lyricsData.lrc || lyricsData.lrc.trim().length < 5) {
    body.innerHTML = '<div class="lyrics-empty">暂无歌词</div>';
    S.lyrics = [];
    return;
  }
  // 同步来源徽章（缓存对象带 source；不带则保持现状不覆盖）
  if (lyricsData.source) {
    applyLyricSourceFromData(lyricsData);
  }
  const result = parseLyrics(lyricsData);
  S.lyrics = result;
  // 同步到全屏播放界面
  if (pf && pf.open) {
    renderPFLyrics(result);
  }
  // 渲染
  renderLyricsLines();
  syncDesktopLyric();
}

// 重建歌词行后触发一次淡入：切歌时旧词瞬间清空太生硬（2026-11-19 反馈「断崖式」）。
// 移除→reflow→重加 class，保证每次重建都能重新触发动画。
function fadeRebuild(el) {
  if (!el) return;
  el.classList.remove('rebuild-fade');
  void el.offsetWidth;
  el.classList.add('rebuild-fade');
}

// 根据当前模式渲染歌词行
function renderLyricsLines() {
  const body = $('lyrics-body');
  body.innerHTML = '';
  // DOM 全部重建：旧的行节点已游离，缓存必须失效。
  // 不失效的话（切原文/翻译走的就是这条路）：高亮 class 打在游离节点上、
  // centerLyricLine 按游离节点的几何算滚动位置 —— 歌词就此不跟随播放。
  // lastLyricActiveIdx 置 -2 强制重算：即便新旧行号相同也要把 class 挂到新节点上。
  lyricLinesCache = null;
  lastLyricActiveIdx = -2;
  if (S.lyrics.length === 0) {
    body.innerHTML = '<div class="lyrics-empty">暂无歌词</div>';
    return;
  }
  const padTop = document.createElement('div');
  padTop.className = 'lyric-spacer';
  body.appendChild(padTop);
  S.lyrics.forEach((line, i) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.dataset.idx = i;
    // 根据模式显示对应文本，没有就空着，不回退到原文
    let displayText = line.text;
    if (S.lyricsMode === 'trans') displayText = line.ttext || '';
    else if (S.lyricsMode === 'roma') displayText = line.rtext || '';
    div.textContent = displayText;
    div.addEventListener('click', () => {
      if (isFinite(audio.duration)) audio.currentTime = line.time;
    });
    body.appendChild(div);
  });
  const padBottom = document.createElement('div');
  padBottom.className = 'lyric-spacer';
  body.appendChild(padBottom);
  // 重新高亮当前行并居中
  updateLyricsHighlight();
  centerLyricLine(true);
  fadeRebuild(body);
}

// 更新歌词模式按钮状态
function updateLyricsModeButtons() {
  const btns = document.querySelectorAll('.lyrics-mode-btn');
  btns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === S.lyricsMode);
  });
}

// 切换歌词模式
function switchLyricsMode(mode) {
  if (mode === 'roma') return;   // 音译按钮已移除，别让歌词显示成空白
  if (S.lyricsMode === mode) return;
  S.lyricsMode = mode;
  updateLyricsModeButtons();
  renderLyricsLines();
  // 同步全屏歌词
  if (pf && pf.open && pf.lyrics.length > 0) {
    renderPFLyrics(pf.lyrics);
  }
}

// 歌词滚动高亮（优化版：缓存DOM，只在高亮行变化时更新）
let lastLyricActiveIdx = -1;
let lyricLinesCache = null;
function updateLyricsHighlight() {
  if (S.lyrics.length === 0) { lastLyricActiveIdx = -1; return; }
  // 加歌词偏移：正值让歌词提前显示（整体时间轴前移）
  const cur = audio.currentTime + lyricOffsetSec();
  let activeIdx = -1;
  for (let i = 0; i < S.lyrics.length; i++) {
    if (S.lyrics[i].time <= cur) activeIdx = i;
    else break;
  }
  // 高亮行没变化时直接返回，避免重复DOM操作
  if (activeIdx === lastLyricActiveIdx) return;
  lastLyricActiveIdx = activeIdx;
  
  // 缓存DOM查询，歌词重新渲染时清空缓存
  if (!lyricLinesCache || lyricLinesCache.length !== S.lyrics.length) {
    lyricLinesCache = document.querySelectorAll('.lyric-line');
  }
  const lines = lyricLinesCache;
  lines.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  if (activeIdx >= 0) centerLyricLine(false);
}

// 把当前高亮行滚到歌词窗口的正中。
// 不能用 scrollIntoView —— 它会连带滚动外层页面/主窗口，且面板 hidden 时完全无效。
function centerLyricLine(instant) {
  const panel = $('lyrics-panel');
  const body = $('lyrics-body');
  if (!panel || !body || panel.hidden) return;
  // 首尾占位按「可视区一半」动态算：写死 150px 时面板一高，第一句就滚不到正中
  const spacers = body.querySelectorAll('.lyric-spacer');
  if (spacers.length === 2) {
    const h = Math.max(40, Math.round(body.clientHeight / 2 - 22));
    if (Math.abs(spacers[0].offsetHeight - h) > 2) {
      spacers[0].style.height = h + 'px';
      spacers[1].style.height = h + 'px';
    }
  }
  const idx = lastLyricActiveIdx;
  if (idx < 0 || !lyricLinesCache || !lyricLinesCache[idx]) return;
  const line = lyricLinesCache[idx];
  const lr = line.getBoundingClientRect();
  const br = body.getBoundingClientRect();
  // 用「两中心点之差」换算 scrollTop，不依赖 offsetParent，也不受 head 高度影响
  const delta = (lr.top + lr.height / 2) - (br.top + br.height / 2);
  const top = Math.max(0, body.scrollTop + delta);
  if (instant) {
    const prev = body.style.scrollBehavior;
    body.style.scrollBehavior = 'auto';
    body.scrollTop = top;
    body.style.scrollBehavior = prev;
  } else {
    body.scrollTo({ top, behavior: 'smooth' });
  }
}

// ---------- 随机播放顺序（洗牌） ----------
// 用户预期：切到随机播放后，「播放列表」里显示的顺序就是打乱过的播放顺序。
// shuffleOrder 存**路径**数组（不是下标）：曲目删除/重排（sort、下一首播放 splice）不会让顺序错位。
function buildShuffleOrder(currentFirst = true) {
  const paths = S.tracks.map(t => t.path);
  for (let i = paths.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = paths[i]; paths[i] = paths[j]; paths[j] = tmp;
  }
  const cur = S.current >= 0 && S.tracks[S.current] ? S.tracks[S.current].path : null;
  if (currentFirst && cur) {
    const ci = paths.indexOf(cur);
    if (ci > 0) { paths.splice(ci, 1); paths.unshift(cur); }
  }
  S.shuffleOrder = paths;
  S.shufflePos = cur ? Math.max(0, paths.indexOf(cur)) : 0;
}

// 顺序失效兜底：曲目增删（长度变了）或当前歌不在顺序里（新加的歌）就重洗
function ensureShuffleOrder() {
  if (S.shuffleOrder.length !== S.tracks.length) { buildShuffleOrder(true); return; }
  if (S.current >= 0 && S.tracks[S.current] && !S.shuffleOrder.includes(S.tracks[S.current].path)) {
    buildShuffleOrder(true);
  }
}

// 播放顺序（播放列表面板用）：随机=洗牌顺序，其余=曲库自然顺序；返回路径数组
function playOrderPaths() {
  if (S.mode === 'shuffle') {
    ensureShuffleOrder();
    return S.shuffleOrder;
  }
  return S.tracks.map(t => t.path);
}

function nextTrack(auto) {
  // 电台模式
  if (S.currentRadio) {
    const radios = getFilteredRadios();
    if (radios.length === 0) return;
    // 随机播放模式：在绿灯（可播放）电台之间随机
    if (S.mode === 'shuffle') {
      const okRadios = radios.filter(r => r.status === 'ok');
      const pool = okRadios.length > 0 ? okRadios : radios;
      if (pool.length === 1) { playRadio(pool[0]); return; }
      let i;
      do { i = Math.floor(Math.random() * pool.length); } while (pool[i].url === S.currentRadio.url);
      playRadio(pool[i]);
      return;
    }
    // 顺序模式：切换到下一个相邻电台
    const idx = radios.findIndex(r => r.url === S.currentRadio.url);
    const nextIdx = (idx + 1) % radios.length;
    playRadio(radios[nextIdx]);
    return;
  }
  // 手动队列优先：队列里有歌就先播队列
  while (S.queue.length > 0) {
    const path = S.queue.shift();
    const qi = S.tracks.findIndex(t => t.path === path);
    if (qi >= 0 && !S.tracks[qi].isPlaceholder) {
      renderQueuePanel();
      saveConfig();
      playAt(qi);
      return;
    }
  }
  if (S.queue.length === 0 && $('queue-panel') && !$('queue-panel').hidden) renderQueuePanel();

  const n = S.tracks.length;
  if (n === 0) return;
  if (S.mode === 'shuffle') {
    // 随机模式：沿洗牌顺序前进（跳过占位；走完一轮重新洗牌）——不是每首纯随机，
    // 播放列表面板显示的顺序就是接下来实际的播放顺序
    ensureShuffleOrder();
    const byPath = new Map(S.tracks.map(t => [t.path, t]));
    let pos = S.shufflePos + 1;
    if (pos >= S.shuffleOrder.length) {
      buildShuffleOrder(true); // 走完一轮：重新洗牌，刚播完的当前歌放最前
      pos = 1;
    }
    const len = S.shuffleOrder.length;
    for (let i = 0; i < len; i++) {
      const p = (pos + i) % len;
      const t = byPath.get(S.shuffleOrder[p]);
      if (!t || t.isPlaceholder) continue;
      if (S.current >= 0 && t.path === S.tracks[S.current].path) continue;
      S.shufflePos = p;
      playAt(S.tracks.indexOf(t));
      return;
    }
    return; // 没有可播放的歌曲
  }
  // 顺序模式：跳过占位歌曲
  let next = S.current + 1;
  let found = -1;
  for (let step = 0; step < n; step++) {
    const idx = (next + step) % n;
    if (!S.tracks[idx].isPlaceholder) {
      found = idx;
      break;
    }
  }
  if (found < 0) return; // 没有可播放的歌曲
  if (found <= S.current && !auto) {
    // 循环到开头了
  }
  playAt(found);
}

// ---- 无缝切歌预载（gapless-lite，借鉴 Cloudy）：当前歌剩最后 20 秒时，
// 提前把下一首音频读进缓存，自然切歌时 load() 直接命中、几乎无停顿。 ----
let gaplessAudio = null;
let gaplessUrl = '';

// 与 nextTrack 相同的决策逻辑，但只「偷看」不产生副作用（不动队列、不推进洗牌位置）
function peekNextTrackPath() {
  if (S.currentRadio) return '';
  // 手动队列优先：队首第一条有效项就是下一首（无效项到时候会被 shift 掉）
  for (const path of S.queue) {
    const qi = S.tracks.findIndex(t => t.path === path);
    if (qi >= 0 && !S.tracks[qi].isPlaceholder) return S.tracks[qi].path;
  }
  if (S.tracks.length === 0 || S.current < 0) return '';
  if (S.mode === 'shuffle') {
    ensureShuffleOrder();
    const byPath = new Map(S.tracks.map(t => [t.path, t]));
    const len = S.shuffleOrder.length;
    if (!len) return '';
    let pos = S.shufflePos + 1;
    if (pos >= len) pos = 1; // 走完一轮时 nextTrack 会重洗并把刚播的放最前，这里保守按下一条估
    for (let i = 0; i < len; i++) {
      const p = (pos + i) % len;
      const t = byPath.get(S.shuffleOrder[p]);
      if (!t || t.isPlaceholder) continue;
      if (t.path === S.tracks[S.current].path) continue;
      return t.path;
    }
    return '';
  }
  // 顺序模式：跳过占位
  const n = S.tracks.length;
  for (let step = 0; step < n; step++) {
    const idx = (S.current + 1 + step) % n;
    if (!S.tracks[idx].isPlaceholder) return S.tracks[idx].path;
  }
  return '';
}

function maybePreloadNext() {
  if (S.currentRadio) return;
  if (!isFinite(audio.duration) || audio.duration <= 0) return;
  if (audio.duration - audio.currentTime > 20) return;
  const path = peekNextTrackPath();
  if (!path) return;
  const url = fileURL(path);
  if (url === gaplessUrl) return;
  gaplessUrl = url;
  try {
    if (!gaplessAudio) gaplessAudio = new Audio();
    gaplessAudio.preload = 'auto';
    gaplessAudio.src = url;
    gaplessAudio.load();
  } catch (e) { /* 预载失败不影响正常播放 */ }
}

function prevTrack() {
  // 电台模式：切换到上一个相邻电台
  if (S.currentRadio) {
    const radios = getFilteredRadios();
    if (radios.length === 0) return;
    const idx = radios.findIndex(r => r.url === S.currentRadio.url);
    const prevIdx = (idx - 1 + radios.length) % radios.length;
    playRadio(radios[prevIdx]);
    return;
  }
  const n = S.tracks.length;
  if (n === 0) return;
  // 随机模式下，从播放历史中取上一首
  if (S.mode === 'shuffle' && S.playHistory.length > 1 && S.historyIndex > 0) {
    S.historyIndex--;
    const prevIdx = S.playHistory[S.historyIndex];
    playAt(prevIdx);
    return;
  }
  // 顺序模式：跳过占位歌曲
  let prev = S.current - 1;
  let found = -1;
  for (let step = 0; step < n; step++) {
    const idx = (prev - step + n) % n;
    if (!S.tracks[idx].isPlaceholder) {
      found = idx;
      break;
    }
  }
  if (found < 0) return;
  playAt(found);
}

function cycleMode() {
  const i = MODE_ORDER.indexOf(S.mode);
  S.mode = MODE_ORDER[(i + 1) % MODE_ORDER.length];
  // 切到随机：立刻洗牌（当前歌放最前），播放列表面板马上按打乱顺序显示
  if (S.mode === 'shuffle') buildShuffleOrder(true);
  renderModeBtn();
  toast('播放模式：' + MODE_NAME[S.mode]);
  saveConfig();
  const qp = $('queue-panel');
  if (qp && qp.classList.contains('open')) renderQueuePanel();
}
function renderModeBtn() {
  const m = MODE_ICONS[S.mode];
  const btn = $('btn-mode');
  btn.title = m.title;
  btn.innerHTML = m.svg;
  if (S.mode !== 'list') btn.classList.add('mode-on');
  else btn.classList.remove('mode-on');
  // 同步全屏模式按钮
  if (pf && pf.open) renderPFModeBtn();
  // 托盘小窗的模式按钮跟随主界面三态切换
  reportPlayerState();
}

// ---- 时长懒加载队列 ----
const durQueue = [];
const durQueued = new Set();
let durBusy = 0; // 改为计数器，支持并发
const DUR_CONCURRENCY = 3; // 同时读取3个文件的时长
let durStatsCounter = 0; // 节流renderStats的计数器
function pumpDurations() {
  if (durBusy >= DUR_CONCURRENCY || !durQueue.length) return;
  durBusy++;
  const p = durQueue.shift();
  durQueued.delete(p);
  const probe = new Audio();
  probe.preload = 'metadata';
  const done = (val) => {
    probe.src = '';
    if (val) {
      S.durations.set(p, val);
      const i = S.tracks.findIndex((t) => t.path === p);
      if (i >= 0) {
        if (S.current === i) $('dur-time').textContent = fmtTime(val);
      }
      // 节流：每10首更新一次统计信息
      durStatsCounter++;
      if (durStatsCounter % 10 === 0) {
        renderStats();
      }
    }
    durBusy--;
    if (durQueue.length > 0) {
      setTimeout(pumpDurations, 10);
    } else {
      // 全部完成，最后更新一次统计
      renderStats();
    }
  };
  probe.addEventListener('loadedmetadata', () => done(probe.duration), { once: true });
  probe.addEventListener('error', () => done(0), { once: true });
  probe.src = fileURL(p);
  // 继续启动更多并发
  pumpDurations();
}

// ---- 扫描 / 导入 ----
let scanCount = 0;
let isScanning = false;
// 新歌叠顶：歌单顺序模式下新增歌曲插到当前顺序最上面（一批内保持扫描顺序，后一批叠在更上层），
// 不再强制切换排序（旧行为一切歌就切「添加时间」，把用户认好的歌单顺序冲掉了）。
// 同步 S.importedTrackOrder，保证保存/重启后新歌仍在顶部。
// isRestoringOrder：启动装载/恢复导入顺序期间为 true——此时"新增"其实是全库初载，
// 不许叠顶改写 importedTrackOrder，否则保存的歌单顺序会被扫描顺序冲掉。
let isRestoringOrder = false;
function stackNewTracksOnTop(newTracks) {
  if (!newTracks || !newTracks.length || isRestoringOrder) return;
  const curTrack = S.current >= 0 ? S.tracks[S.current] : null;
  const newSet = new Set(newTracks.map(t => t.path));
  S.tracks = [...newTracks, ...S.tracks.filter(t => !newSet.has(t.path))];
  if (S.importedTrackOrder && S.importedTrackOrder.length > 0) {
    const newPaths = newTracks.map(t => t.path);
    const pathSet = new Set(newPaths);
    S.importedTrackOrder = [...newPaths, ...S.importedTrackOrder.filter(p => !pathSet.has(p))];
  }
  // 索引跟到正在播放的对象上，避免重排后指错歌
  if (curTrack) {
    const idx = S.tracks.indexOf(curTrack);
    S.current = idx >= 0 ? idx : -1;
  } else if (S.current >= S.tracks.length) {
    S.current = -1;
  }
}

async function addPaths(paths, recursive = false) {
  if (!paths || !paths.length) return;
  const myScan = ++scanCount;
  isScanning = true;
  showScanStatus();
  $('scan-text').textContent = '扫描中…';
  const sb = $('scan-bar'); if (sb) sb.style.width = '0%';
  try {
    const tracks = await mb.scan(paths, recursive);
    if (myScan !== scanCount) return;
    
    // 优化：分批处理扫描结果，避免一次性处理大量歌曲导致未响应
    const known = new Set(S.tracks.map((t) => t.path.toLowerCase()));
    const newTracks = tracks.filter(t => !known.has(t.path.toLowerCase()));
    let added = 0;
    const now = Date.now();
    let batchIndex = 0;
    const BATCH_SIZE = 50;
    const addedTracks = [];

    $('scan-text').textContent = `处理中… 0/${newTracks.length}`;

    // 必须等分批处理全部跑完才 resolve：以前 processBatch 用 setTimeout 续批、函数直接返回，
    // 于是 `await addPaths(...)` 在只有第一批（50 首）入库后就继续往下走 ——
    // 启动恢复按"半成品曲库"去比对，把曲库里明明有的歌判成"缺失"并造出占位条目
    // （实测 1439 首的库恢复时只看到 50 首，凭空多出 134 条占位）。
    await new Promise((resolve) => {
    function processBatch() {
      if (myScan !== scanCount) { resolve(); return; } // 被新扫描顶掉：不要挂住调用方
      const end = Math.min(batchIndex + BATCH_SIZE, newTracks.length);
      for (; batchIndex < end; batchIndex++) {
        const t = newTracks[batchIndex];
        t.addedTime = now + added;
        // 占位/缺失找回：同首歌（歌名+宽松歌手）的占位条目用真实文件顶替，保住原位置
        const phIdx = findRecoverMatch(t);
        if (phIdx >= 0) {
          replacePlaceholderAt(phIdx, t, now + added);
        } else {
          S.tracks.push(t);
          addedTracks.push(t);
        }
        added++;
        S.folders.set(t.root, (S.folders.get(t.root) || 0) + 1);
      }
      $('scan-text').textContent = `处理中… ${batchIndex}/${newTracks.length}`;
      const bar = $('scan-bar');
      if (bar && newTracks.length > 0) bar.style.width = (batchIndex / newTracks.length * 100) + '%';

      if (batchIndex < newTracks.length) {
        // 还有更多，让出主线程后继续
        setTimeout(processBatch, 0);
      } else {
        // 扫描过的每个根目录都要记入曲库（空文件夹也保留，否则文件夹列表/合并目标下拉里看不到）
        paths.forEach(p => {
          if (!S.folders.has(p)) S.folders.set(p, S.tracks.filter(t => t.root === p).length);
        });
        // 处理完成：歌单顺序模式下新歌叠到顶部（不切换排序，保住用户认好的顺序）
        if (addedTracks.length > 0 && (S.sortKey === 'qqmusic' || S.sortKey === 'netease')) {
          stackNewTracksOnTop(addedTracks);
        }
        isScanning = false;
        renderFolders();
        renderList();
        hideScanStatus();
        toast(added > 0 ? '已添加 ' + added + ' 首曲目' : '没有发现新曲目');
        saveConfig();
        resolve();
      }
    }
    
    processBatch();
    });
  } catch (e) {
    window.__errs.push('scan: ' + e);
    toast('扫描失败：' + e);
    isScanning = false;
    hideScanStatus();
  }
}

function removeFolder(root) {
  const removed = S.tracks.filter((t) => t.root === root);
  if (removed.length) {
    const cur = S.current >= 0 ? S.tracks[S.current] : null;
    S.tracks = S.tracks.filter((t) => t.root !== root);
    if (cur && !S.tracks.includes(cur)) {
      audio.pause(); audio.removeAttribute('src');
      S.current = -1;
      setPlaying(false);
      updateNowPlaying();
    } else if (cur) {
      S.current = S.tracks.indexOf(cur);
    }
  }
  S.folders.delete(root);
  if (S.activeFolder === root) S.activeFolder = null;
  renderFolders();
  renderList();
  saveConfig();
}

// ---- 进度条 ----
function seekFromEvent(e) {
  const bar = $('seek');
  const rect = bar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  if (isFinite(audio.duration) && audio.duration > 0) audio.currentTime = ratio * audio.duration;
}
let seeking = false;
(function initSeek() {
  const bar = $('seek');
  bar.addEventListener('pointerdown', (e) => {
    if (S.current < 0) return;
    seeking = true;
    bar.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  bar.addEventListener('pointermove', (e) => { if (seeking) seekFromEvent(e); });
  bar.addEventListener('pointerup', () => { seeking = false; });
})();

// 进度条更新节流（优化：每100ms更新一次，减少DOM操作）
let lastProgressUpdate = 0;
audio.addEventListener('timeupdate', () => {
  // 电台模式：进度条保持0，不更新
  if (S.currentRadio) {
    $('seek-fill').style.width = '0%';
    $('seek-knob').style.left = '0%';
    $('cur-time').textContent = '直播';
    return;
  }
  if (!isFinite(audio.duration)) return;
  const now = Date.now();
  if (now - lastProgressUpdate < 100) return; // 节流：100ms更新一次
  lastProgressUpdate = now;
  
  const r = audio.currentTime / audio.duration;
  $('cur-time').textContent = fmtTime(audio.currentTime);
  $('seek-fill').style.width = (r * 100) + '%';
  $('seek-knob').style.left = (r * 100) + '%';
  updateLyricsHighlight();
  syncDesktopLyric();
  // 同步全屏进度条
  if (pf && pf.open) {
    $('pf-cur').textContent = fmtTime(audio.currentTime);
    $('pf-seek-fill').style.width = (r * 100) + '%';
    $('pf-seek-knob').style.left = (r * 100) + '%';
    updatePFLyricsHighlight();
  }
  updateMediaSessionPosition();
  maybePreloadNext();
});
audio.addEventListener('loadedmetadata', () => {
  $('dur-time').textContent = fmtTime(audio.duration);
  if (S.current >= 0) S.durations.set(S.tracks[S.current].path, audio.duration);
  // 同步全屏总时长
  if (pf && pf.open) {
    $('pf-dur').textContent = fmtTime(audio.duration);
  }
});
audio.addEventListener('play', () => setPlaying(true));
audio.addEventListener('pause', () => setPlaying(false));
audio.addEventListener('ended', () => {
  if (S.mode === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  nextTrack(true);
});
audio.addEventListener('error', () => {
  if (S.current >= 0 && audio.src) toast('无法播放：' + (S.tracks[S.current] ? S.tracks[S.current].name : ''));
});

// 缓冲状态指示：避免播放卡住时用户以为死机
audio.preload = 'auto';
function showBuffering() {
  const btn = $('btn-play');
  if (btn) { btn.classList.add('buffering'); btn.title = '缓冲中…'; }
}
function hideBuffering() {
  const btn = $('btn-play');
  if (btn) { btn.classList.remove('buffering'); btn.title = '播放 / 暂停'; }
}
audio.addEventListener('waiting', showBuffering);
audio.addEventListener('stalled', showBuffering);
audio.addEventListener('canplay', hideBuffering);
audio.addEventListener('playing', hideBuffering);

// ---- 音量 ----
function applyVolume() {
  // 用户手动拖音量时打断正在进行的渐变，避免渐变把音量又拉回去
  stopVolumeFade();
  audio.volume = S.muted ? 0 : S.volume;
  audio.muted = S.muted;
  $('volume').value = S.muted ? 0 : Math.round(S.volume * 100);
  $('vol-wave').style.display = (S.muted || S.volume === 0) ? 'none' : '';
  $('btn-mute').style.color = (S.muted || S.volume === 0) ? 'var(--text-faint)' : '';
  // 同步全屏音量
  if (pf && pf.open) {
    $('pf-volume').value = S.muted ? 0 : Math.round(S.volume * 100);
    $('pf-vol-wave').style.display = (S.muted || S.volume === 0) ? 'none' : '';
  }
  // 托盘小窗的音量滑轨要跟着主界面（含静音）一起变
  reportPlayerState();
}
$('volume').addEventListener('input', (e) => {
  S.volume = e.target.value / 100;
  if (S.volume > 0) S.muted = false;
  applyVolume();
  saveConfig();
});
$('btn-mute').addEventListener('click', () => {
  S.muted = !S.muted;
  applyVolume();
  saveConfig();
});
// 滚轮调节音量（首页+全屏喇叭按钮共用）
function onVolumeWheel(e) {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.05 : -0.05;
  S.volume = Math.max(0, Math.min(1, S.volume + delta));
  if (S.volume > 0) S.muted = false;
  applyVolume();
  saveConfig();
}
$('btn-mute').addEventListener('wheel', onVolumeWheel, { passive: false });
$('pf-mute').addEventListener('wheel', onVolumeWheel, { passive: false });

// ---- 音频输出设备选择（右键音量按钮）----
let audioDevices = [];
async function loadAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioDevices = devices.filter(d => d.kind === 'audiooutput');
    renderAudioDeviceMenu();
  } catch (e) {
    console.error('获取音频设备失败:', e);
  }
}
function renderAudioDeviceMenu() {
  const list = $('audio-device-list');
  if (!audioDevices || audioDevices.length === 0) {
    list.innerHTML = '<div class="audio-device-empty">未检测到音频输出设备</div>';
    return;
  }
  list.innerHTML = '';
  // 添加默认设备选项
  const defaultItem = document.createElement('div');
  defaultItem.className = 'audio-device-item' + (!S.audioOutputDevice ? ' active' : '');
  defaultItem.innerHTML = `
    <div class="audio-device-icon">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/></svg>
    </div>
    <div class="audio-device-info">
      <div class="audio-device-name">系统默认设备</div>
      <div class="audio-device-type">Default</div>
    </div>
    <div class="audio-device-check">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
  `;
  defaultItem.addEventListener('click', () => selectAudioDevice(''));
  list.appendChild(defaultItem);

  // 排序：置顶设备排前面，其余按原顺序
  const sortedDevices = [...audioDevices].sort((a, b) => {
    const aPinned = S.pinnedAudioDevices.includes(a.deviceId) ? 0 : 1;
    const bPinned = S.pinnedAudioDevices.includes(b.deviceId) ? 0 : 1;
    return aPinned - bPinned;
  });

  sortedDevices.forEach(device => {
    const isPinned = S.pinnedAudioDevices.includes(device.deviceId);
    const item = document.createElement('div');
    item.className = 'audio-device-item' + (S.audioOutputDevice === device.deviceId ? ' active' : '') + (isPinned ? ' pinned' : '');
    const deviceName = device.label || '未命名设备';
    item.innerHTML = `
      <div class="audio-device-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/></svg>
      </div>
      <div class="audio-device-info">
        <div class="audio-device-name">${escapeHtml(deviceName)}${isPinned ? '<span class="pinned-badge">📌</span>' : ''}</div>
        <div class="audio-device-type">${device.deviceId.substring(0, 20)}...</div>
      </div>
      <div class="audio-device-check">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
    `;
    item.addEventListener('click', () => selectAudioDevice(device.deviceId));
    // 右键置顶/取消置顶
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePinAudioDevice(device.deviceId);
    });
    list.appendChild(item);
  });
}

// 置顶/取消置顶音频设备
function togglePinAudioDevice(deviceId) {
  const idx = S.pinnedAudioDevices.indexOf(deviceId);
  if (idx >= 0) {
    S.pinnedAudioDevices.splice(idx, 1);
    toast('已取消置顶');
  } else {
    S.pinnedAudioDevices.push(deviceId);
    toast('已置顶该设备');
  }
  saveConfig();
  renderAudioDeviceMenu();
}
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
async function selectAudioDevice(deviceId) {
  S.audioOutputDevice = deviceId;
  saveConfig();
  try {
    if (deviceId) {
      await applyOutputSink(deviceId);
      toast('已切换音频输出设备');
    } else {
      await applyOutputSink('');
      toast('已切换到系统默认设备');
    }
  } catch (e) {
    toast('切换设备失败: ' + e.message);
  }
  renderAudioDeviceMenu();
  $('audio-device-menu').hidden = true;
}
// 右键音量按钮显示设备菜单（主界面 + 全屏播放页共用）
function toggleAudioDeviceMenu(anchorEl) {
  const menu = $('audio-device-menu');
  if (menu.hidden) {
    loadAudioDevices();
    // 动态定位到锚点按钮上方
    const rect = anchorEl.getBoundingClientRect();
    menu.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.hidden = false;
  } else {
    menu.hidden = true;
  }
}
$('btn-mute').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  toggleAudioDeviceMenu(e.currentTarget);
});
$('pf-mute').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  toggleAudioDeviceMenu(e.currentTarget);
});
// 点击其他地方关闭菜单
document.addEventListener('click', (e) => {
  if (!e.target.closest('#audio-device-menu') && !e.target.closest('#btn-mute') && !e.target.closest('#pf-mute')) {
    $('audio-device-menu').hidden = true;
  }
});
// 刷新设备列表
$('btn-refresh-audio-devices').addEventListener('click', () => {
  loadAudioDevices();
  toast('正在刷新设备列表...');
});
// 应用启动时恢复选中的输出设备
async function restoreAudioDevice() {
  if (S.audioOutputDevice) {
    try {
      await applyOutputSink(S.audioOutputDevice);
    } catch (e) {
      console.error('恢复音频设备失败:', e);
    }
  }
}

// ---- 按钮绑定 ----
$('btn-play').addEventListener('click', () => togglePlayback());
$('btn-prev').addEventListener('click', prevTrack);
$('btn-next').addEventListener('click', () => nextTrack(false));

// 托盘弹窗控制命令
if (window.mb && mb.onTrayControl) {
  mb.onTrayControl((action, value) => {
    if (action === 'toggle-play') {
      $('btn-play').click();
    } else if (action === 'media-toggle') {
      // 全局媒体键（主进程 globalShortcut 转发）→ 和 MediaSession 共用防抖入口
      mediaKeyToggle();
    } else if (action === 'prev') {
      prevTrack();          // 托盘小窗按钮：真实点击，不去重
    } else if (action === 'next') {
      nextTrack(false);     // 托盘小窗按钮：真实点击，不去重
    } else if (action === 'media-prev') {
      mediaKeyStep('prev'); // 键盘媒体键（和 MediaSession 共用去重入口）
    } else if (action === 'media-next') {
      mediaKeyStep('next');
    } else if (action === 'media-keys-ready') {
      // 主进程：先前被其它播放器独占的媒体键刚刚接管成功，给个轻提示
      toast('键盘媒体键已接管（上一首 / 下一首）');
    } else if (action === 'cycle-mode') {
      // 托盘小窗的随机/模式按钮：和主界面 btn-mode 走同一个三态循环
      cycleMode();
    } else if (action === 'volume') {
      const v = Number(value);
      if (!Number.isFinite(v)) return;
      S.volume = Math.max(0, Math.min(1, v));
      if (S.volume > 0) S.muted = false;
      applyVolume();
      saveConfig();
    } else if (action === 'toggle-mute') {
      // 托盘小窗的喇叭按钮：单击静音/取消静音（和主界面 btn-mute 同一逻辑）
      S.muted = !S.muted;
      applyVolume();
      saveConfig();
    } else if (action === 'toggle-fav') {
      // 托盘小窗的红心：收藏/取消收藏当前歌曲（电台模式没有曲目，忽略）
      if (!S.currentRadio && S.current >= 0 && S.tracks[S.current]) {
        toggleFavorite(S.tracks[S.current].path);
      }
    } else if (action === 'toggle-lyric') {
      // 托盘小窗的歌词键：只管开关。关 → 恢复上次的悬浮/任务栏模式；开 → 记住当前模式再关
      const cur = S.settings.desktopLyric || 'off';
      if (cur === 'off') {
        setDesktopLyricMode(S.settings.desktopLyricLast || 'desktop');
      } else {
        setDesktopLyricMode('off');
      }
    }
  });
}
$('btn-mode').addEventListener('click', cycleMode);
// 定位当前歌曲已移到列表右下角悬浮按钮组（准星）；播放栏不再单独放该按钮
// 侧边栏加号按钮（添加音乐文件夹）
$('sidebar-add-folder').addEventListener('click', async (e) => {
  e.stopPropagation();
  const folders = await mb.pickFolders();
  if (folders && folders.length) {
    // 询问是否包含子文件夹（默认不包含）
    const recursive = await showConfirm('添加音乐文件夹', `已选择 ${folders.length} 个文件夹。\n\n是否包含子文件夹中的音乐？\n（默认仅扫描当前文件夹，点击"确定"则包含子文件夹）`);
    addPaths(folders, recursive);
  }
});
// 空状态点击 = 点「添加文件夹」（没有音乐时点空白处即可添加）
$('empty-state').addEventListener('click', () => $('sidebar-add-folder').click());

// ---------- 全屏播放详情页 ----------
function openPlayerFull() {
  if (S.current < 0) { toast('请先播放一首歌曲'); return; }
  pf.open = true;
  $('player-full').hidden = false;
  document.body.style.overflow = 'hidden';
  // 初始化歌词行间距（按「真正有内容的列数」选单/双间距）
  applyLyricSpacing(pfVisibleModes().length);
  // 同步滑块值
  $('pf-spacing-single').value = pf.spacingSingle;
  $('pf-spacing-single-val').textContent = pf.spacingSingle.toFixed(1);
  $('pf-spacing-double').value = pf.spacingDouble;
  $('pf-spacing-double-val').textContent = pf.spacingDouble.toFixed(1);
  pfVsliderFillSync();
  // 立即更新所有内容（封面、歌曲信息、歌词、进度、时长）
  updatePlayerFull();
  // 逐字填充的 rAF 循环（只在全屏页开着时跑）
  startPFWordFill();
  // 逐字 / 整行开关状态
  syncPFWordToggle();
  // 确保封面已加载：如果当前歌曲封面为空，主动触发获取（本地缓存或网络）
  const curTrack = S.tracks[S.current];
  if (curTrack && !curTrack.cover && S.settings.autoCover) {
    fetchAndApplyCover(curTrack, true);
  }
  if (isFinite(audio.duration)) {
    $('pf-dur').textContent = fmtTime(audio.duration);
    $('pf-cur').textContent = fmtTime(audio.currentTime);
    const r = audio.currentTime / audio.duration;
    $('pf-seek-fill').style.width = (r * 100) + '%';
  }
  // 同步歌词
  if (S.lyrics && S.lyrics.length > 0) {
    renderPFLyrics(S.lyrics);
  } else if (S.lyricsCache.has(S.tracks[S.current].path)) {
    renderLyrics(S.lyricsCache.get(S.tracks[S.current].path));
  }
  // 进来先完整显示操作层，静止 3.2 秒后才进入沉浸态
  $('player-full').classList.remove('idle');
  document.body.classList.remove('pf-idle');
  pfWake();
  // 打开瞬间 pf-lyrics 的几何可能还没就绪（刚 unhide + 入场动画），
  // renderPFLyrics 里的首次定位会算错位置 —— 表现为「打开全屏不定位，
  // 等下一句歌词才跳过去」（2026-11-19 反馈）。布局稳定后再强制定位两次兜底。
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (pf.open && pf.lyrics && pf.lyrics.length) updatePFLyricsHighlight(true);
  }));
  setTimeout(() => {
    if (pf.open && pf.lyrics && pf.lyrics.length) updatePFLyricsHighlight(true);
  }, 380);
}

function closePlayerFull() {
  if (!pf.open) return;
  // 如果在真全屏里返回，先退出全屏，避免主界面还是无边框状态
  if (document.body.classList.contains('is-fullscreen') && mb.setFullScreen) {
    mb.setFullScreen(false);
  }
  clearTimeout(pfIdleTimer);
  const pfEl = $('player-full');
  pfEl.classList.add('fade-out');
  setTimeout(() => {
    pf.open = false;
    stopPFWordFill();
    pfEl.hidden = true;
    pfEl.classList.remove('fade-out');
    pfEl.classList.remove('idle');
    document.body.classList.remove('pf-idle');
    document.body.style.overflow = '';
    // 退回首页后滚动到当前播放的歌曲
    if (S.current >= 0) {
      setTimeout(() => scrollTrackIntoView(S.current, true), 50);
    }
  }, 280);
}

// 歌词模式按钮默认悬停才出现（见 .pf-lyrics-toolbar 样式）。
// 但"默认看不见"会让新用户根本不知道有翻译/音译，所以进页面和切歌时先亮 2.5 秒。
let pfToolsTimer = 0;
function flashLyricTools() {
  const wrap = document.querySelector('.pf-lyrics-wrap');
  if (!wrap) return;
  wrap.classList.add('show-tools');
  clearTimeout(pfToolsTimer);
  pfToolsTimer = setTimeout(() => wrap.classList.remove('show-tools'), 2500);
}

// ---------- 沉浸模式（网易云式：鼠标静止 3.2 秒后操作层淡出） ----------
let pfIdleTimer = 0;
const PF_IDLE_MS = 3200;

function pfSleep() {
  const el = $('player-full');
  if (!el || !pf.open) return;
  el.classList.add('idle');
  document.body.classList.add('pf-idle');
}

function pfWake() {
  const el = $('player-full');
  if (!el || !pf.open) return;
  el.classList.remove('idle');
  document.body.classList.remove('pf-idle');
  clearTimeout(pfIdleTimer);
  pfIdleTimer = setTimeout(pfSleep, PF_IDLE_MS);
}

// 任何输入都算"用户还在看"，重新计时
['mousemove', 'mousedown', 'wheel', 'touchstart'].forEach(ev => {
  $('player-full').addEventListener(ev, pfWake, { passive: true });
});
document.addEventListener('keydown', (e) => {
  if (pf.open) pfWake();
  // F11 / Ctrl+F 切换沉浸全屏（真全屏，隐藏系统标题栏）
  if (e.key === 'F11' || (e.ctrlKey && (e.key === 'f' || e.key === 'F'))) {
    e.preventDefault();
    toggleImmersiveFullscreen();
  }
});

// ---------- 真·全屏 ----------
async function toggleImmersiveFullscreen() {
  if (!mb.setFullScreen) return;
  const on = mb.isFullScreen ? await mb.isFullScreen() : false;
  mb.setFullScreen(!on);
}
if ($('pf-fs')) {
  $('pf-fs').addEventListener('click', toggleImmersiveFullscreen);
}
// 主进程发来的全屏状态变化（含用户按 Esc / 系统手势退出）
if (mb.onFullScreenChange) {
  mb.onFullScreenChange((on) => {
    document.body.classList.toggle('is-fullscreen', !!on);
    const btn = $('pf-fs');
    if (btn) {
      btn.classList.toggle('active', !!on);
      btn.title = on ? '退出沉浸全屏（F11）' : '沉浸全屏（F11）';
    }
    pfWake();
  });
}

// 设置全屏背景（双层交叉淡入淡出）
function setPFBackground(blurredUrl) {
  const layers = [$('pf-bg-a'), $('pf-bg-b')];
  const curIdx = pf.bgIndex;
  const nextIdx = 1 - curIdx;
  const curLayer = layers[curIdx];
  const nextLayer = layers[nextIdx];
  // 在新层设置背景
  if (blurredUrl) {
    nextLayer.style.backgroundImage = `url(${blurredUrl})`;
  } else {
    nextLayer.style.backgroundImage = '';
  }
  // 强制重排，确保 transition 生效
  void nextLayer.offsetWidth;
  // 淡入新层，淡出旧层
  nextLayer.style.opacity = '1';
  curLayer.style.opacity = '0';
  pf.bgIndex = nextIdx;
}

// ---------- 海报底色模式（2026-11-19 引入，2026-11-20 起为默认背景模式） ----------
// 与全屏页的 setPFBackground 同一套双层交叉淡入思路，但铺满整个窗口、
// 低透明度罩在 UI 上（氛围光）。纯色/海报切换与强度滑块在顶栏「外观」浮窗里。
// 旧配置兼容：老版本用布尔 posterBg（false=纯色）；没存过 bgMode 时按它推断。
function posterBgOn() {
  if (S.settings.bgMode) return S.settings.bgMode === 'poster';
  return S.settings.posterBg !== false;
}
let posterBgIndex = 0;
// 海报氛围强度 0~1：旧配置只有一个 posterBgOpacity 时默认氛围层全显（旧视觉）
function posterIntensityVal() {
  const v = S.settings.posterIntensity;
  if (v == null || isNaN(Number(v))) return 1;
  return Math.max(0, Math.min(1, Number(v)));
}
// 界面透明度 0~1：旧配置的 posterBgOpacity 就是旧版「表面透明占比」，直接迁移
function uiTransparencyVal() {
  const v = S.settings.uiTransparency != null ? S.settings.uiTransparency : S.settings.posterBgOpacity;
  if (v == null || isNaN(Number(v))) return 1;
  return Math.max(0, Math.min(1, Number(v)));
}
function setPosterBackground(blurredUrl) {
  if (!posterBgOn()) return;
  const a = $('poster-bg-a'), b = $('poster-bg-b');
  if (!a) return;
  const layers = [a, b];
  const nextLayer = layers[1 - posterBgIndex];
  const curLayer = layers[posterBgIndex];
  nextLayer.style.backgroundImage = blurredUrl ? `url(${blurredUrl})` : '';
  void nextLayer.offsetWidth;
  // 氛围强度 = 氛围层透明度（2026-11-20 与界面透明度解耦）：0=无氛围 1=最浓
  nextLayer.style.opacity = String(posterIntensityVal());
  curLayer.style.opacity = '0';
  posterBgIndex = 1 - posterBgIndex;
  syncMiniPosterTint(blurredUrl);
}

// 模式/强度变化时应用：纯色 = 隐藏层并恢复实心变量；海报 = 垫层常驻内容后面、
// 两个滑块各管一摊（2026-11-20 拆分）：海报氛围强度 = 氛围层浓度（setPosterBackground），
// 界面透明度 = 表面透明占比（下面三个底色变量），文字不透明不受影响。
function applyPosterBgSetting() {
  const el = $('poster-bg');
  if (!el) return;
  const root = document.documentElement.style;
  const cs = getComputedStyle(document.documentElement);
  const base = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  const strength = uiTransparencyVal();
  // body 上的开关类：控制所有弹窗/菜单走毛玻璃外观（海报模式）还是纯色（solid）
  document.body.classList.toggle('poster-bg', posterBgOn());
  if (!posterBgOn()) {
    el.hidden = true;
    root.setProperty('--bg', 'var(--bg-base)');
    root.setProperty('--bg-elev', 'var(--bg-elev-base)');
    root.setProperty('--bg-elev2', 'var(--bg-elev2-base)');
    $('poster-bg-a').style.backgroundImage = '';
    $('poster-bg-b').style.backgroundImage = '';
    syncMiniPosterTint(null);
    return;
  }
  el.hidden = false;
  // 表面透明度策略（2026-11-22 用户定稿「保底直接调到 100%」）：氛围度滑块只管
  // 氛围层浓度（setPosterBackground）+ 主背景 --bg 的透出度，控件表面一律不参与——
  // --bg-elev / --bg-elev2 永远是实底基色（进度条轨道、半透明按钮、滚动条等不被
  // 背景影响，拉满也不消失）。海报色只从主背景透出来。
  root.setProperty('--bg', hexToRgba(base('--bg-base', '#12141a'), Math.max(0.12, 1 - strength)));
  root.setProperty('--bg-elev', base('--bg-elev-base', '#1a1d26'));
  root.setProperty('--bg-elev2', base('--bg-elev2-base', '#222633'));
  const t = S.current >= 0 ? S.tracks[S.current] : null;
  if (t && t.cover) {
    getBlurredBackground(t.cover).then(u => {
      if (posterBgOn()) setPosterBackground(u);
    }).catch(() => {});
  } else {
    setPosterBackground(null);
  }
}

function updatePFFavBtn() {
  const pfFavBtn = $('pf-fav');
  if (!pfFavBtn || S.current < 0) return;
  const t = S.tracks[S.current];
  if (!t) return;
  const faved = isFavorite(t.path);
  pfFavBtn.classList.toggle('faved', faved);
  pfFavBtn.title = faved ? '取消收藏' : '收藏';
  pfFavBtn.innerHTML = faved
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
}

function updatePlayerFull() {
  if (!pf.open || S.current < 0) return;
  const t = S.tracks[S.current];
  // 标题 + 音质标记
  const pfTitle = $('pf-title');
  pfTitle.textContent = t.title;
  const oldBadge = pfTitle.querySelector('.pf-quality-badge');
  if (oldBadge) oldBadge.remove();
  const qInfo = getQualityInfo(t.path);
  if (qInfo) {
    const badge = document.createElement('span');
    badge.className = `quality-badge pf-quality-badge ${qInfo.cls}`;
    badge.textContent = qInfo.label;
    badge.title = qInfo.title;
    pfTitle.appendChild(badge);
  }
  $('pf-artist').textContent = t.artist || '未知艺术家';
  $('pf-artist').title = t.artist ? '单击跳转歌手网页详情，右键可选平台/本地筛选' : '';
  // 专辑名：没有专辑信息就置灰不可点（不要留一个点了没反应的按钮）
  const albumEl = $('pf-album');
  const albumName = (t.album || '').trim();
  albumEl.textContent = albumName || '未知专辑';
  albumEl.title = albumName ? '单击跳转专辑网页详情，右键可选平台/本地筛选' : '';
  albumEl.classList.toggle('empty', !albumName);
  // 歌名：没有真实歌名（未在播放）不给可点的暗示
  pfTitle.title = (t.title || '').trim() ? '单击跳转歌曲网页详情，右键可选平台' : '';

  // 收藏按钮状态
  updatePFFavBtn();
  // 封面（交叉淡入淡出：旧图淡出，新图淡入）
  const pfCover = $('pf-cover');
  if (t.cover) {
    const oldImg = pfCover.querySelector('img');
    const newImg = document.createElement('img');
    newImg.style.opacity = '0';
    newImg.style.transition = 'opacity 0.45s ease';
    newImg.style.position = 'absolute';
    newImg.style.top = '0';
    newImg.style.left = '0';
    newImg.style.width = '100%';
    newImg.style.height = '100%';
    newImg.style.objectFit = 'cover';
    newImg.onload = () => {
      // 移除占位符
      const placeholder = pfCover.querySelector('.pf-cover-fallback');
      if (placeholder) placeholder.remove();
      // 新图淡入
      newImg.style.opacity = '1';
      // 旧图淡出，淡出完成后移除
      if (oldImg && oldImg.parentNode === pfCover) {
        oldImg.style.transition = 'opacity 0.45s ease';
        oldImg.style.opacity = '0';
        setTimeout(() => {
          if (oldImg.parentNode === pfCover) pfCover.removeChild(oldImg);
        }, 500);
      }
    };
    newImg.onerror = () => {
      if (newImg.parentNode === pfCover) pfCover.removeChild(newImg);
    };
    newImg.src = t.cover;
    pfCover.appendChild(newImg);
    // 背景（双层交叉淡入淡出）
    getBlurredBackground(t.cover).then(blurredUrl => {
      if (S.current >= 0 && S.tracks[S.current] === t) {
        setPFBackground(blurredUrl);
      }
    });
  } else {
    // 无封面：淡出旧图，显示占位符，背景恢复默认渐变
    const oldImg = pfCover.querySelector('img');
    if (oldImg) {
      oldImg.style.transition = 'opacity 0.4s ease';
      oldImg.style.opacity = '0';
      setTimeout(() => {
        if (oldImg.parentNode === pfCover) pfCover.removeChild(oldImg);
      }, 450);
    }
    if (!pfCover.querySelector('.pf-cover-fallback')) {
      const ph = document.createElement('span');
      ph.className = 'pf-cover-fallback';
      ph.textContent = '♪';
      pfCover.appendChild(ph);
    }
    setPFBackground(null);
  }
  // 播放状态
  $('player-full').classList.toggle('playing', S.playing);
  $('pf-ic-play').style.display = S.playing ? 'none' : 'block';
  $('pf-ic-pause').style.display = S.playing ? 'block' : 'none';
  // 模式按钮
  renderPFModeBtn();
  // 音量
  $('pf-volume').value = Math.round(S.volume * 100);
  // 歌词：如果有缓存就渲染，没有就显示"正在获取歌词..."
  if (S.lyrics && S.lyrics.length > 0) {
    renderPFLyrics(S.lyrics);
  } else if (S.lyricsCache.has(t.path)) {
    renderLyrics(S.lyricsCache.get(t.path));
  } else {
    const pfLyricsEl = $('pf-lyrics');
    pfLyricsEl.innerHTML = '<div class="pf-lyric-empty">正在获取歌词...</div>';
    pfLyricsEl.classList.remove('multi-col');
    pfLyricsEl.style.removeProperty('--lyric-cols');
    pf.lyrics = [];
    pf.activeIdx = -1;
    pf.lastActiveEl = null;
  }
  // 总时长
  if (isFinite(audio.duration)) {
    $('pf-dur').textContent = fmtTime(audio.duration);
  }
  // 切歌后把歌词模式按钮亮一下，免得用户忘了有翻译/音译
  flashLyricTools();
}

function renderPFModeBtn() {
  const btn = $('pf-mode');
  const m = MODE_ICONS[S.mode];
  btn.title = m.title;
  btn.innerHTML = m.svg;
  if (S.mode !== 'list') btn.classList.add('mode-on');
  else btn.classList.remove('mode-on');
}

// 歌词模式元数据：固定列顺序 原文 → 翻译 → 音译（不受用户点击顺序影响）
const PF_MODE_ORDER = { orig: 0, trans: 1, roma: 2 };
const PF_MODE_LABEL = { orig: '原文', trans: '翻译', roma: '音译' };
const PF_MODE_KEY = { orig: 'text', trans: 'ttext', roma: 'rtext' };

// 点击歌词行跳转播放进度
function pfSeekTo(time) {
  if (isFinite(audio.duration)) audio.currentTime = time;
}

function pfMakeLyricText(mode, line) {
  const span = document.createElement('span');
  span.className = 'pf-lyric-text';
  setLyricText(span, mode, line);
  return span;
}

// 把某一行某个模式的文本写进已存在的 span（复用节点时只改内容，不重建 DOM）
function setLyricText(span, mode, line) {
  const useWords = mode === 'orig' && line.words && line.words.length > 0 && wordLyricsOn();
  if (!useWords) {
    span.classList.remove('has-words');
    // 原文模式显示原文；翻译/音译模式该行没有内容就留空，不回退到原文
    span.textContent = mode === 'orig' ? (line.text || '') : (line[PF_MODE_KEY[mode]] || '');
    return;
  }
  const words = line.words;
  const sameShape = span.classList.contains('has-words') && span.childElementCount === words.length;
  if (sameShape) {
    // 结构一样：只更新文字并清掉上一首残留的填充进度
    const kids = span.children;
    for (let i = 0; i < words.length; i++) {
      kids[i].textContent = words[i].w;
      clearWordProgress(kids[i]);
    }
    return;
  }
  span.classList.add('has-words');
  span.textContent = '';
  const frag = document.createDocumentFragment();
  for (const w of words) {
    const ws = document.createElement('span');
    ws.className = 'pf-word';
    ws.textContent = w.w;
    frag.appendChild(ws);
  }
  span.appendChild(frag);
}

// ---------- 逐字填充（卡拉OK） ----------
// 每个字只用 --p（0~1）表达"唱到哪"，不切 class、不改 color：
// 切 class 时 color 有 transition，字会在"正在唱→已唱完"的一瞬间几乎透明，看着就是一閃一閃。
let pfWordRaf = 0;
let pfWordBox = null;   // 当前正在逐字填充的 .pf-lyric-text
let pfWordIdx = -1;     // 当前正在唱的字下标

function clearWordProgress(el) {
  if (!el) return;
  el._p = 0;
  el.style.removeProperty('--p');
}

function resetPFWordBox(box) {
  if (!box) return;
  for (let i = 0; i < box.children.length; i++) clearWordProgress(box.children[i]);
}

function updatePFWordFill() {
  if (!pf.open) return;
  const box = pf.lastActiveEl
    ? (pf.lastActiveEl.querySelector('.pf-lyric-text.has-words')
       || (pf.lastActiveEl.classList.contains('has-words') ? pf.lastActiveEl : null))
    : null;
  if (!box) {
    if (pfWordBox) { resetPFWordBox(pfWordBox); pfWordBox = null; pfWordIdx = -1; }
    return;
  }
  if (box !== pfWordBox) {
    if (pfWordBox) resetPFWordBox(pfWordBox);
    pfWordBox = box;
    pfWordIdx = -1;
  }
  const line = pf.lyrics[pf.activeIdx];
  const words = line && line.words;
  if (!words || words.length === 0) return;
  const spans = box.children;
  // 逐字进度同样吃歌词偏移，保证"整行高亮"和"逐字扫过"不会错位
  const cur = audio.currentTime + lyricOffsetSec();
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    if (cur >= words[i].t) idx = i; else break;
  }
  if (idx !== pfWordIdx) {
    // 只在换字时批量刷一次：前面的字置满，后面的字归零（跳过当前字，它紧接着按进度算）
    for (let i = 0; i < spans.length; i++) {
      if (i !== idx) setWordProgress(spans[i], i < idx ? 1 : 0);
    }
    pfWordIdx = idx;
  }
  if (idx >= 0 && spans[idx]) {
    const w = words[idx];
    setWordProgress(spans[idx], w.d > 0 ? (cur - w.t) / w.d : 1);
  }
}

// 写 --p 时做两件事：值没变/变化极小就跳过（省样式重算），并且不留小数抖动。
function setWordProgress(el, p) {
  if (!el) return;
  const v = p <= 0 ? 0 : (p >= 1 ? 1 : p);
  if (el._p !== undefined && Math.abs(v - el._p) < 0.01) return;
  el._p = v;
  el.style.setProperty('--p', v.toFixed(3));
}

function startPFWordFill() {
  if (pfWordRaf) return;
  // 不降频：每帧只写一个元素的 --p，60fps 比 25fps 的"跳格"观感明显更连续
  const loop = () => {
    if (!pf.open) { pfWordRaf = 0; return; }
    updatePFWordFill();
    pfWordRaf = requestAnimationFrame(loop);
  };
  pfWordRaf = requestAnimationFrame(loop);
}

function stopPFWordFill() {
  if (pfWordRaf) cancelAnimationFrame(pfWordRaf);
  pfWordRaf = 0;
  if (pfWordBox) resetPFWordBox(pfWordBox);
  pfWordBox = null;
  pfWordIdx = -1;
}

function renderPFLyrics(lines) {
  const container = $('pf-lyrics');
  if (!container) return;
  const playerFull = document.querySelector('.player-full');

  // 清掉上一次的高亮引用，避免切歌后残留
  pf.lastActiveEl = null;

  if (!lines || lines.length === 0) {
    container.innerHTML = '<div class="pf-lyric-empty">暂无歌词</div>';
    // 无歌词时，降低背景透明度（更暗、更模糊）
    if (playerFull) playerFull.classList.add('no-lyrics');
    container.classList.remove('multi-col');
    container.style.removeProperty('--lyric-cols');
    container.dataset.renderKey = '';
    pf.lyrics = [];
    pf.activeIdx = -1;
    pfWordBox = null;
    pfWordIdx = -1;
    updatePFLyricModeButtons([]);
    return;
  }
  // 有歌词时，恢复正常背景
  if (playerFull) playerFull.classList.remove('no-lyrics');

  // 过滤掉整首歌都没有内容的翻译/音译列，避免出现一整列空白；列序固定为 原文 → 翻译
  const validModes = pfVisibleModesFor(lines).slice()
    .sort((a, b) => (PF_MODE_ORDER[a] ?? 99) - (PF_MODE_ORDER[b] ?? 99));
  // 行距跟着「实际列数」走：选中的模式因为没有内容被过滤掉时，间距必须保持单列的样子
  applyLyricSpacing(validModes.length);

  if (validModes.length <= 1) {
    renderPFLyricsSingle(container, lines, validModes[0] || 'orig');
  } else {
    renderPFLyricsColumns(container, lines, validModes);
  }

  pf.lyrics = lines;
  pf.activeIdx = -1;
  updatePFLyricModeButtons(lines);
  // 同步定位到当前播放行：一次性读几何后立即滚动，避免「先闪到顶部再滚回来」
  pfWordBox = null;
  pfWordIdx = -1;
  updatePFLyricsHighlight(true);
  if (pf.activeIdx < 0) container.scrollTop = 0;
  startPFWordFill();
}

// 单列歌词（行数/模式不变时只更新文本，不重建 DOM）
function renderPFLyricsSingle(container, lines, mode) {
  container.classList.remove('multi-col');
  container.style.removeProperty('--lyric-cols');
  const existing = container.querySelectorAll('.pf-lyric-line');
  const canReuse = existing.length === lines.length
    && container.dataset.renderKey === 'single:' + mode;
  if (canReuse) {
    for (let i = 0; i < lines.length; i++) {
      const div = existing[i];
      div.dataset.t = lines[i].time;
      let span = div.firstElementChild;
      if (!span || !span.classList.contains('pf-lyric-text')) {
        span = document.createElement('span');
        span.className = 'pf-lyric-text';
        div.textContent = '';
        div.appendChild(span);
      }
      setLyricText(span, mode, lines[i]);
    }
    return;
  }
  const frag = document.createDocumentFragment();
  lines.forEach(line => {
    const div = document.createElement('div');
    div.className = 'pf-lyric-line';
    div.dataset.mode = mode;
    div.dataset.t = line.time;
    div.appendChild(pfMakeLyricText(mode, line));
    div.addEventListener('click', function () { pfSeekTo(parseFloat(this.dataset.t)); });
    frag.appendChild(div);
  });
  container.innerHTML = '';
  container.appendChild(frag);
  container.dataset.renderKey = 'single:' + mode;
  fadeRebuild(container); // 切歌重建后淡入，别断崖式跳出
}

// 多列歌词：一个滚动容器 + Grid 行对齐（行高由 CSS 保证，不靠 JS 量算）
function renderPFLyricsColumns(container, lines, modes) {
  container.classList.add('multi-col');
  container.style.setProperty('--lyric-cols', String(modes.length));
  const key = 'col:' + modes.join(',');
  const oldGrid = container.querySelector('.pf-lyric-grid');
  const oldRows = oldGrid ? oldGrid.querySelectorAll('.pf-lyric-row') : null;
  const canReuse = oldRows && oldRows.length === lines.length && container.dataset.renderKey === key;
  if (canReuse) {
    for (let i = 0; i < lines.length; i++) {
      const row = oldRows[i];
      row.dataset.t = lines[i].time;
      const cells = row.children;
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        const span = cell.firstElementChild;
        if (span && span.classList.contains('pf-lyric-text')) {
          setLyricText(span, cell.dataset.mode, lines[i]);
        }
      }
    }
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'pf-lyric-grid';

  // 列头：标明每列是原文 / 翻译 / 音译
  const headRow = document.createElement('div');
  headRow.className = 'pf-lyric-head-row';
  modes.forEach(mode => {
    const head = document.createElement('div');
    head.className = 'pf-lyric-head';
    head.dataset.mode = mode;
    head.textContent = PF_MODE_LABEL[mode] || mode;
    headRow.appendChild(head);
  });
  grid.appendChild(headRow);

  const frag = document.createDocumentFragment();
  lines.forEach(line => {
    const row = document.createElement('div');
    row.className = 'pf-lyric-row';
    row.dataset.t = line.time;
    modes.forEach(mode => {
      const cell = document.createElement('div');
      cell.className = 'pf-lyric-cell';
      cell.dataset.mode = mode;
      cell.appendChild(pfMakeLyricText(mode, line));
      row.appendChild(cell);
    });
    row.addEventListener('click', function () { pfSeekTo(parseFloat(this.dataset.t)); });
    frag.appendChild(row);
  });
  grid.appendChild(frag);

  container.innerHTML = '';
  container.appendChild(grid);
  container.dataset.renderKey = key;
  fadeRebuild(container); // 切歌重建后淡入，别断崖式跳出
}

// 更新翻译/音译按钮的斜线状态（整首没有翻译时按钮加斜线）
function updatePFLyricModeButtons(lines) {
  const hasTrans = lines.some(line => line.ttext && line.ttext.trim());
  document.querySelectorAll('.pf-lyrics-mode').forEach(btn => {
    const mode = btn.dataset.mode;
    if (mode === 'trans') {
      btn.classList.toggle('no-lyrics', !hasTrans);
      btn.title = hasTrans ? '翻译' : '翻译（本首暂无翻译歌词）';
    }
  });
}

// ---------- 可见列数：整首空白的列不算列 ----------
// 以前行距是按「选中了几个模式」算的，点了「翻译」→ 立刻从单列行距切到双列行距，
// 但歌根本没有翻译，画面上只是歌词间距变了 —— 用户看到的就是"点了没用的按钮，字却动了"。
// 现在一切都按「真正渲染出内容的列数」算。
function pfVisibleModesFor(lines) {
  const src = lines || ((pf.lyrics && pf.lyrics.length) ? pf.lyrics : (S.lyrics || []));
  const modes = (pf.lyricModes && pf.lyricModes.length > 0) ? pf.lyricModes : ['orig'];
  const valid = modes.filter(m => m === 'orig' || src.some(l => String(l[PF_MODE_KEY[m]] || '').trim()));
  return valid.length ? valid : ['orig'];
}
function pfVisibleModes() { return pfVisibleModesFor(null); }
// 当前这首歌里某个模式有没有内容
function pfHasModeContent(mode) {
  const src = (pf.lyrics && pf.lyrics.length) ? pf.lyrics : (S.lyrics || []);
  if (mode === 'orig') return true;
  return src.some(l => String(l[PF_MODE_KEY[mode]] || '').trim());
}
// 行距只跟「实际列数」挂钩
function pfSpacingFor(cols) {
  return cols <= 1 ? pf.spacingSingle : pf.spacingDouble;
}
function applyLyricSpacing(cols) {
  document.documentElement.style.setProperty('--lyric-spacing', pfSpacingFor(cols));
}

// 同步模式按钮的选中态 + 行间距变量
function syncPFLyricModeButtons() {
  document.querySelectorAll('.pf-lyrics-mode').forEach(b => {
    b.classList.toggle('active', pf.lyricModes.includes(b.dataset.mode));
  });
  applyLyricSpacing(pfVisibleModes().length);
}

// 取当前高亮行对应的 DOM（单列是行本身，多列是一整行 row）
function pfActiveRowEl() {
  const container = $('pf-lyrics');
  if (!container || pf.activeIdx < 0) return null;
  const sel = container.classList.contains('multi-col') ? '.pf-lyric-row' : '.pf-lyric-line';
  return container.querySelectorAll(sel)[pf.activeIdx] || null;
}

// 把当前行滚动到可视区中间。force=true 时立即定位（不做动画、不理会用户手动滚动状态）
function pfScrollToActive(force = false) {
  const container = $('pf-lyrics');
  if (!container || pf.activeIdx < 0) return;
  // 用户刚刚手动滚动过，先不要抢滚动条
  if (!force && Date.now() < (pf.userScrollUntil || 0)) return;
  const row = pfActiveRowEl();
  if (!row) return;
  const cRect = container.getBoundingClientRect();
  const rRect = row.getBoundingClientRect();
  const offset = (rRect.top - cRect.top) + rRect.height / 2 - container.clientHeight / 2;
  // 当前行已接近中间安全区就不滚动，避免每句都触发动画
  if (!force && Math.abs(offset) < Math.max(24, rRect.height * 0.6)) return;
  // 注意用 instant：CSS 上写了 scroll-behavior: smooth，传 auto 仍会走平滑动画
  container.scrollTo({ top: container.scrollTop + offset, behavior: force ? 'instant' : 'smooth' });
}

// 用户手动滚动时暂停自动跟随 2.5 秒
(function initPFUserScrollGuard() {
  const container = $('pf-lyrics');
  if (!container) return;
  const pause = () => { pf.userScrollUntil = Date.now() + 2500; };
  container.addEventListener('wheel', pause, { passive: true });
  container.addEventListener('touchstart', pause, { passive: true });
  container.addEventListener('touchmove', pause, { passive: true });
})();

// 注：多列歌词的行高对齐已交给 CSS Grid（.pf-lyric-row + subgrid），
// 不再需要 JS 量算自然高度、也不再需要 ResizeObserver 反复重算，
// 从根本上消除了「长句换行后两列错位 / 文字溢出压到下一行」的问题。

function updatePFLyricsHighlight(force = false) {
  if (!pf.open || !pf.lyrics || pf.lyrics.length === 0) return;
  const cur = audio.currentTime + lyricOffsetSec();
  let activeIdx = -1;
  for (let i = 0; i < pf.lyrics.length; i++) {
    if (pf.lyrics[i].time <= cur) activeIdx = i;
    else break;
  }
  if (activeIdx === pf.activeIdx && !force) return;
  pf.activeIdx = activeIdx;

  const container = $('pf-lyrics');
  if (!container) return;
  // 只切换上一行/当前行的 class，不遍历全部行（长歌词下开销更小）
  if (pf.lastActiveEl) pf.lastActiveEl.classList.remove('active');
  const sel = container.classList.contains('multi-col') ? '.pf-lyric-row' : '.pf-lyric-line';
  const el = activeIdx >= 0 ? container.querySelectorAll(sel)[activeIdx] : null;
  if (el) el.classList.add('active');
  pf.lastActiveEl = el || null;

  pfScrollToActive(force);
}

// 底部封面点击展开全屏
$('cover').addEventListener('click', openPlayerFull);
$('cover').style.cursor = 'pointer';
$('cover').title = '点击展开播放详情';

// 关闭按钮
$('pf-close').addEventListener('click', closePlayerFull);

// 封面旁的歌手 / 专辑 / 歌名（2026-11-21 改版）：
//  · 左键 = 直接跳网页详情（QQ音乐/网易云，用最近一次右键选过的平台，默认 QQ）；
//  · 右键 = 平台菜单（选另一家平台 / 本地筛选）。
//  本地筛选从左键挪进了右键菜单——左键跳网页是用户要的主交互。
function pfOnlineJump(want) {
  if (S.current < 0) return;
  const t = S.tracks[S.current];
  if (want === 'artist' && !(t.artist || '').trim()) { toast('这首歌没有歌手信息，跳转不了网页'); return; }
  if (want === 'album' && !(t.album || '').trim()) { toast('这首歌没有专辑信息，跳转不了网页'); return; }
  const plat = (S.settings && S.settings.onlineJumpPlatform) || 'qqmusic';
  openPlatformPage(plat, want, t);
}
$('pf-title').addEventListener('click', () => pfOnlineJump('song'));
$('pf-artist').addEventListener('click', () => pfOnlineJump('artist'));
$('pf-album').addEventListener('click', () => pfOnlineJump('album'));

// 页脚左下角（歌单/专辑/曲库页通用）：歌名 / 歌手 / 专辑同样可点跳网页详情。
// 平台记忆（onlineJumpPlatform）与全屏页共用。电台模式没有对应曲目，忽略。
$('now-title').addEventListener('click', () => { if (!S.currentRadio) pfOnlineJump('song'); });
$('now-artist').addEventListener('click', () => { if (!S.currentRadio) pfOnlineJump('artist'); });
$('now-album').addEventListener('click', () => { if (!S.currentRadio) pfOnlineJump('album'); });

// 本地筛选（右键菜单用）：关全屏页并按歌手/专辑筛列表
function pfFilterAndClose(field, value) {
  if (!value) return;
  closePlayerFull();
  if (S.filterField === field && S.filterValue === value) clearTrackFilter();
  else { pushNav(); S.filterField = field; S.filterValue = value; renderList(); toast('已筛选' + (field === 'artist' ? '歌手：' : '专辑：') + value); }
}

// 歌词模式切换（原文 / 翻译 可同时开）
document.querySelectorAll('.pf-lyrics-mode').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    if (mode !== 'orig' && mode !== 'trans') return;   // 音译按钮已移除
    const idx = pf.lyricModes.indexOf(mode);
    if (idx >= 0) {
      // 已选中，取消选中（至少保留一个）
      if (pf.lyricModes.length > 1) {
        pf.lyricModes.splice(idx, 1);
      } else {
        toast('至少保留一种歌词显示');
        return;
      }
    } else {
      // 本首这一列没有内容：只给提示，不加入选择、更不动布局
      if (!pfHasModeContent(mode)) {
        toast('本首暂无翻译歌词');
        return;
      }
      pf.lyricModes.push(mode);
    }
    // 更新按钮状态 + 行间距变量（行距按实际有内容的列数算）
    syncPFLyricModeButtons();
    saveConfig();  // 记住这次选择，下次启动沿用
    // 重新渲染歌词（渲染完成后会自动定位回当前播放行）
    if (pf.lyrics && pf.lyrics.length > 0) {
      renderPFLyrics(pf.lyrics);
    }
  });
});

// ---------- 逐字 / 整行 一键切换 ----------
// 摆在「原文 / 翻译」旁边，不用进设置页；选择会存进 settings.wordLyrics
function syncPFWordToggle() {
  const btn = $('pf-word-toggle');
  if (!btn) return;
  const on = wordLyricsOn();
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? '逐字点亮（点一下改为整行点亮）' : '整行一起点亮（点一下开启逐字推进）';
}
const pfWordToggleBtn = $('pf-word-toggle');
if (pfWordToggleBtn) {
  pfWordToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const on = !wordLyricsOn();
    S.settings.wordLyrics = on;
    S.settings.lyricWordOptOut = true;   // 用户手动选过，别再被默认值迁移覆盖
    // 开启时如果这首歌词还没有逐字时间轴，就地等比切一份（不重新联网）
    if (on) {
      if (S.lyrics && S.lyrics.length) synthWordTimings(S.lyrics);
      if (pf.lyrics && pf.lyrics.length) synthWordTimings(pf.lyrics);
    }
    syncPFWordToggle();
    saveConfig();
    if (pf.lyrics && pf.lyrics.length) renderPFLyrics(pf.lyrics);
    if (S.lyrics && S.lyrics.length) renderLyricsLines();
    toast(on ? '已开启逐字点亮' : '已改为整行点亮');
  });
}

// ESC：先退真全屏，再退播放页（两层，避免一按就整个退出）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pf.open) {
    if (document.body.classList.contains('is-fullscreen') && mb.setFullScreen) {
      mb.setFullScreen(false);
      return;
    }
    closePlayerFull();
  }
});

// 全屏播放控制
$('pf-play').addEventListener('click', () => togglePlayback());
$('pf-prev').addEventListener('click', () => prevTrack());
$('pf-next').addEventListener('click', () => nextTrack(false));
$('pf-mode').addEventListener('click', cycleMode);
// 专辑页面收藏按钮
$('pf-fav').addEventListener('click', () => {
  if (S.current >= 0) {
    toggleFavorite(S.tracks[S.current].path);
    // 只刷新收藏按钮自身，避免整页重绘导致背景遮罩深浅切换、页面变亮
    updatePFFavBtn();
  }
});
// 专辑页面歌单按钮
$('pf-playlist').addEventListener('click', (e) => {
  if (S.current >= 0) {
    showPlaylistMenu(e, S.tracks[S.current].path);
  }
});

// 歌词间距滑块
let pfSpacingTimer = null;
// 竖滑条自绘填充：appearance:none 后没有原生 accent 填充，把当前值百分比写进
// --fill 变量，CSS 轨道用它画「已过段橙色 / 未到段灰色」渐变
function pfVsliderFillSync() {
  for (const id of ['pf-spacing-single', 'pf-spacing-double']) {
    const el = $(id);
    if (!el) continue;
    const span = parseFloat(el.max) - parseFloat(el.min);
    const pct = span > 0 ? ((parseFloat(el.value) - parseFloat(el.min)) / span) * 100 : 0;
    el.style.setProperty('--fill', pct.toFixed(1) + '%');
  }
}
function applySpacing() {
  // 同样按实际列数取值：歌没有翻译时，只有「单」这一档有意义
  applyLyricSpacing(pfVisibleModes().length);
  // 间距变化会让所有行重新排版，行高由 Grid 自动重算，这里只需把当前行重新居中
  if (!pf.open) return;
  clearTimeout(pfSpacingTimer);
  pfSpacingTimer = setTimeout(() => {
    requestAnimationFrame(() => pfScrollToActive(true));
  }, 90);
}
$('pf-spacing-single').addEventListener('input', (e) => {
  pf.spacingSingle = parseFloat(e.target.value);
  $('pf-spacing-single-val').textContent = pf.spacingSingle.toFixed(1);
  pfVsliderFillSync();
  applySpacing();
  saveConfig();
});
$('pf-spacing-double').addEventListener('input', (e) => {
  pf.spacingDouble = parseFloat(e.target.value);
  $('pf-spacing-double-val').textContent = pf.spacingDouble.toFixed(1);
  pfVsliderFillSync();
  applySpacing();
  saveConfig();
});

// 全屏进度条（支持拖拽）
let pfSeeking = false;
(function initPFSeek() {
  const bar = $('pf-seek');
  bar.addEventListener('pointerdown', (e) => {
    if (!isFinite(audio.duration)) return;
    pfSeeking = true;
    bar.setPointerCapture(e.pointerId);
    seekFromPEvent(e);
  });
  bar.addEventListener('pointermove', (e) => { if (pfSeeking) seekFromPEvent(e); });
  bar.addEventListener('pointerup', () => { pfSeeking = false; });
})();
function seekFromPEvent(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (isFinite(audio.duration) && audio.duration > 0) audio.currentTime = ratio * audio.duration;
}

// 全屏音量
$('pf-volume').addEventListener('input', (e) => {
  S.volume = parseInt(e.target.value, 10) / 100;
  S.muted = false;
  applyVolume();
  saveConfig();
});
$('pf-mute').addEventListener('click', () => {
  S.muted = !S.muted;
  applyVolume();
  saveConfig();
});
$('search').addEventListener('input', (e) => {
  // 从空到非空才算「进入搜索」这一级，避免每敲一个字都塞一条历史
  if (!S.keyword && e.target.value) pushNav();
  S.keyword = e.target.value;
  const clearBtn = $('search-clear');
  if (clearBtn) clearBtn.hidden = !e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderList, 120);
});
// 搜索框一键清空
$('search-clear').addEventListener('click', () => {
  pushNav();
  $('search').value = '';
  S.keyword = '';
  $('search-clear').hidden = true;
  renderList();
  $('search').focus();
});

// ---------- 排序菜单 ----------
function updateSortLabel() {
  // 「歌单来源 / 刷新顺序」入口：一直显示，后面带上当前歌单名，方便认出用的是哪份
  const srcItem = $('sort-playlist-source');
  if (srcItem) {
    const src = S.importedPlaylistSource;
    let extra = '';
    if (src && src.type === 'url' && src.url) {
      const pfLabel = src.platform === 'netease' ? '网易云' : 'QQ音乐';
      extra = '（' + pfLabel + (S.importedPlaylistName ? '：' + S.importedPlaylistName : '') + '）';
    } else if (S.importedPlaylistName) {
      extra = '（' + S.importedPlaylistName + '）';
    }
    srcItem.textContent = extra ? '🌐 歌单来源 / 刷新顺序' + extra : '🌐 歌单来源 / 刷新顺序…';
  }
  // 歌单顺序模式：显示来源平台 + 歌单名（重启后也要认出来，不能退化成「排序」）
  if (S.sortKey === 'qqmusic' || S.sortKey === 'netease') {
    const platformLabel = S.sortKey === 'netease' ? '网易云' : 'QQ音乐';
    $('sort-label').textContent = S.importedPlaylistName
      ? platformLabel + '：' + S.importedPlaylistName
      : platformLabel + '歌单顺序';
    document.querySelectorAll('.sort-item').forEach(item => item.classList.remove('active'));
    return;
  }
  const labels = {
    'addedTime--1': '添加时间↓',
    'addedTime-1': '添加时间↑',
    'title-1': '名称↑',
    'title--1': '名称↓',
    'artist-1': '歌手↑',
    'artist--1': '歌手↓',
    'shuffle-1': '随机'
  };
  const key = S.sortKey + '-' + S.sortDir;
  $('sort-label').textContent = labels[key] || '排序';
  // 更新菜单项高亮
  document.querySelectorAll('.sort-item').forEach(item => {
    const active = item.dataset.sort === S.sortKey &&
      (S.sortKey === 'shuffle' || parseInt(item.dataset.dir) === S.sortDir);
    item.classList.toggle('active', active);
  });
}
$('btn-sort').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('sort-menu');
  menu.hidden = !menu.hidden;
});
// 左上角 logo → GitHub 项目主页（2026-11-21）
const GITHUB_REPO_URL = 'https://github.com/sunmanxu/MusicSMX';
$('logo-home').addEventListener('click', (e) => {
  e.stopPropagation();
  if (window.mb && typeof mb.openExternal === 'function') mb.openExternal(GITHUB_REPO_URL);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.sort-wrap')) {
    $('sort-menu').hidden = true;
  }
});
// 全屏透明遮罩已废除（2026-11-20）：它 z-index:999 盖住整个窗口（含顶栏按钮），
// 排序/批处理菜单开着时点「个性化/设置」，mousedown 落在遮罩上把菜单关掉、
// click 根本到不了按钮 → 表现为"按钮展不开，得多点一下"。遮罩当年解决的
// 拖拽区吞点击问题，现由 body.popover-open（顶栏临时 no-drag）+ 捕获阶段
// 关闭 handler 完整覆盖，遮罩不再有存在必要。
// 历史调用点散落十几处，统一保留为空操作。
function showMenuOverlay() {}
function hideMenuOverlay() {}
document.querySelectorAll('.sort-item').forEach(item => {
  item.addEventListener('click', () => {
    // 歌单来源窗口：粘贴各平台链接 → 点「刷新」按链接重抓顺序
    if (item.id === 'sort-playlist-source') {
      $('sort-menu').hidden = true;
      hideMenuOverlay();
      openPlaylistSourceModal();
      return;
    }
    // 导入本地歌单JSON（带子菜单，点击时也显示子菜单）
    if (item.id === 'sort-import-qqmusic') {
      renderImportHistorySubmenu();
      $('import-history-submenu').hidden = false;
      return;
    }
    S.sortKey = item.dataset.sort;
    S.sortDir = item.dataset.dir ? parseInt(item.dataset.dir) : 1;
    updateSortLabel();
    renderList();
    saveConfig();   // 立刻落盘：否则改完排序没播放就关窗，下次打开又是旧顺序
    $('sort-menu').hidden = true;
    hideMenuOverlay();
  });
});

// ---------- 导入歌单历史子菜单 ----------
function renderImportHistorySubmenu() {
  const listEl = $('import-history-list');
  const history = S.importedPlaylistHistory || [];
  
  if (history.length === 0) {
    listEl.innerHTML = '<div class="submenu-empty">暂无导入历史</div>';
    return;
  }
  
  listEl.innerHTML = history.map((h, idx) => {
    const platformClass = h.platform === 'netease' ? 'netease' : 'qq';
    const platformLabel = h.platform === 'netease' ? '网易云' : 'QQ';
    const name = h.name || '未命名歌单';
    const count = h.songs ? h.songs.length : 0;
    // 记住过链接的才给刷新按钮；本地 JSON 导入的只能重新导入
    const canRefresh = !!(h.source && h.source.type === 'url' && h.source.url);
    const timeStr = h.importedTime ? new Date(h.importedTime).toLocaleString() : '';
    const tip = name + (timeStr ? '\n上次导入：' + timeStr : '') +
      (canRefresh ? '\n点右侧 ⟳ 从原链接重新抓取（歌单更新后用）' : '');
    return `<div class="submenu-item" data-history-idx="${idx}" title="${tip}">
      <span class="platform-tag ${platformClass}">${platformLabel}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span>
      <span class="song-count">${count}首</span>
      ${canRefresh ? `<button class="history-refresh" data-refresh-idx="${idx}" title="从原链接重新抓取">⟳</button>` : ''}
    </div>`;
  }).join('');
  
  // 绑定点击事件
  listEl.querySelectorAll('.submenu-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(el.dataset.historyIdx);
      const h = S.importedPlaylistHistory[idx];
      if (h) {
        // 重新导入这个歌单（用记住的快照，不走网络）
        const importData = {
          dissname: h.name,
          platform: h.platform,
          songs: h.songs
        };
        $('sort-menu').hidden = true;
        $('import-history-submenu').hidden = true;
        hideMenuOverlay();
        toast('正在导入：' + h.name);
        setTimeout(() => importQQMusicPlaylist(importData, { source: h.source || null }), 100);
      }
    });
  });
  // 历史行右侧 ⟳：按记住的链接重新抓（会带上平台最新内容）
  listEl.querySelectorAll('.history-refresh').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.refreshIdx);
      const h = S.importedPlaylistHistory[idx];
      if (!h) return;
      $('sort-menu').hidden = true;
      $('import-history-submenu').hidden = true;
      hideMenuOverlay();
      refreshPlaylistSource(h.source, { name: h.name });
    });
  });
}

// 鼠标悬停"导入本地歌单JSON"时显示子菜单
$('sort-import-qqmusic').addEventListener('mouseenter', () => {
  renderImportHistorySubmenu();
  $('import-history-submenu').hidden = false;
});

// 鼠标离开子菜单区域时隐藏子菜单
let submenuHideTimer = null;
function hideImportSubmenuWithDelay() {
  clearTimeout(submenuHideTimer);
  submenuHideTimer = setTimeout(() => {
    $('import-history-submenu').hidden = true;
  }, 200);
}
$('sort-import-qqmusic').addEventListener('mouseleave', hideImportSubmenuWithDelay);
$('import-history-submenu').addEventListener('mouseenter', () => clearTimeout(submenuHideTimer));
$('import-history-submenu').addEventListener('mouseleave', hideImportSubmenuWithDelay);

// 点击"从文件导入..."
$('submenu-import-file').addEventListener('click', (e) => {
  e.stopPropagation();
  $('qqmusic-import-input').click();
  $('sort-menu').hidden = true;
  $('import-history-submenu').hidden = true;
  hideMenuOverlay();
});

// 关闭排序菜单时也关闭子菜单
const originalSortMenuHide = () => {
  $('import-history-submenu').hidden = true;
};
// 监听 sort-menu 的 hidden 变化
const sortMenuObserver = new MutationObserver(() => {
  if ($('sort-menu').hidden) {
    $('import-history-submenu').hidden = true;
  }
});
sortMenuObserver.observe($('sort-menu'), { attributes: true, attributeFilter: ['hidden'] });

// 抓取接口返回的 data → importQQMusicPlaylist 能吃的格式
function playlistPayloadToImportData(data) {
  return {
    dissname: data.playlistName || (data.platform === 'netease' ? '网易云歌单' : 'QQ音乐歌单'),
    platform: data.platform,
    songs: (data.songs || []).map(s => ({
      name: s.name,
      singer: s.singer,
      album: s.album,
      duration: s.duration,
      songid: s.songid,
      songmid: s.songmid
    }))
  };
}

// 按记住的链接重新抓一遍歌单（平台上更新过歌单就用这个，不用再导链接）
// 返回 { ok, name, count, platform } 或 { ok:false, error }，方便「歌单来源」窗口显示进度/结果
// opts.silent = true 时不弹 toast（窗口里自己显示状态）
async function refreshPlaylistSource(source, opts = {}) {
  if (!source || source.type !== 'url' || !source.url) {
    if (!opts.silent) toast('这个歌单没记住链接，只能重新导入');
    return { ok: false, error: '没有可用的歌单链接' };
  }
  const label = opts.name ? '「' + opts.name + '」' : '';
  if (!opts.silent) toast('正在刷新歌单' + label + '…');
  try {
    const res = await window.mb.fetchPlaylist(source.url);
    if (!res.ok) {
      if (!opts.silent) toast('刷新失败：' + (res.error || '未知错误'));
      return { ok: false, error: res.error || '未知错误' };
    }
    const importData = playlistPayloadToImportData(res.data);
    importQQMusicPlaylist(importData, {
      source: { type: 'url', url: source.url, platform: res.data.platform }
    });
    return {
      ok: true,
      name: importData.dissname,
      count: importData.songs.length,
      platform: res.data.platform
    };
  } catch (e) {
    if (!opts.silent) toast('刷新失败：' + e.message);
    return { ok: false, error: e.message };
  }
}

// ---------- 歌单来源窗口（每个平台一行链接 + 刷新按钮） ----------
// 三行：QQ音乐 / 网易云音乐 / 其他（自动识别）。链接存在 settings.playlistSourceUrls，
// 跟「当前导入来源」分开存 —— 两个平台可以同时记住，重启也不清空。
const PL_SRC_ROWS = [
  { key: 'qq', label: 'QQ音乐', platform: 'qqmusic' },
  { key: 'netease', label: '网易云音乐', platform: 'netease' },
  { key: 'auto', label: '其他 / 自动识别', platform: null }
];
const plSrcBusy = { qq: false, netease: false, auto: false };
const plSrcError = { qq: '', netease: '', auto: '' };
const plSrcInfo = { qq: null, netease: null, auto: null };  // {count, time}
let plSrcSaveTimer = null;

function plSrcUrls() {
  const s = S.settings;
  if (!s.playlistSourceUrls || typeof s.playlistSourceUrls !== 'object') {
    s.playlistSourceUrls = { qq: '', netease: '', auto: '' };
  }
  const u = s.playlistSourceUrls;
  if (typeof u.qq !== 'string') u.qq = '';
  if (typeof u.netease !== 'string') u.netease = '';
  if (typeof u.auto !== 'string') u.auto = '';
  return u;
}

// 分享文案里常夹着说明文字，这里只把链接抠出来
function extractPlaylistUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/https?:\/\/[^\s"'<>，。；、！）)】]+/i);
  if (m) s = m[0];
  return s;
}

function detectPlaylistPlatform(url) {
  const s = String(url || '').toLowerCase();
  if (/music\.163\.com|163cn\.tv|y\.music\.163/.test(s)) return 'netease';
  if (/qq\.com|songlist|songmid|^qq:/.test(s)) return 'qqmusic';
  if (/^\d{4,}$/.test(s)) return 'qqmusic';   // 纯数字按歌单 ID，默认 QQ音乐
  return null;
}

function plSrcStateEl(key) { return document.querySelector('.pl-src-state[data-state="' + key + '"]'); }
function plSrcRowEl(key) { return document.querySelector('.pl-src-row[data-row="' + key + '"]'); }
function plSrcInputEl(key) { return document.querySelector('.pl-src-input[data-key="' + key + '"]'); }
function plSrcBtnEl(key) { return document.querySelector('.pl-src-btn[data-key="' + key + '"]'); }
function plSrcPlatformLabel(p) { return p === 'netease' ? '网易云' : 'QQ音乐'; }

// 刷新按钮的忙碌态：图标转圈 + 文案变「刷新中」，不用 textContent 覆盖（会吃掉图标）
function setPlSrcBtnBusy(btn, on) {
  if (!btn) return;
  btn.classList.toggle('busy', !!on);
  btn.disabled = !!on;
  const t = btn.querySelector('.pl-src-btn-t');
  if (t) t.textContent = on ? '刷新中' : '刷新';
}

function setPlSrcState(key, text, cls) {
  const el = plSrcStateEl(key);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('ok', cls === 'ok');
  el.classList.toggle('err', cls === 'err');
}

// 刷每行右上角的状态文字（正在刷新 / 出错的行不动，避免覆盖进度）
function renderPlSrcStates() {
  const urls = plSrcUrls();
  const cur = S.importedPlaylistSource;
  PL_SRC_ROWS.forEach(({ key }) => {
    if (plSrcBusy[key] || plSrcError[key]) return;
    const url = (urls[key] || '').trim();
    const row = plSrcRowEl(key);
    const isCurrent = !!(cur && cur.type === 'url' && cur.url && url && cur.url === url);
    if (row) row.classList.toggle('active', isCurrent);
    if (!url) { setPlSrcState(key, '未填写链接'); return; }
    if (isCurrent) {
      const info = plSrcInfo[key];
      const extra = info
        ? ' · ' + info.count + ' 首' + (info.time ? ' · ' + info.time : '')
        : '';
      setPlSrcState(key, '✅ 当前歌单' +
        (S.importedPlaylistName ? '：' + S.importedPlaylistName : '') + extra, 'ok');
    } else {
      setPlSrcState(key, '已记住链接（未生效）');
    }
  });
}

function openPlaylistSourceModal() {
  const urls = plSrcUrls();
  // 首次打开：当前歌单是从链接抓来的，就把链接填到对应那一行，省得再去找
  const cur = S.importedPlaylistSource;
  if (cur && cur.type === 'url' && cur.url) {
    const slot = cur.platform === 'netease' ? 'netease' : 'qq';
    if (!urls[slot]) urls[slot] = cur.url;
  }
  document.querySelectorAll('.pl-src-input').forEach(inp => {
    inp.value = urls[inp.dataset.key] || '';
  });
  PL_SRC_ROWS.forEach(({ key }) => { plSrcError[key] = ''; });
  renderPlSrcStates();
  showModal('playlist-source-modal');
}

function closePlaylistSourceModal() {
  $('playlist-source-modal').hidden = true;
  saveConfig();   // 关窗立刻落盘，别等下一次操作
}

// 点「刷新」：按这一行的链接重抓歌单顺序（不改排序方式）
async function refreshPlaylistRow(key) {
  if (plSrcBusy[key]) return;
  const row = PL_SRC_ROWS.find(r => r.key === key);
  const inp = plSrcInputEl(key);
  const btn = plSrcBtnEl(key);
  const raw = ((inp && inp.value) || '').trim();
  const url = extractPlaylistUrl(raw);
  if (!url) {
    toast('先粘贴' + (row ? row.label + '的' : '') + '歌单链接');
    if (inp) inp.focus();
    return;
  }
  if (url !== raw && inp) inp.value = url;   // 分享文案 → 只留链接
  plSrcUrls()[key] = url;
  saveConfig();

  const detected = detectPlaylistPlatform(url);
  if (!detected) {
    plSrcError[key] = '看不出是歌单链接';
    setPlSrcState(key, '❌ 看不出是歌单链接', 'err');
    toast('这不像歌单链接（支持 QQ音乐 / 网易云）');
    return;
  }
  if (row && row.platform && row.platform !== detected && key !== 'auto') {
    toast('这是' + plSrcPlatformLabel(detected) + '的链接，已按那个平台抓取');
  }

  plSrcBusy[key] = true;
  plSrcError[key] = '';
  setPlSrcBtnBusy(btn, true);
  setPlSrcState(key, '正在抓取歌单…');
  const res = await refreshPlaylistSource(
    { type: 'url', url, platform: detected },
    { name: S.importedPlaylistName, silent: true }
  );
  plSrcBusy[key] = false;
  setPlSrcBtnBusy(btn, false);

  if (res && res.ok) {
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    plSrcInfo[key] = { count: res.count, time: hhmm };
    // 「其他」行抓成功后，把链接顺手归位到它真正的平台那一行
    const slot = res.platform === 'netease' ? 'netease' : 'qq';
    if (key === 'auto' && slot !== 'auto') {
      plSrcUrls()[slot] = url;
      const slotInp = plSrcInputEl(slot);
      if (slotInp) slotInp.value = url;
      plSrcInfo[slot] = { count: res.count, time: hhmm };
      plSrcError[slot] = '';
    }
    renderPlSrcStates();
    toast('已刷新：' + (res.name || '歌单') + '（' + res.count + ' 首）');
    updateSortLabel();
  } else {
    plSrcError[key] = (res && res.error) || '刷新失败';
    setPlSrcState(key, '❌ ' + plSrcError[key], 'err');
  }
}

document.querySelectorAll('.pl-src-input').forEach(inp => {
  const key = inp.dataset.key;
  inp.addEventListener('input', () => {
    plSrcUrls()[key] = inp.value.trim();
    plSrcError[key] = '';            // 用户改了内容，旧报错就作废
    renderPlSrcStates();
    clearTimeout(plSrcSaveTimer);
    plSrcSaveTimer = setTimeout(() => saveConfig(), 400);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); refreshPlaylistRow(key); }
  });
  inp.addEventListener('blur', () => {
    plSrcUrls()[key] = inp.value.trim();
    saveConfig();
  });
});
document.querySelectorAll('.pl-src-btn').forEach(btn => {
  btn.addEventListener('click', () => refreshPlaylistRow(btn.dataset.key));
});
document.querySelectorAll('[data-close="playlist-source"]').forEach(el => {
  el.addEventListener('click', closePlaylistSourceModal);
});

// ---------- 导入QQ音乐歌单排序 ----------
$('qqmusic-import-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      // 本地 JSON 也记下来源（只是没法在线刷新，菜单里不会出现刷新按钮）
      importQQMusicPlaylist(data, { source: { type: 'file', name: file.name } });
    } catch (err) {
      toast('文件解析失败：' + err.message);
    }
  };
  reader.readAsText(file, 'utf-8');
  e.target.value = '';
});

// 字符串规范化（用于模糊匹配）
function normalizeStr(s) {
  return String(s || '').toLowerCase()
    .replace(/[\\/:*?"<>|【】\[\]（）()《》<>!！?？,，.。、;；:：'"\s\-_~`@#$%^&+=|]/g, '')
    .trim();
}

// 导入QQ音乐歌单并应用排序
// opts.source: 这份歌单的来源 {type:'url',url,platform} | {type:'file',name} | null
// 记住来源之后，菜单里才会出现「🔄 刷新歌单顺序」——不用再去导出一遍链接
function importQQMusicPlaylist(data, opts = {}) {
  if (!data || !Array.isArray(data.songs) || data.songs.length === 0) {
    toast('无效的歌单文件');
    return;
  }
  const source = opts.source || null;
  const qqSongs = data.songs;
  const playlistName = data.dissname || 'QQ音乐歌单';
  // 本次导入用的来源（写进 state 和历史，供刷新用）
  S.importedPlaylistSource = source;
  // 顺手把链接记到「歌单来源」窗口对应那一行：下次打开窗口就是填好的，重启也不清空
  if (source && source.type === 'url' && source.url) {
    const urls = plSrcUrls();
    const slot = source.platform === 'netease' ? 'netease' : 'qq';
    urls[slot] = source.url;
    plSrcError[slot] = '';
    plSrcInfo[slot] = { count: qqSongs.length, time: '' };
    const inp = plSrcInputEl(slot);
    if (inp && !inp.value) inp.value = source.url;
  }
  
  // 构建本地音乐的规范化索引（真实曲目优先匹配，占位/缺失条目其次）
  const realList = [], phList = [];
  S.tracks.forEach((t, idx) => {
    ((t.isPlaceholder || t.isMissing) ? phList : realList).push(idx);
  });
  const keyOf = (title, artist) => normalizeStr(title) + '||' + normalizeStr(artist);
  const buildKeyMap = (list) => {
    const m = new Map();
    list.forEach(idx => {
      const k = keyOf(S.tracks[idx].title, S.tracks[idx].artist);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(idx);
    });
    return m;
  };
  const buildTitleMap = (list) => {
    const m = new Map();
    list.forEach(idx => {
      const k = normalizeStr(S.tracks[idx].title);
      if (!k) return;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(idx);
    });
    return m;
  };
  const buildLooseMap = (list) => {
    const m = new Map();
    list.forEach(idx => {
      const k = looseTitleOf(S.tracks[idx].title);
      if (!k) return;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(idx);
    });
    return m;
  };
  const realByKey = buildKeyMap(realList), phByKey = buildKeyMap(phList);
  const realByTitle = buildTitleMap(realList), phByTitle = buildTitleMap(phList);
  const realByLoose = buildLooseMap(realList), phByLoose = buildLooseMap(phList);

  // 匹配歌曲。优先级：真实曲目（精确键 → 去注释歌名+宽松歌手 → 仅歌名+宽松歌手）
  // > 占位/缺失（同序）> 真实曲目（仅歌名模糊）> 占位（仅歌名模糊）。真实曲目优先是关键：
  // 歌手名写法不统一时（DAOKO vs Daoko (ダラコ)/米津玄師）宁可让真实文件占住歌单位置，
  // 也不要让旧占位条目顶着"缺失"占位、把真实文件甩到列表末尾。
  const matchedSongs = [];
  const unmatchedSongs = [];
  const dupSongs = [];             // 歌单里重复出现的同一首歌（曲库只有一份 / 前面已建过占位）
  const usedIndices = new Set();
  const takenPlaceholderKeys = new Set();
  const takeKey = (map, key) => {
    for (const idx of (map.get(key) || [])) if (!usedIndices.has(idx)) return idx;
    return -1;
  };
  const takeLoose = (map, nameKey, qs) => {
    for (const idx of (map.get(nameKey) || [])) {
      if (!usedIndices.has(idx) && artistLooseMatch(qs.singer, S.tracks[idx].artist)) return idx;
    }
    return -1;
  };
  const takeFuzzyName = (list, qs, ignoreUsed) => {
    const nameKey = normalizeStr(qs.name);
    if (!nameKey) return -1;
    for (const idx of list) {
      if (!ignoreUsed && usedIndices.has(idx)) continue;
      const localName = normalizeStr(S.tracks[idx].title);
      if (localName && (localName === nameKey || localName.includes(nameKey) || nameKey.includes(localName))) return idx;
    }
    return -1;
  };
  // 曲库里到底有没有这首歌的**真实文件**（不排除已被歌单里前面条目占用的）
  const findAnyReal = (qs) => {
    const exact = realByKey.get(keyOf(qs.name, qs.singer));
    if (exact && exact.length) return exact[0];
    const lk = looseTitleOf(qs.name);
    if (lk) {
      for (const idx of (realByLoose.get(lk) || [])) if (artistLooseMatch(qs.singer, S.tracks[idx].artist)) return idx;
    }
    return takeFuzzyName(realList, qs, true);
  };

  qqSongs.forEach((qs, qIdx) => {
    const key = keyOf(qs.name, qs.singer);
    const nameKey = normalizeStr(qs.name);
    const looseKey = looseTitleOf(qs.name);
    let idx = takeKey(realByKey, key);
    if (idx < 0 && looseKey) idx = takeLoose(realByLoose, looseKey, qs);
    if (idx < 0) idx = takeLoose(realByTitle, nameKey, qs);
    if (idx < 0) idx = takeKey(phByKey, key);
    if (idx < 0 && looseKey) idx = takeLoose(phByLoose, looseKey, qs);
    if (idx < 0) idx = takeLoose(phByTitle, nameKey, qs);
    if (idx < 0) idx = takeFuzzyName(realList, qs);
    if (idx < 0) idx = takeFuzzyName(phList, qs);
    if (idx >= 0) {
      usedIndices.add(idx);
      matchedSongs.push({qqIndex: qIdx + 1, localIndex: idx, name: qs.name, singer: qs.singer});
      return;
    }
    // 没有可用的本地文件。但曲库里**其实有**这首歌（歌单里另一条已占用了那份文件，QQ 常见：
    // 同一首歌挂着两个不同 songid）——这时再建占位就会凭空多出一条「缺失」（用户看到的
    // 「明明有却显示缺失」）。直接跳过这条重复条目，不造占位、不排进列表。
    if (findAnyReal(qs) >= 0) {
      dupSongs.push({index: qIdx + 1, name: qs.name, singer: qs.singer, reason: 'local-exists'});
      return;
    }
    // 同一首歌在歌单里出现多次且曲库确实没有：只保留第一个占位，后面同样不再重复造
    const phKey = nameKey + '||' + normalizeStr(qs.singer);
    if (takenPlaceholderKeys.has(phKey)) {
      dupSongs.push({index: qIdx + 1, name: qs.name, singer: qs.singer, reason: 'duplicate-entry'});
      return;
    }
    takenPlaceholderKeys.add(phKey);
    unmatchedSongs.push({index: qIdx + 1, name: qs.name, singer: qs.singer, qs: qs});
  });
  // 被跳过的重复条目：按 qq 序号集合记下来，构建列表时直接略过
  const dupQqIndex = new Set(dupSongs.map(d => d.index));

  // 未匹配的本地音乐（保持原顺序）；同首歌已被真实文件顶掉的占位/缺失条目直接并入，不再重复出现
  const unmatchedLocal = [];
  S.tracks.forEach((t, idx) => {
    if (usedIndices.has(idx)) return;
    if (isFulfilledEntry(t)) return;
    unmatchedLocal.push(idx);
  });

  // 构建新的歌曲列表：按QQ音乐顺序，匹配的用本地歌曲，未匹配的创建占位
  const matchByQq = new Map();
  matchedSongs.forEach(m => matchByQq.set(m.qqIndex, m.localIndex));
  const newTracks = [];
  const now = Date.now();
  qqSongs.forEach((qs, qIdx) => {
    if (dupQqIndex.has(qIdx + 1)) return; // 歌单重复条目：已由前面的同名条目代表
    const li = matchByQq.get(qIdx + 1);
    if (li !== undefined) {
      newTracks.push(S.tracks[li]);
    } else {
      // 创建占位歌曲
      const placeholder = {
        path: 'placeholder://qqmusic_' + (qs.songid || qs.songmid || qIdx),
        title: qs.name || '未知歌曲',
        artist: qs.singer || '未知歌手',
        album: qs.album || '',
        duration: qs.duration || 0,
        addedTime: now + qIdx,
        root: '__placeholder__',
        isPlaceholder: true,
        qqmusicId: qs.songid,
        qqmusicMid: qs.songmid,
        cover: null
      };
      newTracks.push(placeholder);
    }
  });
  
  // 本地有但不在QQ音乐歌单里的歌曲跟在后面
  unmatchedLocal.forEach(idx => {
    newTracks.push(S.tracks[idx]);
  });

  // 收尾收敛：列表里如果已经存在同首歌的真实文件，任何还挂着的占位/缺失条目都直接摘掉。
  // 这是「旧数据里"缺失占位 + 已有文件"并存」的兜底（历史上匹配失败留下的），
  // 保证导入完不会再有"明明有这首歌却显示缺失"。
  const realTitleIdx = new Map();
  newTracks.forEach(t => {
    if (t.isPlaceholder || t.isMissing) return;
    const k = looseTitleOf(t.title);
    if (!k) return;
    if (!realTitleIdx.has(k)) realTitleIdx.set(k, []);
    realTitleIdx.get(k).push(t);
  });
  let convergedPh = 0;
  const converged = newTracks.filter(t => {
    if (!t.isPlaceholder) return true;
    const cands = realTitleIdx.get(looseTitleOf(t.title)) || [];
    if (cands.some(r => artistLooseMatch(t.artist, r.artist))) { convergedPh++; return false; }
    return true;
  });
  if (convergedPh > 0) {
    newTracks.length = 0;
    converged.forEach(t => newTracks.push(t));
  }
  
  S.tracks = newTracks;
  
  // 保存导入的歌单原始顺序，用于切换排序后恢复
  S.importedTrackOrder = newTracks.map(t => t.path);
  S.importedPlatform = data.platform || 'qqmusic';
  S.importedPlaylistName = playlistName || '';
  
  // 保存到导入历史（去重，同名同平台歌单更新）
  const historyId = (data.platform || 'qqmusic') + '_' + playlistName;
  const existingIdx = S.importedPlaylistHistory.findIndex(h => h.id === historyId);
  const historyItem = {
    id: historyId,
    name: playlistName,
    platform: data.platform || 'qqmusic',
    songs: qqSongs.map(s => ({
      name: s.name,
      singer: s.singer,
      album: s.album,
      duration: s.duration,
      songid: s.songid,
      songmid: s.songmid
    })),
    importedTime: Date.now(),
    source: source
  };
  if (existingIdx >= 0) {
    S.importedPlaylistHistory[existingIdx] = historyItem;
  } else {
    S.importedPlaylistHistory.unshift(historyItem);
  }
  // 最多保留20个历史记录
  if (S.importedPlaylistHistory.length > 20) {
    S.importedPlaylistHistory = S.importedPlaylistHistory.slice(0, 20);
  }
  
  // 导入歌单后切换到全部音乐视图，确保占位歌曲能正常显示（占位歌曲root为__placeholder__，在文件夹视图下会被过滤）
  S.activeFolder = null;
  S.showFavorites = false;
  S.activePlaylist = null;
  S.filterField = null;
  S.filterValue = '';
  renderSidebar();
  renderFolders();
  
  // 设置排序为自定义（用一个特殊的 sortKey）
  S.sortKey = 'qqmusic';
  S.sortDir = 1;
  updateSortLabel();   // 顺带把「刷新歌单顺序」这一项点亮/显示出来
  
  renderList();
  saveConfig();
  
  // 显示结果
  const matchRate = Math.round(matchedSongs.length / qqSongs.length * 100);
  const platName = (data.platform === 'netease') ? '网易云' : 'QQ音乐';
  let msg = `${platName}「${playlistName}」导入完成：${matchedSongs.length}/${qqSongs.length} 首匹配（${matchRate}%）`;
  if (unmatchedSongs.length > 0) {
    msg += `，${unmatchedSongs.length} 首本地确实没有（占位）`;
  }
  if (dupSongs.length > 0) {
    msg += `，合并 ${dupSongs.length} 条重复条目`;
  }
  if (convergedPh > 0) {
    msg += `，自动收敛 ${convergedPh} 条同名占位`;
  }
  toast(msg);
  
  // 详情进控制台：未匹配（真缺）与重复条目分开列，便于排查"为什么显示缺失"
  if (unmatchedSongs.length > 0) {
    console.log('未匹配的QQ音乐歌曲（本地确实没有）：', unmatchedSongs);
  }
  if (dupSongs.length > 0) {
    console.log('歌单重复条目已合并（曲库已有同曲 / 同一首重复出现）：', dupSongs);
  }
  
  // 更新排序菜单高亮（清除其他高亮）
  document.querySelectorAll('.sort-item').forEach(item => {
    item.classList.toggle('active', item.id === 'sort-import-qqmusic');
  });
}

// 初始化排序标签
updateSortLabel();

// ---------- 窗口置顶按钮 ----------
function togglePin() {
  try {
    if (window.mb && window.mb.toggleAlwaysOnTop) {
      window.mb.toggleAlwaysOnTop().then(result => {
        if (result.ok) {
          $('btn-pin').classList.toggle('active', result.alwaysOnTop);
          toast(result.alwaysOnTop ? '窗口已置顶' : '已取消置顶');
        }
      });
    }
  } catch (e) {
    toast('置顶失败: ' + e.message);
  }
}
$('btn-pin').addEventListener('click', togglePin);

// ---------- 设置面板 ----------
// ---------- 主题强调色 / 歌词字号 / 关闭行为 ----------
function hexToRgba(hex, alpha) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!isFinite(n)) return `rgba(255,107,61,${alpha})`;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 托盘迷你窗跟随主题：把当前生效的主题变量推给主进程（主进程缓存并转发小窗）。
// applyAccent / applyBgTheme 末尾都会调它，启动恢复配置时自然覆盖。
// 海报模式开着时附带从模糊封面提的主色（压暗过），小窗底色跟着海报走。
function pushMiniTheme() {
  try {
    if (!window.mb || typeof mb.setMiniTheme !== 'function') return;
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    // 亮色主题下不推海报深色底：小窗文字色跟随主界面，深底配深字会看不清
    const tint = (miniPosterTint && !document.body.classList.contains('theme-light')) ? miniPosterTint : null;
    mb.setMiniTheme({
      accent: v('--accent') || '#ff6b3d',
      // 只推实心基色：海报模式下 --bg 是半透明 rgba，推给小窗会让卡片透出桌面
      bg: v('--bg-base') || v('--bg') || '#12141a',
      bgElev: v('--bg-elev-base') || v('--bg-elev') || '#1a1d26',
      text: v('--text') || '#e8eaf0',
      textDim: v('--text-dim') || '#8b90a0',
      textFaint: v('--text-faint') || '#5a5f70',
      border: v('--border') || 'rgba(255,255,255,0.07)',
      hover: v('--hover') || 'rgba(255,255,255,0.05)',
      posterBg: tint ? tint.bg : '',
      posterElev: tint ? tint.bgElev : ''
    });
  } catch (e) /* ignore */ {}
}

// ---------- 迷你窗海报底色 ----------
// 从模糊封面（data URL）里提平均主色，HSL 压暗到暗色可读区间。
// 2026-11-20 用户要求：悬浮窗底色也适配海报的颜色。
let miniPosterTint = null;         // { bg, bgElev }，null = 不染色
const miniTintCache = new Map();   // blurredUrl -> tint（同一张封面的模糊结果只提一次色）
function computePosterTint(imgUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 16; c.height = 16;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
        const { h, s } = hexToHsl(hex);
        const sat = Math.min(42, Math.max(16, s));
        resolve({ bg: hslToHex(h, sat, 12), bgElev: hslToHex(h, sat, 17) });
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = imgUrl;
  });
}
// setPosterBackground 末尾调用：海报开着且有封面时提色推小窗，关掉/无封面时恢复主题底色
function syncMiniPosterTint(blurredUrl) {
  if (!posterBgOn() || !blurredUrl) {
    if (miniPosterTint) { miniPosterTint = null; pushMiniTheme(); }
    return;
  }
  const cached = miniTintCache.get(blurredUrl);
  if (cached) {
    if (JSON.stringify(cached) !== JSON.stringify(miniPosterTint)) { miniPosterTint = cached; pushMiniTheme(); }
    return;
  }
  computePosterTint(blurredUrl).then(t => {
    if (!t) return;
    miniTintCache.set(blurredUrl, t);
    if (miniTintCache.size > 12) miniTintCache.delete(miniTintCache.keys().next().value);
    if (posterBgOn() && JSON.stringify(t) !== JSON.stringify(miniPosterTint)) {
      miniPosterTint = t;
      pushMiniTheme();
    }
  }).catch(() => {});
}

function applyAccent(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(color, 0.14));
  S.settings.accent = color;
  syncAccentSwatches();
  pushMiniTheme();
}

function syncAccentSwatches() {
  const cur = (S.settings.accent || '#ff6b3d').toLowerCase();
  let matched = false;
  document.querySelectorAll('#accent-swatches .accent-swatch').forEach(btn => {
    const c = (btn.dataset.color || '').toLowerCase();
    const on = !!c && c === cur;
    if (on) matched = true;
    btn.classList.toggle('active', on);
  });
  // 颜色不在预设里 → 自定义色卡显示选中态
  const wrap = $('accent-custom-wrap');
  if (wrap) wrap.classList.toggle('active', !matched);
  const inp = $('accent-custom');
  if (inp && /^#[0-9a-f]{6}$/i.test(cur)) inp.value = cur;
}

// ---------- 界面底色 ----------
// 只让用户选一个"基色"，面板/卡片按它的明度自动上浮，任何底色都不会出现撞色或断层
function hexToHsl(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  if (!isFinite(n)) return { h: 220, s: 14, l: 9 };
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let s = 0, hh = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hh = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
  }
  return { h: hh, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  const to = (v) => Math.round(Math.max(0, Math.min(1, v + m)) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

function applyBgTheme(color) {
  const base = /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#12141a';
  const { h, s, l } = hexToHsl(base);
  const light = l > 55;   // 亮底色必须反转文字色，否则白字压白底全看不见
  const root = document.documentElement.style;
  // 只写 *-base 三个基色变量：--bg/--bg-elev/--bg-elev2 由 CSS 默认指向 base，
  // 海报模式下 applyPosterBgSetting 会再把它们换成半透明 rgba（基色变了要重算）
  root.setProperty('--bg-base', base);
  root.setProperty('--bg-elev-base', hslToHex(h, s, Math.min(93, l + 4.5)));
  root.setProperty('--bg-elev2-base', hslToHex(h, s, Math.min(96, l + 9)));
  root.setProperty('--text', light ? '#1b1e24' : '#e8eaf0');
  root.setProperty('--text-dim', light ? '#5c6272' : '#8b90a0');
  root.setProperty('--text-faint', light ? '#8d93a3' : '#5a5f70');
  root.setProperty('--hover', light ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)');
  root.setProperty('--border', light ? 'rgba(0, 0, 0, 0.09)' : 'rgba(255, 255, 255, 0.07)');
  root.setProperty('--sel-bg', light ? 'rgba(0, 0, 0, 0.07)' : 'rgba(255, 255, 255, 0.06)');
  document.body.classList.toggle('theme-light', light);
  S.settings.bgTheme = base;
  syncBgSwatches();
  pushMiniTheme();
  applyPosterBgSetting();   // 海报模式下重算半透明表面（换底色后 rgba 得跟着新基色走）
}

function syncBgSwatches() {
  const cur = (S.settings.bgTheme || '').toLowerCase();
  let matched = false;
  document.querySelectorAll('#bg-swatches .accent-swatch').forEach(btn => {
    const c = (btn.dataset.color || '').toLowerCase();
    const on = !!c && c === cur;
    if (on) matched = true;
    btn.classList.toggle('active', on);
  });
  const wrap = $('bg-custom-wrap');
  if (wrap) wrap.classList.toggle('active', !matched);
  const inp = $('bg-custom');
  if (inp && /^#[0-9a-f]{6}$/i.test(cur)) inp.value = cur;
}

// ---------- 纯色模式底色预设（可增删，持久化到 S.settings.bgPresets） ----------
const BG_PRESET_DEFAULTS = ['#12141a', '#0a0a0c', '#0e1626', '#171210', '#0d1a15', '#16101f'];
function bgPresets() {
  const v = S.settings.bgPresets;
  if (!Array.isArray(v)) { S.settings.bgPresets = [...BG_PRESET_DEFAULTS]; return S.settings.bgPresets; }
  return v;
}
// 动态渲染底色预设色块（插在自定义取色前面）；右键删除，自定义取色自动入库
function renderBgPresets() {
  const wrap = $('bg-swatches');
  if (!wrap) return;
  const anchor = $('bg-custom-wrap');
  wrap.querySelectorAll('button[data-preset]').forEach(b => b.remove());
  bgPresets().forEach((hex) => {
    const b = document.createElement('button');
    b.className = 'accent-swatch';
    b.dataset.color = hex;
    b.dataset.preset = '1';
    b.style.setProperty('--c', hex);
    b.title = hex + '（右键删除该预设）';
    b.addEventListener('click', () => {
      applyBgTheme(hex);
      saveConfig();
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const list = bgPresets();
      const i = list.indexOf(hex);
      if (i >= 0) {
        list.splice(i, 1);
        saveConfig();
        renderBgPresets();
        syncBgSwatches();
        toast('已删除底色预设 ' + hex);
      }
    });
    if (anchor) wrap.insertBefore(b, anchor); else wrap.appendChild(b);
  });
}
function addBgPreset(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex || '')) return;
  const list = bgPresets();
  const low = hex.toLowerCase();
  if (!list.some(c => String(c).toLowerCase() === low)) {
    list.push(low);
    saveConfig();
    renderBgPresets();
    syncBgSwatches();
  }
}

function applyLyricScale() {
  const scale = S.settings.lyricScale || 1;
  document.documentElement.style.setProperty('--lyric-scale', String(scale));
  // 海报页 A+/A− 控件的数值跟着刷（启动恢复配置时也走这里）
  document.querySelectorAll('[data-fs-val]').forEach(el => {
    el.textContent = scale.toFixed(1) + '×';
  });
}

// ---------- 歌词同步微调（快 / 慢） ----------
// 语义：offset > 0 → 歌词提前（听觉上"歌还在唱，字幕先到"）；< 0 → 歌词延后。
// 记忆粒度：每首歌各自一份（settings.lyricOffsets[path]），换歌不会把上一首的偏移带过去。
const LYRIC_OFFSET_STEP = 0.1;
const LYRIC_OFFSET_LIMIT = 5;
function lyricOffsetsMap() {
  if (!S.settings.lyricOffsets || typeof S.settings.lyricOffsets !== 'object') S.settings.lyricOffsets = {};
  return S.settings.lyricOffsets;
}
function currentTrackPath() {
  if (S.current >= 0 && S.tracks[S.current]) return S.tracks[S.current].path || '';
  return '';
}
function lyricOffsetSec() {
  const v = Number(S.settings.lyricOffset);
  return isFinite(v) ? v : 0;
}
// 切歌时把"这首歌"存下的偏移读进实时值；没存过就是 0
function loadLyricOffsetForTrack() {
  const p = currentTrackPath();
  const m = lyricOffsetsMap();
  const v = p && typeof m[p] === 'number' && isFinite(m[p]) ? m[p] : 0;
  S.settings.lyricOffset = Math.round(v * 10) / 10;
  applyLyricOffset();
}
// 写入实时值 + 落到当前这首歌头上
function setLyricOffset(v) {
  v = Math.round(Math.max(-LYRIC_OFFSET_LIMIT, Math.min(LYRIC_OFFSET_LIMIT, v)) * 10) / 10;
  S.settings.lyricOffset = v;
  const p = currentTrackPath();
  const m = lyricOffsetsMap();
  if (p) {
    if (Math.abs(v) < 0.001) delete m[p];   // 归零就不再占配置空间
    else m[p] = v;
  }
}
function applyLyricOffset() {
  const v = lyricOffsetSec();
  const sign = v > 0.001 ? '+' : (v < -0.001 ? '−' : '');
  const txt = sign + Math.abs(v).toFixed(1) + 's';
  document.querySelectorAll('[data-lo-val]').forEach(el => {
    el.textContent = txt;
    el.classList.toggle('active', Math.abs(v) > 0.001);
  });
}
// 调完立刻重算当前行，不用等下一次 timeupdate
function refreshLyricHighlightNow() {
  lastLyricActiveIdx = -2;      // 幂等失效，强制重算
  updateLyricsHighlight();
  if (pf.open) updatePFLyricsHighlight(true);
}
// 把当前这首歌的歌词调速同步进歌词缓存边车（.lrc.json 的 offset 字段）。
// 配置里按路径记的偏移在文件挪位置后会丢；边车跟着「歌手 - 标题.lrc」走，路径无关。
// 只在本地已有这份歌词的缓存文件时写（没文件就没边车可挂）。
function syncLyricOffsetToCache() {
  try {
    const t = S.tracks[S.current];
    if (!t || !window.mb || typeof mb.saveLyricOffset !== 'function') return;
    const lyricsKey = `${t.artist} - ${t.title}`.toLowerCase().replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!S.localLyricsFiles.has(lyricsKey)) return;
    mb.saveLyricOffset({ saveDir: S.settings.cachePath || '', artist: t.artist, title: t.title, offset: lyricOffsetSec() });
  } catch (e) { /* ignore */ }
}
document.querySelectorAll('.lyric-offset .lo-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const step = parseFloat(btn.dataset.lo) * LYRIC_OFFSET_STEP;
    setLyricOffset(lyricOffsetSec() + step);
    applyLyricOffset();
    refreshLyricHighlightNow();
    saveConfig();
    syncLyricOffsetToCache();
  });
});
// 点数值本身归零
document.querySelectorAll('[data-lo-val]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Math.abs(lyricOffsetSec()) < 0.001) return;
    setLyricOffset(0);
    applyLyricOffset();
    refreshLyricHighlightNow();
    saveConfig();
    syncLyricOffsetToCache();
    toast('本首歌词同步已复位');
  });
});

// ---------- 海报页歌词字号（A+ / A−，点数值恢复默认） ----------
const LYRIC_SCALE_MIN = 0.8, LYRIC_SCALE_MAX = 1.5, LYRIC_SCALE_STEP = 0.05;
function setLyricScaleValue(v, persist = true) {
  const clamped = Math.min(LYRIC_SCALE_MAX, Math.max(LYRIC_SCALE_MIN, Math.round(v * 100) / 100));
  S.settings.lyricScale = clamped;
  applyLyricScale();
  // 海报页竖排控件
  document.querySelectorAll('[data-fs-val]').forEach(el => {
    el.textContent = clamped.toFixed(1) + '×';
  });
  // 字号变化会改变行高，重新居中当前行
  centerLyricLine(true);
  if (pf.open) {
    pfScrollToActive(true);
  }
  if (persist) saveConfig();
}
document.querySelectorAll('[data-fs]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const dir = parseFloat(btn.dataset.fs) || 0;
    setLyricScaleValue((S.settings.lyricScale || 1) + dir * LYRIC_SCALE_STEP);
  });
});
// 点数值恢复默认 1.0×
document.querySelectorAll('[data-fs-val]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Math.abs((S.settings.lyricScale || 1) - 1) < 0.001) return;
    setLyricScaleValue(1);
    toast('歌词字号已恢复默认');
  });
});

// 关闭按钮行为：最小化到托盘 / 直接退出（主进程据此决定 close 时怎么处理）
function applyCloseBehavior() {
  try {
    if (window.mb && typeof mb.setCloseToTray === 'function') {
      mb.setCloseToTray(S.settings.closeToTray !== false);
    }
  } catch (e) { /* ignore */ }
}

document.querySelectorAll('#accent-swatches .accent-swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!btn.dataset.color) return;
    applyAccent(btn.dataset.color);
    saveConfig();
  });
});

// 底色预设色块是动态渲染的（增删后重建 DOM），用事件委托绑定，重建不用重挂
$('bg-swatches').addEventListener('click', (e) => {
  const btn = e.target.closest('button.accent-swatch');
  if (!btn || !btn.dataset.color) return;
  applyBgTheme(btn.dataset.color);
  saveConfig();
});
renderBgPresets(); // 启动先铺预设色块（配置持久化，重启不丢）

// 自定义强调色
(function initAccentCustom() {
  const inp = $('accent-custom');
  if (!inp) return;
  inp.addEventListener('input', () => {
    applyAccent(inp.value);
  });
  inp.addEventListener('change', () => saveConfig());
})();

// 自定义底色
(function initBgCustom() {
  const inp = $('bg-custom');
  if (!inp) return;
  inp.addEventListener('input', () => {
    applyBgTheme(inp.value);
  });
  inp.addEventListener('change', () => {
    addBgPreset(inp.value);   // 自定义色自动加入预设列表（去重）
    saveConfig();
  });
})();

// 外观浮窗：海报氛围度滑块（0~100，拖动即预览）。
// 2026-11-22 精简：原「海报氛围强度 + 界面透明度」两滑块合并为一个——
// 同值双写 posterIntensity（氛围层浓度）与 uiTransparency（表面透出度），
// 拖起来就是"氛围浓/淡"的一体调节，两个消费端不用改。
$('tp-ui-opacity').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  const val = isNaN(v) ? 1 : Math.max(0, Math.min(1, v / 100));
  S.settings.uiTransparency = val;
  S.settings.posterIntensity = val;
  $('tp-ui-opacity-val').textContent = Math.round(val * 100) + '%';
  applyPosterBgSetting();
  saveConfig();
});

// 外观浮窗：背景模式切换（纯色 / 海报），切换即生效并记住
document.querySelectorAll('#bg-mode-seg button').forEach(btn => {
  btn.addEventListener('click', () => {
    S.settings.bgMode = btn.dataset.mode === 'solid' ? 'solid' : 'poster';
    syncBgModeUI();
    applyPosterBgSetting();
    saveConfig();
    toast(S.settings.bgMode === 'poster' ? '背景：海报氛围' : '背景：纯色');
  });
});
// 同步外观浮窗的模式按钮选中态与两个滑块的显隐/数值
function syncBgModeUI() {
  const seg = $('bg-mode-seg');
  if (!seg) return;
  seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', (b.dataset.mode === 'solid') !== posterBgOn()));
  $('tp-ui-row').hidden = !posterBgOn();
  $('tp-ui-opacity').value = String(Math.round(uiTransparencyVal() * 100));
  $('tp-ui-opacity-val').textContent = Math.round(uiTransparencyVal() * 100) + '%';
}

$('btn-settings').addEventListener('click', async (e) => {
  e.stopPropagation();
  const pop = $('settings-modal');
  const opening = pop.hidden;
  // 互斥（浮层家族统一规则）：别的浮层开着先收掉
  $('theme-popover').hidden = true;
  $('desktop-lyric-menu').hidden = true;
  if (!$('batch-menu').hidden) { $('batch-menu').hidden = true; hideMenuOverlay(); }
  if (!opening) { pop.hidden = true; return; }
  // 封面/歌词合并为一个「自动获取」开关（autoCover/autoLyrics/saveCover/saveLyrics 联动）
  $('set-auto-fetch').checked = S.settings.autoCover !== false;
  $('set-cache-path').value = S.settings.cachePath || '';
  // 输入框宽度有限，长路径会显示不全，挂个 title 让悬停能看到完整路径
  $('set-cache-path').title = S.settings.cachePath || '';
  $('set-word-lyrics').checked = wordLyricsOn();
  $('set-close-tray').checked = S.settings.closeToTray !== false;
  syncAccentSwatches();
  syncBgSwatches();
  applyLyricOffset();
  // 开机自启：读系统真实状态（写死的 settings 字段可能与注册表不同步）
  try {
    if (window.mb && window.mb.getAutostart) {
      $('set-autostart').checked = await window.mb.getAutostart();
    }
  } catch (e) { $('set-autostart').checked = false; }
  // 获取默认路径，更新 placeholder
  try {
    if (window.mb && window.mb.getDefaultDirs) {
      const dirs = await window.mb.getDefaultDirs();
      $('set-cache-path').placeholder = '默认：' + (dirs.cache || '软件目录/cache');
    }
  } catch (e) {}
  placeFloatMenu(pop, $('btn-settings'));
});

document.querySelectorAll('[data-close="settings"]').forEach(el => {
  el.addEventListener('click', () => { $('settings-modal').hidden = true; });
});

$('btn-clear-cache-path').addEventListener('click', () => {
  $('set-cache-path').value = '';
});
$('btn-open-cache-path').addEventListener('click', async () => {
  let dir = $('set-cache-path').value.trim();
  if (!dir && window.mb && window.mb.getDefaultDirs) {
    try {
      const dirs = await window.mb.getDefaultDirs();
      dir = dirs.cache;
    } catch (e) {}
  }
  if (dir && window.mb && window.mb.openFolder) {
    window.mb.openFolder(dir);
  } else {
    toast('无法打开文件夹');
  }
});

$('btn-save-settings').addEventListener('click', () => {
  // 「自动获取封面与歌词」单一开关：auto 联动 save（抓取结果统一入缓存文件夹）
  const autoFetch = $('set-auto-fetch').checked;
  S.settings.autoCover = autoFetch;
  S.settings.autoLyrics = autoFetch;
  S.settings.saveCover = autoFetch;
  S.settings.saveLyrics = autoFetch;
  S.settings.cachePath = $('set-cache-path').value.trim();
  const wordBefore = wordLyricsOn();
  S.settings.wordLyrics = $('set-word-lyrics').checked;
  // 用户在设置里改过就记下来，避免下次启动被"默认关"的一次性迁移覆盖
  S.settings.lyricWordOptOut = true;
  syncPFWordToggle();
  S.settings.closeToTray = $('set-close-tray').checked;
  applyCloseBehavior();
  // 开机自启：调主进程写系统登录项；失败时 toast 提示但不算保存失败
  if (window.mb && window.mb.setAutostart) {
    window.mb.setAutostart($('set-autostart').checked).catch(() => toast('开机自启设置失败'));
  }
  // 逐字开关变化后重渲染歌词，立即生效
  if (wordBefore !== S.settings.wordLyrics && pf.lyrics && pf.lyrics.length) {
    renderPFLyrics(pf.lyrics);
    renderLyricsLines();
  }
  $('settings-modal').hidden = true;
  toast('设置已保存');
  saveConfig();
});

// 检查更新：占位入口，功能后续接入
$('btn-check-update').addEventListener('click', () => {
  toast('检查更新功能即将上线，敬请期待');
});

// ---------- 歌词面板 ----------
// 统一打开入口：先收起播放列表抽屉（同一角落只留一个浮层），再按需刷新内容。
// 右键「获取歌词」、手动导入歌词等入口也走这里，避免各写一份。
function showLyricsPanel() {
  closeQueuePanel();
  // 桌面歌词外观菜单也是右下角浮层，一起收掉
  const dlm = $('desktop-lyric-menu');
  if (dlm) dlm.hidden = true;
  const panel = $('lyrics-panel');
  const wasHidden = panel.hidden;
  panel.hidden = false;
  // 页脚按钮跟着亮一下（用中性高亮，不是主题橙，见 style.css 注释）
  if ($('btn-lyrics')) $('btn-lyrics').classList.add('active');
  if (wasHidden) {
    if (S.current >= 0) {
      const t = S.tracks[S.current];
      if (S.lyricsCache.has(t.path)) {
        renderLyrics(S.lyricsCache.get(t.path));
      } else if (S.settings.autoLyrics) {
        fetchAndApplyLyrics(t, true);
      }
    }
    // 面板刚从 hidden 变可见：之前算好的滚动位置全部失效，强制重算并即刻居中
    lastLyricActiveIdx = -2;
    updateLyricsHighlight();
    centerLyricLine(true);
  }
}

$('btn-lyrics').addEventListener('click', () => {
  const panel = $('lyrics-panel');
  // 桌面歌词外观菜单也是右下角的浮层，点「歌词」时先收掉
  const dm = $('desktop-lyric-menu');
  if (dm) dm.hidden = true;
  if (!panel.hidden) {
    // 统一出口：closeLyricsPanel 负责收面板 + 灭掉按钮高亮
    closeLyricsPanel();
    return;
  }
  showLyricsPanel();
});
$('btn-lyrics-close').addEventListener('click', () => {
  closeLyricsPanel();
});

// 歌词模式切换（原文/翻译/音译）
document.querySelectorAll('.lyrics-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    switchLyricsMode(btn.dataset.mode);
  });
});

// ESC 关闭模态框
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('queue-panel') && $('queue-panel').classList.contains('open')) { toggleQueuePanel(false); e.__pfEscHandled = true; return; }
    if (!$('settings-modal').hidden) { $('settings-modal').hidden = true; e.__pfEscHandled = true; }
    else if (!$('lyrics-panel').hidden) { $('lyrics-panel').hidden = true; e.__pfEscHandled = true; }
    closeAllFloatMenus();
  }
});

// ---------- 右键菜单 ----------
let ctxTrackIdx = -1;
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.track-row');
  if (!row) return;
  e.preventDefault();
  // 右键菜单是 contextmenu 事件（不走左键捕获关闭），先收起所有浮层/其他菜单再开，杜绝重叠
  closeAllFloatMenus();
  ctxTrackIdx = parseInt(row.dataset.idx, 10);
  const track = S.tracks[ctxTrackIdx];
  // 多选（Ctrl/Shift 选了多行）→ 批量菜单；右键没选中的行时先把它变成单选
  const isMulti = track && S.multiSel.has(track) && S.multiSel.size > 1;
  if (!isMulti && track) {
    S.multiSel.clear();
    S.multiSel.add(track);
    S.selectedIdx = ctxTrackIdx;
    S.selAnchor = track;
    refreshSelectionClasses();
    renderStats();
  }
  const menu = $(isMulti ? 'batch-context-menu' : 'context-menu');
  $('context-menu').hidden = true;
  $('batch-context-menu').hidden = true;
  menu.hidden = false;
  if (isMulti) {
    const cnt = $('batch-ctx-count');
    if (cnt) cnt.textContent = '已选 ' + S.multiSel.size + ' 首';
  }
  // 占位歌曲：隐藏大部分菜单项，只显示有限选项
  const isPlaceholder = track && track.isPlaceholder;
  if (!isMulti) {
    menu.querySelectorAll('.ctx-item').forEach(item => {
      const action = item.dataset.action;
      if (isPlaceholder) {
        // 占位/缺失歌曲只留：「复制歌曲名称」（第一项）、「补全信息」、两个平台外链和「删除歌曲」。
        // 占位 = 本地根本没这首歌，复制歌名去别处搜索 / 在线看页面反而最有用。
        item.style.display = (action === 'copy-track-name' || action === 'delete-track' || action === 'online-qqmusic' || action === 'online-netease' || action === 'complete-info') ? '' : 'none';
      } else {
        // 正常歌曲不显示「复制歌曲名称」（那是缺失歌曲菜单的第一项专属）
        item.style.display = (action === 'copy-track-name') ? 'none' : '';
      }
    });
  }
  // 先显示以获取实际尺寸
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const menuWidth = menu.offsetWidth || 200;
  const menuHeight = menu.offsetHeight || 300;
  // 计算 X 坐标，避免超出左右边缘
  let x = e.clientX;
  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 5;
  }
  if (x < 0) x = 5;
  // 计算 Y 坐标，避免超出上下边缘
  let y = e.clientY;
  if (y + menuHeight > window.innerHeight) {
    // 向下放不下，向上弹出
    y = e.clientY - menuHeight;
    if (y < 0) y = 5; // 向上也放不下就贴顶部
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.visibility = 'visible';
});

// ---------- 平台外链：歌单右键「QQ音乐查看 / 网易云查看」+ 全屏专辑页右键跳转 ----------
// 设计要点（2026-11-19 改版）：
//  · 平台由菜单项显式指定，strictPlatform:true 只查那一家，不再自动串台；
//  · 精确页定位不到就落到该平台的搜索页，保证点下去永远有反应；
//  · 缓存加 `strict|` 前缀，与旧版「联网查看」的跨平台兜底结果彻底隔离。
const ONLINE_WANT_LABEL = { song: '单曲页', album: '专辑页', artist: '歌手主页' };
const ONLINE_PLATFORM_LABEL = { qqmusic: 'QQ音乐', netease: '网易云音乐' };
const onlinePrefetch = new Map();   // 缓存键 -> Promise（悬停时预热，点下去往往已经好了）

function onlineCacheKey(platform, want, t) {
  // 歌手页只看歌手本身：同一歌手不同歌解析出来是同一个主页，别按歌缓存成多条
  const sub = want === 'album' ? (t.artist + '|' + t.album)
    : want === 'artist' ? String(t.artist || '')
    : (t.artist + '|' + t.title);
  return 'strict|' + platform + '|' + want + '|' + String(sub || '').toLowerCase();
}

function onlineCacheGet(key) {
  const c = S.settings.onlineLinkCache || {};
  const hit = c[key];
  return hit && hit.url ? hit : null;
}

function onlineCacheSet(key, data) {
  const c = S.settings.onlineLinkCache || (S.settings.onlineLinkCache = {});
  c[key] = {
    url: data.url, platform: data.platform, label: data.label || '',
    fallback: !!data.fallback, at: Date.now()
  };
  // 上限 400 条，按写入顺序淘汰最旧的（够用，不必真做 LRU）
  const keys = Object.keys(c);
  if (keys.length > 400) keys.slice(0, keys.length - 400).forEach((k) => { delete c[k]; });
  saveConfig();
}

function resolveOnlineData(platform, want, track) {
  const key = onlineCacheKey(platform, want, track);
  const cached = onlineCacheGet(key);
  if (cached && cached.platform === platform) return Promise.resolve(cached);
  if (onlinePrefetch.has(key)) return onlinePrefetch.get(key);
  const p = window.mb.resolveOnlinePage({
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    want,
    platform,
    songmid: track.qqmusicMid || '',
    strictPlatform: true
  }).then((res) => {
    const data = res && res.ok ? res.data : null;
    if (data) onlineCacheSet(key, data);
    onlinePrefetch.delete(key);
    return data;
  }).catch(() => { onlinePrefetch.delete(key); return null; });
  onlinePrefetch.set(key, p);
  return p;
}

function hideAllCtxMenus() {
  $('context-menu').hidden = true;
  $('batch-context-menu').hidden = true;
  $('placeholder-ctx-menu').hidden = true;
  const albumMenu = $('album-online-menu');
  if (albumMenu) albumMenu.hidden = true;
  const onlineMenu = $('online-track-menu');
  if (onlineMenu) onlineMenu.hidden = true;
}

async function openPlatformPage(platform, want, track) {
  if (!track) return;
  const platName = ONLINE_PLATFORM_LABEL[platform] || '平台';
  const label = ONLINE_WANT_LABEL[want] || '页面';
  if (!onlineCacheGet(onlineCacheKey(platform, want, track))) toast('正在定位' + platName + label + '…');
  const data = await resolveOnlineData(platform, want, track);
  hideAllCtxMenus();
  if (!data || !data.url) { toast('没定位到' + platName + '页面，换一个平台试试'); return; }
  const r = await window.mb.openExternal(data.url);
  if (r && r.ok === false) { toast('打开失败：' + (r.error || '未知错误')); return; }
  toast(data.fallback ? ('没定位到精确页面，已在' + platName + '打开搜索结果')
    : ('已在' + platName + '打开' + label + (data.label ? '：' + data.label : '')));
}

// 悬停预热：歌单右键两项 / 专辑页右键两项，点下去时多半已经有结果
document.querySelectorAll('#context-menu .ctx-item[data-action^="online-"]').forEach((item) => {
  item.addEventListener('mouseenter', () => {
    const track = S.tracks[ctxTrackIdx];
    if (track) resolveOnlineData(item.dataset.action === 'online-qqmusic' ? 'qqmusic' : 'netease', 'song', track);
  });
});

// ---------- 全屏专辑页：右键歌名 / 歌手 / 专辑 / 封面 → 选平台看详情或本地筛选 ----------
(function bindAlbumOnlineMenu() {
  const trigger = document.querySelector('.pf-cover-col');
  const menu = $('album-online-menu');
  if (!trigger || !menu) return;

  let pfMenuWant = 'album';   // 本次菜单针对的目标类型（song/artist/album）
  let pfMenuFilter = null;    // 「在曲库中筛选」要用的 {field, value}，null 则隐藏该项

  const hide = () => { menu.hidden = true; };
  const show = (x, y) => {
    menu.hidden = false;
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';
    const mw = menu.offsetWidth || 180;
    const mh = menu.offsetHeight || 100;
    menu.style.left = Math.max(5, Math.min(x, window.innerWidth - mw - 5)) + 'px';
    menu.style.top = Math.max(5, Math.min(y, window.innerHeight - mh - 5)) + 'px';
    menu.style.visibility = 'visible';
  };

  function openMenu(e, want) {
    const track = S.tracks[S.current];
    if (!track) return;
    e.preventDefault();
    e.stopPropagation();
    pfMenuWant = want;
    const artist = (track.artist || '').trim();
    const album = (track.album || '').trim();
    pfMenuFilter = want === 'artist' && artist ? { field: 'artist', value: artist }
      : want === 'album' && album ? { field: 'album', value: album }
      : null;
    const filterItem = $('album-online-filter');
    const filterSep = $('album-online-filter-sep');
    if (filterItem) filterItem.hidden = !pfMenuFilter;
    if (filterSep) filterSep.hidden = !pfMenuFilter;
    const title = $('album-online-title');
    if (title) {
      const target = want === 'artist' ? (artist || '歌手')
        : want === 'album' ? (album || track.title || '这张专辑')
        : (track.title || '这首歌');
      title.textContent = '在平台查看：' + target;
    }
    closeAllFloatMenus();
    show(e.clientX, e.clientY);
  }

  trigger.addEventListener('contextmenu', (e) => openMenu(e, 'album'));
  $('pf-title').addEventListener('contextmenu', (e) => openMenu(e, 'song'));
  $('pf-artist').addEventListener('contextmenu', (e) => openMenu(e, 'artist'));
  $('pf-album').addEventListener('contextmenu', (e) => openMenu(e, 'album'));

  menu.querySelectorAll('.ctx-item[data-platform]').forEach((item) => {
    item.addEventListener('mouseenter', () => {
      const track = S.tracks[S.current];
      if (track) resolveOnlineData(item.dataset.platform, pfMenuWant, track);
    });
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = S.tracks[S.current];
      if (!track) { hide(); return; }
      // 记住所选平台：之后左键直接跳这家（用户常犯懒，不每次都右键选）
      S.settings.onlineJumpPlatform = item.dataset.platform;
      saveConfig();
      openPlatformPage(item.dataset.platform, pfMenuWant, track);
    });
  });

  const filterItem = $('album-online-filter');
  if (filterItem) filterItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hide();
    if (pfMenuFilter) pfFilterAndClose(pfMenuFilter.field, pfMenuFilter.value);
  });

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('#album-online-menu')) hide();
  });
  window.addEventListener('blur', hide);
})();

document.addEventListener('click', (e) => {
  if (!e.target.closest('#context-menu')) {
    $('context-menu').hidden = true;
  }
  if (!e.target.closest('#batch-context-menu')) {
    $('batch-context-menu').hidden = true;
  }
  if (!e.target.closest('#placeholder-ctx-menu')) {
    $('placeholder-ctx-menu').hidden = true;
  }
  if (!e.target.closest('#folder-ctx-menu')) {
    $('folder-ctx-menu').hidden = true;
  }
});

// ---------- 资料库文件夹右键菜单（移除该文件夹） ----------
let folderCtxRoot = null;
function showFolderCtxMenu(x, y, root) {
  folderCtxRoot = root;
  const menu = $('folder-ctx-menu');
  menu.hidden = false;
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const mw = menu.offsetWidth || 150;
  const mh = menu.offsetHeight || 40;
  let mx = x, my = y;
  if (mx + mw > window.innerWidth) mx = window.innerWidth - mw - 5;
  if (my + mh > window.innerHeight) my = Math.max(5, y - mh);
  menu.style.left = mx + 'px';
  menu.style.top = my + 'px';
  menu.style.visibility = 'visible';
}
document.querySelectorAll('#folder-ctx-menu .ctx-item').forEach(item => {
  item.addEventListener('click', async () => {
    $('folder-ctx-menu').hidden = true;
    if (item.dataset.action !== 'folder-remove' || !folderCtxRoot) return;
    const root = folderCtxRoot;
    folderCtxRoot = null;
    const name = root.split(/[\\/]/).pop() || root;
    const ok = await showConfirm('移除文件夹',
      `确定从曲库移除「${name}」吗？文件夹里的音频文件不会被删除，只是不再纳入曲库扫描。`);
    if (ok) removeFolder(root);
  });
});

// ---------- 占位统计右键菜单（左侧「X 首缺失（占位）」） ----------
$('stats').addEventListener('contextmenu', (e) => {
  const tag = e.target.closest('#placeholder-stat');
  if (!tag) return;
  e.preventDefault();
  const placeholders = S.tracks.filter(t => t.isPlaceholder && !t.isMissing);
  if (!placeholders.length) return;
  closeAllFloatMenus();
  const menu = $('placeholder-ctx-menu');
  $('placeholder-ctx-title').textContent = placeholders.length + ' 首缺失（占位）';
  menu.hidden = false;
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 80;
  let x = e.clientX, y = e.clientY;
  if (x + mw > window.innerWidth) x = window.innerWidth - mw - 5;
  if (y + mh > window.innerHeight) y = Math.max(5, e.clientY - mh);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.visibility = 'visible';
});
document.querySelectorAll('#placeholder-ctx-menu .ctx-item').forEach(item => {
  item.addEventListener('click', () => {
    const action = item.dataset.action;
    $('placeholder-ctx-menu').hidden = true;
    if (action === 'repair-placeholders') { repairPlaceholders(); return; }
    if (action === 'filter-placeholders') {
      // 再点一次 = 退出筛选（和歌手/专辑筛选标签同样的互斥逻辑）
      if (S.filterField === 'missing') { clearTrackFilter(); return; }
      pushNav();
      S.filterField = 'missing';
      S.filterValue = '缺失歌曲';
      renderList();
      toast('已筛选：仅显示缺失歌曲（点统计区的筛选标签可退出）');
      return;
    }
    if (action !== 'delete-all-placeholders') return;
    const placeholders = S.tracks.filter(t => t.isPlaceholder && !t.isMissing);
    if (!placeholders.length) { toast('没有占位条目'); return; }
    openBatchDeleteModal(placeholders);
  });
});

// 一键修复占位/缺失条目：在**已有曲库**里找同一首歌的真实文件，原位替换（纯本地，不联网）。
// 判定与歌单导入一致：精确同曲 → 宽松同曲（去注释歌名 + 宽松歌手）。
// 用途：老版本/匹配失败留下的一堆"明明有却显示缺失"，用户不想重导歌单时点一下即可收敛。
function repairPlaceholders() {
  const phs = S.tracks.filter(t => t.isPlaceholder);
  if (!phs.length) { toast('没有缺失/占位条目'); return; }
  const reals = S.tracks.filter(t => !t.isPlaceholder && !t.isMissing);
  const taken = new Set();
  const replaceMap = new Map(); // 占位条目 -> 真实文件
  phs.forEach(p => {
    let hit = reals.find(r => !taken.has(r) && sameSongMeta(r, p));
    if (!hit) hit = reals.find(r => !taken.has(r) && sameSongLoose(r, p));
    if (hit) { taken.add(hit); replaceMap.set(p, hit); }
  });
  if (!replaceMap.size) { toast('曲库里没有与这些占位同曲的文件'); return; }
  const cur = S.current >= 0 ? S.tracks[S.current] : null;
  const dropObj = new Set(replaceMap.values());
  const next = [];
  S.tracks.forEach(t => {
    if (replaceMap.has(t)) { next.push(replaceMap.get(t)); return; } // 占位处放真实文件
    if (dropObj.has(t)) return;                                      // 真实文件的旧位置让出来，避免重复
    next.push(t);
  });
  S.tracks = next;
  if (cur) S.current = S.tracks.indexOf(cur);
  if (S.current < 0) S.current = -1;
  // 同步歌单顺序表：占位路径换成真实路径；真实文件的旧路径整条去掉（位置以占位处为准）
  if (Array.isArray(S.importedTrackOrder) && S.importedTrackOrder.length) {
    const phToReal = new Map([...replaceMap].map(([p, r]) => [p.path, r.path]));
    const realPaths = new Set([...replaceMap.values()].map(r => r.path));
    S.importedTrackOrder = S.importedTrackOrder
      .filter(p => !realPaths.has(p))
      .map(p => (phToReal.has(p) ? phToReal.get(p) : p));
  }
  saveConfig();
  renderList();
  renderFolders();
  updateNowPlaying();
  toast(`已修复 ${replaceMap.size} 首（曲库里找到了同曲）`);
}

// 多选批量操作（批量加歌单的二级菜单跟着右键位置弹出）
let lastCtxX = 0, lastCtxY = 0;
document.addEventListener('contextmenu', (e) => { lastCtxX = e.clientX; lastCtxY = e.clientY; });
document.querySelectorAll('#batch-context-menu .ctx-item').forEach(item => {
  item.addEventListener('click', async () => {
    const action = item.dataset.action;
    $('batch-context-menu').hidden = true;
    const tracks = [...S.multiSel].filter(t => S.tracks.includes(t));
    if (!tracks.length) return;
    switch (action) {
      case 'batch-fav': {
        let n = 0;
        tracks.forEach(t => {
          if (!S.favorites.has(t.path)) {
            S.favorites.add(t.path);
            n++;
          }
        });
        saveConfig();
        renderList();
        toast(n ? `已收藏 ${n} 首` : '所选歌曲已在收藏中');
        break;
      }
      case 'batch-add-playlist':
        showPlaylistMenu({ clientX: lastCtxX, clientY: lastCtxY }, tracks.map(t => t.path));
        break;
      case 'batch-delete':
        openBatchDeleteModal(tracks);
        break;
    }
  });
});

document.querySelectorAll('#context-menu .ctx-item').forEach(item => {
  item.addEventListener('click', () => {
    const action = item.dataset.action;
    const track = ctxTrackIdx >= 0 ? S.tracks[ctxTrackIdx] : null;
    $('context-menu').hidden = true;
    if (!track) return;
    switch (action) {
      case 'copy-track-name':
        // 复制歌曲名称（缺失歌曲右键菜单第一项）：优先 navigator.clipboard，file:// 等场景 execCommand 兜底
        (async () => {
          const name = track.title || '';
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(name);
            } else {
              const ta = document.createElement('textarea');
              ta.value = name;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              ta.remove();
            }
            toast('已复制歌曲名称：' + name);
          } catch (e) {
            toast('复制失败');
          }
        })();
        break;
      case 'fetch-all':
        // 一键获取封面和歌词
        toast('正在获取封面和歌词...');
        fetchAndApplyCover(track, true);
        fetchAndApplyLyrics(track, true).then((ok) => {
          if (!ok) {
            // 找不到歌词，询问是否手动导入
            setTimeout(async () => {
              const confirmed = await showConfirm('未找到歌词', `未找到「${track.title}」的歌词，是否手动导入？`);
              if (confirmed) openLyricsImportModal(track);
            }, 500);
          }
        });
        showLyricsPanel();
        break;
      case 'clear-refetch':
        // 清除海报歌词并重新获取
        (async () => {
          const coverKey = `${track.artist} - ${track.title}`.toLowerCase().replace(/[\\/:*?"<>|]/g, '_').trim();
          const lyricsKey = coverKey;
          // 1. 清除内存缓存
          S.coverCache.delete(track.path);
          S.lyricsCache.delete(track.path);
          // 2. 清除本地缓存记录并删除文件
          if (S.localCoverFiles.has(coverKey)) {
            const coverPath = S.localCoverFiles.get(coverKey);
            S.localCoverFiles.delete(coverKey);
            if (window.mb && window.mb.deleteFile) {
              try { await window.mb.deleteFile(coverPath); } catch (e) { console.error('删除封面缓存失败:', e); }
            }
          }
          if (S.localLyricsFiles.has(lyricsKey)) {
            const lyricsPath = S.localLyricsFiles.get(lyricsKey);
            S.localLyricsFiles.delete(lyricsKey);
            if (window.mb && window.mb.deleteFile) {
              try { await window.mb.deleteFile(lyricsPath); } catch (e) { console.error('删除歌词缓存失败:', e); }
            }
          }
          // 3. 清除当前歌曲封面
          track.cover = null;
          // 4. 重新获取封面和歌词
          toast('已清除缓存，正在重新获取...');
          fetchAndApplyCover(track, true);
          fetchAndApplyLyrics(track, true);
          showLyricsPanel();
        })();
        break;
      case 'import-lyrics':
        openLyricsImportModal(track);
        break;
      case 'edit-title':
        openEditModal(track, 'title');
        break;
      case 'auto-fix':
        autoFixSingle(ctxTrackIdx);
        break;
      case 'complete-info':
        openCompleteInfoModal(ctxTrackIdx);
        break;
      case 'complete-info-batch':
        completeInfoBatch();
        break;
      case 'online-qqmusic':
      case 'online-netease':
        openPlatformPage(action === 'online-qqmusic' ? 'qqmusic' : 'netease', 'song', track);
        break;
      case 'convert-mp3':
        convertTrackToMp3(ctxTrackIdx);
        break;
      case 'delete-track':
        openDeleteTrackModal(track);
        break;
      case 'show-file':
        // 在资源管理器中显示
        if (window.mb && window.mb.showItemInFolder) {
          window.mb.showItemInFolder(track.path);
        } else {
          toast('文件路径: ' + track.path);
        }
        break;
    }
  });
});

// ---------- 删除音乐 ----------
let deletingTrack = null;
function openDeleteTrackModal(track) {
  deletingTrack = track;
  $('delete-track-name').textContent = track.title;
  $('delete-source-file').checked = false;
  // 占位条目没有源文件：隐藏源文件勾选，明示「只删列表条目」
  const isPh = !!track.isPlaceholder;
  $('delete-source-row').style.display = isPh ? 'none' : '';
  const hint = $('delete-track-hint');
  if (isPh) {
    hint.hidden = false;
    hint.textContent = track.isMissing
      ? '这是「文件缺失」的保留条目（没有可删除的源文件）。删除后将从列表中移除，不再保留对照记录。'
      : '这是导入歌单时未匹配到本地文件的占位条目（没有源文件）。删除后仅移除列表项，不影响任何文件。';
    $('delete-track-tip').textContent = '删除后可在回收站恢复列表条目';
  } else {
    hint.hidden = true;
    $('delete-track-tip').textContent = '点击删除会将歌曲移动至系统回收站';
  }
  showModal('delete-track-modal');
}
function closeDeleteTrackModal() {
  $('delete-track-modal').hidden = true;
  deletingTrack = null;
}
document.querySelectorAll('[data-close="delete-track"]').forEach(el => {
  el.addEventListener('click', closeDeleteTrackModal);
});
// 批量删除弹窗（多选右键删除 / 查重面板 / 占位批量删除复用）
let deletingBatch = null;
function openBatchDeleteModal(tracks) {
  deletingBatch = tracks;
  $('batch-delete-count').textContent = tracks.length;
  $('batch-delete-source').checked = false;
  // 全部是占位/缺失条目：没有源文件可删，隐藏勾选并明示
  const allPh = tracks.length > 0 && tracks.every(t => t.isPlaceholder);
  $('batch-delete-source-row').style.display = allPh ? 'none' : '';
  const hint = $('batch-delete-hint');
  if (allPh) {
    hint.hidden = false;
    hint.textContent = '所选均为缺失/占位条目（没有源文件），删除只移除列表项。';
    $('batch-delete-tip').textContent = '删除后可在回收站恢复列表条目';
  } else {
    hint.hidden = true;
    $('batch-delete-tip').textContent = '删除后可在回收站恢复列表项；源文件删除走系统回收站';
  }
  showModal('batch-delete-modal');
}
function closeBatchDeleteModal() {
  $('batch-delete-modal').hidden = true;
  deletingBatch = null;
}
document.querySelectorAll('[data-close="batch-delete"]').forEach(el => {
  el.addEventListener('click', closeBatchDeleteModal);
});
// 从曲库移除一批曲目（单删/批删/查重共用）：回收站记录 + 可选删源文件
// 返回 { n, fail }：n = 移除条数，fail = 源文件删除失败条数
async function deleteTracks(tracks, deleteSource) {
  const set = new Set(tracks);
  // 正在播放的歌在其中：先停掉，避免指向已移除的曲目
  const curTrack = S.current >= 0 ? S.tracks[S.current] : null;
  if (curTrack && set.has(curTrack)) {
    audio.pause();
    audio.src = '';
    S.current = -1;
    S.playing = false;
    setPlaying(false);
    updateNowPlaying();
  }
  addToRecycleBin(tracks);
  // 按索引倒序 splice，避免下标错位；当前播放的在删除点之后则下标回退
  const idxs = tracks.map(t => S.tracks.indexOf(t)).filter(i => i >= 0).sort((a, b) => b - a);
  const removedPaths = [];
  const removedAll = [];
  idxs.forEach(i => {
    const t = S.tracks[i];
    removedAll.push(t.path);
    if (!t.isPlaceholder) removedPaths.push(t.path);
    const folder = t.path.replace(/[\\/][^\\/]+$/, '');
    if (S.folders.has(folder)) {
      const count = S.folders.get(folder) - 1;
      if (count <= 0) S.folders.delete(folder);
      else S.folders.set(folder, count);
    }
    S.tracks.splice(i, 1);
    if (S.current > i) S.current--;
  });
  // 导入歌单顺序里同步剔除已删条目（占位/缺失也在其中），避免残留幽灵路径
  if (S.importedTrackOrder && S.importedTrackOrder.length) {
    const gone = new Set(removedAll);
    S.importedTrackOrder = S.importedTrackOrder.filter(p => !gone.has(p));
  }
  pruneMultiSel();
  if (S.selectedIdx >= S.tracks.length) S.selectedIdx = -1;
  // 删除源文件（移动到系统回收站）
  let fail = 0;
  if (deleteSource && window.mb && window.mb.deleteFile) {
    for (const p of removedPaths) {
      try {
        const res = await window.mb.deleteFile(p);
        if (!res.ok) fail++;
      } catch (e) {
        fail++;
      }
    }
  }
  saveConfig();
  renderList();
  renderFolders();
  return { n: idxs.length, fail };
}
$('btn-confirm-delete-track').addEventListener('click', async () => {
  if (!deletingTrack) return;
  const track = deletingTrack;
  const deleteSource = $('delete-source-file').checked;
  closeDeleteTrackModal();
  const { n, fail } = await deleteTracks([track], deleteSource);
  if (!n) { toast('歌曲不在列表中'); return; }
  toast('已删除：' + track.title + (deleteSource ? '（含源文件）' : '') + (fail ? `，${fail} 个源文件删除失败` : ''));
});
$('btn-confirm-batch-delete').addEventListener('click', async () => {
  if (!deletingBatch || !deletingBatch.length) return;
  const tracks = deletingBatch;
  const deleteSource = $('batch-delete-source').checked;
  closeBatchDeleteModal();
  const { n, fail } = await deleteTracks(tracks, deleteSource);
  toast(`已删除 ${n} 首` + (deleteSource ? '（含源文件）' : '') + (fail ? `，${fail} 个源文件删除失败` : ''));
  // 查重面板还开着：结果已过期，重扫一遍（常驻横幅明确告知删除结果：操作已完成、窗口可关闭）
  if (!$('dedupe-modal').hidden) {
    const banner = $('dedupe-banner');
    banner.hidden = false;
    banner.textContent = `✓ 已删除 ${n} 首${deleteSource ? '（含源文件）' : ''}${fail ? `，${fail} 个源文件删除失败` : ''}（可在回收站恢复）。删除已完成，窗口可随时关闭；正在重新扫描剩余重复…`;
    runDedupeScan();
  }
});

// ---------- 重复歌曲检查 ----------
document.querySelectorAll('[data-close="dedupe"]').forEach(el => {
  el.addEventListener('click', () => { $('dedupe-modal').hidden = true; });
});
// 两种方式（参考开源查重工具的通行做法）：
// ① 同名·歌手匹配：歌名用 looseTitleOf（保留 Live/Remix 等版本标记，去掉 (Explicit) 这类说明），
//    歌手用 dedupeArtistMatch（拆多歌手 + 整串包含，所以 "Just Kiddin" 和 "Just Kiddin/Camden Cox" 算同一人），
//    时长已知时再按 ±DEDUPE_DUR_TOL 分簇区分不同版本
// ② 文件完全相同：主进程按文件大小分组后算 MD5（find-duplicate-files）
const DEDUPE_DUR_TOL = 5;
// 查重结果渲染状态：分批显示（大曲库上千组，一次全渲染会卡）
const dedupeState = { groups: [], shown: 0 };
function openDedupeModal() {
  showModal('dedupe-modal');
  $('dedupe-banner').hidden = true;
  $('dedupe-banner').textContent = '';
  runDedupeScan();
}
async function runDedupeScan(initialMsg) {
  const el = $('dedupe-results');
  if (!el) return;
  el.innerHTML = '<div class="dedupe-status">' + (initialMsg || '正在分析曲库…') + '</div>';
  updateDedupeDeleteBtn();
  const groups = [];
  const grouped = new Set(); // 已经入组的 track，防止同一对在两种方式里重复出现
  // ① 文件内容完全相同（大小 + MD5）——最强信号，先认领
  try {
    const paths = S.tracks.filter(t => t && !t.isPlaceholder && t.path).map(t => t.path);
    if (paths.length && window.mb && window.mb.findDuplicateFiles) {
      el.innerHTML = '<div class="dedupe-status">正在检查文件内容（大小 + MD5）…大曲库可能要几分钟，期间可关闭窗口稍后再来</div>';
      const res = await window.mb.findDuplicateFiles(paths);
      if (res && res.ok && Array.isArray(res.groups)) {
        res.groups.forEach(gp => {
          const tracks = gp.map(p => S.tracks.find(t => t.path === p)).filter(Boolean);
          if (tracks.length >= 2) { groups.push({ type: 'hash', tracks }); tracks.forEach(t => grouped.add(t)); }
        });
      }
    }
  } catch (e) {
    console.error('文件哈希查重失败:', e);
  }
  // ② 同名 + 歌手宽松匹配 + 时长聚类（只看没被 ① 收进去的）
  // 歌手不能精确比：同一首歌常被写成 "Just Kiddin/Camden Cox" 和 "Just Kiddin"（合作者列不全），
  // 精确比对会让这类重复整批漏掉，所以按 artistLooseMatch（拆多歌手，任一相同即同歌手）聚簇。
  el.innerHTML = '<div class="dedupe-status">正在按歌名歌手聚类…</div>';
  const byTitle = new Map();
  S.tracks.forEach(t => {
    if (!t || t.isPlaceholder || !t.path || grouped.has(t)) return;
    // 必须用 looseTitleOf 而不是 normLrcTag：后者会把括号内容全去掉，
    // 「Believer (Kaskade Remix)」和「Believer」会塌成同一个歌名被误判成重复
    const key = looseTitleOf(t.title);
    if (!key) return;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(t);
  });
  byTitle.forEach(list => {
    if (list.length < 2) return;
    // 第一层：同名但歌手完全不搭的（不同人的同名歌）分开
    const buckets = [];
    for (const t of list) {
      const hit = buckets.find(b => dedupeArtistMatch(b[0].artist, t.artist));
      if (hit) hit.push(t); else buckets.push([t]);
    }
    // 第二层：歌手对上了，再按时长区分版本（Live / Remix 时长通常差得多）
    for (const bucket of buckets) {
      for (const cluster of clusterByDuration(bucket)) {
        groups.push({ type: 'tag', tracks: cluster });
        cluster.forEach(t => grouped.add(t));
      }
    }
  });
  renderDedupeResults(groups);
}
// 查重专用歌手比对：比 artistLooseMatch 再宽一层
// artistLooseMatch 依赖 normArtistParts 拆分，但 "Just Kiddin _ Camden Cox" 这种文件名写法的 "_" 不是分隔符，
// 会被并成一整串而跟 "Just Kiddin" 对不上；这里再补一条"整串包含"判定（同一首歌的歌手名常常只是列全/列简之差）
function dedupeArtistMatch(a, b) {
  if (artistLooseMatch(a, b)) return true;
  const N = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s\u3000\-_~`'"“”‘’!！?？,，.。:：、/\\|&×+・]/g, '');
  const A = N(a), B = N(b);
  if (A.length < 3 || B.length < 3) return false;   // 太短的歌手名（如 "K"）包含判定会误伤
  return A.includes(B) || B.includes(A);
}
// 时长聚类：已知时长的按 ±DEDUPE_DUR_TOL 归簇，时长未知的不能参与比较
// （旧实现把未知时长当 0 排序，会跟 218 秒差出 218 > 5 而误判成"不同版本"，白白漏掉重复）
function clusterByDuration(list) {
  const known = list.filter(t => trackDurationSec(t) > 0)
    .sort((a, b) => trackDurationSec(a) - trackDurationSec(b));
  const unknown = list.filter(t => trackDurationSec(t) <= 0);
  const clusters = [];
  for (const t of known) {
    const last = clusters[clusters.length - 1];
    if (last && trackDurationSec(t) - trackDurationSec(last[last.length - 1]) <= DEDUPE_DUR_TOL) last.push(t);
    else clusters.push([t]);
  }
  if (!clusters.length) clusters.push([]);
  // 时长未知的没法比：只有一个已知簇时才并进去，否则单独成簇，避免把 Live 版硬塞进录音室版
  if (unknown.length) {
    if (clusters.length === 1) unknown.forEach(t => clusters[0].push(t));
    else clusters.push(unknown);
  }
  return clusters.filter(c => c.length >= 2);
}
function renderDedupeResults(groups) {
  const el = $('dedupe-results');
  if (!el) return;
  dedupeState.groups = groups;
  dedupeState.shown = 0;
  el.innerHTML = '';
  if (!groups.length) {
    el.innerHTML = '<div class="dedupe-status">✓ 没有发现重复歌曲</div>';
    updateDedupeDeleteBtn();
    return;
  }
  const head = document.createElement('div');
  head.className = 'dedupe-summary';
  const nTracks = groups.reduce((s, g) => s + g.tracks.length, 0);
  head.textContent = `发现 ${groups.length} 组重复，共 ${nTracks} 首（每组默认保留第一首，勾选其余的删除）`;
  el.appendChild(head);
  const more = document.createElement('button');
  more.className = 'btn ghost dedupe-more';
  more.addEventListener('click', () => appendPage());
  el.appendChild(more);
  const PAGE = 80;
  function appendPage() {
    const end = Math.min(dedupeState.shown + PAGE, groups.length);
    const frag = document.createDocumentFragment();
    for (; dedupeState.shown < end; dedupeState.shown++) {
      frag.appendChild(buildDedupeGroupCard(groups[dedupeState.shown]));
    }
    el.insertBefore(frag, more);
    if (dedupeState.shown < groups.length) {
      more.hidden = false;
      more.textContent = `显示更多（剩余 ${groups.length - dedupeState.shown} 组）`;
    } else {
      more.hidden = true;
    }
    updateDedupeDeleteBtn();
  }
  appendPage();
}
function buildDedupeGroupCard(g) {
  const card = document.createElement('div');
  card.className = 'dedupe-group';
  const h = document.createElement('div');
  h.className = 'dedupe-group-head';
  const typeLabel = g.type === 'hash' ? '文件完全相同' : '同名·歌手匹配';
  h.innerHTML = `<span class="dedupe-type ${g.type}">${typeLabel}</span><span class="dedupe-count">${g.tracks.length} 首</span>`;
  card.appendChild(h);
  g.tracks.forEach((t, ti) => {
    const row = document.createElement('label');
    row.className = 'dedupe-row';
    const dur = trackDurationSec(t);
    const durText = dur > 0 ? `${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}` : '—';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'dedupe-check';
    chk.dataset.path = t.path;
    chk.checked = ti > 0;
    const keep = document.createElement('span');
    keep.className = 'dedupe-keep';
    keep.textContent = ti === 0 ? '保留' : '';
    const name = document.createElement('span');
    name.className = 'dedupe-name';
    name.textContent = t.title;
    name.title = t.title;
    const artist = document.createElement('span');
    artist.className = 'dedupe-artist';
    artist.textContent = t.artist;
    artist.title = t.artist;
    const durEl = document.createElement('span');
    durEl.className = 'dedupe-dur';
    durEl.textContent = durText;
    const loc = document.createElement('button');
    loc.className = 'dedupe-locate';
    loc.title = '打开文件所在位置';
    loc.textContent = '📂';
    loc.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.mb && window.mb.showItemInFolder) window.mb.showItemInFolder(t.path);
    });
    row.append(chk, keep, name, artist, durEl, loc);
    card.appendChild(row);
  });
  return card;
}
// 汇总将删除的曲目：已渲染分组以页面勾选为准；未渲染分组按默认（保留每组第一首，勾其余）
function collectDedupeChecked() {
  const el = $('dedupe-results');
  const renderedPicked = new Set();
  if (el) {
    el.querySelectorAll('.dedupe-check:checked').forEach(chk => renderedPicked.add(chk.dataset.path));
  }
  const tracks = [];
  dedupeState.groups.forEach((g, gi) => {
    g.tracks.forEach((t, ti) => {
      if (gi < dedupeState.shown) {
        if (renderedPicked.has(t.path)) tracks.push(t);
      } else if (ti > 0) {
        tracks.push(t);
      }
    });
  });
  return tracks;
}
function updateDedupeDeleteBtn() {
  const btn = $('btn-dedupe-delete');
  if (!btn) return;
  const n = dedupeState.groups.length ? collectDedupeChecked().length : 0;
  btn.textContent = n > 0 ? `删除勾选的歌曲（${n} 首）` : '删除勾选的歌曲';
}
// 勾选变化实时刷新按钮上的数量
$('dedupe-results').addEventListener('change', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('dedupe-check')) updateDedupeDeleteBtn();
});
// 删除勾选的重复歌曲（走批量删除弹窗，可选一并删源文件）
$('btn-dedupe-delete').addEventListener('click', () => {
  const picked = collectDedupeChecked();
  if (!picked.length) { toast('请先勾选要删除的歌曲（每组默认已勾选除第一首外的条目）'); return; }
  const tracks = picked.map(t => S.tracks.find(x => x.path === t.path)).filter(Boolean);
  if (!tracks.length) { toast('所选歌曲已不在曲库'); return; }
  openBatchDeleteModal(tracks);
});

// ---------- 音乐库合并 ----------
// 把两个音乐文件夹合并为一个：重叠歌曲只保留一份（自动选信息更全/更新的那份，可手动换），
// 并把两边缺失的歌名/歌手/专辑互补合并进保留方；独有歌曲全部复制到目标文件夹。
// 重复判定与查重引擎一致：MD5 完全相同优先，其次歌名|歌手归一化 + 时长聚类（时长未知时要求专辑一致）。
const mergeState = {
  groups: [],      // { type:'hash'|'tag', members:[track], winnerIdx, enabled, merged:{title,artist,album} }
  uniques: [],     // 未入组的曲目（含 _src:'A'|'B'）
  targetDir: '',
  srcA: '', srcB: '',
  ready: false,
  running: false,  // 正在执行合并（防重入）
  done: false,     // 本次分析结果已执行过合并（防重复生成副本）
  shown: 0         // 预览已渲染的组数（分批显示）
};

function openMergeModal() {
  showModal('merge-modal');
  mergeState.ready = false;
  mergeState.running = false;
  mergeState.done = false;
  mergeState.shown = 0;
  mergeState.groups = [];
  mergeState.uniques = [];
  $('btn-merge-execute').disabled = true;
  $('btn-merge-execute').textContent = '执行合并';
  $('merge-summary').hidden = true;
  $('merge-results').innerHTML = '<div class="dedupe-status">选择两个音乐库和目标文件夹，点击「分析重叠歌曲」</div>';
  fillMergeSelect('merge-src-a');
  fillMergeSelect('merge-src-b');
  fillMergeSelect('merge-target');
}
function fillMergeSelect(id) {
  const sel = $(id);
  const prev = sel.value;
  sel.innerHTML = '';
  const folders = [...S.folders.keys()];
  if (!folders.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '（点右侧「浏览…」选择文件夹）';
    sel.appendChild(o);
    return;
  }
  folders.forEach(f => {
    const o = document.createElement('option');
    o.value = f; o.textContent = f;
    sel.appendChild(o);
  });
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}
async function mergeBrowse(id) {
  const dir = await mb.pickDir();
  if (!dir) return;
  const sel = $(id);
  if (![...sel.options].some(o => o.value === dir)) {
    const o = document.createElement('option');
    o.value = dir; o.textContent = dir;
    sel.appendChild(o);
  }
  sel.value = dir;
}
// 用 Audio 探测单个文件时长（合并分析用，仅候选组内少量文件）
function probeFileDuration(p) {
  return new Promise((resolve) => {
    const a = new Audio();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { a.src = ''; } catch (e) { /* ignore */ }
      resolve(Number(v) > 0 ? Number(v) : 0);
    };
    a.preload = 'metadata';
    a.addEventListener('loadedmetadata', () => finish(a.duration), { once: true });
    a.addEventListener('error', () => finish(0), { once: true });
    setTimeout(() => finish(a.duration), 5000); // 兜底超时
    a.src = fileURL(p);
  });
}
// 「信息更全」评分：歌名/歌手/专辑是否有效（非空且非"未知"）+ 有无封面
function mergeScore(t) {
  let s = 0;
  const title = (t.title || '').trim();
  const artist = (t.artist || '').trim();
  const album = (t.album || '').trim();
  if (title && title !== t.name) s += 3;
  if (artist && artist !== '未知歌手') s += 3;
  if (album && album !== '未知专辑') s += 2;
  if (t.cover) s += 1;
  return s;
}
function pickMergeWinner(members) {
  let best = 0;
  for (let i = 1; i < members.length; i++) {
    const x = members[i], y = members[best];
    const sx = mergeScore(x), sy = mergeScore(y);
    if (sx !== sy) { if (sx > sy) best = i; continue; }
    if ((x.mtimeMs || 0) !== (y.mtimeMs || 0)) { if ((x.mtimeMs || 0) > (y.mtimeMs || 0)) best = i; continue; }
    if ((x.size || 0) > (y.size || 0)) best = i;
  }
  return best;
}
// 互补合并：保留方缺的字段（空或"未知"）从组内其他成员补全
function buildMergedMeta(members, winnerIdx) {
  const w = members[winnerIdx];
  const good = (v, unknown) => {
    const s = String(v || '').trim();
    return s && s !== unknown;
  };
  const pick = (field, unknown) => {
    if (good(w[field], unknown)) return w[field];
    for (const m of members) if (good(m[field], unknown)) return m[field];
    return w[field] || '';
  };
  return {
    title: pick('title', '未知歌曲'),
    artist: pick('artist', '未知歌手'),
    album: pick('album', '未知专辑')
  };
}
async function analyzeMergeLibraries() {
  const a = $('merge-src-a').value, b = $('merge-src-b').value, target = $('merge-target').value;
  if (!a || !b || !target) { toast('请选择两个音乐库和目标文件夹'); return; }
  if (a.toLowerCase() === b.toLowerCase()) { toast('音乐库 A 和 B 不能是同一个文件夹'); return; }
  if (isScanning) { toast('正在扫描中，请稍候'); return; }
  if (mergeState.running) { toast('合并正在进行中，请稍候'); return; }
  const el = $('merge-results');
  el.innerHTML = '<div class="dedupe-status">正在扫描音乐库 A…</div>';
  $('btn-merge-execute').disabled = true;
  $('btn-merge-execute').textContent = '执行合并';
  mergeState.ready = false;
  mergeState.done = false;
  mergeState.shown = 0;
  try {
    const tracksA = await mb.scan([a], true);
    if (!$('merge-modal') || $('merge-modal').hidden) return;
    el.innerHTML = '<div class="dedupe-status">正在扫描音乐库 B…</div>';
    const tracksB = await mb.scan([b], true);
    if (!$('merge-modal') || $('merge-modal').hidden) return;
    el.innerHTML = '<div class="dedupe-status">正在分析重叠歌曲…</div>';
    const all = [
      ...tracksA.map(t => ({ ...t, _src: 'A' })),
      ...tracksB.map(t => ({ ...t, _src: 'B' }))
    ];
    const grouped = new Set(); // 已入组，防止同一对在两种方式里重复出现
    const groups = [];
    // ① 文件内容完全相同（大小 + MD5）——最强信号
    try {
      const paths = all.map(t => t.path);
      if (paths.length && window.mb && window.mb.findDuplicateFiles) {
        const res = await window.mb.findDuplicateFiles(paths);
        if (res && res.ok && Array.isArray(res.groups)) {
          res.groups.forEach(gp => {
            const members = gp.map(p => all.find(t => t.path === p)).filter(Boolean);
            if (members.length >= 2) {
              groups.push({ type: 'hash', members });
              members.forEach(m => grouped.add(m));
            }
          });
        }
      }
    } catch (e) {
      console.error('合并 MD5 查重失败:', e);
    }
    // ② 歌名|歌手 归一化相同 + 时长聚类（时长未知时要求专辑一致，避免误合并 Live 版）
    const byKey = new Map();
    all.forEach(t => {
      if (grouped.has(t)) return;
      const titleKey = normLrcTag(t.title);
      if (!titleKey) return;
      const key = titleKey + '|' + normLrcTag(t.artist);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(t);
    });
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      for (const t of list) {
        if (!t._dur) t._dur = await probeFileDuration(t.path);
      }
      const sorted = [...list].sort((x, y) => (x._dur || 0) - (y._dur || 0));
      let cluster = [sorted[0]];
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1], cur = sorted[i];
        const bothKnown = prev._dur > 0 && cur._dur > 0;
        const compatible = bothKnown
          ? (cur._dur - prev._dur) <= DEDUPE_DUR_TOL
          : (normLrcTag(prev.album) === normLrcTag(cur.album));
        if (compatible) {
          cluster.push(cur);
        } else {
          if (cluster.length >= 2) { groups.push({ type: 'tag', members: cluster }); cluster.forEach(m => grouped.add(m)); }
          cluster = [cur];
        }
      }
      if (cluster.length >= 2) { groups.push({ type: 'tag', members: cluster }); cluster.forEach(m => grouped.add(m)); }
    }
    // 分组选优 + 互补合并
    groups.forEach(g => {
      g.winnerIdx = pickMergeWinner(g.members);
      g.enabled = true;
      g.merged = buildMergedMeta(g.members, g.winnerIdx);
    });
    const uniques = all.filter(t => !grouped.has(t));
    mergeState.groups = groups;
    mergeState.uniques = uniques;
    mergeState.targetDir = target;
    mergeState.srcA = a;
    mergeState.srcB = b;
    mergeState.ready = true;
    renderMergePreview();
    $('btn-merge-execute').disabled = groups.length === 0 && uniques.length === 0;
  } catch (e) {
    window.__errs.push('merge-analyze: ' + e);
    el.innerHTML = '<div class="dedupe-status">分析失败：' + (e && e.message ? e.message : e) + '</div>';
    toast('分析失败：' + e);
  }
}
function fmtMergeSize(n) {
  const v = Number(n) || 0;
  return v >= 1048576 ? (v / 1048576).toFixed(1) + ' MB' : v >= 1024 ? (v / 1024).toFixed(0) + ' KB' : v + ' B';
}
function renderMergePreview() {
  const el = $('merge-results');
  const sum = $('merge-summary');
  const g = mergeState.groups, uniques = mergeState.uniques;
  const nA = uniques.filter(t => t._src === 'A').length;
  const nB = uniques.filter(t => t._src === 'B').length;
  // 执行后目标曲目数：启用组每组 1 首 + 未启用组的全部成员 + 全部独有
  const enabledCount = g.filter(x => x.enabled).length;
  const disabledExtra = g.filter(x => !x.enabled).reduce((s, x) => s + x.members.length - 1, 0);
  const total = enabledCount + disabledExtra + uniques.length;
  sum.hidden = false;
  sum.textContent = `重叠 ${g.length} 组 · 库A独有 ${nA} 首 · 库B独有 ${nB} 首 · 执行后目标文件夹约 ${total} 首`;
  const st = el.scrollTop;
  el.innerHTML = '';
  if (!g.length) {
    el.innerHTML = '<div class="dedupe-status">✓ 两个音乐库没有发现重叠歌曲，执行后将复制全部 ' + uniques.length + ' 首到目标文件夹</div>';
    el.scrollTop = 0;
    return;
  }
  // 分批渲染（大库可能上百组）；切换勾选时整体重绘但保持滚动位置
  const more = document.createElement('button');
  more.className = 'btn ghost dedupe-more';
  more.addEventListener('click', () => appendPage());
  el.appendChild(more);
  const PAGE = 60;
  function appendPage() {
    const end = Math.min(mergeState.shown + PAGE, g.length);
    const frag = document.createDocumentFragment();
    for (; mergeState.shown < end; mergeState.shown++) {
      frag.appendChild(buildMergeGroupCard(g[mergeState.shown], mergeState.shown));
    }
    el.insertBefore(frag, more);
    if (mergeState.shown < g.length) {
      more.hidden = false;
      more.textContent = `显示更多（剩余 ${g.length - mergeState.shown} 组）`;
    } else {
      more.hidden = true;
    }
  }
  appendPage();
  el.scrollTop = st;
}
function buildMergeGroupCard(grp, gi) {
    const card = document.createElement('div');
    card.className = 'dedupe-group';
    const h = document.createElement('div');
    h.className = 'dedupe-group-head';
    const typeLabel = grp.type === 'hash' ? '文件完全相同' : '同名同歌手';
    const enChk = document.createElement('input');
    enChk.type = 'checkbox';
    enChk.className = 'dedupe-check';
    enChk.checked = grp.enabled;
    enChk.title = '取消勾选则本组歌曲全部保留复制（不合并）';
    enChk.addEventListener('change', () => { grp.enabled = enChk.checked; renderMergePreview(); });
    const typeEl = document.createElement('span');
    typeEl.className = 'dedupe-type ' + grp.type;
    typeEl.textContent = typeLabel;
    const cnt = document.createElement('span');
    cnt.className = 'dedupe-count';
    cnt.textContent = grp.members.length + ' 首';
    h.append(enChk, typeEl, cnt);
    card.appendChild(h);
    grp.members.forEach((t, ti) => {
      const row = document.createElement('label');
      row.className = 'merge-row-item';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'merge-winner-' + gi;
      radio.checked = ti === grp.winnerIdx;
      radio.disabled = !grp.enabled;
      radio.addEventListener('change', () => {
        grp.winnerIdx = ti;
        grp.merged = buildMergedMeta(grp.members, grp.winnerIdx);
        renderMergePreview();
      });
      const badge = document.createElement('span');
      badge.className = 'merge-src-badge ' + t._src;
      badge.textContent = t._src;
      badge.title = t._src === 'A' ? '来自音乐库 A' : '来自音乐库 B';
      const name = document.createElement('span');
      name.className = 'dedupe-name';
      name.textContent = t.title;
      name.title = t.path;
      const artist = document.createElement('span');
      artist.className = 'dedupe-artist';
      artist.textContent = t.artist;
      const album = document.createElement('span');
      album.className = 'dedupe-artist';
      album.textContent = t.album;
      album.title = t.album;
      const meta = document.createElement('span');
      meta.className = 'dedupe-dur';
      meta.textContent = fmtMergeSize(t.size) + ' · ' + (t.mtimeMs ? new Date(t.mtimeMs).toLocaleDateString('zh-CN') : '—');
      meta.title = '大小 · 修改日期';
      const pick = document.createElement('span');
      pick.className = 'dedupe-keep';
      pick.textContent = (grp.enabled && ti === grp.winnerIdx) ? '保留' : '';
      if (grp.enabled && ti === grp.winnerIdx && mergeScore(t) === Math.max(...grp.members.map(mergeScore))) {
        pick.textContent = '保留（信息更全）';
      }
      const loc = document.createElement('button');
      loc.className = 'dedupe-locate';
      loc.title = '打开文件所在位置';
      loc.textContent = '📂';
      loc.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.mb && window.mb.showItemInFolder) window.mb.showItemInFolder(t.path);
      });
      row.append(radio, badge, pick, name, artist, album, meta, loc);
      card.appendChild(row);
    });
    if (grp.enabled) {
      const info = document.createElement('div');
      info.className = 'merge-info';
      const w = grp.members[grp.winnerIdx];
      const changes = [];
      if (String(grp.merged.title || '') !== String(w.title || '')) changes.push('歌名→' + grp.merged.title);
      if (String(grp.merged.artist || '') !== String(w.artist || '')) changes.push('歌手→' + grp.merged.artist);
      if (String(grp.merged.album || '') !== String(w.album || '')) changes.push('专辑→' + grp.merged.album);
      info.textContent = changes.length
        ? '互补合并（写入目标副本）：' + changes.join('；')
        : '保留方信息已完整，无需补全';
      card.appendChild(info);
    }
  return card;
}
async function executeMergeLibraries() {
  if (!mergeState.ready) return;
  if (mergeState.running) { toast('合并正在进行中，请稍候'); return; }
  if (mergeState.done) { toast('本次合并已执行完成；如需再次合并请先点「分析重叠歌曲」'); return; }
  const { groups, uniques, targetDir } = mergeState;
  if (!targetDir) { toast('未指定目标文件夹'); return; }
  mergeState.running = true;
  const btn = $('btn-merge-execute');
  btn.disabled = true;
  const sumEl = $('merge-summary');
  let copied = 0, skipped = 0, mergedInfo = 0, fail = 0;
  const jobs = [];
  uniques.forEach(t => jobs.push({ kind: 'copy', t }));
  groups.forEach(g => {
    if (!g.enabled) {
      g.members.forEach(t => jobs.push({ kind: 'copy', t }));
    } else {
      jobs.push({ kind: 'merge', g });
    }
  });
  try {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      sumEl.hidden = false;
      sumEl.textContent = `正在合并 ${i + 1}/${jobs.length} …（新复制 ${copied} 首，已存在跳过 ${skipped} 首，补全信息 ${mergedInfo} 首，失败 ${fail}）`;
      if (job.kind === 'copy') {
        const r = await mb.copyFile(job.t.path, targetDir, { skipIdentical: true });
        if (r && r.ok) { if (r.skipped) skipped++; else copied++; } else fail++;
      } else {
        const g = job.g;
        const w = g.members[g.winnerIdx];
        const r = await mb.copyFile(w.path, targetDir, { skipIdentical: true });
        if (!r || !r.ok) { fail++; continue; }
        if (r.skipped) skipped++; else copied++;
        // 互补合并只写到目标副本，不动源文件
        const m = g.merged;
        if (m && (String(m.title || '') !== String(w.title || '') ||
                  String(m.artist || '') !== String(w.artist || '') ||
                  String(m.album || '') !== String(w.album || ''))) {
          try {
            const wr = await mb.writeMusicMetadata(r.destPath, m.title, m.artist, m.album);
            if (wr && wr.ok) mergedInfo++; else fail++;
          } catch (e) { fail++; }
        }
      }
    }
    mergeState.done = true;
    sumEl.hidden = false;
    sumEl.textContent = `合并完成：新复制 ${copied} 首，已存在跳过 ${skipped} 首，互补补全信息 ${mergedInfo} 首，失败 ${fail} 首。目标文件夹：${targetDir}（已合并完成；如需再次合并请重新分析）`;
    toast(`合并完成：${copied} 首已复制到目标文件夹`);
    // 目标文件夹加入曲库（已在曲库中则只刷新计数）
    if (!S.folders.has(targetDir)) {
      await addPaths([targetDir], true);
    }
  } catch (e) {
    window.__errs.push('merge-exec: ' + e);
    toast('合并失败：' + e);
    sumEl.hidden = false;
    sumEl.textContent = '合并中断：' + (e && e.message ? e.message : e) + '（可重新点「执行合并」继续，已复制的文件会自动跳过）';
  } finally {
    mergeState.running = false;
    if (mergeState.done) {
      btn.disabled = true;
      btn.textContent = '已合并完成';
    } else {
      btn.disabled = false;
    }
  }
}
$('btn-merge-analyze').addEventListener('click', analyzeMergeLibraries);
$('btn-merge-execute').addEventListener('click', executeMergeLibraries);
$('merge-browse-a').addEventListener('click', () => mergeBrowse('merge-src-a'));
$('merge-browse-b').addEventListener('click', () => mergeBrowse('merge-src-b'));
$('merge-browse-target').addEventListener('click', () => mergeBrowse('merge-target'));
document.querySelectorAll('[data-close="merge"]').forEach(el => {
  el.addEventListener('click', () => { $('merge-modal').hidden = true; });
});

// ---------- 均衡器 / 音频曲线 ----------
// 实现参考开源 Web Audio 均衡器的通行方案（weq8 / Web3BandEq / Peaks）：
// BiquadFilterNode 滤波链 + getFrequencyResponse() 求总频响曲线，零第三方依赖。
// 坑：① createMediaElementSource 对同一元素只能调一次，之后音频恒走 Web Audio 图；
//     ② 进图后 audio.setSinkId 失效，输出设备要改用 AudioContext.setSinkId（双路径）。
const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  flat:       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pop:        [-1, 0, 2, 4, 4, 2, 0, -1, -2, -2],
  rock:       [4, 3, 2, 0, -2, -1, 1, 3, 4, 4],
  classical:  [3, 2, 1, 0, -1, -1, 0, 2, 3, 4],
  jazz:       [2, 1, 0, 1, 2, -1, 0, 1, 2, 3],
  vocal:      [-2, -2, -1, 2, 4, 4, 3, 1, 0, -1],
  bass:       [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  treble:     [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  electronic: [4, 3, 0, -2, 2, 1, 0, 2, 4, 5],
  // —— 品牌音效风格（参考各厂声音签名的通行调音取向，非官方数据）——
  harman:     [3, 2, 1, 0, -1, 0, 1, 1, 2, 2],   // 哈曼卡顿：温润均衡，低音/高音轻微提升、中频顺滑
  beats:      [7, 6, 3, 1, -1, -1, 0, 1, 3, 3],  // Beats：重低音轰炸，中频略凹
  bose:       [5, 4, 2, 0, -1, -1, 0, 2, 3, 2],  // Bose：深沉温暖的低频
  bo:         [2, 1, 0, -1, 0, 1, 2, 3, 3, 2],   // B&O：通透干净，空气感
  sennheiser: [1, 1, 0, 1, 2, 2, 1, 0, 1, 1],    // 森海塞尔：自然均衡，中频略前
  sony:       [4, 3, 1, 0, -1, -1, 1, 3, 4, 4],  // 索尼：动感 V 形
  apple:      [1, 0, 0, 1, 1, 0, 0, 1, 2, 2]     // 苹果：干净中性，高音稍亮
};
const eq = {
  ctx: null, src: null, preamp: null, filters: [], chainOn: false,
  // 画曲线专用的滤波器组（不接入音频链）：gain 同步赋值，避免 setTargetAtTime
  // 渐变过程中 getFrequencyResponse 读到过渡起点（曲线显示滞后/变平）
  curveFilters: [],
  on: false, preampDb: 0, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preset: 'flat'
};

function dbToGain(db) { return Math.pow(10, db / 20); }

// 拖滑轨/调预设就自动启用（否则改了参数却没声效变化，不符合直觉）
function ensureEqOn() {
  if (eq.on) return;
  eq.on = true;
  ensureEqChain();
  if (eq.ctx && eq.ctx.state === 'suspended') eq.ctx.resume().catch(() => {});
  const en = $('eq-enable');
  if (en) en.checked = true;
}

// 启动时从 settings.eq 恢复（旧配置没有该字段则用默认值）
function initEqFromSettings() {
  const st = S.settings.eq;
  if (st && typeof st === 'object') {
    eq.on = !!st.on;
    eq.preampDb = Number(st.preamp) || 0;
    if (Array.isArray(st.gains) && st.gains.length === EQ_BANDS.length) {
      eq.gains = st.gains.map(v => Number(v) || 0);
    }
    eq.preset = st.preset || 'custom';
  }
  if (eq.on) {
    // 上次开着：把链搭好（AudioContext 可能 suspended，首次播放时 resume）
    ensureEqChain();
    applyEqToGraph(false);
  }
}

function ensureEqCtx() {
  if (eq.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  eq.ctx = new AC();
  eq.preamp = eq.ctx.createGain();
  eq.preamp.gain.value = 1;
  const mk = (freq) => {
    const f = eq.ctx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = freq;
    f.Q.value = 1.2;
    f.gain.value = 0;
    return f;
  };
  eq.filters = EQ_BANDS.map(mk);
  eq.curveFilters = EQ_BANDS.map(mk);
}

function ensureEqChain() {
  ensureEqCtx();
  if (!eq.ctx || eq.chainOn) return;
  try {
    eq.src = eq.ctx.createMediaElementSource(audio);
    let node = eq.src;
    node.connect(eq.preamp);
    node = eq.preamp;
    eq.filters.forEach(f => { node.connect(f); node = f; });
    node.connect(eq.ctx.destination);
    eq.chainOn = true;
    // 输出设备：进图后以 AudioContext 的 sink 为准
    if (S.audioOutputDevice && typeof eq.ctx.setSinkId === 'function') {
      eq.ctx.setSinkId(S.audioOutputDevice).catch(() => {});
    }
  } catch (e) {
    console.error('均衡器音频链初始化失败:', e);
  }
}

function applyEqToGraph(smooth = true) {
  if (!eq.ctx) return;
  const t = eq.ctx.currentTime;
  const pg = eq.on ? dbToGain(eq.preampDb) : 1;
  const pf = eq.preamp && eq.preamp.gain;
  if (!pf) return;
  if (smooth && pf.setTargetAtTime) pf.setTargetAtTime(pg, t, 0.03);
  else pf.value = pg;
  eq.filters.forEach((f, i) => {
    const g = eq.on ? (eq.gains[i] || 0) : 0;
    if (smooth && f.gain.setTargetAtTime) f.gain.setTargetAtTime(g, t, 0.03);
    else f.gain.value = g;
  });
}

// 输出设备切换：均衡器链启用后走 AudioContext.setSinkId，否则走元素 setSinkId
async function applyOutputSink(deviceId) {
  if (eq.chainOn && eq.ctx && typeof eq.ctx.setSinkId === 'function') {
    await eq.ctx.setSinkId(deviceId || '');
  } else {
    await audio.setSinkId(deviceId || '');
  }
}

function saveEq() {
  S.settings.eq = {
    on: eq.on,
    preamp: eq.preampDb,
    gains: eq.gains.slice(),
    preset: eq.preset
  };
  saveConfig();
}

function syncEqUI() {
  const en = $('eq-enable');
  if (!en) return;
  en.checked = !!eq.on;
  $('eq-preset').value = eq.preset;
  $('eq-preamp').value = String(eq.preampDb);
  $('eq-preamp-val').textContent = (eq.preampDb > 0 ? '+' : '') + Number(eq.preampDb).toFixed(1) + ' dB';
  document.querySelectorAll('#eq-bands .eq-band').forEach((band, i) => {
    const input = band.querySelector('input');
    const lbl = band.querySelector('.eq-val');
    if (input) input.value = String(eq.gains[i] || 0);
    if (lbl) {
      const v = eq.gains[i] || 0;
      lbl.textContent = (v > 0 ? '+' : '') + v.toFixed(1);
    }
  });
  drawEqCurve();
}

function buildEqBandsUI() {
  const wrap = $('eq-bands');
  if (!wrap || wrap.dataset.built) return;
  wrap.dataset.built = '1';
  EQ_BANDS.forEach((freq, i) => {
    const band = document.createElement('div');
    band.className = 'eq-band';
    const val = document.createElement('div');
    val.className = 'eq-val';
    val.textContent = '0.0';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '-12';
    input.max = '12';
    input.step = '0.5';
    input.value = '0';
    input.title = (freq >= 1000 ? (freq / 1000) + ' kHz' : freq + ' Hz') + '（右键单击拨条归零）';
    input.addEventListener('input', () => {
      ensureEqOn();
      eq.gains[i] = parseFloat(input.value) || 0;
      eq.preset = 'custom';
      applyEqToGraph();
      val.textContent = (eq.gains[i] > 0 ? '+' : '') + eq.gains[i].toFixed(1);
      const sel = $('eq-preset');
      if (sel) sel.value = 'custom';
      drawEqCurve();
      saveEq();
    });
    // 右键单击拨条 → 该频段归零（不用拖回中点，微调过的频段也能一次清掉）
    const resetBand = (e) => {
      e.preventDefault();
      e.stopPropagation();
      eq.gains[i] = 0;
      input.value = '0';
      val.textContent = '0.0';
      eq.preset = 'custom';
      const sel = $('eq-preset');
      if (sel) sel.value = 'custom';
      applyEqToGraph();
      drawEqCurve();
      saveEq();
    };
    input.addEventListener('contextmenu', resetBand);
    // 拨条很窄，右键容易点到两侧留白：整个格子里右键都算
    band.addEventListener('contextmenu', resetBand);
    const lbl = document.createElement('div');
    lbl.className = 'eq-freq';
    lbl.textContent = freq >= 1000 ? (freq / 1000) + 'k' : String(freq);
    band.append(val, input, lbl);
    wrap.appendChild(band);
  });
}

// 频响曲线：对数频率采样，把各滤波器的 dB 响应叠加后画在 canvas 上
function drawEqCurve() {
  const canvas = $('eq-canvas');
  if (!canvas) return;
  const cssW = canvas.clientWidth || canvas.width || 640;
  const cssH = canvas.clientHeight || canvas.height || 180;
  if (!cssW || !cssH) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cssW * dpr)) canvas.width = Math.round(cssW * dpr);
  if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);
  const c2d = canvas.getContext('2d');
  c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cs = getComputedStyle(document.body);
  const accent = cs.getPropertyValue('--accent').trim() || '#ff6b3d';
  const border = cs.getPropertyValue('--border').trim() || '#2a2f3a';
  const textDim = cs.getPropertyValue('--text-faint').trim() || '#6b7280';
  const W = cssW, H = cssH;
  const dBMin = -15, dBMax = 15;
  const yFor = (db) => H - ((db - dBMin) / (dBMax - dBMin)) * H;
  const fMin = 20, fMax = 20000;
  const xFor = (f) => (Math.log10(f / fMin) / Math.log10(fMax / fMin)) * W;
  c2d.clearRect(0, 0, W, H);
  // 网格：dB 横线 + 频段竖线
  c2d.lineWidth = 1;
  [12, 6, 0, -6, -12].forEach(db => {
    c2d.strokeStyle = border;
    c2d.globalAlpha = db === 0 ? 0.95 : 0.45;
    const y = Math.round(yFor(db)) + 0.5;
    c2d.beginPath();
    c2d.moveTo(0, y);
    c2d.lineTo(W, y);
    c2d.stroke();
  });
  EQ_BANDS.forEach(f => {
    c2d.globalAlpha = 0.35;
    const x = Math.round(xFor(f)) + 0.5;
    c2d.beginPath();
    c2d.moveTo(x, 0);
    c2d.lineTo(x, H);
    c2d.stroke();
  });
  c2d.globalAlpha = 1;
  c2d.fillStyle = textDim;
  c2d.font = '10px sans-serif';
  [12, 0, -12].forEach(db => {
    c2d.fillText((db > 0 ? '+' : '') + db, 4, yFor(db) - 3);
  });
  EQ_BANDS.forEach(f => {
    c2d.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), xFor(f) - 6, H - 4);
  });
  // 曲线（用数学滤波器组按当前逻辑增益同步计算；音频链上的渐变不参与）
  const N = 160;
  const freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = fMin * Math.pow(fMax / fMin, i / (N - 1));
  const total = new Float32Array(N);
  const preampDb = eq.on ? eq.preampDb : 0;
  total.fill(preampDb);
  const srcFilters = eq.curveFilters.length ? eq.curveFilters : eq.filters;
  srcFilters.forEach((f, i) => {
    f.gain.value = eq.on ? (eq.gains[i] || 0) : 0;
  });
  if (srcFilters.length) {
    const mag = new Float32Array(N);
    const phase = new Float32Array(N);
    srcFilters.forEach(f => {
      f.getFrequencyResponse(freqs, mag, phase);
      for (let k = 0; k < N; k++) {
        const m = mag[k] > 1e-6 ? mag[k] : 1e-6;
        total[k] += 20 * Math.log10(m);
      }
    });
  }
  c2d.beginPath();
  for (let k = 0; k < N; k++) {
    const x = xFor(freqs[k]);
    const y = yFor(Math.max(dBMin, Math.min(dBMax, total[k])));
    if (k === 0) c2d.moveTo(x, y);
    else c2d.lineTo(x, y);
  }
  c2d.strokeStyle = accent;
  c2d.lineWidth = 2;
  c2d.stroke();
  // 曲线下方轻填充
  c2d.lineTo(W, yFor(0));
  c2d.lineTo(0, yFor(0));
  c2d.closePath();
  c2d.globalAlpha = 0.12;
  c2d.fillStyle = accent;
  c2d.fill();
  c2d.globalAlpha = 1;
  // 频段手柄点（精确算该频点的叠加响应）
  if (srcFilters.length) {
    srcFilters.forEach((f, i) => {
      const fr = new Float32Array([EQ_BANDS[i]]);
      const m = new Float32Array(1);
      const p = new Float32Array(1);
      let db = preampDb;
      srcFilters.forEach(ff => {
        ff.getFrequencyResponse(fr, m, p);
        db += 20 * Math.log10(m[0] > 1e-6 ? m[0] : 1e-6);
      });
      const x = xFor(EQ_BANDS[i]);
      const y = yFor(Math.max(dBMin, Math.min(dBMax, db)));
      c2d.beginPath();
      c2d.arc(x, y, 4, 0, Math.PI * 2);
      c2d.fillStyle = accent;
      c2d.fill();
      c2d.lineWidth = 1.5;
      c2d.strokeStyle = '#fff';
      c2d.stroke();
    });
  }
}

// 打开均衡器弹窗（主页脚 / 全屏专辑页两个入口共用）
function openEqModal() {
  buildEqBandsUI();
  ensureEqCtx();
  showModal('eq-modal');
  syncEqUI();
  drawEqCurve();
}

function initEqModal() {
  buildEqBandsUI();
  $('eq-enable').addEventListener('change', () => {
    eq.on = $('eq-enable').checked;
    if (eq.on) {
      ensureEqChain();
      if (eq.ctx && eq.ctx.state === 'suspended') eq.ctx.resume().catch(() => {});
    }
    applyEqToGraph();
    drawEqCurve();
    saveEq();
    toast(eq.on ? '均衡器已启用' : '均衡器已停用');
  });
  $('eq-preset').addEventListener('change', () => {
    const p = $('eq-preset').value;
    if (!EQ_PRESETS[p]) return;
    ensureEqOn();
    eq.preset = p;
    eq.gains = EQ_PRESETS[p].slice();
    applyEqToGraph();
    syncEqUI();
    saveEq();
  });
  // 悬停预设栏滚动滚轮直接切换音效（每格切一档，跳过「自定义」档）
  (() => {
    const bar = document.querySelector('.eq-presets');
    if (!bar) return;
    const order = Array.from($('eq-preset').options).map(o => o.value).filter(v => v !== 'custom');
    let lastStep = 0;
    bar.addEventListener('wheel', (e) => {
      e.preventDefault(); // 防止弹窗跟着滚，也压掉 select 原生滚轮改值
      const now = Date.now();
      if (now - lastStep < 200) return; // 触控板惯性会连发，节流成一格一档
      if (Math.abs(e.deltaY) < 8) return;
      lastStep = now;
      const dir = e.deltaY > 0 ? 1 : -1;
      const cur = $('eq-preset').value;
      let i = order.indexOf(cur);
      // 停在「自定义」时：向下从第一档开始，向上从最后一档开始
      if (i === -1) i = dir > 0 ? -1 : order.length;
      const next = order[(i + dir + order.length) % order.length];
      $('eq-preset').value = next;
      $('eq-preset').dispatchEvent(new Event('change'));
    }, { passive: false });
  })();
  $('eq-preamp').addEventListener('input', () => {
    ensureEqOn();
    eq.preampDb = parseFloat($('eq-preamp').value) || 0;
    $('eq-preamp-val').textContent = (eq.preampDb > 0 ? '+' : '') + eq.preampDb.toFixed(1) + ' dB';
    applyEqToGraph();
    drawEqCurve();
    saveEq();
  });
  // 前置增益同理：右键单击归零
  $('eq-preamp').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    eq.preampDb = 0;
    $('eq-preamp').value = '0';
    $('eq-preamp-val').textContent = '0.0 dB';
    applyEqToGraph();
    drawEqCurve();
    saveEq();
  });
  $('btn-eq').addEventListener('click', openEqModal);
  // 全屏专辑页的均衡器入口
  $('pf-eq').addEventListener('click', openEqModal);
  document.querySelectorAll('[data-close="eq"]').forEach(el => {
    el.addEventListener('click', () => { $('eq-modal').hidden = true; });
  });
  window.addEventListener('resize', () => {
    if (!$('eq-modal').hidden) drawEqCurve();
  });
}
initEqModal();

// ---------- 编辑歌曲信息弹窗 ----------
let editingTrackIdx = -1;
function openEditModal(track, focusField) {
  editingTrackIdx = S.tracks.indexOf(track);
  $('edit-title-input').value = track.title || '';
  $('edit-artist-input').value = track.artist || '';
  $('edit-album-input').value = track.album || '';
  const renameEl = $('edit-rename-file');
  // 默认勾选「同时改文件名」，并记住用户上次的选择
  if (renameEl) renameEl.checked = S.settings.renameOnEdit !== false;
  showModal('edit-modal');
  // 聚焦到对应字段
  setTimeout(() => {
    if (focusField === 'artist') $('edit-artist-input').focus();
    else if (focusField === 'album') $('edit-album-input').focus();
    else $('edit-title-input').focus();
  }, 50);
}

function closeEditModal() {
  $('edit-modal').hidden = true;
  editingTrackIdx = -1;
}

document.querySelectorAll('[data-close="edit"]').forEach(el => {
  el.addEventListener('click', closeEditModal);
});

$('btn-save-edit').addEventListener('click', async () => {
  if (editingTrackIdx < 0) return;
  const idx = editingTrackIdx;
  const track = S.tracks[idx];
  const newTitle = $('edit-title-input').value.trim();
  const newArtist = $('edit-artist-input').value.trim();
  const newAlbum = $('edit-album-input').value.trim();
  const renameEl = $('edit-rename-file');
  const doRename = !!(renameEl && renameEl.checked) && !track.isPlaceholder;
  // 记住勾选偏好，下次打开弹窗沿用
  if (renameEl) S.settings.renameOnEdit = renameEl.checked;
  if (newTitle) track.title = newTitle;
  if (newArtist) track.artist = newArtist;
  track.album = newAlbum;
  renderList();
  if (S.current === idx) {
    updateNowPlaying();
    updateMediaSessionMeta();
    if (pf.open) {
      const titleEl = $('pf-title');
      const artistEl = $('pf-artist');
      const albumEl = $('pf-album');
      if (titleEl) titleEl.textContent = track.title || '未知歌曲';
      if (artistEl) artistEl.textContent = track.artist || '未知艺术家';
      if (albumEl) albumEl.textContent = track.album || '';
    }
  }
  closeEditModal();
  // 占位歌曲（在线导入未下载）没有本地文件，只改内存
  if (track.isPlaceholder) {
    saveConfig();
    toast('歌曲信息已更新（占位歌曲，未写入文件）');
    return;
  }
  // 写回源文件标签：改名必须落盘到文件本身，否则重启扫描（读标签/文件名）就丢
  if (typeof mb.writeMusicMetadata !== 'function') {
    saveConfig();
    toast('歌曲信息已更新（当前版本不支持写入文件标签）');
    return;
  }
  toast('正在写入音乐文件...');
  try {
    const writeRes = await mb.writeMusicMetadata(track.path, track.title, track.artist, track.album);
    if (writeRes && writeRes.ok) {
      let renamed = false;
      if (doRename) renamed = !!(await renameTrackFile(idx, true));
      saveConfig();
      toast('歌曲信息已写入源文件' + (doRename ? (renamed ? '，文件名已同步更新' : '，但文件名未更改（可能被占用或已存在同名文件）') : ''));
    } else {
      saveConfig();
      toast('写入源文件失败：' + (writeRes?.error || '未知错误') + '（仅列表显示已更新）');
    }
  } catch (e) {
    saveConfig();
    toast('写入源文件出错：' + e.message);
  }
});

// 编辑弹窗按 Enter 保存
['edit-title-input', 'edit-artist-input', 'edit-album-input'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-save-edit').click(); });
});

// ---------- 自定义确认弹窗 ----------
let confirmCallback = null;
let confirmExtraMode = false;
let confirmFormatMode = false;
function showConfirm(title, text) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    const extra = $('confirm-extra');
    if (extra) extra.hidden = true;
    const fw = $('confirm-format-wrap');
    if (fw) fw.hidden = true;
    confirmExtraMode = false;
    confirmFormatMode = false;
    showModal('confirm-modal');
    confirmCallback = resolve;
  });
}
// 带一个附加勾选框 + 可选「命名格式」下拉的确认框。
// 返回 { ok, checked, format }，用于「批量补全 + 顺便改名 + 选格式」这类选项。
// showFormat=true 时显示下拉，并用当前 settings.renameFormat 作为默认选中项。
function showConfirmEx(title, text, extraLabel, checked = false, showFormat = false) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    const extra = $('confirm-extra');
    if (extra) {
      extra.hidden = false;
      $('confirm-extra-label').textContent = extraLabel || '';
      $('confirm-extra-check').checked = !!checked;
    }
    const fw = $('confirm-format-wrap');
    if (fw) {
      fw.hidden = !showFormat;
      if (showFormat) {
        const sel = $('confirm-format-select');
        // 只建一次选项，之后每次打开同步当前值
        if (!sel || !sel.options.length) {
          const opts = [
            ['artist-title-album', '歌手 - 歌名 - 专辑'],
            ['title-artist-album', '歌名 - 歌手 - 专辑'],
            ['artist-album-title', '歌手 - 专辑 - 歌名']
          ];
          opts.forEach(([v, label]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = label;
            sel.appendChild(o);
          });
        }
        sel.value = (S.settings && S.settings.renameFormat) || 'artist-title-album';
      }
    }
    confirmExtraMode = true;
    confirmFormatMode = !!showFormat;
    showModal('confirm-modal');
    confirmCallback = resolve;
  });
}
function closeConfirm(result) {
  $('confirm-modal').hidden = true;
  if (confirmCallback) {
    const cb = confirmCallback;
    confirmCallback = null;
    if (confirmExtraMode) {
      const sel = $('confirm-format-select');
      cb({
        ok: !!result,
        checked: !!($('confirm-extra-check') && $('confirm-extra-check').checked),
        format: confirmFormatMode && sel ? sel.value : null
      });
    } else {
      cb(result);
    }
  }
  confirmExtraMode = false;
  confirmFormatMode = false;
}
$('confirm-cancel').addEventListener('click', () => closeConfirm(false));
$('confirm-ok').addEventListener('click', () => closeConfirm(true));
document.querySelectorAll('[data-close="confirm"]').forEach(el => {
  el.addEventListener('click', () => closeConfirm(false));
});

// ---------- 输入对话框（替代 Electron 不支持的 prompt()） ----------
let inputCallback = null;
function showInput(title, defaultValue = '', desc = '') {
  return new Promise((resolve) => {
    $('input-title').textContent = title;
    $('input-field').value = defaultValue;
    const descEl = $('input-desc');
    if (desc) {
      descEl.innerHTML = desc;
      descEl.style.display = '';
    } else {
      descEl.style.display = 'none';
    }
    showModal('input-modal');
    inputCallback = resolve;
    setTimeout(() => {
      $('input-field').focus();
      $('input-field').select();
    }, 50);
  });
}
function closeInput(result) {
  $('input-modal').hidden = true;
  if (inputCallback) {
    inputCallback(result);
    inputCallback = null;
  }
}
$('input-cancel').addEventListener('click', () => closeInput(null));
$('input-ok').addEventListener('click', () => closeInput($('input-field').value.trim()));
$('input-field').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') closeInput($('input-field').value.trim());
  if (e.key === 'Escape') closeInput(null);
});
document.querySelectorAll('[data-close="input"]').forEach(el => {
  el.addEventListener('click', () => closeInput(null));
});

// ---------- 手动导入歌词 ----------
let importingTrack = null;
function openLyricsImportModal(track) {
  importingTrack = track;
  $('lyrics-import-text').value = '';
  showModal('lyrics-import-modal');
  setTimeout(() => $('lyrics-import-text').focus(), 100);
}
function closeLyricsImportModal() {
  $('lyrics-import-modal').hidden = true;
  importingTrack = null;
}
document.querySelectorAll('[data-close="lyrics-import"]').forEach(el => {
  el.addEventListener('click', closeLyricsImportModal);
});
$('btn-save-lyrics-import').addEventListener('click', () => {
  if (!importingTrack) return;
  const text = $('lyrics-import-text').value.trim();
  if (!text) { toast('请输入歌词内容'); return; }
  // 判断是否是 LRC 格式（包含时间轴）
  const hasTimeAxis = /\[\d{1,2}:\d{2}(\.\d{1,3})?\]/.test(text);
  let lrcText = text;
  if (!hasTimeAxis) {
    // 纯文本歌词，自动生成时间轴（每行 5 秒）
    const lines = text.split('\n').filter(l => l.trim());
    lrcText = lines.map((line, i) => {
      const seconds = i * 5;
      const min = Math.floor(seconds / 60);
      const sec = (seconds % 60).toFixed(2).padStart(5, '0');
      return `[${min}:${sec}]${line.trim()}`;
    }).join('\n');
  }
  // 应用歌词
  const lyricsData = { lrc: lrcText, tlyric: '', rlyric: '', source: '手动导入' };
  S.lyricsCache.set(importingTrack.path, lyricsData);
  renderLyrics(lyricsData);
  applyLyricSourceFromData(lyricsData);
  updateLyricsModeButtons();
  showLyricsPanel();
  // 保存到文件
  if (S.settings.saveLyrics) {
    const saveDir = S.settings.cachePath || '';
    mb.saveLyrics(lrcText, saveDir, importingTrack.artist, importingTrack.title).catch(() => {});
  }
  toast('歌词已导入');
  closeLyricsImportModal();
});

// ---------- 自动修复歌曲信息 ----------
let autoFixing = false;
let autoFixCancel = false;

// ---------- 批量下载专辑封面和歌词 ----------
let batchDownloading = false;
let batchDownloadCancel = false;

async function startBatchDownload() {
  if (batchDownloading) {
    toast('已有批量下载任务正在进行');
    return;
  }
  if (S.tracks.length === 0) {
    toast('播放列表为空，请先添加音乐');
    return;
  }
  // 确认弹窗
  const confirmed = await showConfirm('批量下载', `将为 ${S.tracks.length} 首歌曲下载专辑封面和歌词，并保存到本地。\n\n已下载过的会自动跳过，是否开始？`);
  if (!confirmed) return;

  batchDownloading = true;
  batchDownloadCancel = false;

  // 显示进度条
  const bar = $('batchdl-bar');
  const progress = $('batchdl-bar-progress');
  const coverEl = $('bd-bar-cover');
  const lyricsEl = $('bd-bar-lyrics');
  const failEl = $('bd-bar-fail');
  const countEl = $('bd-bar-count');
  bar.style.display = 'flex';

  let coverOk = 0, lyricsOk = 0, failCount = 0;
  const total = S.tracks.length;

  for (let i = 0; i < total; i++) {
    if (batchDownloadCancel) break;

    const track = S.tracks[i];
    if (!track || !track.path || track.isPlaceholder) continue;
    countEl.textContent = `${i + 1}/${total}`;
    progress.style.width = ((i + 1) / total * 100) + '%';

    try {
      // 生成缓存key（和服务端safeName保持一致：替换特殊字符 + 截断120字符）
      const safeKey = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120).toLowerCase();
      const coverKey = safeKey(`${track.artist} - ${track.title}`);
      // 下载封面（如果本地缓存没有）
      if (!S.coverCache.has(track.path) && !S.localCoverFiles.has(coverKey)) {
        const res = await mb.fetchCover(track.artist, track.title);
        if (res.ok && res.dataUrl) {
          S.coverCache.set(track.path, res.dataUrl);
          // 保存到文件
          if (S.settings.saveCover) {
            const saveDir = S.settings.cachePath || '';
            await mb.saveCover(res.dataUrl, saveDir, track.artist, track.title);
          }
          coverOk++;
          coverEl.textContent = coverOk;
        } else {
          failCount++;
          failEl.textContent = failCount;
        }
      } else {
        coverOk++;
        coverEl.textContent = coverOk;
      }

      // 下载歌词（如果本地缓存没有）
      const lyricsKey = coverKey;
      if (!S.lyricsCache.has(track.path) && !S.localLyricsFiles.has(lyricsKey)) {
        const res = await mb.fetchLyrics(track.artist, track.title, trackDurationSec(track));
        if (res.ok && res.lrc) {
          const lyricsData = {
        lrc: res.lrc,
        tlyric: res.tlyric || '',
        rlyric: res.rlyric || '',
        yrc: res.yrc || ''
      };
          S.lyricsCache.set(track.path, lyricsData);
          // 保存到文件（带翻译/音译/逐字，写法与单曲获取保持一致）
          if (S.settings.saveLyrics) {
            const saveDir = S.settings.cachePath || '';
            await mb.saveLyrics(lyricsData, saveDir, track.artist, track.title,
              { songName: res.info?.songName || track.title, artist: res.info?.artist || track.artist });
          }
          lyricsOk++;
          lyricsEl.textContent = lyricsOk;
        } else {
          failCount++;
          failEl.textContent = failCount;
        }
      } else {
        lyricsOk++;
        lyricsEl.textContent = lyricsOk;
      }
    } catch (e) {
      console.error('批量下载失败:', track.title, e);
      failCount++;
      failEl.textContent = failCount;
    }

    // 短暂延迟，避免请求过快
    await new Promise(r => setTimeout(r, 200));
  }

  // 完成
  batchDownloading = false;
  setTimeout(() => {
    bar.style.display = 'none';
  }, 2000);

  if (batchDownloadCancel) {
    toast(`批量下载已取消，已完成 ${coverOk} 个封面，${lyricsOk} 个歌词`);
  } else {
    toast(`批量下载完成！封面 ${coverOk} 个，歌词 ${lyricsOk} 个，失败 ${failCount} 个`);
  }
  saveConfig();
}

// 批处理按钮（下拉菜单）
$('btn-batch').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('batch-menu');
  // 互斥（2026-11-20 用户反馈重叠）：开着别的浮层先收掉，别和外观/歌词/设置浮层叠在一起
  $('theme-popover').hidden = true;
  $('desktop-lyric-menu').hidden = true;
  $('settings-modal').hidden = true;
  menu.hidden = !menu.hidden;
});

// 点击外部关闭批处理菜单
document.addEventListener('click', (e) => {
  const menu = $('batch-menu');
  const btn = $('btn-batch');
  if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    menu.hidden = true;
    hideMenuOverlay();
  }
});

// 批处理菜单项点击
document.querySelectorAll('.batch-item').forEach(item => {
  item.addEventListener('click', () => {
    const action = item.dataset.action;
    $('batch-menu').hidden = true;
    hideMenuOverlay();
    if (action === 'auto-fix') {
      autoFixAll();
    } else if (action === 'batch-download') {
      startBatchDownload();
    } else if (action === 'batch-mp3') {
      showModal('convert-modal');
    } else if (action === 'export-missing') {
      exportMissingSongs();
    } else if (action === 'check-dupes') {
      openDedupeModal();
    } else if (action === 'merge-libraries') {
      openMergeModal();
    }
  });
});

// ---------- 导出缺失歌曲名单 ----------
function exportMissingSongs() {
  const missing = S.tracks.filter(t => t.isPlaceholder);
  if (missing.length === 0) {
    toast('当前列表没有缺失的歌曲');
    return;
  }
  
  // 生成 txt 内容
  const lines = [];
  lines.push('MusicSMX - 缺失歌曲名单');
  lines.push('导出时间：' + new Date().toLocaleString('zh-CN'));
  lines.push('缺失歌曲数量：' + missing.length);
  lines.push('');
  lines.push('='.repeat(60));
  lines.push('');
  missing.forEach((t, idx) => {
    lines.push((idx + 1) + '. ' + t.title);
    lines.push('   歌手：' + (t.artist || '未知'));
    if (t.album) lines.push('   专辑：' + t.album);
    if (t.duration) lines.push('   时长：' + fmtTime(t.duration));
    if (t.isMissing && t.path) lines.push('   原路径：' + t.path);
    lines.push('');
  });
  lines.push('='.repeat(60));
  lines.push('');
  lines.push('提示：可将此名单用于在QQ音乐/网易云等平台批量下载缺失歌曲');
  
  const content = lines.join('\n');
  
  // 通过浏览器下载
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  a.download = '缺失歌曲名单_' + dateStr + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  toast('已导出 ' + missing.length + ' 首缺失歌曲名单');
}

// ---------- 批量转换为 MP3 ----------
let batchConverting = false;
let batchConvertCancel = false;


// ---------- 批量转换格式（弹窗） ----------
async function startBatchConvertFormat(format, outputDir, replaceOriginal) {
  if (batchConverting) { toast('已有批量转换任务正在进行'); return; }
  if (S.tracks.length === 0) { toast('播放列表为空，请先添加音乐'); return; }
  const toConvert = S.tracks.filter(t => {
    if (!t || !t.path || t.isPlaceholder) return false;
    const ext = (t.path.split('.').pop() || '').toLowerCase();
    return ext !== format;
  });
  if (toConvert.length === 0) { toast('所有歌曲已经是 ' + format.toUpperCase() + ' 格式'); return; }
  $('convert-modal').hidden = true;
  batchConverting = true;
  batchConvertCancel = false;
  const total = toConvert.length;
  let success = 0, skipped = 0, failCount = 0;
  // 显示进度条
  const bar = $('batchdl-bar');
  const progress = $('batchdl-bar-progress');
  const coverEl = $('bd-bar-cover');
  const lyricsEl = $('bd-bar-lyrics');
  const failEl = $('bd-bar-fail');
  const countEl = $('bd-bar-count');
  coverEl.parentElement.querySelector('span').textContent = '成功';
  lyricsEl.parentElement.querySelector('span').textContent = '跳过';
  failEl.parentElement.querySelector('span').textContent = '失败';
  bar.style.display = 'flex';
  progress.style.width = '0%';
  coverEl.textContent = '0'; lyricsEl.textContent = '0'; failEl.textContent = '0';
  countEl.textContent = `0/${total}`;

  for (let i = 0; i < total; i++) {
    if (batchConvertCancel) break;
    const track = toConvert[i];
    countEl.textContent = `${i + 1}/${total}`;
    progress.style.width = ((i + 1) / total * 100) + '%';
    try {
      const result = await mb.convertFormat(track.path, format, outputDir, replaceOriginal);
      if (result && result.ok) {
        const newDir = result.outputPath.substring(0, result.outputPath.lastIndexOf('\\'));
        const scanned = await mb.scan([newDir]);
        if (scanned && scanned.tracks) {
          for (const t of scanned.tracks) {
            if (t.path === result.outputPath && !S.tracks.find(x => x.path === t.path)) {
              S.tracks.push(t);
            }
          }
        }
        // 如果替换了源文件，从播放列表移除原文件
        if (replaceOriginal) {
          const idx = S.tracks.findIndex(x => x.path === track.path);
          if (idx >= 0) S.tracks.splice(idx, 1);
        }
        success++;
        coverEl.textContent = success;
      } else {
        failCount++;
        failEl.textContent = failCount;
      }
    } catch (e) {
      console.error('批量转换失败:', track.title, e);
      failCount++;
      failEl.textContent = failCount;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  batchConverting = false;
  renderList();
  saveConfig();
  setTimeout(() => { bar.style.display = 'none'; }, 2000);
  if (batchConvertCancel) toast(`批量转换已取消，成功 ${success} 个`);
  else toast(`批量转换完成！成功 ${success} 个，失败 ${failCount} 个`);
}
// 批量转格式弹窗事件
$('btn-start-convert').addEventListener('click', () => {
  const format = $('convert-format').value;
  const outputDir = $('convert-output-dir').value.trim();
  const replaceOriginal = $('convert-replace').checked;
  startBatchConvertFormat(format, outputDir, replaceOriginal);
});
$('btn-convert-browse').addEventListener('click', async () => {
  try {
    const result = await mb.selectDirectory();
    if (result && result.path) $('convert-output-dir').value = result.path;
  } catch (e) { toast('选择文件夹失败'); }
});
document.querySelectorAll('[data-close="convert"]').forEach(el => {
  el.addEventListener('click', () => { $('convert-modal').hidden = true; });
});

// 取消批量下载
$('bd-bar-cancel').addEventListener('click', () => {
  batchDownloadCancel = true;
  toast('正在取消批量下载...');
});

// 转换为 MP3
async function convertTrackToMp3(idx) {
  const track = S.tracks[idx];
  if (!track) return;
  const ext = (track.path.split('.').pop() || '').toLowerCase();
  if (ext === 'mp3') {
    toast('已经是 MP3 格式');
    return;
  }
  const confirmed = await showConfirm('转换为 MP3', `将「${track.title}」转换为 MP3（320kbps）？\n\n转换后会在同目录生成新的 MP3 文件，并自动添加到播放列表。`);
  if (!confirmed) {
    return;
  }
  toast('正在转换为 MP3...');
  try {
    const result = await mb.convertToMp3(track.path, '320k');
    if (result && result.ok) {
      toast('转换成功！正在添加到播放列表...');
      // 扫描新文件并添加到播放列表
      const newDir = result.outputPath.substring(0, result.outputPath.lastIndexOf('\\'));
      const scanned = await mb.scan([newDir]);
      if (scanned && scanned.tracks) {
        for (const t of scanned.tracks) {
          if (t.path === result.outputPath && !S.tracks.find(x => x.path === t.path)) {
            S.tracks.push(t);
          }
        }
        renderList();
        saveConfig();
      }
      toast('转换完成，已添加到播放列表');
    } else {
      toast('转换失败：' + (result?.error || '未知错误'));
    }
  } catch (e) {
    toast('转换出错：' + e.message);
  }
}

// 三段式文件名：按用户选的顺序拼（歌手/歌名/专辑），与主进程 rename-file 的清洗规则保持一致。
// 格式：artist-title-album（默认）| title-artist-album | artist-album-title
function currentRenameFormat() {
  const f = S.settings && S.settings.renameFormat;
  return (f === 'title-artist-album' || f === 'artist-album-title') ? f : 'artist-title-album';
}
function fullInfoNameOf(t, fmt) {
  if (!t || t.isPlaceholder || t.isMissing) return '';
  const clean = (s) => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
  const artist = clean(t.artist);
  const title = clean(t.title);
  const album = clean(t.album);
  if (!artist || !title || isBadAlbumName(t.album)) return '';
  if (/^未知(歌手|艺术家|标题)?$/.test(artist) || /^未知/.test(title)) return '';
  switch (fmt || currentRenameFormat()) {
    case 'title-artist-album': return `${title} - ${artist} - ${album}`;
    case 'artist-album-title': return `${artist} - ${album} - ${title}`;
    case 'artist-title-album':
    default: return `${artist} - ${title} - ${album}`;
  }
}
function baseNameNoExt(p) {
  const name = String(p || '').split('\\').pop().split('/').pop();
  return name.replace(/\.[^.]+$/, '');
}
function needFullInfoRename(t, fmt) {
  const name = fullInfoNameOf(t, fmt);
  if (!name) return false;
  const cur = baseNameNoExt(t.path);
  if (cur === name) return false;
  // 主进程遇到重名会加 _1 / _2；这种已经是目标格式，别反复改
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !new RegExp('^' + esc + '_\\d+$').test(cur);
}

// 自动重命名文件（默认「歌手 - 标题」；批量补全可传 newNameOverride 指定三段式名称）
async function renameTrackFile(idx, skipConfirm, newNameOverride, deferUi) {
  const track = S.tracks[idx];
  if (!track) return false;
  const oldName = track.path.split('\\').pop().split('/').pop();
  const newName = newNameOverride || `${track.artist || '未知歌手'} - ${track.title || '未知标题'}`;
  if (!skipConfirm) {
    const confirmed = await showConfirm('重命名文件', `将文件重命名为：\n\n${newName}\n\n原文件名：${oldName}\n\n确定要重命名吗？`);
    if (!confirmed) return false;
  }
  // 正在播放的文件被 Chromium 媒体管线占住句柄，Windows 下改名会 EBUSY 失败。
  // 改名前先卸下当前曲的 audio.src 释放句柄，改完（含失败）再装回去，播放位置/状态都保留。
  const isCurrent = (S.current === idx);
  const wasPlaying = isCurrent && !audio.paused;
  const resumeAt = isCurrent ? audio.currentTime : 0;
  try {
    if (isCurrent) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      await new Promise(r => setTimeout(r, 120));   // 给媒体栈一点时间松手
    }
    let result = await mb.renameFile(track.path, newName);
    if (result && !result.ok && /EBUSY|locked|占用/i.test(String(result.error || ''))) {
      await new Promise(r => setTimeout(r, 300));
      result = await mb.renameFile(track.path, newName);
    }
    if (result && result.ok) {
      // 更新播放列表里的路径
      const oldPath = track.path;
      track.path = result.newPath;
      // 迁移按路径做键的状态，否则歌词偏移/修复标记/锁定/队列/收藏全部失联
      const newPath = result.newPath;
      if (S.settings.lyricOffsets && oldPath in S.settings.lyricOffsets) {
        S.settings.lyricOffsets[newPath] = S.settings.lyricOffsets[oldPath];
        delete S.settings.lyricOffsets[oldPath];
      }
      if (S.settings.fixedTracks && oldPath in S.settings.fixedTracks) {
        S.settings.fixedTracks[newPath] = S.settings.fixedTracks[oldPath];
        delete S.settings.fixedTracks[oldPath];
      }
      if (S.settings.lockedTracks && oldPath in S.settings.lockedTracks) {
        S.settings.lockedTracks[newPath] = S.settings.lockedTracks[oldPath];
        delete S.settings.lockedTracks[oldPath];
      }
      S.queue = S.queue.map(p => (p === oldPath ? newPath : p));
      if (S.favorites.has(oldPath)) {
        S.favorites.delete(oldPath);
        S.favorites.add(newPath);
      }
      S.playlists.forEach(pl => {
        if (Array.isArray(pl.tracks)) {
          for (let i = 0; i < pl.tracks.length; i++) {
            if (pl.tracks[i] === oldPath) pl.tracks[i] = newPath;
          }
        }
      });
      if (S.importedTrackOrder) {
        S.importedTrackOrder = S.importedTrackOrder.map(p => (p === oldPath ? newPath : p));
      }
      // 按路径做键的运行时缓存也要跟着搬，否则批量改名后封面/歌词/时长全丢
      [S.coverCache, S.lyricsCache, S.durations].forEach((map) => {
        if (map && map.has && map.has(oldPath)) {
          map.set(newPath, map.get(oldPath));
          map.delete(oldPath);
        }
      });
      // 之前卸下的当前曲：装回新路径，恢复播放位置与播放状态
      if (isCurrent) {
        audio.src = fileURL(result.newPath);
        const onMeta = () => {
          audio.currentTime = resumeAt;
          audio.removeEventListener('loadedmetadata', onMeta);
          if (wasPlaying) {
            audio.play().catch(() => {});
          }
        };
        audio.addEventListener('loadedmetadata', onMeta);
      }
      if (!deferUi) {
        renderList();
        saveConfig();
        if (!skipConfirm) toast('重命名成功');
      }
      return true;
    } else {
      // 改名失败：把当前曲装回原路径，别让播放停在空 src 上
      if (isCurrent) {
        audio.src = fileURL(track.path);
        const onMeta = () => {
          audio.currentTime = resumeAt;
          audio.removeEventListener('loadedmetadata', onMeta);
          if (wasPlaying) audio.play().catch(() => {});
        };
        audio.addEventListener('loadedmetadata', onMeta);
      }
      if (!skipConfirm) toast('重命名失败：' + (result?.error || '未知错误'));
      return false;
    }
  } catch (e) {
    if (isCurrent) {
      try { audio.src = fileURL(track.path); } catch (e2) {}
    }
    if (!skipConfirm) toast('重命名出错：' + e.message);
    return false;
  }
}

async function autoFixSingle(idx) {
  if (autoFixing) { toast('正在修复中，请稍候...'); return; }
  const track = S.tracks[idx];
  if (!track) return;
  // 已锁定的歌曲跳过
  if (S.settings.lockedTracks && S.settings.lockedTracks[track.path]) {
    toast('该歌曲已锁定，无法自动修复');
    return;
  }
  autoFixing = true;
  toast('正在联网校验歌曲信息...');
  try {
    const result = await mb.autoFixTrack(track.artist, track.title, track.album || '', track.duration || 0);
    if (!result || !result.needFix) {
      toast('歌曲信息已正确，无需修复');
      return;
    }
    // 应用修复到内存（占位值不覆盖：联库搜不到时会回吐"未知歌手/未知专辑"，
    // 直接写回去等于把原来的空信息"洗"成硬编码文本，后面再也修不回来）
    if (result.fixed.title) track.title = result.fixed.title;
    if (result.fixed.artist && !/^(未知歌手|未知艺术家|未知|未知艺人)$/.test(result.fixed.artist)) track.artist = result.fixed.artist;
    if (result.fixed.album) track.album = result.fixed.album;
    renderList();
    if (S.current === idx) updateNowPlaying();
    // 写入音乐文件 ID3 标签
    toast('正在写入音乐文件...');
    if (typeof mb.writeMusicMetadata !== 'function') {
      toast('错误：当前版本不支持写入文件元数据，请更新软件');
      return;
    }
    const writeRes = await mb.writeMusicMetadata(track.path, track.title, track.artist, track.album);
    const conf = Math.round(result.confidence * 100);
    if (writeRes && writeRes.ok) {
      // 自动重命名文件为 歌手 - 标题
      const renamed = await renameTrackFile(idx, true);
      // 记录已修复标记（用重命名后的新路径）
      S.settings.fixedTracks[track.path] = Date.now();
      saveConfig();
      renderList();
      if (renamed) {
        toast(`已修复并写入文件，文件名已更新（${result.source}，置信度${conf}%）`);
      } else {
        toast(`已修复并写入文件（${result.source}，置信度${conf}%）`);
      }
    } else {
      toast(`写入文件失败：${writeRes?.error || '未知错误'}`);
    }
  } catch (e) {
    toast('修复失败：' + e.message);
  } finally {
    autoFixing = false;
  }
}

function updateAutofixBar(current, total, fixed, skip, fail, writeFail) {
  $('autofix-bar-progress').style.width = (total > 0 ? (current / total * 100) : 0) + '%';
  $('af-bar-fixed').textContent = fixed;
  $('af-bar-skip').textContent = skip;
  $('af-bar-fail').textContent = fail;
  $('af-bar-count').textContent = `${current}/${total}`;
  if (writeFail !== undefined && writeFail > 0) {
    $('af-bar-count').textContent += ` (写入失败${writeFail})`;
  }
}

async function autoFixAll() {
  if (autoFixing) { toast('正在修复中，请稍候...'); return; }
  if (S.tracks.length === 0) { toast('没有可修复的歌曲'); return; }
  // 确认提示：会修改源文件
  const alreadyFixedCount = Object.keys(S.settings.fixedTracks || {}).length;
  let msg = `自动修复会修改音乐文件本身的 ID3 标签（标题、歌手、专辑）。\n\n建议先备份重要音乐文件。\n\n共 ${S.tracks.length} 首歌曲`;
  if (alreadyFixedCount > 0) {
    msg += `，其中 ${alreadyFixedCount} 首已修复过会自动跳过`;
  }
  msg += '，确定要继续吗？';
  const confirmed = await showConfirm('自动修复确认', msg);
  if (!confirmed) {
    return;
  }
  autoFixing = true;
  autoFixCancel = false;
  let fixedCount = 0;
  let skipCount = 0;
  let failCount = 0;
  let writeFailCount = 0;
  let renameCount = 0;
  // 显示内嵌进度条
  $('autofix-bar').style.display = 'flex';
  updateAutofixBar(0, S.tracks.length, 0, 0, 0, 0);
  toast('已开始自动修复，进度在顶栏下方显示');
  for (let i = 0; i < S.tracks.length; i++) {
    if (autoFixCancel) break;
    const track = S.tracks[i];
    updateAutofixBar(i, S.tracks.length, fixedCount, skipCount, failCount, writeFailCount);
    // 占位/缺失歌曲跳过（本地无文件）
    if (track.isPlaceholder) {
      skipCount++;
      continue;
    }
    // 已锁定的歌曲自动跳过
    if (S.settings.lockedTracks && S.settings.lockedTracks[track.path]) {
      skipCount++;
      continue;
    }
    // 已修复过的歌曲自动跳过
    if (S.settings.fixedTracks && S.settings.fixedTracks[track.path]) {
      skipCount++;
      continue;
    }
    try {
      const result = await mb.autoFixTrack(track.artist, track.title, track.album || '', track.duration || 0);
      if (result && result.needFix) {
        if (result.fixed.title) track.title = result.fixed.title;
        if (result.fixed.artist && !/^(未知歌手|未知艺术家|未知|未知艺人)$/.test(result.fixed.artist)) track.artist = result.fixed.artist;
        if (result.fixed.album && !/^未知专辑$/.test(result.fixed.album)) track.album = result.fixed.album;
        fixedCount++;
        // 写入音乐文件 ID3 标签
        if (typeof mb.writeMusicMetadata === 'function') {
          try {
            const writeRes = await mb.writeMusicMetadata(track.path, track.title, track.artist, track.album);
            if (!writeRes || !writeRes.ok) {
              writeFailCount++;
              console.error('写入失败:', track.path, writeRes?.error);
            } else {
              // 写入成功后自动重命名文件为 歌手 - 标题
              try {
                const renamed = await renameTrackFile(i, true);
                if (renamed) renameCount++;
              } catch (renameErr) {
                console.error('重命名失败:', track.path, renameErr.message);
              }
              // 记录已修复标记（用重命名后的新路径）
              S.settings.fixedTracks[track.path] = Date.now();
            }
          } catch (writeErr) {
            writeFailCount++;
            console.error('写入异常:', track.path, writeErr.message);
          }
        } else {
          writeFailCount++;
          console.error('writeMusicMetadata 方法不存在');
        }
      } else {
        skipCount++;
      }
    } catch (e) {
      failCount++;
    }
    // 每 10 首更新一次列表（减少频率避免音频中断）
    if ((i + 1) % 10 === 0 || i === S.tracks.length - 1) {
      renderList();
    }
    // 避免请求过快
    await new Promise(r => setTimeout(r, 200));
  }
  renderList();
  if (S.current >= 0) updateNowPlaying();
  updateAutofixBar(S.tracks.length, S.tracks.length, fixedCount, skipCount, failCount, writeFailCount);
  const done = autoFixCancel ? '已取消' : '修复完成';
  let summary = `${done}！已修复${fixedCount}首，无需修复${skipCount}首，失败${failCount}首`;
  if (renameCount > 0) {
    summary += `，文件名已更新${renameCount}首`;
  }
  if (writeFailCount > 0) {
    summary += `\n⚠️ 有${writeFailCount}首写入源文件失败（内存已更新但文件未变）`;
    toast(summary, 8000);
  } else {
    toast(summary);
  }
  // 5 秒后隐藏进度条
  setTimeout(() => {
    if (!autoFixing) $('autofix-bar').style.display = 'none';
  }, 5000);
  autoFixing = false;
}

// ---------- 写入文件标签（歌名 / 歌手 / 专辑） ----------
// 资源管理器「标题 / 参与创作的艺术家 / 专辑」三列读的就是音频文件本身的标签。
// 曲库里补全过的信息只有落盘到文件，系统和其他播放器才看得到。
// 写标签只重写容器里的标签区（音频流原样复制），不转码、不改文件名、不改文件修改时间。

// 单首：以曲库为准覆盖这三项
async function writeTrackTags(idx) {
  if (infoFilling || autoFixing) { toast('已有任务在进行，请稍候'); return; }
  const track = S.tracks[idx];
  if (!track) return;
  if (track.isPlaceholder) { toast('占位歌曲没有本地文件，写不了标签'); return; }
  if (typeof mb.writeMusicMetadata !== 'function') { toast('当前版本不支持写入文件标签'); return; }
  if (!track.title && !track.artist && !track.album) { toast('这首歌没有可写入的信息'); return; }
  toast('正在写入文件标签…');
  try {
    const res = await mb.writeMusicMetadata(track.path, track.title, track.artist, track.album);
    if (res && res.ok) {
      toast('已写入文件标签：' + [track.title, track.artist, track.album].filter(Boolean).join(' · ')
        + '（资源管理器里按 F5 刷新即可看到）', 6000);
    } else {
      toast('写入失败：' + ((res && res.error) || '未知错误'), 7000);
    }
  } catch (e) {
    toast('写入出错：' + e.message, 7000);
  }
}

// 批量：以曲库为准，只重写"和文件里不一致"的字段；曲库没值的字段一律不动
async function writeAllTagsBatch() {
  if (infoFilling || autoFixing) { toast('已有任务在进行，请稍候'); return; }
  if (typeof mb.readFileTags !== 'function' || typeof mb.writeMusicMetadata !== 'function') {
    toast('当前版本不支持写入文件标签，请更新软件');
    return;
  }
  const list = S.tracks.filter((t) => !t.isPlaceholder && !t.isMissing && (t.title || t.artist || t.album));
  if (!list.length) { toast('曲库里没有可写入的本地歌曲'); return; }
  const ok = await showConfirm('批量写入文件标签',
    '把曲库里的歌名 / 歌手 / 专辑写进音频文件本身的标签。\n\n'
    + '· 以曲库为准：文件里缺的补上，和曲库不一致的改成曲库的写法\n'
    + '· 曲库里空着的字段不动，文件已有的值不会被抹掉\n'
    + '· 音频流原样复制，不转码、不改音质、不改文件名\n'
    + '· 将逐首比对 ' + list.length + ' 首，已经一致的直接跳过\n\n'
    + '确定继续？');
  if (!ok) return;

  infoFilling = true;
  infoFillCancel = false;
  let filled = 0, skip = 0, fail = 0;
  const failNames = [];
  $('autofix-bar').style.display = 'flex';
  updateAutofixBar(0, list.length, 0, 0, 0, 0);
  toast('开始写入文件标签，进度看顶栏');

  for (let i = 0; i < list.length; i++) {
    if (infoFillCancel) break;
    const t = list[i];
    updateAutofixBar(i, list.length, filled, skip, fail);
    try {
      const cur = await mb.readFileTags(t.path);
      if (!cur || !cur.ok) { fail++; if (failNames.length < 3) failNames.push(t.title); continue; }
      const patch = {};
      ['title', 'artist', 'album'].forEach((f) => {
        const libV = String(t[f] || '').trim();
        if (!libV) return;                       // 曲库没值：不动文件
        if (f === 'album' && isBadAlbumName(libV)) return;  // 「未知专辑」这类占位值不写进文件
        if (String(cur[f] || '').trim() === libV) return;  // 已经一致：不用重写
        patch[f] = libV;
      });
      if (!Object.keys(patch).length) { skip++; continue; }
      const w = await mb.writeMusicMetadata(t.path, patch.title, patch.artist, patch.album);
      if (w && w.ok) filled++;
      else { fail++; if (failNames.length < 3) failNames.push(t.title); }
    } catch (e) {
      fail++;
      if (failNames.length < 3) failNames.push(t.title);
    }
  }

  updateAutofixBar(list.length, list.length, filled, skip, fail);
  let msg = (infoFillCancel ? '已取消' : '批量写入完成') + '：写入 ' + filled + ' 首，已一致跳过 ' + skip + ' 首，失败 ' + fail + ' 首';
  if (filled > 0) msg += '（资源管理器里按 F5 刷新即可看到）';
  if (fail > 0 && failNames.length) msg += '\n失败示例：' + failNames.join('、');
  toast(msg, fail > 0 ? 9000 : 6000);
  setTimeout(() => { if (!infoFilling && !autoFixing) $('autofix-bar').style.display = 'none'; }, 4000);
  infoFilling = false;
}

// ---------- 补全歌曲信息（歌名 / 歌手 / 专辑） ----------
// 思路：联网用「歌名 + 歌手」反查，平台返回的专辑只是"可能那张"。
// 收敛规则：本地曲库已经有这张专辑（去掉 (Deluxe)/(Live) 等注记后同名）就归到已有写法，
// 否则用平台候选里分数最高的那张。整个过程只改本地曲库，不碰音频文件。

let ciIdx = -1;
let ciTrack = null;
let ciData = null;
let infoFilling = false;
let infoFillCancel = false;

// 专辑名归一化：去掉括号注记与标点，用来判断"是不是同一张专辑"
function albumKeyOf(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/g, '')
    .replace(/[《》〈〉\s\u3000·・.,，、;；:：!！?？'"“”‘’\-—_~`|/\\+&×]/g, '');
}

function isBadAlbumName(name) {
  const s = String(name || '').trim();
  return !s || /^(未知专辑|未知|unknown|unknown album)$/i.test(s);
}

// 曲库里已有专辑名池：key -> 出现次数最多的写法（避免同一专辑出现两种名字）
function libraryAlbumPool() {
  const pool = new Map();
  for (const t of S.tracks) {
    if (isBadAlbumName(t.album)) continue;
    const k = albumKeyOf(t.album);
    if (!k) continue;
    const hit = pool.get(k);
    if (hit) hit.n++;
    else pool.set(k, { name: String(t.album).trim(), n: 1 });
  }
  return pool;
}

// 从补全结果里挑专辑名：库内已有写法优先 → 平台最高分候选
function pickAlbumFromResult(res, pool) {
  const best = (res && res.best) || {};
  const albums = (res && Array.isArray(res.albums)) ? res.albums : [];
  let name = best.album || (albums[0] && albums[0].name) || '';
  for (const a of albums) {
    const k = albumKeyOf(a.name);
    if (!k) continue;
    const hit = pool.get(k);
    if (hit) return { name: hit.name, fromPool: hit.name, candidate: a.name };
  }
  return { name, fromPool: '', candidate: name };
}

// 文本是否等价（忽略括号注记 / 标点 / 大小写）
function sameInfoText(a, b) {
  return albumKeyOf(a) === albumKeyOf(b);
}

function ciEl(field, kind) {
  return document.querySelector('[data-ci-' + kind + '="' + field + '"]');
}

function updateCiApplyState() {
  const any = Array.from(document.querySelectorAll('[data-ci-check]'))
    .some((c) => c.checked && !c.disabled);
  const btn = $('ci-apply');
  if (btn) btn.disabled = !any;
}

function closeCompleteInfoModal() {
  $('complete-info-modal').hidden = true;
  ciIdx = -1;
  ciTrack = null;
  ciData = null;
}

async function openCompleteInfoModal(idx) {
  const track = S.tracks[idx];
  if (!track) return;
  if (!window.mb || typeof mb.completeTrackInfo !== 'function') {
    toast('当前版本不支持补全信息，请更新软件');
    return;
  }
  ciIdx = idx;
  ciTrack = track;
  ciData = null;

  // 先把当前值铺上，联网期间窗口不是空白
  ['title', 'artist', 'album'].forEach((f) => {
    const curEl = ciEl(f, 'cur');
    const newEl = ciEl(f, 'new');
    const ck = ciEl(f, 'check');
    const v = String(track[f] || '').trim();
    curEl.textContent = v || '（空）';
    curEl.classList.toggle('empty', !v);
    newEl.value = '';
    newEl.classList.remove('changed');
    ck.checked = false;
    ck.disabled = true;
  });
  $('ci-status').className = 'ci-status';
  $('ci-status').textContent = '正在联网匹配…';
  $('ci-albums').hidden = true;
  $('ci-album-list').innerHTML = '';
  $('ci-note').textContent = '';
  $('ci-meta').textContent = '';
  $('ci-apply').disabled = true;
  showModal('complete-info-modal');

  const duration = (S.durations && S.durations.get(track.path)) || 0;
  let res = null;
  try {
    res = await mb.completeTrackInfo({
      title: track.title,
      artist: track.artist,
      album: track.album || '',
      duration
    });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  // 期间关了窗口或者列表重排换了歌 → 不再写回
  if (ciTrack !== track) return;

  if (!res || !res.ok) {
    $('ci-status').className = 'ci-status err';
    $('ci-status').textContent = '❌ ' + ((res && res.error) || '联网匹配失败');
    $('ci-note').textContent = '可以用右键「修改歌曲信息」手动填写。';
    return;
  }
  ciData = res;
  renderCompleteInfoResult(res);
}

function renderCompleteInfoResult(res) {
  const best = res.best || {};
  const pool = libraryAlbumPool();
  const albums = Array.isArray(res.albums) ? res.albums : [];
  const albumPick = pickAlbumFromResult(res, pool);

  const suggestion = {
    title: best.title || '',
    artist: best.artist || '',
    album: albumPick.name || ''
  };

  let changedCount = 0;
  ['title', 'artist', 'album'].forEach((f) => {
    const curEl = ciEl(f, 'cur');
    const newEl = ciEl(f, 'new');
    const ck = ciEl(f, 'check');
    const curVal = String((ciTrack && ciTrack[f]) || '').trim();
    newEl.value = suggestion[f] || '';
    const changed = !!suggestion[f] && !sameInfoText(curVal, suggestion[f]);
    newEl.classList.toggle('changed', changed);
    ck.disabled = !suggestion[f];
    ck.checked = changed;
    if (changed) changedCount++;
    curEl.classList.toggle('empty', !curVal);
  });

  // 专辑候选：同名专辑只留一条，标出来自哪个平台、库里是否已有
  const listEl = $('ci-album-list');
  listEl.innerHTML = '';
  const seen = new Set();
  const opts = albums.filter((a) => {
    const k = albumKeyOf(a.name);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (opts.length > 1) {
    $('ci-albums').hidden = false;
    const activeKey = albumKeyOf(albumPick.name);
    for (const a of opts) {
      const inPool = pool.get(albumKeyOf(a.name));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ci-album' + (albumKeyOf(a.name) === activeKey ? ' active' : '');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = inPool ? inPool.name : a.name;
      const srcSpan = document.createElement('span');
      srcSpan.className = 'ci-album-src';
      srcSpan.textContent = a.source === '网易云音乐' ? '网易' : 'QQ';
      btn.appendChild(nameSpan);
      btn.appendChild(srcSpan);
      btn.title = inPool ? '本地曲库里已有这张专辑' : (a.source || '');
      btn.addEventListener('click', () => {
        const inp = ciEl('album', 'new');
        const ck = ciEl('album', 'check');
        inp.value = inPool ? inPool.name : a.name;
        inp.classList.toggle('changed', !sameInfoText(ciTrack && ciTrack.album, inp.value));
        ck.disabled = false;
        ck.checked = true;
        listEl.querySelectorAll('.ci-album').forEach((x) => x.classList.toggle('active', x === btn));
        updateCiApplyState();
      });
      listEl.appendChild(btn);
    }
  } else {
    $('ci-albums').hidden = true;
  }

  const conf = Math.round((res.confidence || 0) * 100);
  $('ci-status').className = 'ci-status ok';
  $('ci-status').textContent = changedCount
    ? '✅ 匹配到 ' + changedCount + ' 项可以补全，勾选后点「应用」'
    : '✅ 当前信息与平台一致，无需修改（需要时可直接手改右侧输入框）';
  $('ci-meta').textContent = '来源 ' + (best.source || '—') + ' · 置信度 ' + conf + '%';
  $('ci-note').textContent = albumPick.fromPool
    ? '专辑已归到本地曲库已有的写法「' + albumPick.fromPool + '」，避免同一张专辑在专辑视图里被拆成两条。'
    : '只改软件里的曲库信息，不动音频文件。想把结果写进文件标签，用右键「写入文件标签」。';
  updateCiApplyState();
}

async function applyCompleteInfoChanges() {
  const track = ciTrack;
  if (!track) return;
  const apply = {};
  ['title', 'artist', 'album'].forEach((f) => {
    const ck = ciEl(f, 'check');
    const inp = ciEl(f, 'new');
    if (!ck || !inp || !ck.checked || ck.disabled) return;
    const v = String(inp.value || '').trim();
    if (!v) return;
    if (sameInfoText(track[f], v)) return;
    apply[f] = v;
  });
  const keys = Object.keys(apply);
  if (!keys.length) { toast('没有需要修改的项目'); return; }

  const wasCurrent = S.current >= 0 && S.tracks[S.current] === track;
  // 勾了「写入文件标签」才落盘：这一步会让资源管理器里的标题/艺术家/专辑也跟着变
  const chk = $('ci-write-file');
  const wantWrite = !!(chk && chk.checked) && !track.isPlaceholder
    && typeof mb.writeMusicMetadata === 'function';
  Object.assign(track, apply);
  // 注意：不写 S.settings.fixedTracks —— 那会让「自动修复」以后跳过这首歌，等于断掉写标签的机会
  saveConfig();
  renderList();
  if (wasCurrent) updateNowPlaying();
  closeCompleteInfoModal();

  const label = { title: '歌名', artist: '歌手', album: '专辑' };
  const summary = '已补全：' + keys.map((k) => label[k] + ' → ' + apply[k]).join('；');
  if (!wantWrite) { toast(summary + '（只改了曲库）', 5000); return; }
  toast('正在写入文件标签…');
  try {
    const w = await mb.writeMusicMetadata(track.path, track.title, track.artist, track.album);
    toast(summary + (w && w.ok ? '（已写入文件标签）' : '（写入失败，仅曲库生效）'), 6000);
  } catch (e) {
    toast(summary + '（写入出错：' + e.message + '）', 7000);
  }
}

// 三合一窗口：将歌曲歌手专辑名同步至源文件名。
// 范围：默认仅右键这一首，勾选「修改全部歌曲」后处理全库。
// 返回 { ok, scopeAll, fillAlbum, rename, writeTags, format }
let syncSourcesCallback = null;
let syncCounts = null;   // { all:{fill,rename,write}, one:{fill,rename,write,name}|null }
function renderSyncScope(initChecked) {
  const st = S.settings || {};
  const scopeAll = !!$('ss-scope-all').checked && !!syncCounts.one;
  const c = scopeAll ? syncCounts.all : (syncCounts.one || syncCounts.all);
  const oneName = syncCounts.one && syncCounts.one.name;
  const single = !scopeAll && !!syncCounts.one;
  const fillEl = $('ss-fill-album'), renameEl = $('ss-rename'), writeEl = $('ss-write-tags');
  // 描述：单曲用歌名，全部用数量
  $('ss-fill-desc').textContent = c.fill
    ? (single ? `联网匹配并补全《${oneName}》的专辑信息` : `联网匹配并补全 ${c.fill} 首缺专辑歌曲的曲库信息`)
    : (single ? '《' + oneName + '》的专辑信息已完整' : '曲库里没有缺专辑的歌曲');
  $('ss-rename-desc').textContent = c.rename
    ? (single ? `把《${oneName}》的文件名按所选顺序重命名，重名自动加 _1` : `把 ${c.rename} 首歌曲的文件名按所选顺序重命名，重名自动加 _1`)
    : (single ? '《' + oneName + '》信息不足，无法重命名' : '没有可用于重命名的歌曲');
  $('ss-write-desc').textContent = c.write
    ? (single ? `把《${oneName}》的歌名 / 歌手 / 专辑写进音频文件，资源管理器按 F5 可见` : `把曲库的歌名 / 歌手 / 专辑写进 ${c.write} 首音频文件，资源管理器按 F5 可见`)
    : (single ? '《' + oneName + '》没有可写入标签的信息' : '没有可写入标签的本地歌曲');
  // 无候选的项禁用、取消勾选；有候选项按记住的状态或当前状态显示
  const apply = (el, has, key) => {
    el.disabled = !has;
    if (!has) el.checked = false;
    else if (initChecked) el.checked = st[key] !== false;
  };
  apply(fillEl, !!c.fill, 'syncFillAlbum');
  apply(renameEl, !!c.rename, 'syncRename');
  apply(writeEl, !!c.write, 'syncWriteTags');
}
function showSyncSourcesModal(counts) {
  return new Promise((resolve) => {
    const st = S.settings || {};
    syncCounts = counts;
    const scopeEl = $('ss-scope-all'), scopeWrap = $('ss-scope-wrap');
    // 没有可用的单曲（异常入口）时，隐藏范围选项并强制全部
    if (!counts.one) {
      scopeWrap.style.display = 'none';
      scopeEl.checked = true;
    } else {
      scopeWrap.style.display = '';
      scopeEl.checked = st.syncScopeAll === true;  // 默认仅这一首
    }
    renderSyncScope(true);
    // 命名格式下拉：只建一次，默认选中上次的选择
    const sel = $('ss-format-select');
    if (!sel.options.length) {
      [['artist-title-album', '歌手 - 歌名 - 专辑'],
       ['title-artist-album', '歌名 - 歌手 - 专辑'],
       ['artist-album-title', '歌手 - 专辑 - 歌名']].forEach(([v, label]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o);
      });
    }
    sel.value = st.renameFormat || 'artist-title-album';
    syncSourcesCallback = resolve;
    showModal('sync-sources-modal');
  });
}
// 切换范围时只刷新描述/禁用/提示，保留用户本次已勾的选项
$('ss-scope-all').addEventListener('change', () => renderSyncScope(false));
function closeSyncSources(ok) {
  $('sync-sources-modal').hidden = true;
  if (syncSourcesCallback) {
    const cb = syncSourcesCallback; syncSourcesCallback = null;
    cb({
      ok: !!ok,
      scopeAll: !!$('ss-scope-all').checked && !!syncCounts.one,
      fillAlbum: !!$('ss-fill-album').checked && !$('ss-fill-album').disabled,
      rename: !!$('ss-rename').checked && !$('ss-rename').disabled,
      writeTags: !!$('ss-write-tags').checked && !$('ss-write-tags').disabled,
      format: $('ss-format-select').value
    });
  }
}
$('ss-apply').addEventListener('click', () => closeSyncSources(true));
document.querySelectorAll('[data-close="sync-sources"]').forEach((el) => {
  el.addEventListener('click', () => closeSyncSources(false));
});

// 三合一批量同步：①补缺专辑 → ②写文件标签 → ③按所选顺序同步文件名。
// 顺序很关键：写标签和改名都用「补完之后的最新曲库信息」，所以补专辑必须排在最前。
async function completeInfoBatch() {
  if (infoFilling || autoFixing) { toast('已有修复任务在进行，请稍候'); return; }
  if (!window.mb || typeof mb.completeTrackInfo !== 'function') {
    toast('当前版本不支持补全信息，请更新软件');
    return;
  }
  const canWrite = typeof mb.readFileTags === 'function' && typeof mb.writeMusicMetadata === 'function';
  const isReal = (t) => t && !t.isPlaceholder && !t.isMissing;
  // 一套候选的统计：补专辑（含占位）/ 改名（真实文件且能拼全名）/ 写标签（真实文件且有信息）
  const countOf = (arr) => {
    const locals = arr.filter(isReal);
    return {
      fill: arr.filter((t) => isBadAlbumName(t.album)).length,
      rename: locals.filter((t) => !!fullInfoNameOf(t)).length,
      write: canWrite ? locals.filter((t) => (t.title || t.artist || t.album)).length : 0
    };
  };
  const oneTrack = ctxTrackIdx >= 0 ? S.tracks[ctxTrackIdx] : null;
  const allCounts = countOf(S.tracks);
  const oneCounts = oneTrack ? countOf([oneTrack]) : null;
  if (oneCounts) oneCounts.name = oneTrack.title || '未知标题';
  if (!allCounts.fill && !allCounts.rename && !allCounts.write) {
    toast('库里没有可用于同步的歌曲');
    return;
  }

  const ans = await showSyncSourcesModal({ all: allCounts, one: oneCounts });
  if (!ans.ok) return;
  const renameFmt = ans.format || currentRenameFormat();
  const scopeAll = !!ans.scopeAll;
  // 记住三个勾选 + 命名格式 + 范围选择
  if (S.settings) {
    S.settings.syncFillAlbum = ans.fillAlbum;
    S.settings.syncRename = ans.rename;
    S.settings.syncWriteTags = ans.writeTags;
    S.settings.syncScopeAll = scopeAll;
    S.settings.renameFormat = renameFmt;
  }
  // 收敛本次处理集合：默认仅右键这一首，勾「修改全部歌曲」才用全库
  const workTracks = scopeAll ? S.tracks.slice() : (oneTrack ? [oneTrack] : []);
  const fillList = workTracks.filter((t) => isBadAlbumName(t.album));
  const localWork = workTracks.filter(isReal);
  const nameableCount = localWork.filter((t) => !!fullInfoNameOf(t)).length;
  const writeCount = canWrite ? localWork.filter((t) => (t.title || t.artist || t.album)).length : 0;
  const doFill = ans.fillAlbum && fillList.length > 0;
  const doWrite = ans.writeTags && writeCount > 0;
  const doRename = ans.rename && nameableCount > 0;
  if (!doFill && !doWrite && !doRename) { saveConfig(); toast('没有勾选任何同步项'); return; }
  const scopeLabel = scopeAll ? '全部歌曲' : '《' + (oneTrack.title || '未知标题') + '》';

  infoFilling = true;
  infoFillCancel = false;
  const pool = libraryAlbumPool();
  let filled = 0, skip = 0, fail = 0, renamed = 0, renameFail = 0, tagged = 0, tagFail = 0, step = 0;
  const total = (doFill ? fillList.length : 0) + (doWrite ? writeCount : 0) + (doRename ? nameableCount : 0);
  const okCount = () => filled + tagged + renamed;
  const failCount = () => fail + tagFail + renameFail;
  const tick = () => updateAutofixBar(step++, total, okCount(), skip, failCount());
  $('autofix-bar').style.display = 'flex';
  updateAutofixBar(0, total, 0, 0, 0, 0);
  toast('开始同步，进度看顶栏');

  // 阶段①：补全缺失专辑
  if (doFill) {
    for (let i = 0; i < fillList.length; i++) {
      if (infoFillCancel) break;
      const t = fillList[i];
      tick();
      try {
        const duration = (S.durations && S.durations.get(t.path)) || 0;
        const res = await mb.completeTrackInfo({ title: t.title, artist: t.artist, album: t.album || '', duration });
        const pick = res && res.ok ? pickAlbumFromResult(res, pool) : null;
        if (pick && pick.name && !sameInfoText(pick.name, t.album)) {
          t.album = pick.name;
          pool.set(albumKeyOf(pick.name), { name: pick.name, n: 1 });
          filled++;
        } else {
          skip++;
        }
      } catch (e) {
        fail++;
      }
      await new Promise((r) => setTimeout(r, 220));
    }
  }

  // 阶段②：写文件标签（以刚刚补全后的曲库信息为准，只写和文件不一致的字段）
  if (doWrite && !infoFillCancel) {
    const wt = workTracks.filter((t) => !t.isPlaceholder && !t.isMissing && (t.title || t.artist || t.album));
    for (let i = 0; i < wt.length; i++) {
      if (infoFillCancel) break;
      const t = wt[i];
      tick();
      try {
        const cur = await mb.readFileTags(t.path);
        if (!cur || !cur.ok) { tagFail++; continue; }
        const patch = {};
        ['title', 'artist', 'album'].forEach((f) => {
          const libV = String(t[f] || '').trim();
          if (!libV) return;                                    // 曲库没值：不动文件
          if (f === 'album' && isBadAlbumName(libV)) return;     // 占位专辑值不写进文件
          if (String(cur[f] || '').trim() === libV) return;      // 已一致：跳过
          patch[f] = libV;
        });
        if (!Object.keys(patch).length) { skip++; continue; }
        const w = await mb.writeMusicMetadata(t.path, patch.title, patch.artist, patch.album);
        if (w && w.ok) tagged++; else tagFail++;
      } catch (e) {
        tagFail++;
      }
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }
  }

  // 阶段③：按补全后的最终信息 + 用户选的顺序重命名（专辑可能是刚补上的，这里重新筛）
  if (doRename && !infoFillCancel) {
    const targets = workTracks.filter((t) => needFullInfoRename(t, renameFmt) && !t.isPlaceholder && !t.isMissing);
    let manifest = '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (let i = 0; i < targets.length; i++) {
      if (infoFillCancel) break;
      const t = targets[i];
      tick();
      const newName = fullInfoNameOf(t, renameFmt);
      if (!newName) { skip++; continue; }
      manifest += t.path + '\t→\t' + newName + '\r\n';
      try {
        if (await renameTrackFile(S.tracks.indexOf(t), true, newName, true)) renamed++;
        else renameFail++;
      } catch (e) {
        renameFail++;
      }
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }
    if (manifest && typeof mb.writeTextFile === 'function') {
      try {
        const dirs = await mb.getDefaultDirs();
        const base = String(dirs.userData || '').replace(/[\\/]+$/, '');
        const sep = base.includes('\\') ? '\\' : '/';
        await mb.writeTextFile(base + sep + '批量改名记录-' + stamp + '.txt',
          '原路径\t→\t目标文件名（实际重名会加 _N 后缀）\r\n' + manifest);
      } catch (e) {
        console.error('保存改名清单失败:', e);
      }
    }
    renderList();
    saveConfig();
    if (S.current >= 0) updateNowPlaying();
  }

  saveConfig();
  renderList();
  if (S.current >= 0) updateNowPlaying();
  updateAutofixBar(total, total, okCount(), skip, failCount());
  let msg = (infoFillCancel ? '已取消' : '同步完成') + '（' + scopeLabel + '）：';
  if (doFill) msg += '专辑补全 ' + filled + ' 首，';
  if (doWrite) msg += '标签写入 ' + tagged + ' 首，';
  if (doRename) msg += '文件改名 ' + renamed + ' 首，';
  msg += '跳过 ' + skip + ' 首，失败 ' + failCount() + ' 首';
  if (tagged > 0) msg += '（资源管理器按 F5 可见最新标签）';
  toast(msg, 7000);
  setTimeout(() => { if (!infoFilling && !autoFixing) $('autofix-bar').style.display = 'none'; }, 4000);
  infoFilling = false;
}

// 取消按钮：自动修复 / 批量补全共用一条进度条
(function bindFixCancel() {
  const btn = $('af-bar-cancel');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (infoFilling) infoFillCancel = true;
    if (autoFixing) autoFixCancel = true;
    toast('已请求取消，当前这首处理完就停');
  });
})();

// 弹窗内交互：勾选 → 应用按钮可用性；回车 = 应用
document.querySelectorAll('[data-close="complete-info"]').forEach((el) => {
  el.addEventListener('click', closeCompleteInfoModal);
});
document.querySelectorAll('[data-ci-check]').forEach((ck) => {
  ck.addEventListener('change', updateCiApplyState);
});
document.querySelectorAll('[data-ci-new]').forEach((inp) => {
  inp.addEventListener('input', () => {
    if (!ciTrack) return;
    const isAlbum = inp.dataset.ciNew === 'album';
    inp.classList.toggle('changed', !sameInfoText(ciTrack[inp.dataset.ciNew], inp.value));
    const ck = ciEl(inp.dataset.ciNew, 'check');
    if (ck) ck.checked = !!inp.value.trim();
    if (!isAlbum) return;
    updateCiApplyState();
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyCompleteInfoChanges(); }
  });
});
$('ci-apply').addEventListener('click', applyCompleteInfoChanges);

// 表头排序
document.querySelectorAll('#track-head span').forEach((el) => {
  el.dataset.origText = el.textContent;
  el.addEventListener('click', () => {
    // 点击 # 编号列：切换排序模式（随机/默认/倒置/QQ音乐/网易云）
    if (el.classList.contains('col-index')) {
      cycleOrderMode(el);
      return;
    }
    const key = el.dataset.sort;
    if (S.sortKey === key) S.sortDir = -S.sortDir;
    else { S.sortKey = key; S.sortDir = 1; }
    document.querySelectorAll('#track-head span').forEach((x) => {
      x.classList.remove('sorted');
      x.textContent = x.dataset.origText;
    });
    el.classList.add('sorted');
    el.textContent = el.dataset.origText + (S.sortDir > 0 ? ' ↑' : ' ↓');
    renderList();
    saveConfig();   // 表头点出来的排序同样要记住
  });
});

// ---------- 点击 # 切换排序模式 ----------
const ORDER_MODES = [
  { key: 'random', name: '随机顺序', color: '#ff6b3d' },
  { key: 'default', name: '默认顺序（1→最后）', color: '#4caf50' },
  { key: 'reverse', name: '倒置顺序（最后→1）', color: '#2196f3' },
  { key: 'qqmusic', name: 'QQ音乐歌单顺序', color: '#ff9800' },
  { key: 'netease', name: '网易云歌单顺序', color: '#e91e63' }
];
let currentOrderModeIndex = -1; // -1 表示未使用 # 切换过

function applyOrderMode(modeKey, indexEl) {
  const mode = ORDER_MODES.find(m => m.key === modeKey);
  if (!mode) return false;
  
  switch (modeKey) {
    case 'random':
      // 随机排序（Fisher-Yates 洗牌）
      S.tracks = [...S.tracks];
      for (let i = S.tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [S.tracks[i], S.tracks[j]] = [S.tracks[j], S.tracks[i]];
      }
      S.sortKey = 'shuffle';
      $('sort-label').textContent = '随机顺序';
      break;
    case 'default':
      // 默认顺序（1→最后）：按添加时间旧→新
      S.tracks = [...S.tracks].sort((a, b) => (a.addedTime || 0) - (b.addedTime || 0));
      S.sortKey = 'addedTime';
      S.sortDir = 1;
      $('sort-label').textContent = '添加时间（旧→新）';
      break;
    case 'reverse':
      // 倒置顺序（最后→1）：按添加时间新→旧
      S.tracks = [...S.tracks].sort((a, b) => (b.addedTime || 0) - (a.addedTime || 0));
      S.sortKey = 'addedTime';
      S.sortDir = -1;
      $('sort-label').textContent = '添加时间（新→旧）';
      break;
    case 'qqmusic':
    case 'netease':
      // 恢复导入的歌单顺序
      if (S.importedTrackOrder && S.importedTrackOrder.length > 0) {
        const pathToTrack = new Map();
        S.tracks.forEach(t => pathToTrack.set(t.path, t));
        const orderedTracks = [];
        const usedPaths = new Set();
        S.importedTrackOrder.forEach(p => {
          if (pathToTrack.has(p) && !usedPaths.has(p)) {
            orderedTracks.push(pathToTrack.get(p));
            usedPaths.add(p);
          }
        });
        // 新增的歌曲叠在顶部（与启动恢复一致：新歌排在更上面，不跟末尾）
        const extraTracks = [];
        S.tracks.forEach(t => {
          if (!usedPaths.has(t.path)) {
            extraTracks.push(t);
          }
        });
        S.tracks = [...extraTracks, ...orderedTracks];
        S.sortKey = 'qqmusic';
        const platformLabel = modeKey === 'netease' ? '网易云' : 'QQ音乐';
        $('sort-label').textContent = platformLabel + '歌单顺序';
      } else {
        toast('请先导入歌单顺序');
        return false;
      }
      break;
  }
  
  // 更新 # 列的样式
  if (indexEl) {
    indexEl.style.color = mode.color;
    indexEl.style.fontWeight = '700';
    indexEl.title = '当前：' + mode.name + '（点击切换）';
    indexEl.style.cursor = 'pointer';
    indexEl.style.transition = 'color 0.2s ease';
  }
  
  renderList();
  saveConfig();
  return true;
}

function cycleOrderMode(indexEl) {
  // 点击动画
  indexEl.style.transform = 'scale(0.8)';
  indexEl.style.transition = 'transform 0.15s ease, color 0.2s ease';
  setTimeout(() => { indexEl.style.transform = 'scale(1)'; }, 150);
  
  // 尝试切换到下一个模式
  let attempts = 0;
  while (attempts < ORDER_MODES.length) {
    currentOrderModeIndex = (currentOrderModeIndex + 1) % ORDER_MODES.length;
    const mode = ORDER_MODES[currentOrderModeIndex];
    const success = applyOrderMode(mode.key, indexEl);
    if (success !== false) {
      toast('已切换为：' + mode.name);
      return;
    }
    attempts++;
  }
  // 如果所有模式都失败（如没有导入歌单），回到随机模式
  currentOrderModeIndex = 0;
  applyOrderMode('random', indexEl);
  toast('已切换为：随机顺序');
}

// ---- 键盘快捷键 ----
document.addEventListener('keydown', (e) => {
  // ESC 键：关闭所有展开的菜单和弹窗
  if (e.key === 'Escape') {
    let closed = false;
    // 关闭排序菜单
    if (!$('sort-menu').hidden) { $('sort-menu').hidden = true; hideMenuOverlay(); closed = true; }
    // 关闭批处理菜单
    if (!$('batch-menu').hidden) { $('batch-menu').hidden = true; hideMenuOverlay(); closed = true; }
    // 关闭设置面板
    if (!$('settings-modal').hidden) { $('settings-modal').hidden = true; closed = true; }
    // 关闭歌词面板
    if (!$('lyrics-panel').hidden) { $('lyrics-panel').hidden = true; closed = true; }
    // 关闭输入对话框
    if (!$('input-modal').hidden) {
      $('input-modal').hidden = true;
      if (typeof inputCallback === 'function' && inputCallback) { inputCallback(null); inputCallback = null; }
      closed = true;
    }
    // 关闭确认弹窗
    if (!$('confirm-modal').hidden) { $('confirm-modal').hidden = true; closed = true; }
    // 关闭转换格式弹窗
    if (!$('convert-modal').hidden) { $('convert-modal').hidden = true; closed = true; }
    // 关闭右键菜单
    if (!$('context-menu').hidden) { $('context-menu').hidden = true; closed = true; }
    if (!$('batch-context-menu').hidden) { $('batch-context-menu').hidden = true; closed = true; }
    // 关闭批量删除弹窗
    if (!$('batch-delete-modal').hidden) { closeBatchDeleteModal(); closed = true; }
    // 关闭查重弹窗
    if (!$('dedupe-modal').hidden) { $('dedupe-modal').hidden = true; closed = true; }
    // 关闭均衡器弹窗
    if (!$('eq-modal').hidden) { $('eq-modal').hidden = true; closed = true; }
    // 如果有关闭任何菜单或弹窗，移除焦点避免光圈
    if (closed) {
      if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
      e.preventDefault();
      return;
    }
    // 没有任何弹窗被关掉时，ESC 顺手退出歌手/专辑筛选（避免筛选状态卡住出不来）
    if (S.filterField && !e.__pfEscHandled) {
      clearTrackFilter();
      e.preventDefault();
      return;
    }
    // 多选状态也用 ESC 收起（清回无选中）
    if (S.multiSel.size > 1 && !e.__pfEscHandled) {
      clearMultiSel();
      e.preventDefault();
      return;
    }
    // 如果焦点在输入框或文本框，移除焦点
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      e.target.blur();
      e.preventDefault();
      return;
    }
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    return;
  }
  // Ctrl+A：全选当前视图（多选后可右键批量操作）
  if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault();
    S.multiSel.clear();
    S.view.forEach(t => S.multiSel.add(t));
    const last = S.view[S.view.length - 1];
    if (last) {
      S.selectedIdx = S.tracks.indexOf(last);
      S.selAnchor = last;
    }
    refreshSelectionClasses();
    renderStats();
    toast('已选中 ' + S.multiSel.size + ' 首');
    return;
  }
  switch (e.key) {
    case ' ': e.preventDefault(); $('btn-play').click(); break;
    case 'ArrowRight': audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); break;
    case 'ArrowLeft': audio.currentTime = Math.max(0, audio.currentTime - 5); break;
    case 'ArrowUp': e.preventDefault(); S.volume = Math.min(1, S.volume + 0.05); S.muted = false; applyVolume(); saveConfig(); break;
    case 'ArrowDown': e.preventDefault(); S.volume = Math.max(0, S.volume - 0.05); applyVolume(); saveConfig(); break;
    case 'n': case 'N': nextTrack(false); break;
    case 'p': case 'P': prevTrack(); break;
  }
});

// ---- 鼠标侧键：后退 / 前进（对齐资源管理器）----
// Chromium 里 X1（通常在拇指下侧）= button 3，X2（上侧）= button 4。
// 捕获阶段拦下来，避免 Electron 自己把侧键当成浏览器历史导航。
document.addEventListener('mousedown', (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.target && e.target.blur && e.target.tagName === 'INPUT') e.target.blur();
  // 海报（全屏播放详情）页开着时：后退键直接关闭海报页回到歌单（2026-11-19）；
  // 前进键仍留给列表导航历史。
  if (pf && pf.open) {
    if (e.button === 3) closePlayerFull();
    return;
  }
  if (navModalOpen()) return;
  if (e.button === 3) navBack();
  else navForward();
}, true);
document.addEventListener('auxclick', (e) => {
  if (e.button === 3 || e.button === 4) { e.preventDefault(); e.stopPropagation(); }
}, true);

// ---- 拖拽导入 ----
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragging');
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer.files || [])];
  const paths = files.map((f) => mb.pathOf(f)).filter(Boolean);
  if (paths.length) {
    // 询问是否包含子文件夹（默认不包含）
    const recursive = await showConfirm('添加音乐文件夹', `已拖入 ${paths.length} 个文件/文件夹。\n\n是否包含子文件夹中的音乐？\n（默认仅扫描当前文件夹，点击"确定"则包含子文件夹）`);
    addPaths(paths, recursive);
  }
});

// ---- 保存进度的心跳（优化：10秒一次，减少IPC调用） ----
setInterval(() => { if (S.playing) saveConfig(); }, 10000);
window.addEventListener('beforeunload', () => {
  // 整份快照（曾经的局部写法会把歌单/收藏/排序等键从 config.json 里抹掉）
  flushConfigNow();
});

// ---- 扫描进度 ----
mb.onScanProgress((d) => {
  $('scan-text').textContent = '扫描中… ' + d.done + ' / ' + d.total;
  const bar = $('scan-bar');
  if (bar && d.total > 0) bar.style.width = (d.done / d.total * 100) + '%';
});

// ---- 初始化：先渲染骨架（同步），再异步拉配置恢复 ----
renderModeBtn();
renderFolders();
renderList();
applyVolume();

(async function init() {
  try {
    const cfg = await mb.getConfig() || {};
    // 便携版换到新的版本文件夹后，首次启动会自动继承旧版本数据 —— 告诉用户一声
    try {
      const inh = await mb.getInheritInfo?.();
      if (inh && inh.from) {
        setTimeout(() => toast(`已继承 ${inh.from} 的设置与缓存（${inh.files} 个文件）`), 1500);
      }
    } catch (e) { /* 提示失败不影响主流程 */ }
    if (typeof cfg.volume === 'number') S.volume = cfg.volume;
    if (typeof cfg.muted === 'boolean') S.muted = cfg.muted;
    if (typeof cfg.audioOutputDevice === 'string') S.audioOutputDevice = cfg.audioOutputDevice;
    if (cfg.mode && MODE_ICONS[cfg.mode]) S.mode = cfg.mode;
    // 恢复收藏
    if (Array.isArray(cfg.favorites)) {
      S.favorites = new Set(cfg.favorites);
    }
    // 恢复歌单
    if (Array.isArray(cfg.playlists)) {
      S.playlists = cfg.playlists;
    }
    // 恢复回收站
    if (Array.isArray(cfg.recycleBin)) {
      S.recycleBin = cfg.recycleBin;
    }
    // 恢复置顶的音频设备
    if (Array.isArray(cfg.pinnedAudioDevices)) {
      S.pinnedAudioDevices = cfg.pinnedAudioDevices;
    }
    // 恢复导入的歌单顺序（独立于当前排序模式，确保切换排序后导入顺序不丢失）
    if (Array.isArray(cfg.importedTracks) && cfg.importedTracks.length > 0) {
      S.importedTrackOrder = cfg.importedTracks.map(t => t.path);
      S.importedPlatform = cfg.importedPlatform || 'qqmusic';
      S.importedPlaylistName = cfg.importedPlaylistName || '';
    }
    // 恢复导入歌单历史
    if (Array.isArray(cfg.importedPlaylistHistory)) {
      S.importedPlaylistHistory = cfg.importedPlaylistHistory;
    }
    // 恢复歌单来源链接（一键刷新的依据）
    if (cfg.importedPlaylistSource && cfg.importedPlaylistSource.type) {
      S.importedPlaylistSource = cfg.importedPlaylistSource;
    }
    // 恢复当前排序模式
    if (cfg.currentSortKey) {
      S.sortKey = cfg.currentSortKey;
      S.sortDir = cfg.currentSortDir || 1;
    } else {
      S.sortKey = 'addedTime';
      S.sortDir = -1;
    }
    updateSortLabel();
    // 恢复设置
    if (cfg.settings && typeof cfg.settings === 'object') {
      Object.assign(S.settings, cfg.settings);
    }
    // 一次性迁移（2026-11-20 滑块拆分）：旧版 posterBgOpacity 同时管氛围层和表面透明度，
    // 新版拆成 posterIntensity（氛围浓度）+ uiTransparency（界面透明度）。只认磁盘里
    // 存在旧键且没有新键的配置：界面透明度=旧值，氛围强度维持默认 100（旧版氛围层全显）。
    // 迁移完删掉旧键并落盘，避免下次启动重复迁移、覆盖用户已调整过的新值。
    if (cfg.settings && cfg.settings.posterBgOpacity != null && cfg.settings.uiTransparency == null) {
      const legacyVal = Number(cfg.settings.posterBgOpacity);
      if (isFinite(legacyVal)) S.settings.uiTransparency = Math.max(0, Math.min(1, legacyVal));
      delete S.settings.posterBgOpacity;
      saveConfig();
      // 迁移改变了两把滑块的值：外观浮窗立即按新值重摆，别等下次打开才刷新
      syncBgModeUI();
    }
    // 一次性合并（2026-11-22 两滑块并一）：海报氛围度 = 原界面透明度，
    // 氛围层浓度跟随它（旧配置里两者不一致时以 uiTransparency 为准）
    if (S.settings.posterIntensity !== S.settings.uiTransparency) {
      S.settings.posterIntensity = S.settings.uiTransparency == null ? 1
        : Math.max(0, Math.min(1, Number(S.settings.uiTransparency)));
      saveConfig();
    }
    // 一次性迁移：逐字歌词改为默认关（用户偏好整行一起点亮）。只翻一次，之后用户自己开关都算数
    if (S.settings.wordLyrics === true && S.settings.lyricWordOptOut !== true) {
      S.settings.wordLyrics = false;
      S.settings.lyricWordOptOut = true;
      saveConfig();
    }
    // 恢复全屏歌词显示偏好（原文/翻译/音译组合 + 行间距）
    if (cfg.lyricDisplay && typeof cfg.lyricDisplay === 'object') {
      // 全屏只有「原文 / 翻译」两列（音译按钮已按需求移除），旧的 roma 偏好在这里清掉
      const savedModes = Array.isArray(cfg.lyricDisplay.modes)
        ? cfg.lyricDisplay.modes.filter(m => (m === 'orig' || m === 'trans'))
        : [];
      if (savedModes.length) pf.lyricModes = savedModes;
      if (typeof cfg.lyricDisplay.spacingSingle === 'number') pf.spacingSingle = cfg.lyricDisplay.spacingSingle;
      if (typeof cfg.lyricDisplay.spacingDouble === 'number') pf.spacingDouble = cfg.lyricDisplay.spacingDouble;
    }
    syncPFLyricModeButtons();
    // 恢复播放队列（先只保留字符串路径，等歌曲扫描完再剔除失效项）
    if (Array.isArray(cfg.queue)) {
      S.queue = cfg.queue.filter(p => typeof p === 'string' && p);
      updateQueueBadge();
    }
    // 迁移：确保自动保存封面和歌词是开启的（用户明确希望自动保存）
    if (!S.settings.saveCover || !S.settings.saveLyrics) {
      S.settings.saveCover = true;
      S.settings.saveLyrics = true;
      saveConfig();
      console.log('已自动开启封面和歌词保存功能');
    }
    applyVolume();
    renderModeBtn();
    renderSidebar();
    renderRecycleBin();
    // 主题强调色 / 底色 / 歌词字号 / 歌词偏移 / 关闭行为
    applyAccent(S.settings.accent || '#ff6b3d');
    applyBgTheme(S.settings.bgTheme || '');
    applyLyricScale();
    applyLyricOffset();
    restoreDesktopLyric();
    syncPFWordToggle();
    applyCloseBehavior();
    // 海报底色模式：按配置决定氛围层显隐（当前曲目封面晚一点由 updateNowPlaying/applyCover 补上）
    applyPosterBgSetting();
    // 系统媒体控制：媒体键 / 系统媒体浮层
    initMediaSession();
    updateMediaSessionMeta();
    syncPlayerStateToShell();
    // 恢复音频输出设备
    restoreAudioDevice();
    // 恢复均衡器设置（上次开着就先把滤波链搭好）
    initEqFromSettings();
    
    // 优化启动速度：将耗时操作延迟到UI渲染完成后执行
    setTimeout(async () => {
      // 扫描本地已保存的封面和歌词缓存
      try {
        if (window.mb && window.mb.scanLocalCache) {
          // 2026-11-20 封面/歌词缓存合并为单一 cache 目录（按扩展名区分）。
          // 旧版分开设置的 coverPath/lyricsPath 作为迁移源传给主进程：
          // 缓存目录还没内容时自动把旧目录文件并进去，迁移完这两个字段就废了。
          const cacheDir = S.settings.cachePath || '';
          const legacyDirs = [S.settings.coverPath, S.settings.lyricsPath].filter(Boolean);
          const cache = await window.mb.scanLocalCache(cacheDir, cacheDir, legacyDirs);
          // 建立 key -> 文件路径 的映射
          cache.covers.forEach(f => S.localCoverFiles.set(f.key, f.path));
          cache.lyrics.forEach(f => S.localLyricsFiles.set(f.key, f.path));
          console.log(`本地缓存扫描完成：封面 ${cache.covers.length} 个，歌词 ${cache.lyrics.length} 个`);
        }
      } catch (e) {
        console.error('扫描本地缓存失败:', e);
      }

      if (Array.isArray(cfg.folders) && cfg.folders.length) {
        // 启动装载：全库初载不是"用户添加新歌"，禁用叠顶（否则扫描顺序会冲掉保存的歌单顺序）
        isRestoringOrder = true;
        // 去掉已不存在的目录（从配置恢复的文件夹保持递归扫描，兼容旧数据）
        await addPaths(cfg.folders, true);
        // 清洗：移除 undefined / 无 path 的损坏条目
        S.tracks = S.tracks.filter(t => t && t.path);
        // 给没有 addedTime 的歌曲添加默认值（按当前顺序倒序，越早添加的时间越小）
        const now = Date.now();
        S.tracks.forEach((t, i) => {
          if (!t.addedTime) t.addedTime = now - (S.tracks.length - i);
        });
        // 恢复缺失歌曲条目（文件消失但保留供对照找回；文件已找回/同首歌已有真实文件的跳过）
        if (Array.isArray(cfg.missingTracks)) {
          cfg.missingTracks.forEach(saved => {
            if (!saved || !saved.path) return;
            if (S.tracks.some(t => t.path === saved.path)) return; // 文件已找回，用扫描结果
            // 同首歌（歌名+宽松歌手）已有真实文件：并入该文件，不再单独保留缺失条目（避免同首歌两条）
            if (S.tracks.some(r => !r.isPlaceholder && sameSongMeta(r, saved))) return;
            S.tracks.push(makeMissingTrack(saved));
          });
        }
        // 如果有保存的导入歌单顺序，先恢复导入的顺序（包括占位/缺失歌曲），再按当前排序模式调整
        if (Array.isArray(cfg.importedTracks) && cfg.importedTracks.length > 0) {
          const pathToTrack = new Map();
          S.tracks.forEach(t => pathToTrack.set(t.path, t));
          const orderedTracks = [];
          const usedPaths = new Set();
          // 同首歌合并：占位/缺失条目若曲库里已有同名同歌手（宽松）的真实文件，
          // 用真实文件占住歌单位置、丢弃重复条目（旧数据里"缺失+已有"并存的自动收敛）
          const findRealFor = (saved) => {
            // 先精确、再宽松：宽松这一步能把「봄눈 (春雪) vs 봄눈 (Spring Snow)」这类
            // 只是注释写法不同的同曲认出来，避免旧数据里继续留着"缺失"占位
            let loose = null;
            for (const [, t] of pathToTrack) {
              if (t.isPlaceholder) continue;
              if (sameSongMeta(t, saved)) return t;
              if (!loose && sameSongLoose(t, saved)) loose = t;
            }
            return loose;
          };
          // 按保存的导入顺序排列
          cfg.importedTracks.forEach(saved => {
            if (!saved || !saved.path) return;
            if (usedPaths.has(saved.path)) return; // 同首歌的真实文件已顶替过该条目
            if (pathToTrack.has(saved.path)) {
              // 本地文件还在/已找回：用扫描结果中的对象（确保文件信息最新）
              orderedTracks.push(pathToTrack.get(saved.path));
              usedPaths.add(saved.path);
              return;
            }
            // 占位/缺失条目：曲库已有同首歌的真实文件时并入（真实文件占住歌单位置）
            const real = findRealFor(saved);
            if (real) {
              if (!usedPaths.has(real.path)) {
                orderedTracks.push(real);
                usedPaths.add(real.path);
              }
              return; // 同曲已有真实文件：丢弃占位条目（否则同首歌会同时出现"缺失"和可播两条）
            }
            if (saved.isPlaceholder && !saved.isMissing) {
              // QQ 占位歌曲：直接保留（重新创建占位对象）
              const placeholder = {
                path: saved.path,
                title: saved.title || '未知歌曲',
                artist: saved.artist || '未知歌手',
                album: saved.album || '',
                duration: saved.duration || 0,
                addedTime: saved.addedTime || Date.now(),
                root: '__placeholder__',
                isPlaceholder: true,
                qqmusicId: saved.qqmusicId || null,
                qqmusicMid: saved.qqmusicMid || null,
                cover: null
              };
              orderedTracks.push(placeholder);
              usedPaths.add(saved.path);
            } else {
              // 本地歌曲文件已不存在：转为缺失条目保留（供对照找回），不再丢弃
              orderedTracks.push(makeMissingTrack(saved));
              usedPaths.add(saved.path);
            }
          });
          // 新增的歌曲（不在保存顺序中）叠在顶部——用户期望新歌排在更上面，而不是跟在末尾
          const extraTracks = [];
          S.tracks.forEach(t => {
            if (!usedPaths.has(t.path)) {
              extraTracks.push(t);
            }
          });
          S.tracks = [...extraTracks, ...orderedTracks];
          // 同步导入顺序为 [新歌, 保存顺序]：启动扫描走 addPaths 时叠顶逻辑会改写
          // importedTrackOrder，这里必须拉回正确顺序，否则保存后持久化的顺序就乱了
          S.importedTrackOrder = S.tracks.map(t => t.path);
          const placeholderCount = S.tracks.filter(t => t.isPlaceholder).length;
          console.log('已恢复导入歌单顺序，共 ' + S.tracks.length + ' 首（含 ' + placeholderCount + ' 首占位）');
          
          // 按当前排序模式调整（如果当前不是 qqmusic 模式）
          if (S.sortKey === 'addedTime') {
            // 注意括号：原写法 `a - b * dir` 是 a-(b*dir)，dir=-1 时排序完全错误
            S.tracks = [...S.tracks].sort((a, b) => ((a.addedTime || 0) - (b.addedTime || 0)) * (S.sortDir || 1));
          } else if (S.sortKey === 'shuffle') {
            // 随机排序
            S.tracks = [...S.tracks];
            for (let i = S.tracks.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [S.tracks[i], S.tracks[j]] = [S.tracks[j], S.tracks[i]];
            }
          } else if (S.sortKey && S.sortKey !== 'qqmusic') {
            // 其他排序模式（标题、歌手、专辑等）
            S.tracks = [...S.tracks].sort((a, b) => {
              let x = a[S.sortKey] || '';
              let y = b[S.sortKey] || '';
              if (typeof x === 'string') { x = x.toLowerCase(); y = String(y).toLowerCase(); }
              return (x > y ? 1 : x < y ? -1 : 0) * (S.sortDir || 1);
            });
          }
          // qqmusic 模式保持导入顺序
        }
        // 恢复上次播放位置（不自动出声，等用户点播放；缺失/占位条目不恢复）
        if (cfg.lastTrack) {
          const idx = S.tracks.findIndex((t) => t.path === cfg.lastTrack);
          if (idx >= 0 && !S.tracks[idx].isPlaceholder && !S.tracks[idx].isMissing) {
            S.current = idx;
            const t = S.tracks[idx];
            audio.src = fileURL(t.path);
            const pos = cfg.lastPos || 0;
            audio.addEventListener('loadedmetadata', () => { audio.currentTime = pos; }, { once: true });
            updateNowPlaying();
            renderList();
            // 这首歌自己的歌词偏移
            loadLyricOffsetForTrack();
            // 启动时也要自动补封面/歌词：以前只在 play() 里拉，导致「打开软件后默认选中的歌」
            // 左下角缩略图、托盘小窗海报、歌词面板全是空的，必须手动播放一次才出来。
            if (S.settings.autoCover && !t.cover) fetchAndApplyCover(t, true);
            if (S.settings.autoLyrics) fetchAndApplyLyrics(t, true);
          }
        }
        // 队列里剔除已不存在的歌曲，并刷新队列面板/角标
        if (S.queue.length) {
          S.queue = S.queue.filter(p => S.tracks.some(t => t.path === p));
        }
        renderQueuePanel();
        // 启动装载结束，恢复叠顶逻辑可用（之后用户添加的新歌才允许叠顶）
        isRestoringOrder = false;
        // 恢复的缺失条目 / 导入顺序必须补一次渲染：上面 renderList 只在 lastTrack 分支调用，
        // 无 lastTrack 时列表会停留在扫描快照，缺失条目不上屏
        renderList();
      }
    }, 100); // 延迟100ms，让UI先渲染完成
  } catch (e) {
    isRestoringOrder = false;
    window.__errs.push('init: ' + e);
  }

  // 立即显示所有错误（红色顶部条）
  if (window.__errs.length) showErrors();

  // 错误面板：初始化异常时给用户可见反馈
  setTimeout(() => {
    if (window.__errs.length) {
      const p = $('error-panel');
      if (p) {
        p.hidden = false;
        p.textContent = '初始化出现 ' + window.__errs.length + ' 个错误：\n' + window.__errs.slice(0, 5).join('\n');
      }
    }
  }, 4000);

  // 软件启动时不再自动检测电台：用户不打开电台页就完全不发这 60 个流请求
  // （检测时机挪到 switchView('radio') 的首次进入，见那边）
})();

// ================= 桌面悬浮歌词 / 任务栏歌词 =================
// 数据流：主窗口渲染进程 →(lyric-data)→ 主进程 → 独立透明置顶窗口。
// 主进程不解析歌词、不算时间轴，只做转发，两个窗口永远不会不同步。
let lastLyricPayload = '';
// 悬浮 / 任务栏歌词的外观选项（主进程那份是唯一真源，这里只做镜像）
let desktopLyricStyle = {
  words: true, translation: true, nextLine: true,
  color: '#ffffff', accentWord: false, bg: 'none', align: 'center', shadow: true,
  opacity: 1, layout: 'dual',
  sungColor: '', sungAlpha: 1,        // 已唱颜色/透明度：留空=跟随文字颜色
  unsungColor: '', unsungAlpha: 0.62  // 未唱颜色/透明度：62% = 老版硬编码值
};

// 布局只有单行 / 双行两档。流水（marquee）已下线：旧配置里存着的 marquee
// 一律回落到双行，否则会读到一堆已经不存在的样式分支。
function normalizeLyricLayout(v) {
  return v === 'single' ? 'single' : 'dual';
}

function lyricLineText(line) {
  if (!line) return '';
  if (S.lyricsMode === 'trans') return line.ttext || line.text || '';
  return line.text || '';
}

// 没有逐字时间轴时现算一份：把「本行 → 下一行」的时长按 token 均分。
// 真实逐字数据只有网易云 yrc / 酷狗 krc 的一部分歌才有，其余全靠这份兜底，
// 否则桌面歌词开了「逐字点亮」却整行一起亮，用户会以为开关坏了。
function desktopQuickWords(line, nextLine) {
  const text = line && line.text;
  if (!text || !text.trim()) return null;
  const start = Number(line.time) || 0;
  const end = (nextLine && nextLine.time > start) ? nextLine.time : start + 4;
  const tokens = text.match(/[A-Za-z0-9'\u2019\u2018\u002d]+|\s+|[\s\S]/g) || [];
  if (tokens.length === 0) return null;
  const step = Math.max(0.06, (end - start) / tokens.length);
  const out = [];
  tokens.forEach((tk, i) => {
    if (!tk.trim()) return;          // 空白不占时间片
    out.push({ t: start + i * step, d: step, w: tk });
  });
  return out.length ? out : null;
}

function syncDesktopLyric() {
  if (!window.mb || typeof mb.sendLyric !== 'function') return;
  if ((S.settings.desktopLyric || 'off') === 'off') return;
  const idx = lastLyricActiveIdx;
  const line = idx >= 0 ? S.lyrics[idx] : null;
  const nextLine = idx >= 0 ? S.lyrics[idx + 1] : null;
  const t = S.current >= 0 ? S.tracks[S.current] : null;
  const radio = S.currentRadio;
  const title = radio
    ? (radio.cn ? radio.name + '（' + radio.cn + '）' : radio.name)
    : (t ? (t.title || '') : '');
  // 逐字数据：有真实时间轴就用真的，没有就均分兜底
  let words = null;
  if (line && desktopLyricStyle.words) {
    if (line.words && line.words.length) words = line.words;
    else words = desktopQuickWords(line, nextLine);
  }
  const payload = {
    title,
    artist: radio ? '网络电台' : (t ? (t.artist || '') : ''),
    current: lyricLineText(line),
    translation: (line && line.ttext && S.lyricsMode === 'orig') ? line.ttext : '',
    next: lyricLineText(nextLine),
    playing: !!S.playing,
    // 逐字进度靠这两个：当前播放位置 + 这首歌的歌词偏移
    time: isFinite(audio.currentTime) ? audio.currentTime : 0,
    offset: lyricOffsetSec(),
    words,
    accent: S.settings.accent || '#ff6b3d',
    mode: S.settings.desktopLyric || 'off',
    // 当前是第几句：双行布局靠它的奇偶决定「正在唱的那行放上槽还是下槽」。
    // 只有这样换句时两行才都留在原地，不会整排往上滚。
    lineIndex: idx
  };
  // 去重：time 量化到 0.25s（4Hz）。歌词窗口自己做本地时钟外推，
  // 所以 4Hz 的推送看起来也是连续的，不会把主进程 IPC 淹掉。
  const key = JSON.stringify(Object.assign({}, payload, {
    time: Math.round(payload.time * 4) / 4
  }));
  if (key === lastLyricPayload) return;
  lastLyricPayload = key;
  mb.sendLyric(payload);
}

function refreshDesktopLyricUI() {
  const mode = S.settings.desktopLyric || 'off';
  const btn = $('btn-desktop-lyric');
  if (btn) btn.classList.toggle('active', mode !== 'off');
  document.querySelectorAll('#desktop-lyric-menu .dlm-modes button[data-mode]').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });
  refreshLyricScaleUI();
  refreshLyricOffsetUI();
  // 打开菜单时同步副行/逐字勾选：悬浮窗右键改过的值要从主进程镜像回来
  if (typeof syncLyricStyleUI === 'function') syncLyricStyleUI();
}

// ---- 悬浮 / 任务栏歌词的大小 & 透明度：两套参数互不影响 ----
// 存储：S.settings.lyricScales / lyricOpacities 各是一个 {desktop, taskbar}。
// 「当前模式」= S.settings.desktopLyric（off 时按 desktop 处理，关闭状态下
// 先调好参数、再打开桌面歌词也是合理操作）。
// 名字带 DL 前缀：全屏歌词那套用着 LYRIC_SCALE_MIN/MAX（0.8~1.5），别撞车
const DL_SCALE_MIN = 0.3, DL_SCALE_MAX = 1.8, DL_OPACITY_MIN = 0.1;
function lyricMetricKey(mode) {
  return (mode || S.settings.desktopLyric) === 'taskbar' ? 'taskbar' : 'desktop';
}
function clampLyricScaleNum(v) {
  const n = Number(v);
  return Math.max(DL_SCALE_MIN, Math.min(DL_SCALE_MAX, isFinite(n) ? n : 1));
}
function clampLyricOpacityNum(v) {
  const n = Number(v);
  return Math.max(DL_OPACITY_MIN, Math.min(1, isFinite(n) ? n : 1));
}
// 任务栏歌词水平平移（2026-11-21）：S.settings.lyricTaskbarOffset，DIP px 可负。
// 只作用在任务栏模式的「自动居中」分支；用户手动拖过的位置优先于偏移。
function clampLyricOffsetNum(v) {
  const n = Number(v);
  return Math.max(-600, Math.min(600, isFinite(n) ? Math.round(n) : 0));
}
function lyricTaskbarOffsetValue() {
  return clampLyricOffsetNum(S.settings.lyricTaskbarOffset);
}
function lyricMetricMap(name, fallback) {
  const cur = S.settings[name];
  const ok = cur && typeof cur === 'object' ? cur : {};
  return {
    desktop: ok.desktop != null ? ok.desktop : fallback.desktop,
    taskbar: ok.taskbar != null ? ok.taskbar : fallback.taskbar
  };
}
function lyricScaleValue(mode) {
  const k = lyricMetricKey(mode);
  return clampLyricScaleNum(lyricMetricMap('lyricScales', { desktop: 0.7, taskbar: 1.4 })[k]);
}
function lyricOpacityValue(mode) {
  const k = lyricMetricKey(mode);
  return clampLyricOpacityNum(lyricMetricMap('lyricOpacities', { desktop: 0.5, taskbar: 0.5 })[k]);
}
function refreshLyricScaleUI() {
  const pct = Math.round(lyricScaleValue() * 100);
  const range = $('dlm-scale');
  if (range) range.value = String(pct);
  const label = $('dlm-scale-val');
  if (label) label.textContent = pct + '%';
  // 标题带上模式名：否则用户以为滑块坏了（切到任务栏还是同一个数才是 bug）
  const head = $('dlm-scale-label');
  if (head) head.textContent = '歌词大小 · ' + (lyricMetricKey() === 'taskbar' ? '任务栏' : '桌面');
}
let lyricScaleSaveTimer = null;
function setLyricScale(scale, skipSave, mode) {
  const k = lyricMetricKey(mode);
  const v = clampLyricScaleNum(Math.round(clampLyricScaleNum(scale) * 20) / 20);
  S.settings.lyricScales = lyricMetricMap('lyricScales', { desktop: 0.7, taskbar: 1.4 });
  S.settings.lyricScales[k] = v;
  refreshLyricScaleUI();
  // 只有改的是「当前模式」才回头推给主进程：推别的模式的数会顺着主进程的
  // 「当前模式」写到错误的那一格里（桌面/任务栏互相污染）。
  if (k === lyricMetricKey() && window.mb && typeof mb.setLyricScale === 'function') mb.setLyricScale(v);
  if (!skipSave) {
    // 拖滑块时别每帧写一次配置文件
    clearTimeout(lyricScaleSaveTimer);
    lyricScaleSaveTimer = setTimeout(() => { saveConfig(); }, 260);
  }
}
let lyricOpacitySaveTimer = null;
function setLyricOpacity(op, skipSave, mode) {
  const k = lyricMetricKey(mode);
  const v = Math.round(clampLyricOpacityNum(op) * 100) / 100;
  S.settings.lyricOpacities = lyricMetricMap('lyricOpacities', { desktop: 0.5, taskbar: 0.5 });
  S.settings.lyricOpacities[k] = v;
  desktopLyricStyle.opacity = v;
  S.settings.lyricStyle = Object.assign({}, desktopLyricStyle);
  if (window.mb && typeof mb.sendLyricStyle === 'function') mb.sendLyricStyle({ opacity: v });
  syncLyricStyleUI();
  if (!skipSave) {
    clearTimeout(lyricOpacitySaveTimer);
    lyricOpacitySaveTimer = setTimeout(() => { saveConfig(); }, 260);
  }
}
let lyricOffsetSaveTimer = null;
function setLyricOffset(px, skipSave) {
  const v = clampLyricOffsetNum(px);
  S.settings.lyricTaskbarOffset = v;
  const slider = $('dlm-offset');
  const label = $('dlm-offset-val');
  if (slider && document.activeElement !== slider) slider.value = String(v);
  if (label) label.textContent = (v > 0 ? '+' : '') + v + 'px';
  // 只有任务栏模式才实时推给主进程（桌面模式该值闲置，等切回任务栏时由 metrics 带过去）
  if (lyricMetricKey() === 'taskbar' && window.mb && typeof mb.setLyricOffset === 'function') {
    // reset=true：用户在主动调，清掉之前手动拖过的位置，让「自动居中+偏移」重新生效
    mb.setLyricOffset(v, true);
  }
  if (!skipSave) {
    clearTimeout(lyricOffsetSaveTimer);
    lyricOffsetSaveTimer = setTimeout(() => { saveConfig(); }, 260);
  }
}
// 切模式 / 启动时：把「两套」参数整份推给主进程（主进程按当前模式挑一份用）
// 注意别再单独补一发 setLyricScale：主进程那一刻的模式可能还没切过来（还是 off），
// 会把任务栏的字号写进桌面那一格里。
function applyLyricMetricsForMode() {
  const op = lyricOpacityValue();
  desktopLyricStyle.opacity = op;
  if (window.mb) {
    if (typeof mb.setLyricMetrics === 'function') {
      mb.setLyricMetrics({
        scales: lyricMetricMap('lyricScales', { desktop: 0.7, taskbar: 1.4 }),
        opacities: lyricMetricMap('lyricOpacities', { desktop: 0.5, taskbar: 0.5 }),
        taskbarOffset: lyricTaskbarOffsetValue()
      });
    }
    // 不再单独发 sendLyricStyle({opacity})：主进程此刻的模式可能还是旧的，
    // 会把当前模式那份透明度写到另一格里。metrics 里已经带了两个值，
    // 模式切换后主进程自己会按新模式取一份推给歌词窗口。
  }
  refreshLyricScaleUI();
  syncLyricStyleUI();
}

function setDesktopLyricMode(mode) {
  mode = (mode === 'desktop' || mode === 'taskbar') ? mode : 'off';
  const prev = S.settings.desktopLyric;
  S.settings.desktopLyric = mode;
  // 关掉时记住关之前是哪种模式：小窗歌词键「再点一下开回来」用
  if (prev && prev !== 'off') S.settings.desktopLyricLast = prev;
  // 换模式 = 换一套字号/透明度：先把目标模式那套推过去，再建窗口
  applyLyricMetricsForMode();
  saveConfig();
  if (window.mb && typeof mb.setDesktopLyricMode === 'function') mb.setDesktopLyricMode(mode);
  refreshDesktopLyricUI();
  lastLyricPayload = '';
  syncDesktopLyric();
  reportPlayerState();   // 小窗歌词键的激活态跟着刷新
  toast(({ off: '已关闭桌面歌词', desktop: '已开启桌面悬浮歌词', taskbar: '已开启任务栏歌词' })[mode]);
  // 第一次切到任务栏歌词：告诉用户能拖、能右键，否则窗口条太窄根本发现不了
  if (mode === 'taskbar' && prev !== 'taskbar' && !S.settings.lyricTaskbarHinted) {
    S.settings.lyricTaskbarHinted = true;
    saveConfig();
    setTimeout(() => toast('任务栏歌词可拖动换位置，右键可调字号 / 逐字 / 颜色'), 1400);
  }
}

function restoreDesktopLyric() {
  const mode = S.settings.desktopLyric || 'off';
  refreshDesktopLyricUI();
  // 鼠标穿透是「主进程记状态 + 本窗口记配置」双份：启动时先把配置里的值推过去，
  // 否则重启后会回到主进程的默认值，用户上次取消的勾选白点了。
  if (window.mb && typeof mb.setLyricClickThrough === 'function') {
    const ct = S.settings.lyricClickThrough !== false;
    if ($('dlm-lock')) $('dlm-lock').checked = ct;
    mb.setLyricClickThrough(ct);
  }
  // 字号/透明度：桌面与任务栏各一套，这里把「两套」整份推过去，主进程按模式取用
  applyLyricMetricsForMode();
  if (mode !== 'off' && window.mb && typeof mb.setDesktopLyricMode === 'function') {
    mb.setDesktopLyricMode(mode);
  }
}

// 浮层统一定位：贴着按钮右下角，越界自动翻到上方
function placeFloatMenu(menu, btn) {
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let left = r.right - w;
  let top = r.bottom + 8;
  if (left < 8) left = 8;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

// ---------- 顶栏「衣服」按钮：外观配色独立浮层 ----------
$('btn-theme').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('theme-popover');
  const opening = pop.hidden;
  $('settings-modal').hidden = true;
  $('desktop-lyric-menu').hidden = true;
  // 互斥：批处理菜单开着就收掉（连它那层点击遮罩一起），别两个浮层叠一起
  if (!$('batch-menu').hidden) { $('batch-menu').hidden = true; hideMenuOverlay(); }
  if (!opening) { pop.hidden = true; return; }
  syncAccentSwatches();
  syncBgSwatches();
  syncBgModeUI();
  placeFloatMenu(pop, $('btn-theme'));
});

// ---------- 桌面歌词入口（页脚「歌词」按钮右边） ----------
$('btn-desktop-lyric').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('desktop-lyric-menu');
  const opening = menu.hidden;
  $('theme-popover').hidden = true;
  if (!$('batch-menu').hidden) { $('batch-menu').hidden = true; hideMenuOverlay(); }
  if (!opening) { menu.hidden = true; return; }
  // 菜单浮在右下角，和歌词面板 / 播放列表抽屉抢同一片地方：
  // 开它之前先把那两个收起来，不然三个浮层叠一起谁也点不到。
  closeLyricsPanel();
  closeQueuePanel();
  // 一次点击就出歌词：当前关着的时候直接开任务栏模式。
  // 桌面悬浮歌词会盖在壁纸上、还可能挡住别的窗口，作为「点一下就有」的默认太重了。
  if ((S.settings.desktopLyric || 'off') === 'off') {
    setDesktopLyricMode('taskbar');
  }
  refreshDesktopLyricUI();
  placeFloatMenu(menu, $('btn-desktop-lyric'));
});

// 模式三档：点一下立刻切换，菜单保持打开（方便接着调字号/颜色）
document.querySelectorAll('#desktop-lyric-menu .dlm-modes button[data-mode]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    setDesktopLyricMode(el.dataset.mode);
  });
});

if ($('dlm-scale')) {
  $('dlm-scale').addEventListener('input', (e) => setLyricScale(Number(e.target.value) / 100));
  // 拖动时不要被「点外面关闭浮层」误判
  $('dlm-scale').addEventListener('click', (e) => e.stopPropagation());
}

if ($('dlm-lock')) {
  $('dlm-lock').addEventListener('change', (e) => {
    S.settings.lyricClickThrough = !!e.target.checked;
    saveConfig();   // 记住用户的选择：默认开穿透，但用户关了就得一直是关
    if (window.mb && typeof mb.setLyricClickThrough === 'function') {
      mb.setLyricClickThrough(e.target.checked);
    }
  });
}

// ---------- 悬浮歌词的外观选项 ----------
// 主进程那份是唯一真源；主窗口菜单和悬浮窗右键菜单都写它，两边永远一致。
function syncLyricStyleUI() {
  const w = $('dlm-words');
  if (w) w.checked = desktopLyricStyle.words !== false;
  const t = $('dlm-trans');
  if (t) t.checked = desktopLyricStyle.translation !== false;
  // 布局 / 背景：分段按钮高亮
  const layout = normalizeLyricLayout(desktopLyricStyle.layout);
  document.querySelectorAll('#dlm-layout button').forEach(b => {
    b.classList.toggle('active', b.dataset.layout === layout);
  });
  const bg = desktopLyricStyle.bg || 'none';
  document.querySelectorAll('#dlm-bg button').forEach(b => {
    b.classList.toggle('active', b.dataset.bg === bg);
  });
  // 文字透明度：按模式独立存（桌面 / 任务栏各一份），UI 只显示当前模式那份
  const op = Math.round(clampLyricOpacityNum(lyricOpacityValue()) * 100);
  if ($('dlm-opacity')) {
    $('dlm-opacity').value = op;
    $('dlm-opacity-val').textContent = op + '%';
  }
  const opHead = $('dlm-opacity-label');
  if (opHead) opHead.textContent = '文字透明度 · ' + (lyricMetricKey() === 'taskbar' ? '任务栏' : '桌面');
  // 已唱/未唱颜色与透明度（2026-11-20）：色板高亮 + 自定义圈 + 滑块位置
  // （总「文字颜色」已从设置 UI 下线，color 字段仅作旧配置回退，不再有 UI 同步）
  const clA = (v, d) => Math.round(Math.max(0.1, Math.min(1, isFinite(Number(v)) ? Number(v) : d)) * 100);
  const syncLyricColorGroup = (groupId, customId, val) => {
    const v = String(val || '').toLowerCase();
    let isCustom = true;
    const group = $(groupId);
    if (group) group.querySelectorAll('button[data-color]').forEach(b => {
      const on = String(b.dataset.color).toLowerCase() === v;
      b.classList.toggle('active', on);
      if (on) isCustom = false;
    });
    const cust = $(customId);
    if (cust) {
      if (/^#[0-9a-f]{6}$/.test(v)) cust.value = v;
      if (cust.parentElement) cust.parentElement.classList.toggle('custom-on', isCustom);
    }
  };
  syncLyricColorGroup('dlm-sung-colors', 'dlm-sung-color-custom', desktopLyricStyle.sungColor);
  syncLyricColorGroup('dlm-unsung-colors', 'dlm-unsung-color-custom', desktopLyricStyle.unsungColor);
  if ($('dlm-sung-alpha')) {
    $('dlm-sung-alpha').value = clA(desktopLyricStyle.sungAlpha, 1);
    $('dlm-sung-alpha-val').textContent = clA(desktopLyricStyle.sungAlpha, 1) + '%';
  }
  if ($('dlm-unsung-alpha')) {
    $('dlm-unsung-alpha').value = clA(desktopLyricStyle.unsungAlpha, 0.62);
    $('dlm-unsung-alpha-val').textContent = clA(desktopLyricStyle.unsungAlpha, 0.62) + '%';
  }
}
let lyricStyleSaveTimer = null;
function pushLyricStyle(patch) {
  if (patch && 'layout' in patch) patch = Object.assign({}, patch, { layout: normalizeLyricLayout(patch.layout) });
  desktopLyricStyle = Object.assign(desktopLyricStyle, patch);
  // 旧配置残留的 bgOpacity 不再写回，配置里只留真正生效的字段
  delete desktopLyricStyle.bgOpacity;
  S.settings.lyricStyle = Object.assign({}, desktopLyricStyle);
  if (window.mb && typeof mb.sendLyricStyle === 'function') mb.sendLyricStyle(patch);
  syncLyricStyleUI();
  // 逐字/翻译会改变 payload 结构，必须让去重缓存失效重发一次
  if ('words' in patch || 'translation' in patch) {
    lastLyricPayload = '';
    syncDesktopLyric();
  }
  // 滑块连续拖动会触发几十次 input，配置里有 1300+ 首歌，不能每次都落盘
  clearTimeout(lyricStyleSaveTimer);
  lyricStyleSaveTimer = setTimeout(() => { saveConfig(); }, 400);
}
if ($('dlm-words')) {
  $('dlm-words').addEventListener('change', (e) => pushLyricStyle({ words: e.target.checked }));
}
if ($('dlm-trans')) {
  $('dlm-trans').addEventListener('change', (e) => pushLyricStyle({ translation: e.target.checked }));
}
// 布局分段：单行 / 双行 / 流水
document.querySelectorAll('#dlm-layout button').forEach(b => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    pushLyricStyle({ layout: b.dataset.layout });
    lastLyricPayload = '';   // 布局变了副行内容要重算
    syncDesktopLyric();
  });
});
// 背景分段：透明 / 磨砂 / 深色
document.querySelectorAll('#dlm-bg button').forEach(b => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    pushLyricStyle({ bg: b.dataset.bg });
  });
});
if ($('dlm-opacity')) {
  $('dlm-opacity').addEventListener('input', (e) => {
    setLyricOpacity(Number(e.target.value) / 100);
  });
  $('dlm-opacity').addEventListener('click', (e) => e.stopPropagation());
}
// 水平平移滑块（仅任务栏模式显示；拖动实时生效，260ms 防抖落盘）
if ($('dlm-offset')) {
  $('dlm-offset').addEventListener('input', (e) => setLyricOffset(Number(e.target.value)));
  $('dlm-offset').addEventListener('click', (e) => e.stopPropagation());
}
function refreshLyricOffsetUI() {
  const row = $('dlm-offset-row');
  if (!row) return;
  // 桌面模式没有「贴任务栏」的概念（桌面直接拖位置），整行隐藏
  const taskbar = lyricMetricKey() === 'taskbar';
  row.style.display = taskbar ? '' : 'none';
  if (!taskbar) return;
  const v = lyricTaskbarOffsetValue();
  const slider = $('dlm-offset');
  const label = $('dlm-offset-val');
  if (slider && document.activeElement !== slider) slider.value = String(v);
  if (label) label.textContent = (v > 0 ? '+' : '') + v + 'px';
}
// 背景透明度那一档已下线：只留「文字透明度」，底板用固定值（见 desktop-lyric.html）
// ---------- 歌词颜色预设（已唱/未唱共用一份，右键可删，自定义取色自动入库） ----------
const LYRIC_PRESET_DEFAULTS = ['#ffffff', '#ffe9c9', '#ffd200'];
function lyricColorPresets() {
  const v = S.settings.lyricColorPresets;
  if (!Array.isArray(v)) { S.settings.lyricColorPresets = [...LYRIC_PRESET_DEFAULTS]; return S.settings.lyricColorPresets; }
  return v;
}
// 动态渲染预设色块到已唱/未唱两组；「跟随主题色」与自定义取色是固定尾部元素
function renderLyricPresets() {
  const list = lyricColorPresets();
  const groups = [['dlm-sung-colors', 'sungColor'], ['dlm-unsung-colors', 'unsungColor']];
  groups.forEach(([gid, field]) => {
    const group = $(gid);
    if (!group) return;
    group.querySelectorAll('button[data-preset]').forEach(b => b.remove());
    const anchor = group.querySelector('button[data-color="accent"]');
    list.forEach((hex) => {
      const b = document.createElement('button');
      b.dataset.color = hex;
      b.dataset.preset = '1';
      b.style.background = hex;
      b.title = hex + '（右键删除该预设）';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        pushLyricStyle({ [field]: hex });
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const i = list.indexOf(hex);
        if (i >= 0) {
          list.splice(i, 1);
          saveConfig();
          renderLyricPresets();
          syncLyricStyleUI();
          toast('已删除预设 ' + hex);
        }
      });
      if (anchor) group.insertBefore(b, anchor); else group.appendChild(b);
    });
  });
}
function addLyricPreset(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex || '')) return;
  const list = lyricColorPresets();
  const low = hex.toLowerCase();
  if (!list.some(c => String(c).toLowerCase() === low)) {
    list.push(low);
    saveConfig();
    renderLyricPresets();
    syncLyricStyleUI();
  }
}
// 已唱/未唱颜色与透明度（2026-11-20）：泛化绑定。
// 预设色块由 renderLyricPresets 动态绑定（增删后重建），这里只绑静态的
// 「跟随主题色」块 + 自定义取色器（取色确认后自动加入预设列表）。
function bindLyricColorGroup(groupId, customId, field) {
  const group = $(groupId);
  if (group) {
    const accentBtn = group.querySelector('button[data-color="accent"]');
    if (accentBtn) accentBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pushLyricStyle({ [field]: 'accent' });
    });
  }
  const cust = $(customId);
  if (cust) {
    cust.addEventListener('input', (e) => pushLyricStyle({ [field]: e.target.value }));
    cust.addEventListener('change', (e) => addLyricPreset(e.target.value));
    cust.addEventListener('click', (e) => e.stopPropagation());
  }
}
bindLyricColorGroup('dlm-sung-colors', 'dlm-sung-color-custom', 'sungColor');
bindLyricColorGroup('dlm-unsung-colors', 'dlm-unsung-color-custom', 'unsungColor');
if ($('dlm-sung-alpha')) {
  $('dlm-sung-alpha').addEventListener('input', (e) => pushLyricStyle({ sungAlpha: Number(e.target.value) / 100 }));
  $('dlm-sung-alpha').addEventListener('click', (e) => e.stopPropagation());
}
if ($('dlm-unsung-alpha')) {
  $('dlm-unsung-alpha').addEventListener('input', (e) => pushLyricStyle({ unsungAlpha: Number(e.target.value) / 100 }));
  $('dlm-unsung-alpha').addEventListener('click', (e) => e.stopPropagation());
}
// 启动时把本地存的样式推给主进程，并拉一次主进程的现值（窗口已开过时以它为准）
if (S.settings.lyricStyle && typeof S.settings.lyricStyle === 'object') {
  // 旧的 opacity 是「桌面+任务栏共用一份」，现在改成按模式各存一份，
  // 老字段直接丢掉，别让它把新迁移出来的值带偏
  const legacyStyle = Object.assign({}, S.settings.lyricStyle);
  delete legacyStyle.opacity;
  desktopLyricStyle = Object.assign(desktopLyricStyle, legacyStyle);
  // 迁移：总「文字颜色」已从 UI 下线（2026-11-20），改由已唱/未唱颜色接管。
  // 老配置里 sungColor/unsungColor 都留空且 color 是非默认值时，把它抄进两处，
  // 保证老用户的视觉和迁移前完全一致（否则会回落成白色）。
  const lg = desktopLyricStyle;
  const sungEmpty = !lg.sungColor || lg.sungColor === '';
  const unsungEmpty = !lg.unsungColor || lg.unsungColor === '';
  if (sungEmpty && unsungEmpty && lg.color && String(lg.color).toLowerCase() !== '#ffffff') {
    lg.sungColor = String(lg.color);
    lg.unsungColor = String(lg.color);
    S.settings.lyricStyle = Object.assign({}, lg);
    saveConfig();
  }
}
// 颜色预设色块是动态渲染的（可在 UI 里增删），启动先铺好再同步选中态
renderLyricPresets();
// 字号 / 透明度迁移：老配置里只有一个 lyricScale / 一个 opacity，
// 读不到新结构就直接落到默认值（桌面 70%、任务栏 140%，透明度都 30%）
S.settings.lyricScales = {
  desktop: clampLyricScaleNum(lyricMetricMap('lyricScales', { desktop: 0.7, taskbar: 1.4 }).desktop),
  taskbar: clampLyricScaleNum(lyricMetricMap('lyricScales', { desktop: 0.7, taskbar: 1.4 }).taskbar)
};
S.settings.lyricOpacities = {
  desktop: clampLyricOpacityNum(lyricMetricMap('lyricOpacities', { desktop: 0.5, taskbar: 0.5 }).desktop),
  taskbar: clampLyricOpacityNum(lyricMetricMap('lyricOpacities', { desktop: 0.5, taskbar: 0.5 }).taskbar)
};
// 生效的透明度 = 当前模式那一份（主进程也只认这一份）
desktopLyricStyle.opacity = lyricOpacityValue();
// 老配置里可能还存着 layout:'marquee' 和 bgOpacity，进内存前先洗一遍
desktopLyricStyle.layout = normalizeLyricLayout(desktopLyricStyle.layout);
delete desktopLyricStyle.bgOpacity;
S.settings.lyricStyle = Object.assign({}, desktopLyricStyle);
// 尺寸/透明度：两套一起推（主进程按当前模式挑一份），再推一次当前生效值
applyLyricMetricsForMode();
if (window.mb && typeof mb.lyricGetStyle === 'function') {
  mb.lyricGetStyle().then(st => {
    if (!st) return;
    const merged = Object.assign({}, st);
    delete merged.opacity;      // 透明度以按模式存的那份为准
    desktopLyricStyle = Object.assign(desktopLyricStyle, merged);
    desktopLyricStyle.opacity = lyricOpacityValue();
    syncLyricStyleUI();
  }).catch(() => {});
}
syncLyricStyleUI();

// 点击别处关掉浮层（浮层家族统一规则）——必须挂**捕获阶段**：大量自绘控件
// （搜索栏、歌曲行、播放键等）在冒泡阶段 stopPropagation，冒泡监听收不到那些
// 点击，浮层就"点别处不缩回"；捕获监听先于一切 stopPropagation 执行，无死角。
const POPOVER_IDS = ['theme-popover', 'desktop-lyric-menu', 'settings-modal', 'batch-menu', 'sort-menu'];
// 右键菜单家族（fixed 定位、z-index 2600 统一层级，见 style.css）
const RIGHT_MENU_IDS = ['context-menu', 'batch-context-menu', 'placeholder-ctx-menu', 'album-online-menu', 'radio-context-menu', 'recycle-context-menu', 'online-track-menu', 'folder-ctx-menu'];
// 互斥总闸：收起所有浮层 + 右键菜单 + 动态歌单二级菜单。
// 任何"打开新浮层/新菜单"的入口都先调它，杜绝两类历史 bug：
// ① 右键菜单叠在外观/设置浮层上（右键是 contextmenu 事件，不触发左键捕获关闭）；
// ② 两个右键菜单同时开着互相叠。
function closeAllFloatMenus() {
  POPOVER_IDS.forEach((id) => { const el = $(id); if (el) el.hidden = true; });
  RIGHT_MENU_IDS.forEach((id) => { const el = $(id); if (el) el.hidden = true; });
  if (typeof playlistMenuEl !== 'undefined' && playlistMenuEl) { playlistMenuEl.remove(); playlistMenuEl = null; }
  if (typeof hideMenuOverlay === 'function') hideMenuOverlay();
}
// 任一浮层开着 → body.popover-open：顶栏从拖拽区临时变可点击（见 style.css 注释），
// 否则点顶栏空白条的点击被拖拽吞掉，浮层永远收不回。全关后自动恢复原生拖拽。
function syncPopoverOpenClass() {
  const anyOpen = POPOVER_IDS.some((id) => { const el = $(id); return el && !el.hidden; });
  document.body.classList.toggle('popover-open', anyOpen);
}
const popoverObserver = new MutationObserver(syncPopoverOpenClass);
POPOVER_IDS.forEach((id) => { const el = $(id); if (el) popoverObserver.observe(el, { attributes: true, attributeFilter: ['hidden'] }); });
syncPopoverOpenClass();
document.addEventListener('click', (e) => {
  const tp = $('theme-popover');
  if (tp && !tp.hidden && !e.target.closest('#theme-popover') && !e.target.closest('#btn-theme')) tp.hidden = true;
  const dm = $('desktop-lyric-menu');
  if (dm && !dm.hidden && !e.target.closest('#desktop-lyric-menu') && !e.target.closest('#btn-desktop-lyric')) dm.hidden = true;
  const sp = $('settings-modal');
  if (sp && !sp.hidden && !e.target.closest('#settings-modal') && !e.target.closest('#btn-settings')) sp.hidden = true;
  const bm = $('batch-menu');
  if (bm && !bm.hidden && !e.target.closest('#batch-menu') && !e.target.closest('#btn-batch')) {
    bm.hidden = true;
    hideMenuOverlay();
  }
  const sm = $('sort-menu');
  if (sm && !sm.hidden && !e.target.closest('#sort-menu') && !e.target.closest('#btn-sort')) sm.hidden = true;
  // 右键菜单家族：点在任意菜单/浮层之外一律收起（捕获阶段，stopPropagation 拦不住）
  if (!e.target.closest('.context-menu, .ctx-menu')) {
    RIGHT_MENU_IDS.forEach((id) => { const m = $(id); if (m && !m.hidden) m.hidden = true; });
    if (playlistMenuEl) { playlistMenuEl.remove(); playlistMenuEl = null; }
  }
}, true);

// 悬浮窗被用户点 × 关掉时，主进程回推状态，避免按钮一直亮着
if (window.mb && typeof mb.onLyricWindowState === 'function') {
  mb.onLyricWindowState((st) => {
    if (!st) return;
    if (st.closed) {
      S.settings.desktopLyric = 'off';
      saveConfig();
      refreshDesktopLyricUI();
    }
    // 悬浮窗上直接切了模式，主窗口的设置和按钮状态要跟上
    if (st.mode === 'desktop' || st.mode === 'taskbar') {
      S.settings.desktopLyric = st.mode;
      saveConfig();
      // 目标模式那套字号/透明度立刻顶上来（两个滑块数值要跟着变）
      applyLyricMetricsForMode();
      refreshDesktopLyricUI();
      lastLyricPayload = '';
      syncDesktopLyric();
    }
    if (typeof st.clickThrough === 'boolean' && $('dlm-lock')) $('dlm-lock').checked = st.clickThrough;
    // 悬浮窗工具条的 A±：只有它自己那个模式的字号会变。
    // 模式对不上就丢掉：主进程此刻的模式可能已经换过了，照着写会串到另一格。
    if (typeof st.scale === 'number' && lyricMetricKey(st.mode) === lyricMetricKey()) {
      setLyricScale(st.scale, true, st.mode);
    }
    // 悬浮窗右键菜单改了外观：主窗口菜单的勾选状态跟着走
    if (st.style && typeof st.style === 'object') {
      const patch = Object.assign({}, st.style);
      if ('opacity' in patch) {
        // styleMode 是「这份值属于哪个模式」，不是切模式指令
        const k = lyricMetricKey(st.styleMode || st.mode);
        const v = clampLyricOpacityNum(patch.opacity);
        S.settings.lyricOpacities = lyricMetricMap('lyricOpacities', { desktop: 0.5, taskbar: 0.5 });
        S.settings.lyricOpacities[k] = v;
        // 只有改的是当前模式，才更新「生效值」；另一模式的值先存着
        if (k === lyricMetricKey()) patch.opacity = v; else delete patch.opacity;
      }
      desktopLyricStyle = Object.assign(desktopLyricStyle, patch);
      S.settings.lyricStyle = Object.assign({}, desktopLyricStyle);
      syncLyricStyleUI();
      saveConfig();
      lastLyricPayload = '';
      syncDesktopLyric();
    }
  });
}

// 供自检使用
Object.defineProperty(window, '__tracks', { get: () => S.tracks });

// 窗口控制按钮（无边框窗口）
$('win-min').addEventListener('click', () => { if (mb.minimize) mb.minimize(); });
$('win-max').addEventListener('click', () => {
  if (mb.toggleMaximize) mb.toggleMaximize();
  // 切换最大化按钮图标和标题
  setTimeout(async () => {
    if (mb.isMaximized) {
      const max = await mb.isMaximized();
      $('win-max').title = max ? '还原' : '最大化';
      const svg = $('win-max').querySelector('svg');
      if (max) {
        svg.innerHTML = '<path d="M3.5 8.5V3.5h5M5 5.5h5v5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>';
      } else {
        svg.innerHTML = '<rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.2"/>';
      }
    }
  }, 100);
});
$('win-close').addEventListener('click', () => { if (mb.closeWindow) mb.closeWindow(); });
