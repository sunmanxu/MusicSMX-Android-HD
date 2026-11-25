'use strict';
/**
 * MusicSMX 安卓桥（相当于 Electron 的 preload.js）
 *
 * 铁律：这里只做三件事 —— ① 重造 window.mb 契约；② 把 WebView 拿不到的媒体/系统能力接过来；
 * ③ 收口安卓与桌面的差异（隐藏窗口控制、桌面歌词、托盘类开关）。
 * app.js 的业务逻辑一行都不改。
 */
(function () {
  const IS_ANDROID = true;
  const NATIVE_PLUGIN = 'MusicBridge';

  // ---------------- 原生调用 ----------------

  // 原生注入有竞态：native-bridge.js 可能比页面脚本晚一点，所有调用统一等它就绪（最多 10 秒）
  let bridgeReadyPromise = null;
  function whenBridgeReady() {
    if (!bridgeReadyPromise) {
      bridgeReadyPromise = new Promise(function (resolve, reject) {
        let tries = 0;
        (function tick() {
          const cap = window.Capacitor;
          if (cap && typeof cap.nativePromise === 'function') return resolve(cap);
          if (cap && cap.Plugins && cap.Plugins[NATIVE_PLUGIN]) return resolve(cap);
          if (++tries > 100) return reject(new Error('Capacitor bridge timeout'));
          setTimeout(tick, 100);
        })();
      });
    }
    return bridgeReadyPromise;
  }

  function nativeCall(method, args) {
    return whenBridgeReady().then(function (cap) {
      if (typeof cap.nativePromise === 'function') {
        return cap.nativePromise(NATIVE_PLUGIN, method, args || {});
      }
      return cap.Plugins[NATIVE_PLUGIN][method](args || {});
    });
  }

  // ---------------- 媒体流地址（file:///虚拟路径 -> 本地回环 HTTP） ----------------

  const MEDIA = { base: '', token: '', ready: false };

  function b64url(str) {
    // 先把 UTF-8 字符串转成 latin1 再用 btoa，避免非 ASCII 直接炸
    const utf8 = unescape(encodeURIComponent(str));
    return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** app.js 里 fileURL(p) = 'file:///' + encodeURI(p)，这里逆向还原出原始虚拟路径 */
  function pathFromFileURL(url) {
    try {
      let raw = url.slice('file:///'.length);      // 保留路径开头的 '/'
      let p = decodeURIComponent(raw);
      if (p.indexOf('//') === 0) p = p.replace(/^\/+/, '/');
      return p;
    } catch (e) {
      return null;
    }
  }

  function mediaUrlForPath(path) {
    if (!MEDIA.base || !path) return null;
    return MEDIA.base + '/a/' + b64url(path) + '?k=' + MEDIA.token;
  }

  // 只在 <audio>/<video> 的 src 赋值处换地址：app.js 里所有播放路径都经 fileURL() 转一次，
  // 这是唯一必经的收口点，不需要改任何业务代码。
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      enumerable: srcDesc.enumerable,
      get() { return srcDesc.get.call(this); },
      set(v) {
        let out = v;
        try {
          if (typeof v === 'string' && v.indexOf('file:///') === 0) {
            const p = pathFromFileURL(v);
            const m = p && mediaUrlForPath(p);
            if (m) out = m;
          }
        } catch (e) { /* 换地址失败就按原值走，让播放器自己报错 */ }
        srcDesc.set.call(this, out);
      }
    });
  }

  // ---------------- 系统媒体会话（通知栏 / 锁屏 / 耳机线控） ----------------

  const mediaHandlers = {};
  const lastMedia = { title: '', artist: '', cover: '' };
  let lastSentCover = '';
  let mediaTimer = null;
  let lastNativePush = 0;

  const fakeSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, fn) {
      mediaHandlers[action] = fn;
    },
    setPositionState(st) {
      if (st) fakeSession._pos = st;
    },
    setCameraActive() {},
    setMicrophoneActive() {},
    _pos: null
  };

  try {
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      get() { return fakeSession; },
      set() { /* app.js 只读，忽略写入 */ }
    });
  } catch (e) { /* 定义失败就用原生 navigator 的实现 */ }

  // app.js 会 new MediaMetadata({...}) 并赋给 mediaSession.metadata —— 这里捕获后推给原生
  window.MediaMetadata = function MediaMetadata(init) {
    init = init || {};
    this.title = init.title || '';
    this.artist = init.artist || '';
    this.album = init.album || '';
    this.artwork = init.artwork || [];
  };

  Object.defineProperty(fakeSession, 'metadata', {
    configurable: true,
    get() { return fakeSession._metadata || null; },
    set(v) {
      fakeSession._metadata = v;
      if (v) {
        lastMedia.title = v.title || '';
        lastMedia.artist = v.artist || '';
        // 封面只在变化时传（dataURL 可能接近 900KB，每次都传会拖慢桥）
        let cover = '';
        try {
          if (v.artwork && v.artwork[0] && typeof v.artwork[0].src === 'string'
            && v.artwork[0].src.indexOf('data:image') === 0) cover = v.artwork[0].src;
        } catch (e) {}
        lastMedia.cover = cover;
        pushMediaState(true);
      }
    }
  });

  function audioEl() {
    return document.getElementById('audio') || document.querySelector('audio');
  }

  /** 歌词文件里的「作词：/作曲：/编曲：」这类信息行不是歌词本身，不该出现在歌词条上 */
  function isLyricMeta(s) {
    return /^(作词|作曲|编曲|制作人|制作|监制|出品|录音|混音|母带|演唱|原唱|词|曲|策划|统筹|发行|翻译|校对)\s*[：:]/i
      .test(String(s || '').trim());
  }

  /**
   * 自己算"当前在唱哪一句"。
   * app.js 的顶层 const/let（S、audio、lyricOffsetSec）在同一份全局词法作用域里，
   * 桥是另一段经典脚本，可以直接读到；不用等播放页打开（那边的高亮只在 pf.open 时跑）。
   */
  function currentLyric() {
    try {
      if (!S || !S.lyrics || !S.lyrics.length) return { now: '', next: '' };
      const a = audioEl();
      const t = (a && isFinite(a.currentTime)) ? a.currentTime : 0;
      const off = (typeof lyricOffsetSec === 'function') ? lyricOffsetSec() : 0;
      const cur = t + off;
      let idx = -1;
      const ly = S.lyrics;
      for (let i = 0; i < ly.length; i++) {
        if (ly[i] && typeof ly[i].time === 'number' && ly[i].time <= cur) idx = i;
        else break;
      }
      if (idx < 0) return { now: '', next: '' };
      const lineText = function (l) {
        if (!l) return '';
        if (typeof lyricLineText === 'function') {
          try { return lyricLineText(l) || ''; } catch (e) {}
        }
        return l.text || '';
      };
      // 歌词文件开头的「作词：/作曲：/编曲：」这类信息行不是歌词，别放上歌词条
      const isMetaLine = isLyricMeta;
      let now = '';
      for (let i = idx; i >= 0; i--) {
        const cand = lineText(ly[i]);
        if (cand && !isMetaLine(cand)) { now = cand; break; }
      }
      let next = '';
      for (let i = idx + 1; i < ly.length; i++) {
        const cand = lineText(ly[i]);
        if (cand && !isMetaLine(cand)) { next = cand; break; }
      }
      // 原文+翻译一起上悬浮条会更长，窄屏只放原文，翻译有 UI 里那个开关时再拼
      try {
        if (now && ly[idx].ttext && S.lyricsMode === 'orig') now = now + ' ' + ly[idx].ttext;
      } catch (e) {}
      return { now: now, next: next };
    } catch (e) {
      return { now: '', next: '' };
    }
  }

  function pushMediaState(force) {
    const now = Date.now();
    if (!force && now - lastNativePush < 900) return;
    lastNativePush = now;
    try {
      const a = audioEl();
      const dur = (a && isFinite(a.duration)) ? a.duration : 0;
      const pos = (a && isFinite(a.currentTime)) ? a.currentTime : 0;
      const playing = !!(a && !a.paused && a.src);
      // 封面只在变化时上传（dataURL 可能接近 900KB，每次状态变化都传会把桥拖慢）
      // 1.0.16：当前曲没有联网封面时，退回用「专辑缩略图」，通知栏至少能看见一张图
      let coverPayload = lastMedia.cover || '';
      if (!coverPayload) {
        try {
          const cur = (typeof S !== 'undefined' && S.current >= 0) ? S.tracks[S.current] : null;
          if (cur) coverPayload = cur.cover || THUMB.mem.get(albumKeyOf(cur)) || '';
        } catch (e) {}
      }
      const sendCover = (coverPayload && coverPayload !== lastSentCover) ? coverPayload : '';
      if (sendCover) lastSentCover = coverPayload;
      // 当前歌词句：原生拿去做通知栏/锁屏第二行
      const lyric = playing ? currentLyric().now : '';
      // 1.0.16：通知栏那个「喜欢」按钮要知道现在是不是已收藏，否则图标和文字对不上
      let liked = false;
      try {
        const cur = (typeof S !== 'undefined' && S.current >= 0) ? S.tracks[S.current] : null;
        liked = !!(cur && cur.path && typeof isFavorite === 'function' && isFavorite(cur.path));
      } catch (e) {}
      nativeCall('updateMediaState', {
        title: lastMedia.title,
        artist: lastMedia.artist,
        album: (fakeSession._metadata && fakeSession._metadata.album) || '',
        playing: playing,
        position: pos,
        duration: dur,
        cover: sendCover,
        lyric: lyric,
        liked: liked
      }).catch(function () {});
    } catch (e) { /* 忽略 */ }
  }

  // ---- 顶部歌词条状态（安卓用悬浮窗实现桌面版的「任务栏歌词」） ----
  let topLyricShown = false;
  let topLyricPending = false;
  const bridgeReadyAt = Date.now();
  let topLyricStyle = { opacity: 0.86, sungColor: '#e8eaf0', unsungColor: '#9aa0aa', scale: 1 };
  let lastSentLyric = '';
  let lastTopText = '';
  let lastFullPush = 0;

  // 1.0.7：顶部歌词条（原生悬浮窗）整个下线——用户反馈那条灰带太丑。
  // 这里保留函数名只是为了不断掉内部调用点，实际一律不显示，也不再要悬浮窗权限。
  function pushTopLyric(text) { /* 已下线：不再往悬浮窗推歌词 */ }

  function topLyricRefresh() { /* 已下线 */ }

  function topLyricEnable(mode) {
    topLyricShown = false;
    topLyricPending = false;
    nativeCall('topLyricHide', {}).catch(function () {});
    return Promise.resolve(false);
  }

  function startMediaTick() {
    if (mediaTimer) return;
    mediaTimer = setInterval(function () {
      try {
        const a = audioEl();
        if (!a || a.paused || !a.src) return;
        const ly = currentLyric();
        const changed = ly.now !== lastSentLyric;
        lastSentLyric = ly.now;
        // 悬浮条按句推进（没变化就不发，避免每秒一次无意义的桥调用）
        if (topLyricShown && changed) pushTopLyric(ly.now);
        // 通知栏/锁屏也换句，或位置太久没同步（切歌、拖进度）就整份推一次
        if (changed || Date.now() - lastFullPush > 3000) {
          lastFullPush = Date.now();
          pushMediaState(true);
        }
      } catch (e) { /* 忽略 */ }
    }, 1000);
  }

  // 原生媒体键 / 通知栏按钮 -> 渲染层自己的处理函数（状态不会脱节）
  window.__mbMediaAction = function (action, seekMs) {
    try {
      const h = mediaHandlers;
      if (action === 'play' || action === 'pause' || action === 'toggle') {
        // app.js 的 play / pause 都指向 mediaKeyToggle：按 audio.paused 真值切，不信任系统意图
        if (typeof h.play === 'function') return h.play();
        if (typeof h.pause === 'function') return h.pause();
        return;
      }
      if (action === 'next') { if (h.nexttrack) return h.nexttrack(); return; }
      if (action === 'prev') { if (h.previoustrack) return h.previoustrack(); return; }
      if (action === 'seek') { if (h.seekto) return h.seekto({ seekTime: (seekMs || 0) / 1000 }); return; }
      if (action === 'stop') { if (h.stop) return h.stop(); return; }
      // 1.0.16：通知栏的「喜欢」按钮 —— 切当前曲的收藏状态，然后把状态重新推给原生，
      // 通知栏那颗心立刻换成实心/空心（不必等下一次 1 秒 tick）
      if (action === 'like') {
        try {
          const cur = (typeof S !== 'undefined' && S.current >= 0) ? S.tracks[S.current] : null;
          if (cur && cur.path && typeof toggleFavorite === 'function') {
            toggleFavorite(cur.path);
            try { syncFavBtn(); } catch (e) {}
            setTimeout(function () { pushMediaState(true); }, 60);
          }
        } catch (e) {}
        return;
      }
    } catch (e) {
      console.warn('[mb] media action failed', e);
    }
  };

  // ---------------- 系统栏 insets（edge-to-edge 之后留白由网页自己加） ----------------

  let mbInsets = { top: 0, right: 0, bottom: 0, left: 0, extraTop: 0 };

  window.__mbInsets = function (top, right, bottom, left, extraTop) {
    mbInsets = {
      top: Math.max(0, top || 0),
      right: Math.max(0, right || 0),
      bottom: Math.max(0, bottom || 0),
      left: Math.max(0, left || 0),
      extraTop: Math.max(0, extraTop || 0)
    };
    try {
      const de = document.documentElement;
      de.style.setProperty('--mb-top', mbInsets.top + 'px');
      de.style.setProperty('--mb-right', mbInsets.right + 'px');
      de.style.setProperty('--mb-bottom', mbInsets.bottom + 'px');
      de.style.setProperty('--mb-left', mbInsets.left + 'px');
      de.style.setProperty('--mb-extra-top', mbInsets.extraTop + 'px');
      de.classList.add('mb-insets-ready');
    } catch (e) {}
    return true;
  };

  // ---------------- 返回层级（系统返回键 / 侧滑手势都走这里） ----------------

  function isShown(el) {
    if (!el) return false;
    if (el.hasAttribute('hidden')) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  /** 关掉我们自己加的弹层（歌词调节面板 / 外链确认） */
  function closeOwnSheet() {
    const mix = document.getElementById('mb-mix');
    if (mix && !mix.hasAttribute('hidden')) { closeMixPanel(); return true; }
    const cf = document.getElementById('mb-confirm');
    if (cf && !cf.hasAttribute('hidden')) { cf.querySelector('[data-act="cancel"]').click(); return true; }
    return false;
  }

  // 渲染层所有"会浮在界面上"的层，统一在这里登记：
  // 工具箱(batch-menu)、排序(sort-menu)、外观(theme-popover)、设置(settings-modal)、
  // 歌词面板/桌面歌词菜单、播放队列、以及右键菜单家族和动态歌单二级菜单。
  const POPUP_IDS = [
    'settings-modal', 'theme-popover', 'batch-menu', 'sort-menu',
    'desktop-lyric-menu', 'lyrics-panel', 'queue-panel',
    'context-menu', 'batch-context-menu', 'placeholder-ctx-menu',
    'album-online-menu', 'radio-context-menu', 'recycle-context-menu',
    'online-track-menu', 'folder-ctx-menu'
  ];
  // 1.0.9：安全设置里的 submenu（"歌单来源/刷新顺序"下面还可展开一层）也要算浮层
  const POPUP_SEL = '.modal, .ctx-menu, .context-menu, .batch-menu, .sort-menu,'
    + ' .theme-popover, .float-menu, .submenu, .menu-overlay';

  /** 渲染层当前有没有开着浮层（设置 / 工具箱二级菜单 / 队列 / 歌词面板 / 右键菜单…） */
  function appOverlayOpen() {
    try {
      const qp = document.getElementById('queue-panel');
      if (qp && (qp.classList.contains('open') || isShown(qp))) return true;
    } catch (e) {}
    // 按 id 逐个看：光有 [hidden] 属性不够，元素可能被 display:none 藏着，
    // 那样会把返回键白白吞掉（用户按几下都没反应）；相反只查 class 又会漏掉 batch-menu 这类。
    for (const id of POPUP_IDS) {
      try {
        const el = document.getElementById(id);
        if (el && shownSafe(el) && !isMenuOverlayOnly(el)) return true;
      } catch (e) {}
    }
    try {
      const nodes = document.querySelectorAll(POPUP_SEL);
      for (const el of nodes) {
        try { if (shownSafe(el) && !isMenuOverlayOnly(el)) return true; } catch (e) {}
      }
    } catch (e) {}
    // 动态创建的歌单二级菜单（app.js 里是运行时 new 出来的，没有固定 id）
    try {
      if (typeof playlistMenuEl !== 'undefined' && playlistMenuEl && isShown(playlistMenuEl)) return true;
    } catch (e) {}
    return false;
  }

  /** 纯点击遮罩不算"用户看得见的浮层"，但它在的时候也要先收掉 */
  function isMenuOverlayOnly(el) {
    return !!(el && el.classList.contains('menu-overlay'));
  }

  /** 关掉渲染层自己开的各种浮层：先借 app.js 自己的总闸，关不掉的再逐个强制隐藏 */
  function closeAppOverlay() {
    if (!appOverlayOpen()) return false;
    // app.js 自己有 closeAllFloatMenus()（POPOVER_IDS + 右键菜单家族 + 动态歌单菜单 + 遮罩），
    // 工具箱(batch-menu)、排序、外观、设置都在里面，走它最干净，不会留下半开状态。
    try { if (typeof closeAllFloatMenus === 'function') closeAllFloatMenus(); } catch (e) {}
    // 队列面板是 open class 控制的，Esc 只处理 open 态，这里走它自己的开关
    try {
      const qp = document.getElementById('queue-panel');
      if (qp && qp.classList.contains('open') && typeof toggleQueuePanel === 'function') toggleQueuePanel(false);
      else if (qp) qp.classList.remove('open');
    } catch (e) {}
    // 歌词面板 / 设置面板：兜底直收（有些路径下 Esc 处理器根本没跑）
    try {
      const lp = document.getElementById('lyrics-panel');
      if (lp && !lp.hasAttribute('hidden')) lp.hidden = true;
    } catch (e) {}
    try {
      const sm = document.getElementById('settings-modal');
      if (sm && !sm.hasAttribute('hidden')) sm.hidden = true;
    } catch (e) {}
    // 动态歌单二级菜单（运行时 new 出来的元素）
    try {
      if (typeof playlistMenuEl !== 'undefined' && playlistMenuEl) {
        playlistMenuEl.remove();
        if (typeof playlistMenuEl !== 'undefined') playlistMenuEl = null;
      }
    } catch (e) {}
    try { if (typeof hideMenuOverlay === 'function') hideMenuOverlay(); } catch (e) {}
    // 剩下的（比如某个 .submenu 残留）按 id/class 逐个收
    for (const id of POPUP_IDS) {
      try {
        const el = document.getElementById(id);
        if (el && shownSafe(el) && !isMenuOverlayOnly(el)) el.hidden = true;
      } catch (e) {}
    }
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}
    return !appOverlayOpen();
  }

  /** 屏幕上这块元素是否真的在显示（不抛异常、拿不到就当没显示） */
  function shownSafe(el) {
    try { return !!el && isShown(el); } catch (e) { return false; }
  }

  /**
   * 渲染层的"当前不在根页面"的判断集合。
   * 桌面版的 navHistory 只在「点击进入下一级」时压栈，重启后是空的，
   * 只靠它就等于让用户一路返回到退出软件。
   */
  function appState() {
    const st = { view: 'music', filter: '', keyword: '', favorites: false, folder: null, playlist: null, multi: 0, radioMulti: false };
    try {
      if (typeof S !== 'undefined') {
        st.view = S.currentView || 'music';
        st.filter = S.filterValue || '';
        st.keyword = S.keyword || '';
        st.favorites = !!S.showFavorites;
        st.folder = S.activeFolder || null;
        st.playlist = S.activePlaylist || null;
        st.multi = (S.multiSel && S.multiSel.size) || 0;
      }
    } catch (e) {}
    try { st.radioMulti = (typeof radioMultiMode !== 'undefined') && !!radioMultiMode; } catch (e) {}
    return st;
  }

  /** 一层层退回"音乐库根页面"：清多选、清搜索词、退出收藏/文件夹/歌单视图、清筛选、离开电台页 */
  function goRootView() {
    const st = appState();
    let did = false;

    try { if (st.radioMulti && typeof exitRadioMultiMode === 'function') { exitRadioMultiMode(); did = true; } } catch (e) {}
    try { if (st.multi > 0 && typeof clearMultiSel === 'function') { clearMultiSel(); did = true; } } catch (e) {}

    try {
      if (st.keyword) {
        S.keyword = '';
        const si = document.getElementById('search');
        if (si) si.value = '';
        const sc = document.getElementById('search-clear');
        if (sc) sc.hidden = true;
        did = true;
      }
    } catch (e) {}

    // 收藏 / 文件夹 / 歌单 / 筛选：app.js 自己就有「回到全部音乐」的入口，走它最干净
    try {
      if (st.favorites || st.folder || st.playlist || st.filter) {
        if (typeof showAllMusicView === 'function') { showAllMusicView(); did = true; }
        else { if (typeof clearTrackFilter === 'function') clearTrackFilter(true); }
      }
    } catch (e) {}

    // 电台页不是 pushNav 管的，单独切回来
    try {
      if (st.view && st.view !== 'music' && typeof switchView === 'function') {
        switchView('music');
        did = true;
      }
    } catch (e) {}

    if (did) {
      try { if (typeof renderList === 'function') renderList(); } catch (e) {}
    }
    return did;
  }

  /**
   * 执行一次"回退动作"，但把它顺手压进 navHistory 的那一条撤掉。
   * 因为我们是「返回键」驱动的回退，压栈只会让下一次返回又跳回刚才那一页
   * （典型：退出收藏视图 → 再按一次又回到收藏视图）。
   */
  function withoutNavPush(fn) {
    let h = -1, f = -1;
    try {
      if (typeof navHistory !== 'undefined') h = navHistory.length;
      if (typeof navFuture !== 'undefined') f = navFuture.length;
    } catch (e) {}
    let ret = false;
    try { ret = fn(); } catch (e) { ret = true; }
    try {
      if (h >= 0 && typeof navHistory !== 'undefined' && navHistory.length > h) navHistory.length = h;
      if (f >= 0 && typeof navFuture !== 'undefined' && navFuture.length > f) navFuture.length = f;
    } catch (e) {}
    return ret;
  }

  /**
   * 返回键 / 侧滑返回：按层级退，退到底才离开 App。
   * 顺序：自己的面板 → 播放详情页 → 渲染层浮层 → 多选 → 筛选/视图 → 导航历史 → 退出。
   * 每一层单独 try：任何一层出异常都不许把用户直接踢出 App（之前 pf-close 抛异常就会退出）。
   */
  window.__mbBack = function () {
    // 1) 我们自己加的弹层
    try { if (closeOwnSheet()) return 'handled'; } catch (e) {}

    // 2) 播放详情页（用户嘴里的「专辑页」）：只要它在显示，这一下就是"关掉它"，绝不退出 App
    const pf = document.getElementById('player-full');
    if (shownSafe(pf)) {
      // 2.1) 先退沉浸态：全屏只显示封面和歌词时，第一下返回是"恢复正常播放页"，
      //      不然用户从沉浸里划一下就直接把整个播放页关掉了。
      try {
        if (isImmersive()) { setImmersive(false); return 'handled'; }
      } catch (e) {}
      try {
        const btn = document.getElementById('pf-close');
        if (btn) btn.click(); else pf.hidden = true;
      } catch (e) {
        try { pf.hidden = true; } catch (_) {}
      }
      // app.js 的关闭是 280ms 渐隐后才真正隐藏；再兜一层，
      // 万一它的 open 标记没跟上（点了没反应）就直接收起来，别让用户以为"返回失效"
      setTimeout(function () {
        try {
          if (shownSafe(pf)) {
            pf.open = false;
            pf.hidden = true;
            document.body.classList.remove('is-fullscreen');
            document.body.classList.remove('pf-idle');
            document.body.style.overflow = '';
          }
        } catch (e) {}
      }, 420);
      return 'handled';
    }

    // 3) 渲染层自己的浮层（设置 / 队列 / 歌词面板 / 右键菜单 / 各种 modal）
    try { if (closeAppOverlay()) return 'handled'; } catch (e) {}

    // 4) 多选态：先只清选择，不动当前视图
    try {
      const st = appState();
      if (st.multi > 0 && typeof clearMultiSel === 'function') {
        clearMultiSel();
        return 'handled';
      }
      if (st.radioMulti && typeof exitRadioMultiMode === 'function') {
        exitRadioMultiMode();
        return 'handled';
      }
    } catch (e) {}

    // 5) 筛选态 / 搜索 / 收藏 / 文件夹 / 歌单 / 电台：先退回根页面
    try {
      const st = appState();
      if (st.filter || st.keyword || st.favorites || st.folder || st.playlist
          || (st.view && st.view !== 'music')) {
        if (withoutNavPush(goRootView)) return 'handled';
      }
    } catch (e) {}

    // 6) 桌面版那套页面历史（点击进入文件夹/歌单时压的栈）
    try {
      if (typeof navHistory !== 'undefined' && navHistory.length) {
        const st6 = appState();
        const nowRoot = st6.view === 'music' && !st6.favorites && !st6.folder && !st6.playlist
          && !st6.filter && !st6.keyword && st6.multi === 0 && !st6.radioMulti;
        // 1.0.8：已经站在根页面了，历史里剩的快照全是垃圾（我们自己的回退动作压进去的）。
        // 以前只丢"根快照"，遇到"根 → 文件夹A → 文件夹B"再退回根的情况会剩一条文件夹A，
        // 结果在根页面一划返回又跳回文件夹A。这里在根页面直接清空历史，然后才允许退出。
        if (nowRoot) {
          navHistory.length = 0;
          try { if (typeof navFuture !== 'undefined') navFuture.length = 0; } catch (e) {}
          return 'exit';
        }
        // 历史里可能存着「根页面」的冗余快照（我们自己的回退动作压进去的），
        // 退它等于什么都没变 —— 直接丢掉，别让用户在根页面连按几次返回
        let guard = 0;
        while (navHistory.length && guard++ < 5) {
          const last = navHistory[navHistory.length - 1] || {};
          const lastRoot = (last.view || 'music') === 'music' && !last.favorites && !last.folder
            && !last.playlist && !last.filterValue && !(last.keyword || '');
          const nowRoot2 = st6.view === 'music' && !st6.favorites && !st6.folder && !st6.playlist
            && !st6.filter && !st6.keyword;
          if (lastRoot && nowRoot2) { navHistory.pop(); continue; }
          break;
        }
        if (typeof navBack === 'function' && navHistory.length) {
          navBack();
          return 'handled';
        }
      }
    } catch (e) {}

    return 'exit';
  };

  /**
   * 只读判断：现在是不是"已经在最底层的音乐库根页面"。
   * 原生退出 App 之前必须再过这一道 —— 只要还有任何一层（播放页/浮层/筛选/搜索/收藏/歌单/多选/历史）
   * 没退干净，就绝不离开 App。这是防"侧滑一下就回桌面"的最后一道闸。
   */
  window.__mbAtRoot = function () {
    try {
      if (shownSafe(document.getElementById('player-full'))) return false;
      if (appOverlayOpen()) return false;
      const st = appState();
      if (st.multi > 0 || st.radioMulti) return false;
      if (st.filter || st.keyword || st.favorites || st.folder || st.playlist) return false;
      if (st.view && st.view !== 'music') return false;
      try {
        if (typeof navHistory !== 'undefined' && navHistory.length) return false;
      } catch (e) {}
      return true;
    } catch (e) {
      return false;
    }
  };


  // ---------------- window.mb 契约 ----------------

  const listeners = { scanProgress: null, fullscreen: null, tray: null, updateProgress: null };
  let firstScanUsed = false;

  window.__mbEmit = function (channel, data) {
    try {
      if (channel === '__scanProgress' && listeners.scanProgress) listeners.scanProgress(data);
      else if (channel === '__fullscreen' && listeners.fullscreen) listeners.fullscreen(!!data && !!data.on);
      else if (channel === '__tray' && listeners.tray) listeners.tray(data && data.action, data && data.value);
      else if (channel === '__updateProgress' && listeners.updateProgress) listeners.updateProgress(data || {});
      else if (channel === '__libraryChanged') onLibraryChanged(data);
    } catch (e) { /* 渲染层回调出错不能影响原生 */ }
  };

  /** 后台校正发现曲库有增删改：静默把列表更新成最新的（走 app.js 自己的刷新流程） */
  function onLibraryChanged(ev) {
    if (!ev) return;
    const added = ev.added || 0, removed = ev.removed || 0, changed = ev.changed || 0;
    if (!added && !removed && !changed) return;
    const parts = [];
    if (added) parts.push('新增 ' + added + ' 首');
    if (removed) parts.push('移除 ' + removed + ' 首');
    if (changed) parts.push('更新 ' + changed + ' 首');
    if (typeof toast === 'function') toast('曲库有变化：' + parts.join('，'));
    // 等启动那波渲染稳下来再刷，避免和首屏扫描打架
    setTimeout(function () {
      try {
        if (typeof isScanning !== 'undefined' && isScanning) return;
        if (typeof refreshAllFolders === 'function') refreshAllFolders();
      } catch (e) {}
    }, 1500);
  }

  function dirnameImpl(p) {
    if (!p || typeof p !== 'string') return '';
    const normalized = p.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return p;
    return normalized.substring(0, idx);
  }

  const AUDIO_RE = /\.(mp3|flac|wav|ogg|oga|opus|m4a|aac|mp4|webm|aif|aiff)$/i;

  const mb = {
    version: '1.0.24-android',

    // ---- 曲库 ----
    pickFolders: function () {
      return nativeCall('pickFolders').then(function (r) { return (r && r.paths) || []; });
    },
    pickDir: function () {
      return nativeCall('pickFolders').then(function (r) {
        return (r && r.paths && r.paths.length) ? r.paths[0] : null;
      });
    },
    selectDirectory: function () { return mb.pickDir(); },
    pickLyricsFile: function () {
      return nativeCall('pickLyricsFile').then(function (r) { return (r && r.path) || null; });
    },
    scan: function (paths, recursive) {
      // 启动装载那一次先吃上次的曲库缓存（原生扫盘改到后台做），之后一律真扫。
      const useCache = !firstScanUsed;
      firstScanUsed = true;
      if (useCache) console.log('[mb] scan: try library cache first');
      return nativeCall('scan', { paths: paths || [], recursive: recursive !== false, preferCache: useCache })
        .then(function (r) {
          // 扫不出歌时原生会带一份诊断：打印出来（Capacitor 会把 console 转进 logcat）
          if (r && r.debug && r.debug.length) {
            try { console.warn('[mb] scan empty diag ' + JSON.stringify(r.debug)); } catch (e) {}
          }
          if (r && r.cached) console.log('[mb] scan: cache hit');
          const tracks = (r && r.tracks) || [];
          // 空封面（"data:image/jpeg;base64," 后面没内容）会让渲染层画成一张碎图标，
          // 直接当成"没有封面"，走它自己的兜底（♪ 或自己的封面缓存/联网补）
          for (let i = 0; i < tracks.length; i++) {
            const c = tracks[i] && tracks[i].cover;
            if (typeof c === 'string' && /^data:[^,]*,\s*$/.test(c)) delete tracks[i].cover;
          }
          return tracks;
        });
    },
    onScanProgress: function (cb) { listeners.scanProgress = cb; },
    isAudioName: function (name) { return AUDIO_RE.test(String(name || '')); },
    pathOf: function () { return null; },   // 安卓没有拖拽取路径
    dirname: dirnameImpl,                   // 与 preload 完全一致的同步实现

    readFileTags: function (filePath) {
      return nativeCall('readFileTags', { path: filePath });
    },
    fileExists: function (filePath) {
      return nativeCall('fileExists', { path: filePath }).then(function (r) { return !!(r && r.exists); });
    },

    // ---- 配置（整份读写，桥不做字段合并）----
    getConfig: function () {
      return nativeCall('getConfig').then(function (r) {
        if (!r) return {};
        if (Object.prototype.hasOwnProperty.call(r, 'value') && Object.keys(r).length === 1) return r.value || {};
        return r;
      });
    },
    setConfig: function (cfg) {
      return nativeCall('setConfig', { cfg: cfg || {} }).then(function (r) { return !!(r && r.ok); });
    },
    getInheritInfo: function () {
      return nativeCall('getInheritInfo').then(function (r) { return (r && r.value) || null; });
    },
    getDefaultDirs: function () { return nativeCall('getDefaultDirs'); },

    // ---- 封面 / 歌词缓存 ----
    scanLocalCache: function (coverDir, lyricsDir, legacyDirs) {
      return nativeCall('scanLocalCache', {
        coverDir: coverDir || '', lyricsDir: lyricsDir || '', legacyDirs: legacyDirs || []
      }).then(function (r) {
        return { covers: (r && r.covers) || [], lyrics: (r && r.lyrics) || [] };
      });
    },
    readCoverFile: function (filePath) { return nativeCall('readCoverFile', { filePath: filePath }); },
    // 1.0.12：列表缩略封面。原生侧解标签 → 居中裁方 → 缩到 size → JPEG 落盘缓存，
    // 返回的是 base64 dataURL（约 3~5KB），不是原图（原图几百 KB 会把 WebView 撑爆）。
    readThumb: function (path, size, key) { return nativeCall('readThumb', { path: path || '', key: key || '', size: size || 96 }); },
    saveThumb: function (key, dataUrl) { return nativeCall('saveThumb', { key: key, dataUrl: dataUrl }); },
    readLyricsFile: function (filePath) { return nativeCall('readLyricsFile', { filePath: filePath }); },
    saveCover: function (dataUrl, saveDir, artist, title) {
      return nativeCall('saveCover', { dataUrl: dataUrl, saveDir: saveDir || '', artist: artist || '', title: title || '' })
        .then(function (r) {
          // 1.0.24：存成功了就把 key 记进 app.js 的 localCoverFiles ——
          // 不记的话，同一次运行里再点一次「批量下载」还会把这批歌再下一次（app.js 只在启动时扫盘建这个表）
          try {
            if (r && r.ok && S && S.localCoverFiles && S.localCoverFiles.add) {
              S.localCoverFiles.add(cacheKeyOf(artist, title));
            }
          } catch (e) {}
          return r;
        });
    },
    saveLyrics: function (lrc, saveDir, artist, title, meta) {
      const payload = (lrc && typeof lrc === 'object') ? lrc : { lrc: lrc };
      return nativeCall('saveLyrics', {
        lrc: payload.lrc || '',
        tlyric: payload.tlyric || '',
        rlyric: payload.rlyric || '',
        yrc: payload.yrc || '',
        saveDir: saveDir || '', artist: artist || '', title: title || '',
        meta: meta || {}
      }).then(function (r) {
        // 1.0.24：同上 —— 落盘成功就记进 localLyricsFiles，再点一次也不会重复下载
        try {
          if (r && r.ok && S && S.localLyricsFiles && S.localLyricsFiles.add) {
            S.localLyricsFiles.add(cacheKeyOf(artist, title));
          }
        } catch (e) {}
        return r;
      });
    },
    saveLyricOffset: function (payload) {
      payload = payload || {};
      return nativeCall('saveLyricOffset', {
        saveDir: payload.saveDir || '', artist: payload.artist || '',
        title: payload.title || '', offset: Number(payload.offset) || 0
      });
    },

    // ---- 文件操作 ----
    deleteFile: function (filePath) { return nativeCall('deleteFile', { filePath: filePath }); },
    renameFile: function (oldPath, newName) {
      return nativeCall('renameFile', { oldPath: oldPath, newName: newName });
    },
    copyFile: function (src, destDir, opts) {
      opts = opts || {};
      // 桌面版实际参数名是 skipIdentical（交接文档里写作 skipExisting），两个都认
      const skip = !!(opts.skipIdentical || opts.skipExisting);
      return nativeCall('copyFile', { src: src, destDir: destDir, skipIdentical: skip });
    },
    writeTextFile: function (filePath, text) {
      return nativeCall('writeTextFile', { filePath: filePath, text: text });
    },
    findDuplicateFiles: function (paths) {
      return nativeCall('findDuplicateFiles', { paths: paths || [] }).then(function (r) {
        const groups = [];
        ((r && r.groups) || []).forEach(function (g) {
          if (Array.isArray(g)) groups.push(g);
          else if (g && Array.isArray(g.paths)) groups.push(g.paths);
        });
        return { ok: true, groups: groups };
      });
    },
    showItemInFolder: function () { return Promise.resolve(true); },
    openFolder: function () { return Promise.resolve(true); },
    openExternal: function (url) { return nativeCall('openExternal', { url: url }); },

    // ---- 窗口：语义替换 ----
    minimize: function () { return nativeCall('minimize'); },
    toggleMaximize: function () { return nativeCall('toggleMaximize'); },
    closeWindow: function () { return nativeCall('closeWindow'); },
    isMaximized: function () { return Promise.resolve(true); },
    setFullScreen: function (on) {
      window.__mbFullScreen = !!on;
      return nativeCall('setFullScreen', { on: !!on });
    },
    isFullScreen: function () { return Promise.resolve(!!window.__mbFullScreen); },
    onFullScreenChange: function (cb) { listeners.fullscreen = cb; },
    updatePlayerState: function (state) {
      state = state || {};
      lastMedia.title = state.title || '';
      lastMedia.artist = state.artist || '';
      if (state.cover) lastMedia.cover = state.cover;
      pushMediaState(true);
      startMediaTick();
    },
    onTrayControl: function (cb) { listeners.tray = cb; },
    setMiniTheme: function () {},
    setCloseToTray: function () {},
    getAutostart: function () { return Promise.resolve(false); },
    setAutostart: function () { return Promise.resolve(false); },
    toggleAlwaysOnTop: function () { return Promise.resolve(false); },
    isAlwaysOnTop: function () { return Promise.resolve(false); },

    // ---- 歌词窗系列：桌面版是独立 BrowserWindow，安卓改成本地悬浮窗（顶部歌词条）----
    // 渲染层里的「桌面歌词 / 任务栏歌词」按钮和整套菜单都是现成的，这里只把出口接到原生。

    sendLyric: function (payload) {
      payload = payload || {};
      const cur = String(payload.current == null ? '' : payload.current).trim();
      // 渲染层这版会把「作词：xxx」这类头信息当当前句推过来；直接吞掉，等第一句真歌词
      if (cur && !isLyricMeta(cur)) {
        lastSentLyric = cur;
        pushTopLyric(cur);
      }
      return Promise.resolve(true);
    },
    setDesktopLyricMode: function (mode) {
      // 1.0.7：顶部歌词条下线，这里永远回 'off'，并确保原生那条已经不在了
      topLyricShown = false;
      lastTopText = '';
      nativeCall('topLyricHide', {}).catch(function () {});
      return Promise.resolve('off');
    },
    setLyricClickThrough: function () { return Promise.resolve(true); },
    setLyricScale: function (v) { topLyricStyle.scale = Number(v) || 1; return Promise.resolve(true); },
    setLyricMetrics: function (p) { return Promise.resolve(true); },
    setLyricOffset: function () { return Promise.resolve(true); },
    lyricFitWidth: function () { return Promise.resolve(true); },
    lyricAlign: function () { return Promise.resolve(true); },
    lyricContextMenu: function () { return Promise.resolve(true); },
    sendLyricStyle: function (patch) {
      topLyricStyle = Object.assign(topLyricStyle, patch || {});
      if (topLyricShown) {
        nativeCall('topLyricShow', {
          bg: '#1a1d26',
          color: topLyricStyle.sungColor || '#e8eaf0'
        }).catch(function () {});
      }
      return Promise.resolve(true);
    },
    // 主进程不在了，样式以渲染层自己的设置为准：返回 null，app.js 会跳过合并
    lyricGetStyle: function () { return Promise.resolve(null); },
    lyricGetData: function () { return Promise.resolve(null); },
    lyricAction: function () { return Promise.resolve(true); },
    onLyricWindowState: function () { return function () {}; },
    onLyricData: function () { return function () {}; },
    onLyricMode: function () { return function () {}; },
    onLyricScale: function () { return function () {}; },
    onLyricState: function () { return function () {}; },
    onLyricStyle: function () { return function () {}; },

    // ---- 联网元数据（真实现：算法在 native/online.js 里，与桌面版同一套）----

    /** 封面：先下首选源，失败就把其它来源（含缩略图）逐个兜底，和桌面 main.js 的 fetch-cover 一致 */
    fetchCover: function (artist, title) {
      const O = window.__online;
      if (!O) return Promise.resolve({ ok: false, error: '联网模块未加载' });
      // 1.0.20：app.js 只传歌手+歌名，但专辑级的新源（网易云专辑/酷我专辑）需要专辑名，
      // 所以先在本机曲库里按歌手+歌名反查一次专辑
      let album = '';
      try {
        if (typeof S !== 'undefined' && S.tracks) {
          const norm = function (x) { return String(x || '').toLowerCase().replace(/\s/g, ''); };
          for (let i = 0; i < S.tracks.length; i++) {
            const t = S.tracks[i];
            if (!t || !t.path) continue;
            if (norm(t.title) === norm(title) && norm(t.artist) === norm(artist)) { album = t.album || ''; break; }
          }
        }
      } catch (e) {}
      return O.searchCover(artist, title, album).then(function (info) {
        if (!info || !info.url) return { ok: false, error: '未找到封面' };
        return O.downloadCover(info.url).then(function (dataUrl) {
          if (dataUrl) return { ok: true, dataUrl: dataUrl, info: info };
          return O.searchCoverCandidates(artist, title, album).then(function (cands) {
            let i = 0;
            function next() {
              if (i >= cands.length) return { ok: false, error: '封面下载失败' };
              const cand = cands[i++];
              if (cand.url === info.url) return next();
              return O.downloadCover(cand.url).then(function (d) {
                if (d) return { ok: true, dataUrl: d, info: cand };
                if (cand.thumbUrl && cand.thumbUrl !== cand.url) {
                  return O.downloadCover(cand.thumbUrl).then(function (d2) {
                    if (d2) return { ok: true, dataUrl: d2, info: cand };
                    return next();
                  });
                }
                return next();
              });
            }
            return next();
          });
        });
      }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    },

    fetchLyrics: function (artist, title, duration) {
      const O = window.__online;
      if (!O) return Promise.resolve({ ok: false, error: '联网模块未加载' });
      return O.searchLyrics(artist, title, duration).then(function (r) {
        if (!r) return { ok: false, error: '未找到歌词' };
        return { ok: true, lrc: r.lrc, tlyric: r.tlyric || '', rlyric: r.rlyric || '', yrc: r.yrc || '', info: r };
      }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    },

    fetchLyricsFromSource: function (source, artist, title, duration) {
      const O = window.__online;
      if (!O) return Promise.resolve({ ok: false, error: '联网模块未加载' });
      return O.searchLyricsFromSource(source, artist, title, duration).then(function (r) {
        if (!r) return { ok: false, error: '该来源未找到歌词' };
        return { ok: true, lrc: r.lrc, tlyric: r.tlyric || '', rlyric: r.rlyric || '', yrc: r.yrc || '', info: r };
      }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    },

    fetchPlaylist: function (url) {
      const O = window.__online;
      if (!O) return Promise.resolve({ ok: false, error: '联网模块未加载' });
      return O.fetchPlaylistByUrl(url).then(function (r) {
        if (!r) return { ok: false, error: '抓取歌单失败' };
        if (r.error) return { ok: false, error: r.error };
        return { ok: true, data: r };
      }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    },

    searchSongInfo: function (artist, title, duration) {
      const O = window.__online;
      if (!O) return Promise.resolve({ ok: false });
      return O.searchSongInfo(artist, title, duration).then(function (r) { return r || { ok: false }; })
        .catch(function () { return { ok: false }; });
    },

    searchArtistOnline: function (artist) {
      const O = window.__online;
      return O ? O.searchArtistSongs(artist).catch(function () { return []; }) : Promise.resolve([]);
    },

    searchAlbumOnline: function (album) {
      const O = window.__online;
      return O ? O.searchAlbumSongs(album).catch(function () { return []; }) : Promise.resolve([]);
    },

    searchSongsOnline: function (keyword) {
      const O = window.__online;
      return O ? O.searchSongsByKeyword(keyword).catch(function () { return []; }) : Promise.resolve([]);
    },

    getDownloadLink: function (artist, title, duration) {
      const O = window.__online;
      if (!O) return Promise.resolve({ ok: false });
      return O.getFreeDownloadLink(artist, title, duration).then(function (r) { return r || { ok: false }; })
        .catch(function () { return { ok: false }; });
    },

    resolveOnlinePage: function (payload) {
      const O = window.__online;
      if (!O) return Promise.resolve({ ok: false });
      return O.resolveOnlineLinks(payload || {}).then(function (d) {
        if (!d || !d.url) return { ok: false, error: '没能解析出页面地址' };
        return { ok: true, data: d };
      }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    },

    completeTrackInfo: function (payload) {
      const O = window.__online;
      if (!O) return Promise.resolve({ ok: false });
      return O.completeTrackInfo(payload || {}).then(function (r) { return r || { ok: false }; })
        .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    },

    autoFixTrack: function (artist, title, album, duration) {
      const O = window.__online;
      if (!O) return Promise.resolve({ ok: false, needFix: false });
      // 1.0.24：查过的「信息本来就对」的歌不再每次重查（详见下方 autoFixMemo）
      const fp = autoFixFp(artist, title, album, duration);
      const m = readAutoFixMemo(fp);
      if (m) {
        window.__mbAutoFixMemo = window.__mbAutoFixMemo || { hit: 0, net: 0, saved: 0 };
        window.__mbAutoFixMemo.hit++;
        return Promise.resolve({ ok: true, needFix: false, memo: true, reason: '已核对过，无需修复' });
      }
      return O.autoFixTrackInfo(artist, title, album, duration).then(function (r) {
        const out = r || { ok: false, needFix: false };
        // 只有「明确核对过是对的信息」才记下来；没搜到（可能是网络问题）只记一个短期的"没搜到"，
        // 过几天还会再试一次，免得偶发一次失败就把这首歌永久判成"没信息"。
        if (!out.needFix && out.checks && out.checks.titleOk && out.checks.artistOk && out.checks.albumOk) {
          writeAutoFixMemo(fp, 1);
        } else if (!out.needFix) {
          writeAutoFixMemo(fp, 0);
        }
        try {
          window.__mbAutoFixMemo = window.__mbAutoFixMemo || { hit: 0, net: 0, saved: 0 };
          window.__mbAutoFixMemo.net++;
        } catch (e) {}
        return out;
      })
        .catch(function () { return { ok: false, needFix: false }; });
    },

    writeMusicMetadata: function (path, title, artist, album) {
      return nativeCall('writeMusicMetadata', { path: path || '', title: title || '', artist: artist || '', album: album || '' });
    },
    convertToMp3: function () { return Promise.resolve({ ok: false, error: '安卓端暂不支持格式转换' }); },
    convertFormat: function () { return Promise.resolve({ ok: false, error: '安卓端暂不支持格式转换' }); },

    // ---- 应用内更新（1.0.21）----
    // 原生负责：查 GitHub Release / 下载到 cache/updates / 交给系统安装器。
    // 这里只做版本号比较和事件转发，UI 在 updateCenter（同文件后半段）。
    checkUpdate: function () {
      return nativeCall('updateCheck').catch(function (e) {
        return { ok: false, error: String(e && e.message || e) };
      });
    },
    downloadUpdate: function (url, fileName, size, onProgress) {
      listeners.updateProgress = onProgress || null;
      return nativeCall('updateDownload', {
        url: url || '', fileName: fileName || '', size: size || 0
      }).catch(function (e) {
        return { ok: false, error: String(e && e.message || e) };
      }).then(function (r) {
        listeners.updateProgress = null;
        return r;
      });
    },
    installUpdate: function (path) {
      return nativeCall('updateInstall', { path: path || '' }).catch(function (e) {
        return { ok: false, error: String(e && e.message || e) };
      });
    },
    openUpdatePage: function (url) {
      return nativeCall('updateOpenPage', { url: url || '' }).catch(function () { return { ok: false }; });
    },
    openUpdateUninstall: function () {
      return nativeCall('updateOpenUninstall').catch(function () { return { ok: false }; });
    }
  };

  window.mb = mb;
  window.__preloadOk = true;

  // ---------------- 系统栏配色同步（状态栏/导航栏跟软件底色一致） --------------

  let lastChromeKey = '';

  function parseCssColor(c) {
    const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(c || '');
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }

  function syncChromeColors() {
    try {
      // 顶栏/页面的实际底色就是"软件的颜色"
      const probes = ['#topbar', '.topbar', '.app', 'body'];
      let picked = null;
      for (let i = 0; i < probes.length; i++) {
        const el = probes[i][0] === '#' || probes[i][0] === '.' ? document.querySelector(probes[i]) : document.body;
        if (!el) continue;
        const c = parseCssColor(getComputedStyle(el).backgroundColor);
        if (c && c.a >= 0.5) { picked = c; break; }
      }
      if (!picked) picked = { r: 18, g: 20, b: 26, a: 1 };
      // 半透明底（毛玻璃主题）要按原生深色底压平，否则状态栏会比内容区亮一块
      const R = Math.round(picked.a * picked.r + (1 - picked.a) * 16);
      const G = Math.round(picked.a * picked.g + (1 - picked.a) * 18);
      const B = Math.round(picked.a * picked.b + (1 - picked.a) * 22);
      const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const light = lum > 150;   // 底色浅 → 状态栏图标用深色
      const hex = '#' + [R, G, B].map(function (v) {
        return ('0' + v.toString(16)).slice(-2);
      }).join('');
      if (hex + light === lastChromeKey) return;
      lastChromeKey = hex + light;
      // edge-to-edge 之后，状态栏那一条露的是 html 的底色：同步成同一个主题色，
      // 软件顶栏和系统通知栏就真的接成一片，而不是"同色系近似"。
      try {
        document.documentElement.style.setProperty('--mb-chrome-bg', hex);
      } catch (e) {}
      nativeCall('setChromeColors', { top: hex, bottom: hex, lightIcons: light }).catch(function () {});
    } catch (e) { /* 取色失败就沿用原生默认深色 */ }
  }

  function checkPendingTopLyric() {
    if (!topLyricPending || topLyricShown) return;
    nativeCall('topLyricCanDraw', {}).then(function (r) {
      if (r && r.can) {
        topLyricPending = false;
        topLyricEnable('restore');   // 用户刚在系统设置里点完"允许"，回来就把歌词条挂上
      }
    }).catch(function () {});
  }

  // ---------------- 安卓 UI 收敛（只隐藏桌面专属入口，不动布局骨架） --------------
  function hideEl(el) { if (el) el.style.display = 'none'; }

  function adaptAndroidUI() {
    // 窗口控制按钮（最小化/最大化/关闭）——安卓没有窗口
    hideEl(document.getElementById('win-min'));
    hideEl(document.getElementById('win-max'));
    hideEl(document.getElementById('win-close'));
    const winWrap = document.getElementById('win-ctrls') || document.querySelector('.win-ctrls');
    hideEl(winWrap);

    // 顶部歌词条（原生悬浮窗）要靠这个入口打开：按钮、模式菜单都沿用桌面版那套
    // 只在"真没权限"时由 topLyricEnable 去拉系统授权页

    // 托盘 / 开机自启 / 缓存路径（安卓走应用私有目录，写绝对路径没意义）
    ['set-close-tray', 'set-autostart'].forEach(function (id) {
      const input = document.getElementById(id);
      if (input) hideEl(input.closest('label') || input.parentElement);
    });
    const cachePath = document.getElementById('set-cache-path');
    if (cachePath) {
      const row = cachePath.closest('.setting-row');
      if (row) hideEl(row);
      else hideEl(cachePath.parentElement);
    }

    // 音频输出设备菜单（安卓由系统音频路由接管）
    const audioDev = document.getElementById('audio-device-menu');
    if (audioDev) hideEl(audioDev);

    // 拖拽导入提示（安卓只能走 SAF 选目录）
    document.querySelectorAll('[data-drag-hint], .drop-hint').forEach(hideEl);
  }

  let mediaBaseTries = 0;

  // ---------------- 1.0.4 触屏交互改造 ----------------
  // 说明：app.js 是桌面版逐字复用的，安卓的语义差异全部在这一层"接管"，不改 app.js。

  const HEART_PATH = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
  const ICON_CLOSE = '✕';

  function curTrack() {
    try {
      if (typeof S !== 'undefined' && S.current >= 0 && S.current < S.tracks.length) return S.tracks[S.current];
    } catch (e) {}
    return null;
  }

  function toastBox(msg) {
    try {
      if (typeof toast === 'function') { toast(msg); return; }
    } catch (e) {}
    let box = document.getElementById('mb-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mb-toast';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.classList.add('show');
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.classList.remove('show'); }, 2000);
  }

  // ---- 1) 歌词调节面板：EQ 按钮改开这个，把右侧那根调节轨整根搬进来 ----
  let railHome = null;

  function ensureMixPanel() {
    if (document.getElementById('mb-mix')) return;
    const wrap = document.createElement('div');
    wrap.id = 'mb-mix';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="mb-mix-card">' +
        '<div class="mb-mix-head"><b>歌词调节</b>' +
          '<button type="button" class="mb-mix-close" aria-label="关闭">' + ICON_CLOSE + '</button>' +
        '</div>' +
        '<div class="mb-mix-body" id="mb-mix-body"></div>' +
        '<div class="mb-mix-tip">单/双列词间距 · 歌词快慢（±0.1 秒，每首单独记）· 歌词字号</div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeMixPanel(); });
    wrap.querySelector('.mb-mix-close').addEventListener('click', function (e) {
      e.stopPropagation();
      closeMixPanel();
    });
  }

  function openMixPanel() {
    ensureMixPanel();
    const body = document.getElementById('mb-mix-body');
    const rail = document.querySelector('.pf-spacing-panel');
    if (rail && body) {
      if (!railHome) railHome = { parent: rail.parentNode, next: rail.nextSibling };
      if (rail.parentNode !== body) body.appendChild(rail);
      rail.classList.add('mb-mix-rail');
    }
    const wrap = document.getElementById('mb-mix');
    wrap.hidden = false;
  }

  function closeMixPanel() {
    const rail = document.querySelector('.pf-spacing-panel');
    if (rail && railHome && railHome.parent) {
      railHome.parent.insertBefore(rail, railHome.next && railHome.next.parentNode === railHome.parent ? railHome.next : null);
      rail.classList.remove('mb-mix-rail');
    }
    const wrap = document.getElementById('mb-mix');
    if (wrap) wrap.hidden = true;
  }

  // ---- 2) 底栏收藏键（跟专辑页 #pf-fav 同一套图标/状态）----
  function favSvg() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="' + HEART_PATH + '"/></svg>';
  }

  function syncFavBtn() {
    const btn = document.getElementById('mb-fav');
    if (!btn) return;
    let fav = false;
    try {
      const t = curTrack();
      if (t && typeof isFavorite === 'function') fav = !!isFavorite(t.path);
    } catch (e) {}
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.setAttribute('fill', fav ? 'currentColor' : 'none');
      btn.classList.toggle('mb-fav-on', fav);
      btn.title = fav ? '取消收藏' : '收藏';
    }
    btn.disabled = !curTrack();
    btn.style.opacity = curTrack() ? '' : '0.4';
  }

  function installFavBtn() {
    if (document.getElementById('mb-fav')) return;
    const play = document.getElementById('btn-play');
    if (!play) return;
    // 位置：播放键右侧一组（对应专辑页「播放键右边那排控制键」，收藏在专辑页右侧独立一组，
    // 这里跟着下一首后面，和专辑页的相对次序一致）
    const next = document.getElementById('btn-next');
    const btn = document.createElement('button');
    btn.id = 'mb-fav';
    btn.className = 'ctl';
    btn.title = '收藏';
    btn.innerHTML = favSvg();
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const t = curTrack();
      if (!t) { toastBox('还没有在播放的歌曲'); return; }
      try {
        if (typeof toggleFavorite === 'function') toggleFavorite(t.path);
        if (typeof isFavorite === 'function' && !isFavorite(t.path)) toastBox('已取消收藏');
        else toastBox('已收藏');
      } catch (err) {}
      syncFavBtn();
    });
    if (next && next.parentElement) next.after(btn);
    else play.after(btn);
    syncFavBtn();
  }

  // ---- 3) 歌单/列表：单击播放，单击歌手/专辑进筛选 ----
  function installListClicks() {
    const list = document.getElementById('track-list');
    if (!list || list.dataset.mbClick) return;
    list.dataset.mbClick = '1';
    list.addEventListener('click', function (e) {
      // Ctrl/Shift 多选是桌面语义，保留原生处理
      if (e.ctrlKey || e.shiftKey || e.metaKey) return;
      const row = e.target.closest('.track-row');
      if (!row) return;
      // 行内按钮（收藏/歌单/播放/下一首）自己处理
      if (e.target.closest('.row-actions')) return;
      const idx = Number(row.dataset.idx);
      const t = S.tracks[idx];
      if (!t) return;

      // 1.0.17：点歌手 / 专辑格子不再跳筛选，一律当作「播放这一行」。
      // app.js 里 t-album 自带一个 click 监听（会 toggleTrackFilter 跳筛选）、t-artist 是双击筛选，
      // 这里在捕获阶段 stopPropagation，事件到不了行内那两个监听，只走播放
      const isMetaCell = !!e.target.closest('.t-artist, .t-album');
      if (isMetaCell) {
        e.stopPropagation();
        e.preventDefault();
        // 双击会被拆成两次 click：400ms 内重复点同一首不重复触发，免得自己把自己暂停
        const nowT = Date.now();
        if (idx === lastListClickIdx && nowT - lastListClickAt < 400) return;
        lastListClickIdx = idx;
        lastListClickAt = nowT;
      }

      // 单击 = 播放（桌面是双击，触屏上双击容易误操作）
      if (t.isPlaceholder) { toastBox('本地无此歌曲，无法播放'); return; }
      if (t.isOnline) return;
      if (typeof playAt === 'function') playAt(idx);
    }, true);

    // 歌手格子桌面版是「双击筛选」，同样拦掉，避免双击变跳页
    list.addEventListener('dblclick', function (e) {
      if (!e.target.closest('.t-artist, .t-album')) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  let lastListClickIdx = -1;
  let lastListClickAt = 0;

  // ---- 4) 跳浏览器前先确认 ----
  function confirmJump(url) {
    return new Promise(function (resolve) {
      const mask = document.createElement('div');
      mask.id = 'mb-confirm';
      const host = (function () {
        try { return new URL(url).host; } catch (e) { return ''; }
      })();
      mask.innerHTML =
        '<div class="mb-confirm-card">' +
          '<div class="mb-confirm-title">要在浏览器里打开吗？</div>' +
          '<div class="mb-confirm-url">' + (host || url || '') + '</div>' +
          '<div class="mb-confirm-btns">' +
            '<button type="button" class="mb-btn" data-act="cancel">留在 App</button>' +
            '<button type="button" class="mb-btn primary" data-act="ok">去浏览器</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);
      function done(ok) {
        mask.remove();
        resolve(ok);
      }
      mask.addEventListener('click', function (e) {
        if (e.target === mask) return done(false);
        const act = e.target.closest('[data-act]');
        if (!act) return;
        done(act.dataset.act === 'ok');
      });
    });
  }

  function wrapExternal(url) {
    if (!url) return Promise.resolve(false);
    return confirmJump(url).then(function (ok) {
      if (!ok) return false;
      return nativeCall('openExternal', { url: url }).then(function () { return true; }).catch(function () { return true; });
    });
  }

  // ---- 5) 全部装好（必须在 app.js 建完 DOM 之后跑）----
  function adaptTouchUI() {
    installFavBtn();
    installListClicks();

    // 播放页右下角：桌面版那个 F11 全屏键在手机上没意义，藏掉（音量条在 CSS 里加长）
    // 注意别藏错：1.0.14 我们在左下角新加的沉浸全屏键是 mb-pf-fs，这个是桌面版的 pf-fs
    const fs = document.getElementById('pf-fs');
    if (fs) fs.style.display = 'none';

    // 均衡器（1.0.6 起彻底去掉）：两个入口（底栏 btn-eq / 播放页 pf-eq）都藏掉，
    // 只留 CSS 隐藏，app.js 的原监听器不去碰，避免动了共享代码
    ['btn-eq', 'pf-eq'].forEach(function (id) {
      const btn = document.getElementById(id);
      if (btn) { btn.style.display = 'none'; btn.setAttribute('aria-hidden', 'true'); }
    });

    // 播放页中间组去掉「均衡器」后剩 6 个按钮（左 3 / 右 2），播放键就不在几何中心了。
    // 补一个等宽的隐形占位把左右配平，播放键重新落在窗口正中（平板上一眼就能看出来歪）。
    const pfPlay = document.getElementById('pf-play');
    const pfCenter = pfPlay && pfPlay.parentElement;
    if (pfCenter && !document.getElementById('mb-pf-spacer')) {
      const spacer = document.createElement('span');
      spacer.id = 'mb-pf-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.cssText = 'display:inline-block;height:1px;visibility:hidden;';
      pfCenter.appendChild(spacer);
    }

    // 「词」按钮 + 顶部歌词条：1.0.7 整体下线（那条灰带用户觉得丑，直接去掉）。
    // 按钮也就没了用途，一起藏掉；桌面版的三档模式菜单同样永久隐藏。
    const lyricBtn = document.getElementById('btn-desktop-lyric');
    if (lyricBtn) { lyricBtn.style.display = 'none'; lyricBtn.setAttribute('aria-hidden', 'true'); }
    // 1.0.9：列表页（歌单页）的「歌词」按钮也一起去掉——它的歌词面板交给播放页，
    // 页脚那排只留静音和音量，别再挤掉音量条的位置。
    const lyricsBtn = document.getElementById('btn-lyrics');
    if (lyricsBtn) { lyricsBtn.style.display = 'none'; lyricsBtn.setAttribute('aria-hidden', 'true'); }
    const lyricsPanel = document.getElementById('lyrics-panel');
    if (lyricsPanel) { lyricsPanel.hidden = true; lyricsPanel.style.display = 'none'; }
    const dlm = document.getElementById('desktop-lyric-menu');
    if (dlm) { dlm.hidden = true; dlm.style.display = 'none'; }
    // 老配置里可能还留着 desktopLyric: 'taskbar'，启动就压成 off，别让 app.js 再去挂悬浮条
    try {
      if (typeof S !== 'undefined' && S.settings && S.settings.desktopLyric && S.settings.desktopLyric !== 'off') {
        S.settings.desktopLyric = 'off';
      }
    } catch (e) {}
    nativeCall('topLyricHide', {}).catch(function () {});

    // 1.0.9：角落版本号（用户要求"在某一个角落能看到当前版本"）。
    // 挂在左侧栏最底部（sticky，滚动时不跑），小字、低对比，不抢视线。
    if (!document.getElementById('mb-corner-ver')) {
      try {
        const ver = String(mb.version || '1.0.9-android').replace('-android', '');
        const box = document.createElement('div');
        box.id = 'mb-corner-ver';
        box.textContent = '安卓HD v' + ver;
        box.title = 'MusicSMX HD ' + ver;
        const sb = document.getElementById('sidebar');
        if (sb) sb.appendChild(box);
        else (document.getElementById('app') || document.body).appendChild(box);
      } catch (e) {}
    }

    // 外链：拦截 mb.openExternal 与 window.open
    if (mb && mb.openExternal && !mb._mbWrapped) {
      mb._mbWrapped = true;
      mb.openExternal = function (url) { return wrapExternal(url); };
    }
    if (!window._mbOpenWrapped) {
      window._mbOpenWrapped = true;
      window.open = function (url) {
        if (!url) return null;
        wrapExternal(String(url));
        return null;
      };
    }
  }

  function ensureMediaBase() {
    if (MEDIA.ready) return;
    mediaBaseTries++;
    nativeCall('getMediaBase').then(function (r) {
      if (r && r.base) {
        MEDIA.base = r.base;
        MEDIA.token = r.token || '';
        MEDIA.ready = true;
        console.log('[mb] media base =', r.base);
      } else if (mediaBaseTries < 40) {
        setTimeout(ensureMediaBase, 300);
      }
    }).catch(function (e) {
      // Capacitor 注入存在竞态：native-bridge 还没跑起来时这里会失败，退避重试即可
      if (mediaBaseTries < 40) setTimeout(ensureMediaBase, 300);
      else console.warn('[mb] getMediaBase failed', e);
    });
  }

  /** 启动时主动拉一次真实 insets：原生 push 可能打在还没加载完的页面上而丢掉 */
  function pullInsets() {
    nativeCall('getInsets', {}).then(function (r) {
      if (!r) return;
      window.__mbInsets(r.top, r.right, r.bottom, r.left, mbInsets.extraTop);
      console.log('[mb] insets', JSON.stringify(r));
    }).catch(function () {});
  }

  /**
   * 均衡器静音兜底（安卓版已无 EQ 界面，但老配置可能还留着「已启用」）。
   * 只要 eq.on 或 eq.chainOn 为真，<audio> 的音频就永久走 AudioContext；
   * WebView 里 AudioContext 常常停在 suspended，于是「在播但没声」。这里：
   *   ① 强制把 EQ 关成平坦（增益全 0、预增益 1、preset=flat）；
   *   ② 已经搭起来的音频图不拆（拆了反而更没声），改为在首次触摸时 ctx.resume()。
   */
  function guardEqSilence() {
    try {
      if (typeof eq === 'undefined' || !eq) return;
      // 有上下文但没跑：等到用户第一次碰屏幕时恢复（Web Audio 需要手势）
      try {
        if (eq.ctx && eq.ctx.state !== 'running' && !guardEqSilence._hooked) {
          guardEqSilence._hooked = true;
          const resume = function () { try { eq.ctx.resume(); console.log('[mb] eq ctx resumed'); } catch (e) {} };
          document.addEventListener('touchstart', resume, { once: true, passive: true });
          document.addEventListener('pointerdown', resume, { once: true });
        }
      } catch (e) {}
      if (!eq.on && !eq.chainOn) return;
      // 1) 内存里关掉
      eq.on = false;
      eq.preampDb = 0;
      eq.preset = 'flat';
      if (Array.isArray(eq.gains)) for (let i = 0; i < eq.gains.length; i++) eq.gains[i] = 0;
      if (eq.chainOn && typeof applyEqToGraph === 'function') {
        try { applyEqToGraph(false); } catch (e) {}
      }
      // 2) 配置里也关掉，免得下次启动又搭一遍
      try {
        if (typeof S !== 'undefined' && S.settings) {
          S.settings.eq = { on: false, preamp: 0, preset: 'flat', gains: eq.gains ? eq.gains.slice() : [] };
          if (typeof saveConfig === 'function') saveConfig();
        }
      } catch (e) {}
      console.log('[mb] eq guard: 均衡器已强制关闭（旧版残留会静音）');
      try { toastBox('已关闭均衡器（旧版本残留会导致无声）'); } catch (e) {}
    } catch (e) {}
  }

  // ---------------- 1.0.12/1.0.13：列表行左侧缩略封面 ----------------
  // 只留 96px 小图（约 3~5KB），不把原图塞进 WebView。取图顺序按「最快出图」排：
  //  1) 磁盘上已有的专辑缩略图（key = alb:歌手|专辑）—— 重启后第一批全靠它，零网络；
  //  2) 联网「快枪」搜索（online.js 的 searchCoverFast：五个源并发抢 + 3.2s 预算），
  //     并且直接下源给的 thumbUrl（200/300px），不再下 600~800 的大图；
  //  3) 前面都没出图，才去读文件内嵌封面（实测这批曲库基本没有内嵌封面，只是兜底）；
  //  搜不到的专辑写入负缓存（localStorage，7 天），下次启动不再浪费请求。
  const THUMB = {
    mem: new Map(),        // albumKey -> dataUrl
    missFile: new Set(),   // path -> 内嵌封面确认没有
    jobs: new Map(),       // albumKey -> job（同一专辑只跑一次）
    dead: new Set(),       // 本次运行「连续 3 次」都拿不到的专辑，别再重排
    fails: new Map(),      // albumKey -> 本次运行失败次数（1.0.22：失败可重排，不再一次就拉黑）
    nextAt: new Map(),     // albumKey -> 下次允许重排的时间（退避冷却，别一失败就立刻重打接口）
    tries: 3,              // 同一张专辑最多试几次
    backoff: 12000,        // 重试间隔基数（第 n 次失败等 n×backoff；一次 job 里已含精搜，所以不用等那么久）
    persist: new Set(),    // 已经用 app.js 的单曲封面顶过专辑缩略图的 key（别重复写盘）
    queue: [],
    inflight: 0,
    max: 8,                // 1.0.22：并发路数。原本 4，一度降到 3 是为了绕开「下载全挂」引发的空转，
                           // 但真正的元凶是酷我图床 https 握手失败（改 http 后 dlFail=0），
                           // 于是放开到 8：一屏 33 张图从 20s+ 压到 10s 左右。
    scrollAt: 0,           // 最近一次用户滚动时间（滚动中不做预取，免得把可见区的队排到后面）
    fp: new Map(),         // 1.0.22：缩略图指纹 → 占用它的专辑 key（用来揪「多张专辑同一张图」的通用占位图）
    weak: new Set(),       // 1.0.22：目前行上贴的是「占位/共用图」的专辑 key（还没等到真封面）
    neg: {},
    negLoaded: false,
  };

  function loadThumbNeg() {
    if (THUMB.negLoaded) return;
    THUMB.negLoaded = true;
    try {
      const raw = localStorage.getItem('mb_thumb_neg_v3');
      THUMB.neg = raw ? JSON.parse(raw) : {};
    } catch (e) { THUMB.neg = {}; }
  }

  function saveThumbNeg() {
    try { localStorage.setItem('mb_thumb_neg_v3', JSON.stringify(THUMB.neg)); } catch (e) {}
  }

  function negTs(rec) {
    if (typeof rec === 'number') return rec;             // 老格式：直接存的时间戳
    return rec && rec.t ? rec.t : 0;
  }

  function negCount(rec) {
    if (typeof rec === 'number') return 1;
    return rec && rec.n ? rec.n : 1;
  }

  function markThumbNeg(key) {
    loadThumbNeg();
    // 只失败一次不算「这专辑没封面」——网络抖一下就永久拉黑，歌单页会一直缺图。
    // 记次数，连着失败 3 次才真正跳过。
    const prev = THUMB.neg[key];
    THUMB.neg[key] = { n: negCount(prev) + 1, t: Date.now() };
    // 负缓存别无限长，超过 300 条就清掉最旧的一半
    const keys = Object.keys(THUMB.neg);
    if (keys.length > 300) {
      keys.sort(function (a, b) { return negTs(THUMB.neg[a]) - negTs(THUMB.neg[b]); });
      for (let i = 0; i < 150; i++) delete THUMB.neg[keys[i]];
    }
    saveThumbNeg();
  }

  function clearThumbNeg(key) {
    loadThumbNeg();
    if (THUMB.neg[key]) { delete THUMB.neg[key]; saveThumbNeg(); }
  }

  function thumbNegFresh(key) {
    loadThumbNeg();
    const rec = THUMB.neg[key];
    if (!rec) return false;
    // 1.0.20：7 天太久 —— 网络抖三下就把一张专辑封了 7 天，发如雪这种就是被这么坑掉的。
    // 1.0.22：改 6 小时，并且换了存储键（mb_thumb_neg_v3）—— 老记录全是"失败一次就拉黑"时代留下的，
    //         留着只会让用户升级后还是那批歌没图。
    return (Date.now() - negTs(rec) < 6 * 3600 * 1000) && negCount(rec) >= 3;
  }

  function thumbBox(row) {
    let box = row.querySelector('.mb-row-cover');
    if (!box) {
      box = document.createElement('div');
      box.className = 'mb-row-cover';
      box.innerHTML = '<span class="mb-cover-ph">&#9835;</span>';
      row.insertBefore(box, row.firstChild);
    }
    return box;
  }

  function paintThumb(row, url, force) {
    const box = thumbBox(row);
    if (!force && box.dataset.ready === '1' && box.firstChild && box.firstChild.tagName === 'IMG') return;
    box.dataset.ready = '1';
    box.innerHTML = '';
    const img = document.createElement('img');
    img.decoding = 'async';
    img.src = url;
    box.appendChild(img);
  }

  function albumKeyOf(t) {
    // 1.0.18：键前面加版本号 —— 老版本有一批专辑缩略图抓到了「黑胶唱片」那种默认图
    // （酷狗/酷我 搜不到时塞的占位图），落盘后一直赢，行里永远显示那张假的。
    // 换个命名空间让老文件自然作废，重新按新规则抓一遍。
    return 'albv18:' + ((t.artist || '') + '|' + (t.album || t.title || '')).toLowerCase();
  }

  // ---------------- 1.0.19：左下角缩略封面「点即出图」 ----------------
  // 现象：点一首还没抓过封面的歌，左下角先闪一下渐变色 ♪ 占位，约 1 秒后才换成真封面。
  // 原因：app.js 的 updateNowPlaying() 只认 t.cover，而 t.cover 得等 fetchAndApplyCover()
  // 联网（或读本地封面文件）回来才赋值；可列表这边早就把这首歌的专辑缩略图抓在手里了。
  // 这里不改 app.js，只在「已知图」里挑一张先贴上去；app.js 的真封面晚到时会自己清空重画。
  function footerCoverEl() {
    return document.getElementById('cover');
  }

  function knownCoverFor(t) {
    if (!t) return null;
    if (t.cover) return { url: t.cover, from: 'track' };
    try {
      if (S.coverCache && S.coverCache.has(t.path)) return { url: S.coverCache.get(t.path), from: 'cache' };
    } catch (e) {}
    try {
      const mem = THUMB.mem.get(albumKeyOf(t));
      if (mem) return { url: mem, from: 'thumb' };
    } catch (e) {}
    // 行里已经画好的那张（当前曲一般在可见区内）
    try {
      const row = document.querySelector('.track-row[data-idx="' + S.current + '"]');
      const img = row && row.querySelector('.mb-row-cover img');
      if (img && img.getAttribute('src')) return { url: img.getAttribute('src'), from: 'row' };
    } catch (e) {}
    return null;
  }

  /** 当前曲的专辑图还不知道 → 插队到缩略图队列最前面，几百毫秒内就能贴上去 */
  function primeFooterThumb(t) {
    try {
      if (!t || !t.path) return;
      const key = albumKeyOf(t);
      if (THUMB.mem.has(key) || THUMB.dead.has(key)) return;
      const queued = THUMB.jobs.get(key);
      if (queued) {
        const i = THUMB.queue.indexOf(queued);
        if (i > 0) { THUMB.queue.splice(i, 1); THUMB.queue.unshift(queued); }
        return;
      }
      const job = { key: key, path: t.path, artist: t.artist || '', title: t.title || '', album: t.album || '' };
      THUMB.jobs.set(key, job);
      THUMB.queue.unshift(job);
      pumpThumbs();
    } catch (e) {}
  }

  function paintFooterCover() {
    try {
      const el = footerCoverEl();
      if (typeof S === 'undefined' || !S.tracks || S.current < 0) return;
      const cur = S.tracks[S.current];
      if (!el || !cur) return;
      const img = el.querySelector('img');
      // 已经有 app.js 贴的正式封面（没打 mbFast 标）→ 不动它
      if (img && img.dataset.mbFast !== '1') return;
      const best = knownCoverFor(cur);
      if (!best) { primeFooterThumb(cur); return; }
      if (img && img.dataset.mbFast === '1' && img.dataset.mbSrc === best.from) return;
      el.textContent = '';
      el.style.background = '';
      const nimg = document.createElement('img');
      nimg.dataset.mbFast = '1';
      nimg.dataset.mbSrc = best.from;
      nimg.decoding = 'async';
      nimg.src = best.url;
      el.appendChild(nimg);
    } catch (e) {}
  }

  /** 把「点即出图」的几个入口挂上：updateNowPlaying 包装 + 封面区 DOM 变化监听 */
  function installFooterCoverFast() {
    try {
      const el = footerCoverEl();
      if (el && !el.dataset.mbObs) {
        el.dataset.mbObs = '1';
        // 兜底：不管 app.js 从哪条路径重画左下角（切歌/换主题/清空），只要画成占位就补一张已知图
        new MutationObserver(function () { paintFooterCover(); }).observe(el, { childList: true });
      }
      if (typeof window.updateNowPlaying === 'function' && !window.__mbNpWrapped) {
        const origNp = window.updateNowPlaying;
        window.updateNowPlaying = function () {
          const r = origNp.apply(this, arguments);
          paintFooterCover();
          return r;
        };
        window.__mbNpWrapped = true;
      } else if (!window.__mbNpWrapped) {
        // 函数还没挂到 window 上（app.js 尚未跑完）：稍后再试
        setTimeout(installFooterCoverFast, 300);
      }
    } catch (e) {}
  }

  /** 1.0.20：手动重抓某首（长按左下角封面触发）—— 清负缓存/失效标记，再走一遍正常流程 */
  function forceRefetchCover(t) {
    try {
      if (!t || !t.path) return;
      const key = albumKeyOf(t);
      loadThumbNeg();
      if (THUMB.neg[key]) { delete THUMB.neg[key]; saveThumbNeg(); }
      THUMB.dead.delete(key);
      THUMB.mem.delete(key);
      try { if (S.coverCache) S.coverCache.delete(t.path); } catch (e) {}
      try { t.cover = null; } catch (e) {}
      try { toastBox('正在重新抓这张封面…'); } catch (e) {}
      primeFooterThumb(t);
      // app.js 的高分辨率封面也让它重来一次
      try {
        if (typeof window.fetchAndApplyCover === 'function') window.fetchAndApplyCover(t, true);
        else if (typeof fetchAndApplyCover === 'function') fetchAndApplyCover(t, true);
      } catch (e) {}
    } catch (e) {}
  }

  /** 长按左下角封面 = 重抓当前这首的封面（小米平板没有长按菜单，这样最顺手） */
  function installFooterRefetch() {
    try {
      const el = footerCoverEl();
      if (!el || el.dataset.mbRefetch) return;
      el.dataset.mbRefetch = '1';
      let timer = 0;
      const cancel = function () { if (timer) { clearTimeout(timer); timer = 0; } };
      el.addEventListener('pointerdown', function () {
        cancel();
        timer = setTimeout(function () {
          timer = 0;
          try {
            if (typeof S === 'undefined' || S.current < 0) return;
            forceRefetchCover(S.tracks[S.current]);
          } catch (e) {}
        }, 650);
      });
      ['pointerup', 'pointercancel', 'pointermove', 'pointerleave'].forEach(function (ev) {
        el.addEventListener(ev, cancel, { passive: true });
      });
    } catch (e) {}
  }

  function rowTrack(row) {
    try {
      const idx = parseInt(row.dataset.idx, 10);
      if (isNaN(idx) || typeof S === 'undefined' || !S.tracks) return null;
      const t = S.tracks[idx];
      if (!t || !t.path || t.isOnline) return null;
      return t;
    } catch (e) { return null; }
  }

  /** 把任意尺寸的封面 dataUrl 居中裁方缩到 size，返回 JPEG dataUrl */
  function downscaleCover(dataUrl, size) {
    return new Promise(function (resolve) {
      try {
        const img = new Image();
        img.onload = function () {
          try {
            const c = document.createElement('canvas');
            c.width = size;
            c.height = size;
            const g = c.getContext('2d');
            const side = Math.min(img.width, img.height);
            g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
            resolve(c.toDataURL('image/jpeg', 0.78));
          } catch (e) { resolve(null); }
        };
        img.onerror = function () { resolve(null); };
        img.src = dataUrl;
      } catch (e) { resolve(null); }
    });
  }

  // ===== 1.0.18：识别「占位/默认封面」 =====
  // 有些源（酷狗/酷我之类）搜不到专辑时会返回一张通用的「黑胶唱片」占位图：
  // 大面积近白底 + 中间一圈很暗的唱片。真封面几乎不会有这种配色（实测真封面
  // whiteFrac≈0.01 / center≈160，那张黑胶 whiteFrac≈0.20 / center≈64），
  // 所以用「近白像素占比 > 12% 且 中心亮度 < 110」来判定。
  function looksLikeDefaultCover(dataUrl) {
    return new Promise(function (resolve) {
      try {
        const img = new Image();
        img.onload = function () {
          try {
            const N = 32;
            const c = document.createElement('canvas');
            c.width = N; c.height = N;
            const g = c.getContext('2d');
            g.drawImage(img, 0, 0, N, N);
            const d = g.getImageData(0, 0, N, N).data;
            let white = 0, total = 0, cs = 0, cn = 0;
            for (let y = 0; y < N; y++) {
              for (let x = 0; x < N; x++) {
                const k = (y * N + x) * 4;
                const r = d[k], gg = d[k + 1], b = d[k + 2];
                if (r > 235 && gg > 235 && b > 235) white++;
                total++;
                if (x > N * 0.32 && x < N * 0.68 && y > N * 0.32 && y < N * 0.68) {
                  cs += (r + gg + b) / 3; cn++;
                }
              }
            }
            const whiteFrac = white / total;
            const center = cn ? cs / cn : 255;
            resolve(whiteFrac > 0.12 && center < 110);
          } catch (e) { resolve(false); }
        };
        img.onerror = function () { resolve(false); };
        img.src = dataUrl;
      } catch (e) { resolve(false); }
    });
  }

  // 联网取缩略图：快枪搜索 → 下 thumbUrl（小图）→ canvas 缩到 96px → 写盘
  //   顺带把各阶段失败记到 window.__thumbStats，方便在真机上直接查「到底卡在哪一步」
  const THUMB_STATS = { ok: 0, searchFail: 0, dlFail: 0, smallFail: 0, defaultImg: 0, genericImg: 0, timeout: 0, drop: 0, failLog: [] };
  try { window.__thumbStats = THUMB_STATS; } catch (e) {}
  function thumbFail(key, stage) {
    THUMB_STATS[stage]++;
    if (THUMB_STATS.failLog.length < 30) THUMB_STATS.failLog.push(stage + ':' + key);
  }

  // ===== 1.0.22：揪出「多张专辑共用同一张图」的通用占位图 =====
  // 源站搜不到封面时会塞一张通用的唱片图（酷狗/酷我/网易云都给，而且往往是同一张）。
  // 1.0.18 的白底判据抓不住全部（实测有 whiteFrac=0、中心亮度 13 的深色唱片图）。
  // 更硬的办法：同一张缩略图如果出现在第二张「不同专辑」上，它就不可能是真封面。
  // 但它比「一片空白 ♪」还是好看 —— 所以当「弱图」先顶上去（不落盘、标记 THUMB.weak），
  // 后台继续按 12s/24s 退避找真封面，找到了再整块换掉（见 syncRowCover / forceRepaintKey）。
  function coverFp(small) { return small.length + ':' + small.slice(-64); }
  function coverIsGeneric(key, small) {
    const fp = coverFp(small);
    const prev = THUMB.fp.get(fp);
    if (prev && prev !== key) return true;
    if (THUMB.fp.size > 900) THUMB.fp.clear();
    THUMB.fp.set(fp, key);
    return false;
  }

  /** 某专辑拿到真图了 → 把已经贴上「弱图」的行强制重画一遍 */
  function forceRepaintKey(key) {
    try {
      const url = THUMB.mem.get(key);
      if (!url) return;
      const rows = document.querySelectorAll('#track-list .track-row');
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].dataset.mbCoverKey === key) {
          paintThumb(rows[i], url, true);
          rows[i].dataset.mbCoverFrom = 'thumb';
        }
      }
    } catch (e) {}
  }

  function fetchThumbOnline(job) {
    return new Promise(function (resolve) {
      const O = window.__online;
      let auto = true;
      try { auto = S && S.settings ? S.settings.autoCover !== false : true; } catch (e) {}
      if (!O || !auto) { resolve(null); return; }
      // 1.0.22 实测：一次 job 里「快枪失败立刻精搜」会让单张专辑耗时翻十倍（精搜是源×变体串行），
      // 排在后面的行反而更晚出图（冷缓存滚屏时出现过「一屏 33 行只出 1 张」）。
      // 所以退回到「第一次快枪、第二次以后精搜」，只是把退避从 25s 收到 12s。
      const fast = O.searchCoverFast || O.searchCover;
      const search = (job.deep && typeof O.searchCover === 'function') ? O.searchCover : fast;
      if (typeof search !== 'function') { resolve(null); return; }
      // 拿搜索结果的图地址 → 下载 → 缩 96 → 判占位图/共用图；weak=只能当临时占位
      const take = function (info) {
        const url = info && (info.thumbUrl || info.url);
        if (!url) return Promise.resolve(null);
        return O.downloadCover(url).then(function (dataUrl) {
          if (!dataUrl) { thumbFail(job.key, 'dlFail'); return null; }
          return downscaleCover(dataUrl, 96).then(function (small) {
            if (!small) return null;
            return looksLikeDefaultCover(small).then(function (isDefault) {
              const generic = coverIsGeneric(job.key, small);
              if (isDefault) THUMB_STATS.defaultImg++;
              if (generic) THUMB_STATS.genericImg++;
              return { url: small, weak: !!(isDefault || generic) };
            });
          });
        }).catch(function () { return null; });
      };
      search(job.artist, job.title, 2600, job.album).then(take).then(function (res) {
        if (res && res.url) {
          if (res.weak) {
            THUMB.weak.add(job.key);      // 弱图先顶上，不写盘；后台继续找真图
          } else {
            THUMB.weak.delete(job.key);
            THUMB_STATS.ok++;
            mb.saveThumb(job.key, res.url).catch(function () {});
          }
          resolve(res.url);
        } else {
          thumbFail(job.key, 'searchFail');
          resolve(null);
        }
      }).catch(function () { thumbFail(job.key, 'searchFail'); resolve(null); });
    });
  }

  /** 1.0.22：失败退避重试（最多 3 次，间隔 12s / 24s） */
  function scheduleThumbRetry(job) {
    const n = (THUMB.fails.get(job.key) || 0) + 1;
    THUMB.fails.set(job.key, n);
    if (n >= THUMB.tries) {
      THUMB.dead.add(job.key);
      THUMB.nextAt.delete(job.key);
      markThumbNeg(job.key);      // 跨重启也记住，但 12 小时后会自己解禁
      thumbFail(job.key, 'drop');
      return;
    }
    const delay = THUMB.backoff * n;
    job.deep = true;   // 重试走精搜
    // 冷却期内的 key 不许被"扫一遍就重排"的定时任务立刻再派一次
    THUMB.nextAt.set(job.key, Date.now() + delay);
    setTimeout(function () {
      if (THUMB.dead.has(job.key)) return;
      // 已有「真图」就别再抢；只有弱图（占位/共用图）时继续找
      if (THUMB.mem.has(job.key) && !THUMB.weak.has(job.key)) return;
      THUMB.nextAt.delete(job.key);
      if (THUMB.jobs.has(job.key)) return;
      THUMB.jobs.set(job.key, job);
      if (THUMB.queue.indexOf(job) < 0) THUMB.queue.unshift(job);  // 重试也走优先位
      pumpThumbs();
    }, delay);
  }

  function runThumbJob(job) {
    THUMB.inflight++;
    let settled = false;
    let watchdog = 0;
    const done = function (url) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      THUMB.inflight--;
      THUMB.jobs.delete(job.key);
      if (url) {
        if (THUMB.mem.size > 600) THUMB.mem.clear();
        THUMB.mem.set(job.key, url);
        const wasWeak = THUMB.weak.has(job.key);
        if (wasWeak) {
          // 先贴着占位/共用图，但真封面还没到手 → 继续退避重试（找到了 forceRepaintKey 会整块换掉）
          scheduleThumbRetry(job);
        } else {
          clearThumbNeg(job.key);
          THUMB.fails.delete(job.key);
          if (wasWeak === false && THUMB.fp.size) forceRepaintKey(job.key);
        }
        // 1.0.19：刚拿到当前这首歌的专辑图 → 顺手把左下角那张占位图换掉
        try {
          if (typeof S !== 'undefined' && S.current >= 0 && job.key === albumKeyOf(S.tracks[S.current])) paintFooterCover();
        } catch (e) {}
      } else {
        // 1.0.22：失败不再"一次就拉黑"。用户反馈"有些歌不点它就不出图"，
        // 根因就是这里一次失败就把专辑塞进 dead、本次运行永不再试，
        // 只能等他点播放让 app.js 自己那条链路把封面补上来。
        // 改成：最多试 3 次，第 n 次失败后隔 n×25s 再排一次；3 次都空才真放弃。
        scheduleThumbRetry(job);
      }
      scheduleThumbPass();
      pumpThumbs();
    };
    // 1.0.22：看门狗。原来 fetchThumbOnline 里任何一步卡住（httpFetch 挂起、
    // 某首歌的封面接口不回包），inflight 就永远不还，pumpThumbs 卡在 max 上不再派活 ——
    // 表现就是"整个列表的缩略图突然集体不加载了"。22 秒还没结果就当失败，放回队列重试。
    watchdog = setTimeout(function () {
      if (settled) return;
      thumbFail(job.key, 'timeout');
      done(null);
    }, 22000);
    const tryFile = function () {
      if (THUMB.missFile.has(job.path)) { done(null); return; }
      mb.readThumb(job.path, 96).then(function (r) {
        if (r && r.ok && r.dataUrl) {
          done(r.dataUrl);
          mb.saveThumb(job.key, r.dataUrl).catch(function () {});
          return;
        }
        THUMB.missFile.add(job.path);
        done(null);
      }).catch(function () { done(null); });
    };
    // 1) 磁盘里已有的专辑缩略图
    mb.readThumb('', 96, job.key).then(function (r) {
      if (r && r.ok && r.dataUrl) { done(r.dataUrl); return; }
      // 2) 联网（负缓存里的 7 天内直接跳过，别再空跑一次搜索）
      if (thumbNegFresh(job.key)) { tryFile(); return; }
      fetchThumbOnline(job).then(function (url) {
        if (url) { done(url); return; }
        markThumbNeg(job.key);
        tryFile();
      }).catch(function () { tryFile(); });
    }).catch(function () { done(null); });
  }

  function pumpThumbs() {
    while (THUMB.inflight < THUMB.max && THUMB.queue.length) {
      const job = THUMB.queue.shift();
      if (!job) break;
      runThumbJob(job);
    }
  }

  function syncRowCover(row) {
    if (row.classList.contains('online-row')) return;
    const t = rowTrack(row);
    if (!t) return;
    const key = albumKeyOf(t);
    let box = row.querySelector('.mb-row-cover');
    if (row.dataset.mbCoverKey !== key) {
      row.dataset.mbCoverKey = key;
      delete row.dataset.mbCoverFrom;
      if (box) { box.dataset.ready = '0'; box.innerHTML = '<span class="mb-cover-ph">&#9835;</span>'; }
    }
    if (box && box.dataset.ready === '1' && row.dataset.mbCoverFrom === 'track') return;
    // 1.0.22：行上贴的是「弱图」（占位/共用图）→ 下面拿到真图要强制盖掉，不能因为 ready=1 就跳过
    const weak = THUMB.weak.has(key);
    // 1.0.14：页脚/海报页那边 app.js 自己联网拿到的封面（S.coverCache 按 path 存 dataUrl）
    // 也拿来给行用 —— 用户反馈「左下角有封面、列表里同一首却没图」就是这条路没接上：
    // 两条链路（行缩略图按「专辑」、app.js 封面色按「单曲」）各查各的。
    let cached = null;
    try { cached = S && S.coverCache ? S.coverCache.get(t.path) : null; } catch (e) {}
    // 顺手把这张图当「本专辑缩略图」落盘：同一专辑的其他首歌下次直接读盘，
    // 不用再各搜一次（app.js 是按单曲抓的，不落这张盘）
    if (cached && !THUMB.mem.has(key) && !THUMB.persist.has(key)) {
      THUMB.persist.add(key);
      downscaleCover(cached, 96).then(function (small) {
        if (small) { THUMB.mem.set(key, small); mb.saveThumb(key, small).catch(function () {}); }
      });
    }
    // 1.0.18：这首自己的封面（app.js 按单曲抓的真封面）永远优先，而且是「后到也要盖上去」——
    // 之前行先被专辑缩略图（有时还是黑胶占位图）画好了，后来 t.cover 到了也不重画，
    // 用户看到的就是「打上花火有封面却是张假唱片」
    if (t.cover && row.dataset.mbCoverFrom !== 'track') {
      paintThumb(row, t.cover, true);
      row.dataset.mbCoverFrom = 'track';
      THUMB.weak.delete(key);      // app.js 的单曲封面当「真图」，弱图标记作废
      return;
    }
    if (box && box.dataset.ready === '1' && !weak) return;
    const url = cached || THUMB.mem.get(key);
    if (url) {
      paintThumb(row, url, weak);
      row.dataset.mbCoverFrom = cached && !THUMB.mem.has(key) ? 'track' : 'thumb';
      return;
    }
    thumbBox(row);                              // 先占位，行高不抖
    if (THUMB.jobs.has(key) || THUMB.dead.has(key)) return;
    // 1.0.22：退避冷却中（这张专辑刚失败过），等冷却结束那支定时器自己重排，别在这儿空转
    if (THUMB.nextAt.has(key) && Date.now() < THUMB.nextAt.get(key)) return;
    // 滑动很快时一行只会被扫到一次，这时先别发请求（发了也是白花流量）；
    // 停住不动会有第二次扫描（见 scheduleThumbPass 里的补扫定时器），那时才排队。
    const seen = (parseInt(row.dataset.mbSeen, 10) || 0) + 1;
    row.dataset.mbSeen = String(seen);
    if (seen < 2) return;
    const job = { key: key, path: t.path, artist: t.artist || '', title: t.title || '', album: t.album || '' };
    THUMB.jobs.set(key, job);
    THUMB.queue.unshift(job);   // 1.0.22：可见行的队插到最前面（预取的在后面排队，别抢可见区的网速）
    pumpThumbs();
  }

  // 往下多抓一点：可见区域之后一小段提前排队，用户往下滑的时候不用等。
  // 1.0.22：原来「之后 30 首、队列上限 60」在滚动时会把队列灌满 —— 可见区那几十行反而排在预取后面，
  // 表现就是「滚下去一片 ♪，等半天才出图，点一下播放倒立刻有了」。收成：
  //   ① 只在用户停手 900ms 以上才预取；② 队列里还有活就先不加塞；③ 只预取 8 首、队列上限 10。
  function prefetchAhead(maxVisibleIdx) {
    if (typeof S === 'undefined' || !S.tracks || maxVisibleIdx < 0) return;
    if (Date.now() - THUMB.scrollAt < 900) return;
    if (THUMB.inflight + THUMB.queue.length > 3) return;
    const end = Math.min(S.tracks.length - 1, maxVisibleIdx + 8);
    let added = 0;
    for (let i = maxVisibleIdx + 1; i <= end; i++) {
      if (THUMB.queue.length >= 10 || added >= 8) break;
      const t = S.tracks[i];
      if (!t || !t.path || t.isOnline) continue;
      const key = albumKeyOf(t);
      if (THUMB.mem.has(key) || THUMB.jobs.has(key) || THUMB.dead.has(key) || thumbNegFresh(key)) continue;
      if (THUMB.nextAt.has(key) && Date.now() < THUMB.nextAt.get(key)) continue;
      THUMB.jobs.set(key, { key: key, path: t.path, artist: t.artist || '', title: t.title || '', album: t.album || '' });
      THUMB.queue.push(THUMB.jobs.get(key));
      added++;
    }
    pumpThumbs();
  }

  // 1.0.22：自己这条链路 3 次都没拿到的专辑，最后借 app.js 的单曲封面链路再要一次。
  // 用户描述的现象是「不点它就不出图，点一下播放立刻就有了」—— 播放走的是 app.js 的 fetchAndApplyCover
  // （按单曲、多个变体、更高预算），它拿到的图会写进 S.coverCache，这里下一轮扫描就能贴上行了。
  // 所以对 dead 的专辑，主动替它跑一次 app.js 那条路，等于「不用点播放也能补图」。
  const appCoverTried = new Set();
  function nudgeAppCover(row, limit) {
    if (limit.left <= 0) return;
    const t = rowTrack(row);
    if (!t || t.cover) return;
    if (!THUMB.dead.has(albumKeyOf(t))) return;
    if (appCoverTried.has(t.path)) return;
    try { if (S && S.coverCache && S.coverCache.has(t.path)) return; } catch (e) {}
    if (appCoverTried.size > 400) appCoverTried.clear();
    appCoverTried.add(t.path);
    limit.left--;
    try {
      if (typeof window.fetchAndApplyCover === 'function') window.fetchAndApplyCover(t);
      else if (typeof fetchAndApplyCover === 'function') fetchAndApplyCover(t);
    } catch (e) {}
  }

  let thumbRaf = 0;
  function scheduleThumbPass() {
    if (thumbRaf) return;
    thumbRaf = requestAnimationFrame(function () {
      thumbRaf = 0;
      try {
        const list = document.getElementById('track-list');
        if (!list) return;
        const rows = list.getElementsByClassName('track-row');
        let maxIdx = -1;
        let needAgain = false;
        const limit = { left: 2 };   // 每次扫描最多借 2 首，别把 app.js 那条路也打爆
        for (let i = 0; i < rows.length; i++) {
          syncRowCover(rows[i]);
          nudgeAppCover(rows[i], limit);
          if ((parseInt(rows[i].dataset.mbSeen, 10) || 0) < 2) needAgain = true;
          const idx = parseInt(rows[i].dataset.idx, 10);
          if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
        }
        prefetchAhead(maxIdx);
        // 第一次只算「看见过」不发请求；停住 350ms 后补扫一次，这时才真正去取图
        if (needAgain) setTimeout(scheduleThumbPass, 350);
      } catch (e) {}
    });
  }

  function installRowCovers() {
    if (installRowCovers._done) { scheduleThumbPass(); return; }
    const list = document.getElementById('track-list');
    if (!list) return;
    installRowCovers._done = true;
    loadThumbNeg();
    // 虚拟列表每次滚动都会增删行 → MutationObserver + rAF 合并，只处理可见的那几十行
    try {
      new MutationObserver(scheduleThumbPass).observe(list, { childList: true });
    } catch (e) {}
    list.addEventListener('scroll', function () { THUMB.scrollAt = Date.now(); scheduleThumbPass(); }, { passive: true });
    scheduleThumbPass();
    setTimeout(scheduleThumbPass, 600);
    setTimeout(scheduleThumbPass, 2000);
    // 1.0.14：封面可能是「晚到的」——app.js 联网补封面不经过我们的队列，
    // 它写进 S.coverCache 时列表不会有任何 DOM 变化可观察。低频补扫一遍，
    // 让这些晚到的封面自己贴上去（24 行而已，代价可以忽略）。
    setInterval(scheduleThumbPass, 2500);
  }

  // ============ 1.0.14：播放页（海报页）左下角全屏按钮 + 沉浸模式 ============
  // 沉浸态=只留「专辑封面 + 歌词」，顶栏返回键、播放控制、进度条、歌名歌手都收起来，
  // 封面与歌词各自放大到撑满画面（用户原话：只显示专辑封面和歌词，并进行一定程度的拉伸）。
  const FS_SVG_IN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  const FS_SVG_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';

  function playerFullEl() { return document.getElementById('player-full'); }

  function isImmersive() {
    const pf = playerFullEl();
    return !!(pf && pf.classList.contains('pf-immo'));
  }

  function setImmersive(on) {
    const pf = playerFullEl();
    if (!pf) return;
    pf.classList.toggle('pf-immo', !!on);
    const btn = document.getElementById('mb-pf-fs');
    if (btn) {
      btn.classList.toggle('on', !!on);
      btn.title = on ? '退出全屏（回到完整播放页）' : '全屏沉浸（只显示封面和歌词）';
      btn.innerHTML = on ? FS_SVG_OUT : FS_SVG_IN;
    }
    // 连系统状态栏一起收起来才是真沉浸；失败也不影响页面内的沉浸布局
    try { nativeCall('setImmersiveBars', { on: !!on }).catch(function () {}); } catch (e) {}
    // 系统栏隐藏/恢复会改 insets，让原生再推一次留白，避免下一屏顶到状态栏底下
    setTimeout(function () { try { pullInsets(); } catch (e) {} }, 260);
  }

  function installPosterFs() {
    const ctl = document.querySelector('#player-full .pf-controls');
    if (!ctl) return;
    if (document.getElementById('mb-pf-fs')) return;
    const box = document.createElement('div');
    box.className = 'pf-side pf-side-left';
    const btn = document.createElement('button');
    btn.className = 'pf-ctl mb-fs-btn';
    btn.id = 'mb-pf-fs';
    btn.title = '全屏沉浸（只显示封面和歌词）';
    btn.innerHTML = FS_SVG_IN;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setImmersive(!isImmersive());
    });
    box.appendChild(btn);
    ctl.insertBefore(box, ctl.firstChild);
    // 播放页被关掉（点返回 / 侧滑）时把沉浸态复位，下次打开还是完整播放页
    const pf = playerFullEl();
    if (pf) {
      try {
        new MutationObserver(function () {
          if (pf.hidden) setImmersive(false);
        }).observe(pf, { attributes: true, attributeFilter: ['hidden', 'class'] });
      } catch (err) {}
    }
    // 沉浸态下点一下歌词空白处也能退出（手上不想找那个小按钮时）
    try {
      const ly = document.getElementById('pf-lyrics');
      if (ly) ly.addEventListener('click', function (ev) {
        if (!isImmersive()) return;
        // 点歌词行是「跳到这句」，只有点空白才退出
        if (ev.target && ev.target.closest && ev.target.closest('.pf-lyric-line, .pf-lyric-row')) return;
        setImmersive(false);
      });
    } catch (err) {}
  }

  function boot() {
    ensureMediaBase();
    pullInsets();
    setTimeout(pullInsets, 1200);
    adaptAndroidUI();
    setTimeout(adaptAndroidUI, 600);
    setTimeout(adaptAndroidUI, 2000);
    // 触屏语义改造（收藏键/单击播放/歌词调节面板/外链确认）—— app.js 建完 DOM 才好装
    adaptTouchUI();
    setTimeout(adaptTouchUI, 600);
    setTimeout(adaptTouchUI, 2000);
    setInterval(syncFavBtn, 1500);
    // 1.0.17：不管在哪儿切收藏（App 内页脚的心 / 列表 / 通知卡片），都立刻把状态推给原生，
    // 让通知卡片那颗心和软件内那颗心永远同步，不用等 1.5s / 3s 的轮询
    try {
      if (typeof window.toggleFavorite === 'function' && !window.__mbFavWrapped) {
        const origToggleFav = window.toggleFavorite;
        window.toggleFavorite = function () {
          const ret = origToggleFav.apply(this, arguments);
          setTimeout(function () { try { syncFavBtn(); } catch (e) {} pushMediaState(true); }, 60);
          return ret;
        };
        window.__mbFavWrapped = true;
      }
    } catch (e) {}
    // 状态栏/导航栏底色跟随当前主题；用户切主题后 2 秒内自动跟上
    syncChromeColors();
    setTimeout(syncChromeColors, 800);
    setInterval(syncChromeColors, 2000);
    setInterval(checkPendingTopLyric, 4000);
    // 均衡器静音兜底：安卓版没有 EQ 界面了，但老配置里可能还留着「已启用」
    guardEqSilence();
    setTimeout(guardEqSilence, 1200);
    setTimeout(guardEqSilence, 3000);
    // 列表左侧缩略封面（1.0.12）
    installRowCovers();
    setTimeout(installRowCovers, 800);
    setTimeout(installRowCovers, 2500);
    // 播放页全屏沉浸按钮（1.0.14）
    installPosterFs();
    setTimeout(installPosterFs, 800);
    setTimeout(installPosterFs, 2500);
    // 左下角缩略封面「点即出图」（1.0.19）+ 长按重抓封面（1.0.20）
    installFooterCoverFast();
    setTimeout(installFooterCoverFast, 600);
    setTimeout(installFooterCoverFast, 2000);
    installFooterRefetch();
    setTimeout(installFooterRefetch, 800);
    // 设置里的「检查更新」（1.0.21）
    installUpdateCenter();
    setTimeout(installUpdateCenter, 900);
    setTimeout(installUpdateCenter, 2400);
    // 工具菜单合并「自动修复 + 批量下载」（1.0.23）
    installToolboxMerge();
    [500, 1200, 2400, 4000].forEach(function (ms) { setTimeout(installToolboxMerge, ms); });
  }

  // ---------------- 1.0.23：工具菜单「自动修复」合并「批量下载」 ----------------
  // 用户要求：工具按钮里这两个合成一个 —— 点「自动修复」时，修完信息顺手把专辑封面和歌词缓存下来。
  // 不碰 app.js：autoFixAll / startBatchDownload / showConfirm 都是 app.js 顶层的全局函数，
  // 这里把 autoFixAll 包一层（修完接着跑 startBatchDownload），
  // 并把 startBatchDownload 自己那个「批量下载」确认弹窗直接放过 ——
  // 用户刚在「自动修复确认」里点过确定，再弹一次纯属添乱。
  let toolboxMergeTries = 0;
  function installToolboxMerge() {
    try {
      // ① 菜单项：删掉「批量下载」，把「自动修复」改成合并后的说明
      const menu = document.getElementById('batch-menu');
      if (menu) {
        const bd = menu.querySelector('.batch-item[data-action="batch-download"]');
        if (bd && bd.parentNode) bd.parentNode.removeChild(bd);
        const af = menu.querySelector('.batch-item[data-action="auto-fix"]');
        if (af) {
          const t = af.querySelector('.batch-title');
          const d = af.querySelector('.batch-desc');
          if (t) t.textContent = '自动修复 + 缓存封面歌词';
          if (d) d.textContent = '联网校验/修复歌曲信息，修完接着把专辑封面和歌词缓存到本地（已缓存的自动跳过）';
        }
      }
      // ② 确认弹窗钩子：记住「自动修复」到底点没点确定；「批量下载」的确认直接放过
      if (typeof window.showConfirm === 'function' && !window.__mbConfirmHooked) {
        const oc = window.showConfirm;
        window.showConfirm = function (title, text) {
          const ti = String(title || '');
          if (ti.indexOf('批量下载') >= 0) return Promise.resolve(true);
          const p = oc.apply(this, arguments);
          if (ti.indexOf('自动修复') >= 0) {
            return Promise.resolve(p).then(function (v) {
              window.__mbAutoFixConfirmed = !!v;
              return v;
            });
          }
          return p;
        };
        window.__mbConfirmHooked = true;
      }
      // ③ 把 autoFixAll 包起来：修完接缓存
      if (typeof window.autoFixAll === 'function' && !window.__mbAutoFixMerged) {
        const origFix = window.autoFixAll;
        window.autoFixAll = function () {
          window.__mbAutoFixConfirmed = false;
          // 1.0.24：修复循环里每首都固定等 200ms（app.js 为了不打断音频），1400 首就是近 5 分钟的纯等待。
          // 命中记忆的歌是零网络的，这 200ms 完全是干等 —— 所以修复期间把 200ms 这个档压到 30ms，
          // 结束时立刻还原（只动这一档，其它定时器不受影响）。
          clampFixTimers(true);
          const run = origFix.apply(this, arguments);
          const next = function () {
            // 在确认框里点了取消 → 不接着下载（不然等于绕过他本人的确认）
            if (!window.__mbAutoFixConfirmed) { clampFixTimers(false); return; }
            const dl = window.startBatchDownload;
            if (typeof dl !== 'function') { clampFixTimers(false); return; }
            try { toastBox('修复完成，开始缓存封面和歌词…'); } catch (e) {}
            // 缓存那段循环里也是每首固定等 200ms（同样压到 30ms），跑完一并还原
            return Promise.resolve(dl.apply(window, []))
              .catch(function () {})
              .then(function () { clampFixTimers(false); });
          };
          return Promise.resolve(run).then(next, next);
        };
        window.__mbAutoFixMerged = true;
      }
    } catch (e) {}
    // app.js 还没跑完时函数还不在，退避再试几次
    if (!window.__mbAutoFixMerged && toolboxMergeTries < 20) {
      toolboxMergeTries++;
      setTimeout(installToolboxMerge, 400);
    }
  }
  try { window.__mbToolboxMerge = installToolboxMerge; } catch (e) {}

  /** 修复循环期间把 200ms 这一档的定时器压到 30ms（只影响 setTimeout(…, 200) 这一种） */
  function clampFixTimers(on) {
    try {
      if (on) {
        if (window.__mbFixT0) return;
        const orig = window.setTimeout;
        window.__mbFixT0 = orig;
        window.setTimeout = function (fn, ms) {
          const args = Array.prototype.slice.call(arguments);
          if (ms === 200) args[1] = 30;
          return orig.apply(window, args);
        };
      } else if (window.__mbFixT0) {
        window.setTimeout = window.__mbFixT0;
        window.__mbFixT0 = null;
      }
    } catch (e) {}
  }

  // ---------------- 1.0.24：自动修复别把「已经核对过」的歌再联网查一遍 ----------------
  // 现象：app.js 的 autoFixAll 只跳过「已修复过(fixedTracks)」「已锁定」「占位缺失」三种，
  // 对「查完发现信息本来就对」的歌**不留任何记录** —— 于是每点一次自动修复，这些歌都要重新联网搜一遍
  // （一首 0.5~2 秒 + 循环里固定 200ms 间隔，1400 首就是四十分钟起步）。
  // 这里在 mb.autoFixTrack 上做一层本地记忆：核对通过的直接命中记忆、零网络返回 needFix:false；
  // 一条都没搜到的只记 7 天（可能只是当时网络抖了），过几天还会再试。
  const AUTOFIX_MEMO_KEY = 'mb_autofix_memo_v1';
  const AUTOFIX_GOOD_TTL = 30 * 24 * 3600 * 1000;   // 核对通过：30 天内不再重复查
  const AUTOFIX_MISS_TTL = 7 * 24 * 3600 * 1000;    // 一条都没搜到：7 天后再说
  let autofixMemo = null;
  let autofixMemoDirty = false;
  let autofixMemoTimer = 0;
  function loadAutoFixMemo() {
    if (autofixMemo) return autofixMemo;
    try { autofixMemo = JSON.parse(localStorage.getItem(AUTOFIX_MEMO_KEY) || '{}') || {}; }
    catch (e) { autofixMemo = {}; }
    return autofixMemo;
  }
  function autoFixFp(artist, title, album, duration) {
    const n = function (s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
    return n(artist) + '|' + n(title) + '|' + n(album) + '|' + Math.round(Number(duration) || 0);
  }
  function readAutoFixMemo(fp) {
    const m = loadAutoFixMemo()[fp];
    if (!m) return null;
    const ttl = m.v ? AUTOFIX_GOOD_TTL : AUTOFIX_MISS_TTL;
    return (Date.now() - (m.t || 0) < ttl) ? m : null;
  }
  function flushAutoFixMemo() {
    autofixMemoTimer = 0;
    if (!autofixMemoDirty) return;
    autofixMemoDirty = false;
    try { localStorage.setItem(AUTOFIX_MEMO_KEY, JSON.stringify(loadAutoFixMemo())); } catch (e) {}
  }
  function writeAutoFixMemo(fp, v) {
    const m = loadAutoFixMemo();
    m[fp] = { v: v ? 1 : 0, t: Date.now() };
    const keys = Object.keys(m);
    if (keys.length > 5000) {
      keys.sort(function (a, b) { return (m[a].t || 0) - (m[b].t || 0); });
      for (let i = 0; i < Math.floor(keys.length / 2); i++) delete m[keys[i]];
    }
    // 一首一写 localStorage 太贵（1400 首就是 1400 次全量序列化）→ 攒 3 秒或 20 首写一次
    autofixMemoDirty = true;
    const pending = (writeAutoFixMemo._n = (writeAutoFixMemo._n || 0) + 1);
    if (pending % 20 === 0) flushAutoFixMemo();
    else if (!autofixMemoTimer) autofixMemoTimer = setTimeout(flushAutoFixMemo, 3000);
  }
  // 与 app.js 里生成 coverKey / lyricsKey 的 safeKey 保持完全一致
  function cacheKeyOf(artist, title) {
    return (String(artist || '') + ' - ' + String(title || ''))
      .replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120).toLowerCase();
  }

  // ---------------- 应用内更新（1.0.21） ----------------
  // 流程：查 GitHub Release → 比版本号 → 下载到 cache/updates（带进度）→ 交系统安装器。
  // 签名/包名先在原生下载日志里验过，不一致就不往系统安装器里送，免得只留一句"未安装"。

  const UPD = { phase: 'idle', info: null, path: null, apk: null, busy: false, installed: false };

  function verParts(v) {
    // 'android-v1.0.20' / 'v1.0.20' / '1.0.20' / '1.0.3-beta' 都能吃
    const s = String(v || '').replace(/^android-/i, '').replace(/^v/i, '');
    const m = s.match(/^(\d+(?:\.\d+)*)/);
    if (!m) return null;
    return m[1].split('.').map(function (x) { return parseInt(x, 10) || 0; });
  }
  function cmpVer(a, b) {
    const A = verParts(a), B = verParts(b);
    if (!A || !B) return 0;
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) {
      const x = A[i] || 0, y = B[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  function fmtMB(bytes) {
    const b = Number(bytes) || 0;
    return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
  }

  function updLine(text, kind) {
    const el = document.getElementById('mb-update-line');
    if (!el) return;
    el.textContent = text;
    el.setAttribute('data-kind', kind || '');
  }
  function updBar(pct, show) {
    const box = document.getElementById('mb-update-bar');
    if (!box) return;
    box.hidden = !show;
    const i = box.querySelector('i');
    if (i) i.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + '%';
  }
  function updBtn(text) {
    const b = document.getElementById('btn-check-update');
    if (b) b.textContent = text;
  }

  function updCurrentVersion() {
    return (mb && mb.version ? String(mb.version).replace(/-android$/, '') : '');
  }

  /** 点第一下：去 GitHub 看有没有新版本 */
  function doCheckUpdate() {
    if (UPD.busy) return;
    UPD.busy = true;
    UPD.installed = false;
    updBtn('检查中…');
    updBar(0, false);
    updLine('正在查 GitHub 上的最新版本…', 'warn');
    mb.checkUpdate().then(function (r) {
      UPD.busy = false;
      updBtn('检查更新');
      if (!r || !r.ok) {
        const msg = (r && r.error) || '检查失败';
        updLine('检查失败：' + msg + '（网络不通或仓库还没发过 Release）', 'bad');
        return;
      }
      UPD.info = r;
      const cur = (r.current && r.current.versionName) || UPD.currentVersion();
      const latest = r.tag || '';
      if (cmpVer(latest, cur) > 0) {
        UPD.phase = 'ready';
        const size = r.asset ? fmtMB(r.asset.size) : '';
        updLine('发现新版本 ' + String(latest).replace(/^android-v/i, 'v') + '（当前 ' + cur + (size ? '，安装包 ' + size : '') + '）', 'good');
        updBtn('下载并安装');
      } else {
        UPD.phase = 'latest';
        updLine('已是最新版本（' + cur + '，GitHub 上最新是 ' + String(latest).replace(/^android-v/i, 'v') + '）', 'good');
      }
    }).catch(function (e) {
      UPD.busy = false;
      updBtn('检查更新');
      updLine('检查失败：' + String(e && e.message || e), 'bad');
    });
  }

  /** 点第二下：下载 + 校验 + 安装 */
  function doDownloadAndInstall() {
    if (UPD.busy) return;
    const info = UPD.info;
    if (!info || !info.asset) { updLine('没拿到安装包地址，重新检查一次', 'bad'); return; }
    UPD.busy = true;
    updBtn('下载中…');
    updLine('开始下载…', 'warn');
    updBar(0, true);
    mb.downloadUpdate(info.asset.url, info.asset.name, info.asset.size, function (p) {
      const pct = Number(p.percent) >= 0 ? Number(p.percent) : 0;
      updBar(pct, true);
      updLine('下载中 ' + pct + '%（' + fmtMB(p.bytes) + ' / ' + fmtMB(p.total) + '）', 'warn');
    }).then(function (r) {
      updBar(100, false);
      if (!r || !r.ok) {
        UPD.busy = false;
        updBtn('重试下载');
        updLine('下载失败：' + ((r && r.error) || '未知错误'), 'bad');
        return;
      }
      UPD.apk = r;
      UPD.path = r.path;
      if (r.samePackage === false) {
        UPD.busy = false;
        updBtn('去网页下载');
        updLine('这个包不是本应用的安装包（' + (r.apkPackage || '?') + '），没有安装', 'bad');
        return;
      }
      if (r.sameSigner === false) {
        // 同一个包名、不同签名：系统只会报"未安装"。先讲清楚，给出两条路。
        UPD.busy = false;
        UPD.phase = 'sigMismatch';
        updBtn('去网页下载');
        updLine('包装好了，但签名和当前版本不一致（来自 CI 构建的包），系统不会覆盖安装；'
          + '可以「卸载重装」（配置会清空）或从网页手动下载', 'bad');
        return;
      }
      UPD.busy = false;
      installDownloaded();
    }).catch(function (e) {
      UPD.busy = false;
      updBtn('重试下载');
      updLine('下载失败：' + String(e && e.message || e), 'bad');
    });
  }

  function installDownloaded() {
    if (!UPD.path) return;
    updBtn('安装中…');
    updLine('交给系统安装器…', 'warn');
    mb.installUpdate(UPD.path).then(function (r) {
      UPD.busy = false;
      if (!r || !r.ok) {
        if (r && r.needPermission) {
          updBtn('已下载 · 继续安装');
          updLine('需要允许「安装未知应用」：已在设置页打开开关位置，打开后回来再点一次这个按钮', 'warn');
          return;
        }
        updBtn('重试安装');
        updLine('安装失败：' + ((r && r.error) || '未知错误'), 'bad');
        return;
      }
      UPD.installed = true;
      updBtn('重新检查');
      updLine('已调起系统安装器，按提示完成安装即可（装完启动就是新版本）', 'good');
    }).catch(function (e) {
      UPD.busy = false;
      updBtn('重试安装');
      updLine('安装失败：' + String(e && e.message || e), 'bad');
    });
  }

  function installUpdateCenter() {
    const old = document.getElementById('btn-check-update');
    if (!old || old.getAttribute('data-mb-upd') === '1') return;
    // app.js 里那句"即将上线"的占位 handler 是匿名函数，摘不掉，
    // 所以整颗按钮换成一个克隆（克隆节点不带任何 listener），再挂自己的。
    const btn = old.cloneNode(true);
    btn.setAttribute('data-mb-upd', '1');
    btn.textContent = '检查更新';
    old.parentNode.replaceChild(btn, old);
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (UPD.busy) return;
      // 状态机：idle/检查完但没新版 → 重新检查；有新版 → 下载安装；签名冲突 → 去网页
      if (UPD.phase === 'ready') { doDownloadAndInstall(); return; }
      if (UPD.phase === 'sigMismatch') {
        const url = (UPD.info && UPD.info.htmlUrl) || 'https://github.com/sunmanxu/MusicSMX-Android-HD/releases';
        mb.openUpdatePage(url);
        return;
      }
      if (UPD.path && !UPD.installed) { installDownloaded(); return; }
      doCheckUpdate();
    });
    updLine('点「检查更新」去 GitHub 看有没有新版本', '');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

