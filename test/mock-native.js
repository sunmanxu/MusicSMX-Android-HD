/**
 * 桌面端「假原生」——用于在没有手机/模拟器的情况下，用浏览器跑一遍渲染层 + 安卓桥，
 * 验证 bridge.js 的契约重造、mediaSession 桩、UI 收敛不会把 app.js 顶崩。
 * 只做冒烟测试，不参与打包（www/ 目录里没有它）。
 */
(function () {
  const FAKE_COVER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  let config = {
    folders: ['/内部存储/Music'],
    volume: 0.8,
    favorites: ['/内部存储/Music/周杰伦/晴天.mp3'],
    playlists: [],
    queue: [],
    settings: { accent: '#ff6b3d' }
  };

  const tracks = [
    { path: '/内部存储/Music/周杰伦/晴天.mp3', root: '/内部存储/Music', name: '晴天.mp3', title: '晴天', artist: '周杰伦', album: '叶惠美', cover: FAKE_COVER, size: 123, mtimeMs: 1 },
    { path: '/内部存储/Music/陈奕迅/十年.mp3', root: '/内部存储/Music', name: '十年.mp3', title: '十年', artist: '陈奕迅', album: '黑白灰', cover: null, size: 456, mtimeMs: 2 }
  ];

  function handle(method, args) {
    switch (method) {
      case 'getConfig': return config;
      case 'setConfig': return { ok: true };
      case 'getInheritInfo': return { value: null };
      case 'getDefaultDirs': return { cache: '/fake/cache', covers: '/fake/cache', lyrics: '/fake/cache', userData: '/fake' };
      case 'getMediaBase': return { base: 'http://127.0.0.1:18999', token: 'devtoken' };
      case 'scan': return { tracks: tracks };
      case 'scanLocalCache': return { covers: [], lyrics: [] };
      case 'readCoverFile': return { ok: true, dataUrl: FAKE_COVER };
      case 'readLyricsFile': return { ok: true, text: '[00:00.00]测试歌词\n[00:02.00]第二行' };
      case 'fileExists': return { exists: true };
      case 'saveCover': return { ok: true, path: '/fake/cache/a.jpg' };
      case 'saveLyrics': return { ok: true, path: '/fake/cache/a.lrc' };
      case 'findDuplicateFiles': return { ok: true, groups: [] };
      case 'pickFolders': return { paths: ['/内部存储/Music'] };
      case 'updateMediaState': return { ok: true };
      case 'readFileTags': return { title: '晴天', artist: '周杰伦', album: '叶惠美' };
      default: return { ok: true };
    }
  }

  window.Capacitor = {
    nativePromise: function (plugin, method, args) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try { resolve(handle(method, args || {})); } catch (e) { reject(e); }
        }, 20);
      });
    },
    Plugins: {}
  };
})();
