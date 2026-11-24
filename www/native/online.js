/* MusicSMX 安卓端联网元数据：从桌面版 src/online.js 移植（与桌面同一套匹配算法）。
   只替换掉 Node 依赖，算法本身逐字保留，不要改：
     - 网络 GET      → 原生 httpFetch（WebView 里 fetch 会被 CORS 拦，跨域抓取必须走原生）
     - zlib inflate  → 原生 decryptKrc（酷狗逐字歌词 KRC 需要 XOR + inflate）
     - fs / path     → 空实现（封面/歌词落盘统一走 mb.saveCover / mb.saveLyrics）
   定案（不许改）：QQ 封面只能 300/500/800 规格；歌词按 duration 权重匹配；
   歌名兜底校验通过才收。 */

(function () {
  'use strict';

  function nativeCall(method, args) {
    const C = window.Capacitor;
    if (!C || typeof C.nativePromise !== 'function') return Promise.reject(new Error('no Capacitor'));
    return C.nativePromise('MusicBridge', method, args || {});
  }

  const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let B64LOOKUP = null;

  function bytesFromB64(b64) {
    if (!B64LOOKUP) {
      B64LOOKUP = {};
      for (let i = 0; i < B64CHARS.length; i++) B64LOOKUP[B64CHARS[i]] = i;
    }
    const s = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor(s.length / 4 * 3) + 3);
    let p = 0, n = 0;
    for (let i = 0; i < s.length; i += 4) {
      const c1 = B64LOOKUP[s[i]] || 0, c2 = B64LOOKUP[s[i + 1]] || 0;
      const c3 = B64LOOKUP[s[i + 2]] || 0, c4 = B64LOOKUP[s[i + 3]] || 0;
      out[p++] = (c1 << 2) | (c2 >> 4);
      if (i + 2 < s.length) out[p++] = ((c2 & 15) << 4) | (c3 >> 2);
      if (i + 3 < s.length) out[p++] = ((c3 & 3) << 6) | c4;
      n++;
    }
    return out.subarray(0, p);
  }

  function b64FromBytes(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 3) {
      const b1 = u8[i], b2 = u8[i + 1], b3 = u8[i + 2];
      s += B64CHARS[b1 >> 2];
      s += B64CHARS[((b1 & 3) << 4) | ((b2 || 0) >> 4)];
      s += (i + 1 < u8.length) ? B64CHARS[((b2 & 15) << 2) | ((b3 || 0) >> 6)] : '=';
      s += (i + 2 < u8.length) ? B64CHARS[b3 & 63] : '=';
    }
    return s;
  }

  const TD = new TextDecoder('utf-8');

  /** 极简 Buffer 替身：只提供在线元数据代码用到的那几样（length / toString / slice） */
  function Buf(u8) {
    this.u8 = u8;
    this.length = u8.length;
  }
  Buf.prototype.toString = function (enc) {
    if (enc === 'base64') return b64FromBytes(this.u8);
    return TD.decode(this.u8);
  };
  Buf.prototype.slice = function (a, b) { return new Buf(this.u8.subarray(a || 0, b === undefined ? this.u8.length : b)); };

  const Buffer = {
    from: function (data, enc) {
      if (typeof data === 'string') return new Buf(bytesFromB64(data));
      return new Buf(data instanceof Uint8Array ? data : new Uint8Array(data));
    }
  };

  function __b64ToText(b64) { return TD.decode(bytesFromB64(b64)); }

  /** 统一网络出口：原生 httpFetch 拿回 base64，再包成 Buf 给移植代码用 */
  function getBuffer(url, options) {
    options = options || {};
    const headers = options.headers || {};
    return nativeCall('httpFetch', {
      url: url,
      headers: headers,
      timeoutMs: options.timeout || 12000
    }).then(function (r) {
      if (!r || !r.ok) {
        const err = new Error((r && (r.error || ('HTTP ' + r.status))) || '网络请求失败');
        err.status = r && r.status;
        throw err;
      }
      return new Buf(bytesFromB64(r.base64 || ''));
    });
  }

  const httpsGet = function (u, o) { return getBuffer(u, o); };
  const httpGet = function (u, o) { return getBuffer(u, o); };

  // 文件读写不走这里（桌面版是主进程直接写盘，安卓是 SAF/私有目录，统一由 mb.saveCover / saveLyrics 处理）
  const fs = {
    existsSync: function () { return false; },
    mkdirSync: function () {},
    writeFileSync: function () {},
    readFileSync: function () { return ''; },
    readdirSync: function () { return []; }
  };
  const path = { join: function () { return Array.prototype.slice.call(arguments).join('/'); } };

  /** 酷狗逐字歌词解密：XOR + zlib inflate，浏览器里没有 inflate，交给原生做 */
  async function decryptKrc(base64) {
    try {
      const r = await nativeCall('decryptKrc', { base64: base64 });
      return (r && r.ok && r.text) ? r.text : null;
    } catch (e) {
      return null;
    }
  }

  // ==================== 以下为桌面版 src/online.js 原文（逐字移植） ====================

// 把 KRC 明文转成标准 LRC（保留行级时间轴，供保存 .lrc / 逐行高亮使用）
function krcToLrc(krcText) {
  if (!krcText) return '';
  const out = [];
  for (const raw of krcText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 保留元信息标签 [ti:xxx] / [ar:xxx] 等
    if (/^\[[a-z]+:.*\]$/i.test(line) && !/^\[\d/.test(line)) { out.push(line); continue; }
    const m = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const body = m[3].replace(/<\d+,\d+,\d+>/g, '');   // 去掉字级标签
    if (!body.trim()) continue;
    const min = Math.floor(start / 60000);
    const sec = Math.floor((start % 60000) / 1000);
    const cs = Math.floor((start % 1000) / 10);
    out.push(`[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}]${body}`);
  }
  return out.join('\n');
}

// ---------- 文件名安全化 ----------
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120);
}

// ---------- 专辑封面（多源：iTunes + 网易云 + QQ音乐 + 酷狗 + 酷我） ----------

// 来源 1：iTunes Search API
async function searchCoverITunes(artist, title) {
  const term = encodeURIComponent(`${artist} ${title}`.trim());
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=5&country=cn`;
  try {
    const buf = await httpsGet(url, { timeout: 6000 });
    const data = JSON.parse(buf.toString('utf8'));
    const results = data.results || [];
    const best = pickBestMatch(results, artist, title, 0, (r) => ({
      title: r.trackName || '',
      artist: r.artistName || '',
      album: r.collectionName || '',
      duration: (r.trackTimeMillis || 0) / 1000,
      artworkUrl100: r.artworkUrl100
    }));
    if (!best || !best.artworkUrl100) return null;
    const highRes = best.artworkUrl100.replace(/100x100bb/, '600x600bb').replace(/100x100/, '600x600');
    return {
      url: highRes, thumbUrl: best.artworkUrl100,
      source: 'iTunes',
      artist: best.artist, album: best.album || '', title: best.title
    };
  } catch (e) { return null; }
}

// 来源 2：网易云音乐
async function searchCoverNetEase(artist, title) {
  const keyword = encodeURIComponent(`${artist} ${title}`.trim());
  const searchUrl = `https://music.163.com/api/search/get?s=${keyword}&type=1&offset=0&limit=5`;
  try {
    const buf = await httpsGet(searchUrl, { timeout: 6000, headers: { 'Referer': 'https://music.163.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    const songs = data?.result?.songs || [];
    const best = pickBestMatch(songs, artist, title, 0, (s) => ({
      title: s.name || '',
      artist: (s.artists || []).map(x => x.name).join(' / '),
      album: s.album?.name || '',
      duration: (s.duration || s.dt || 0) / 1000,
      id: s.id
    }));
    if (!best || !best.id) return null;
    // 网易云需要通过歌曲详情获取专辑封面
    const songId = best.id;
    const detailUrl = `https://music.163.com/api/song/detail?ids=%5B${songId}%5D`;
    const dbuf = await httpsGet(detailUrl, { timeout: 6000, headers: { 'Referer': 'https://music.163.com/' } });
    const ddata = JSON.parse(dbuf.toString('utf8'));
    const song = ddata?.songs?.[0];
    const coverUrl = song?.album?.picUrl || best?.album?.picUrl;
    if (!coverUrl) return null;
    // 网易云封面可以通过参数调整尺寸
    const highRes = coverUrl + '?param=600y600';
    return {
      url: highRes, thumbUrl: coverUrl + '?param=200y200',
      source: '网易云音乐',
      artist: best.artist,
      album: best.album || '', title: best.title
    };
  } catch (e) { return null; }
}

// 来源 3：QQ音乐
async function searchCoverQQ(artist, title) {
  const keyword = encodeURIComponent(`${artist} ${title}`.trim());
  const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${keyword}&format=json&p=1&n=5`;
  try {
    const buf = await httpsGet(searchUrl, { timeout: 6000, headers: { 'Referer': 'https://y.qq.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    const songs = data?.data?.song?.list || [];
    const best = pickBestMatch(songs, artist, title, 0, (s) => ({
      title: s.songname || '',
      artist: (s.singer || []).map(x => x.name).join(' / '),
      album: s.albumname || '',
      duration: s.interval || 0,
      albummid: s.albummid
    }));
    if (!best || !best.albummid) return null;
    // QQ音乐封面：通过 albumid 或直接用 albummid
    // 规格必须是 300/500/800 —— 实测 600x600 与 200x200 都会返回 404
    // （2026-11-19 晴天等只能命中 QQ 源的歌整批没封面，就是这个原因）
    const albummid = best.albummid;
    const coverUrl = `https://y.gtimg.cn/music/photo_new/T002R800x800M000${albummid}.jpg?max_age=2592000`;
    return {
      url: coverUrl, thumbUrl: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg`,
      source: 'QQ音乐',
      artist: best.artist,
      album: best.album || '', title: best.title
    };
  } catch (e) { return null; }
}

// 来源 4：酷狗音乐
async function searchCoverKugou(artist, title) {
  const keyword = encodeURIComponent(`${artist} ${title}`.trim());
  const searchUrl = `https://songsearch.kugou.com/song_search_v2?keyword=${keyword}&page=1&pagesize=5&format=json&platform=WebFilter`;
  try {
    const buf = await httpsGet(searchUrl, { timeout: 6000, headers: { 'Referer': 'https://www.kugou.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    const songs = data?.data?.lists || [];
    const best = pickBestMatch(songs, artist, title, 0, (s) => ({
      title: s.SongName || '',
      artist: s.SingerName || '',
      album: s.AlbumName || '',
      duration: (s.Duration || (s.Timelength ? s.Timelength / 1000 : 0)) || 0,
      AlbumID: s.AlbumID,
      FileHash: s.FileHash
    }));
    if (!best) return null;
    // 酷狗封面：通过 album_id 获取
    const albumId = best.AlbumID;
    if (!albumId) return null;
    // 酷狗需要通过专辑详情获取封面
    const albumUrl = `https://www.kugou.com/yy/html/api/album?album_id=${albumId}`;
    try {
      const abuf = await httpsGet(albumUrl, { timeout: 5000, headers: { 'Referer': 'https://www.kugou.com/' } });
      const adata = JSON.parse(abuf.toString('utf8'));
      const coverUrl = adata?.data?.img || adata?.img;
      if (coverUrl) {
        return {
          url: coverUrl, thumbUrl: coverUrl,
          source: '酷狗音乐',
          artist: best.artist, album: best.album || '', title: best.title
        };
      }
    } catch (e) { /* 继续尝试备用方案 */ }
    // 备用：酷狗 CDN 封面格式
    const hash = best.FileHash;
    if (hash) {
      const coverUrl = `https://imge.kugou.com/stdmusic/600/${hash}.jpg`;
      return {
        url: coverUrl, thumbUrl: `https://imge.kugou.com/stdmusic/200/${hash}.jpg`,
        source: '酷狗音乐',
        artist: best.artist, album: best.album || '', title: best.title
      };
    }
    return null;
  } catch (e) { return null; }
}

// 来源 5：酷我音乐
async function searchCoverKuwo(artist, title) {
  const keyword = encodeURIComponent(`${artist} ${title}`.trim());
  const searchUrl = `https://search.kuwo.cn/r.s?all=${keyword}&ft=music&itemset=web_2013&client=kt&pn=0&rn=5&rformat=json&encoding=utf8`;
  try {
    const buf = await httpsGet(searchUrl, { timeout: 6000, headers: { 'Referer': 'https://www.kuwo.cn/' } });
    // 1.0.20：酷我返回的是单引号 Python 风格 JSON，原来直接 JSON.parse 一直失败 →
    // 这个源事实上一直没工作过（发如雪就是全靠 QQ/酷狗才没全灭）。改用容错解析。
    const data = looseJsonParse(buf.toString('utf8'));
    if (!data) return null;
    const songs = data.abslist || data.list || [];
    const best = pickBestMatch(songs, artist, title, 0, (s) => ({
      title: s.SONGNAME || s.name || '',
      artist: s.ARTIST || s.artist || '',
      album: s.ALBUM || s.album || '',
      duration: parseFloat(s.DURATION || s.duration || 0) || 0,
      web_albumpic: s.web_albumpic || s.albumpic || s.ALBUMPIC || '',
      musicId: s.MUSICRID || s.musicrid || s.id
    }));
    if (!best) return null;
    // 酷我封面：通过 web_albumpic 或 albumpic
    let coverUrl = best.web_albumpic;
    if (!coverUrl) {
      // 通过歌曲详情获取
      const musicId = best.musicId;
      if (musicId) {
        const id = String(musicId).replace('MUSIC_', '');
        const detailUrl = `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${id}`;
        try {
          const dbuf = await httpsGet(detailUrl, { timeout: 5000, headers: { 'Referer': 'https://m.kuwo.cn/' } });
          const ddata = JSON.parse(dbuf.toString('utf8'));
          coverUrl = ddata?.data?.songinfo?.pic || ddata?.data?.pic;
        } catch (e) { /* ignore */ }
      }
    }
    if (!coverUrl) return null;
    // 酷我封面可以调整尺寸
    const highRes = coverUrl.replace(/\/\d+x\d+\//, '/600x600/');
    return {
      url: highRes, thumbUrl: coverUrl.replace(/\/\d+x\d+\//, '/200x200/'),
      source: '酷我音乐',
      artist: best.artist,
      album: best.album || '', title: best.title
    };
  } catch (e) { return null; }
}

/**
 * 1.0.20：酷我之类的接口返回的是「Python 风格单引号 JSON」（{'a':'b'}，还夹着 None/True/False），
 * JSON.parse 直接报错 —— 之前酷我源其实一直是哑的。这里做个容错解析：
 * 单引号当字符串定界符、内部双引号转义、None/True/False 换成 null/true/false。
 */
function looseJsonParse(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { /* 继续用容错路子 */ }
  let out = '';
  let inStr = false;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { out += c + (s[i + 1] || ''); i++; continue; }
      if (c === quote) { inStr = false; out += '"'; continue; }
      if (c === '"') { out += '\\"'; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      out += c;
      continue;
    }
    if (c === "'" || c === '"') { inStr = true; quote = c; out += '"'; continue; }
    out += c;
  }
  out = out.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
  out = out.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&apos;/g, "'");
  try { return JSON.parse(out); } catch (e) { return null; }
}

/**
 * 1.0.20 新增来源 6：网易云「专辑搜索」。
 * 症状典型的是周杰伦这种「网易云没有版权、单曲搜不到」的歌 —— 单曲为空，但专辑库里有这张专辑，
 * 用 type=10 按专辑名搜就能拿到 picUrl。
 */
async function searchCoverNetEaseAlbum(artist, album) {
  const kw = encodeURIComponent((artist + ' ' + album).trim());
  const url = `https://music.163.com/api/search/get?s=${kw}&type=10&limit=5`;
  try {
    const buf = await httpsGet(url, { timeout: 6000, headers: { 'Referer': 'https://music.163.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    const albums = (data && data.result && data.result.albums) || [];
    if (!albums.length) return null;
    const norm = (x) => String(x || '').toLowerCase().replace(/[\s·・\-_'’()（）[\]【】]/g, '');
    const wantAlbum = norm(album);
    const wantArtist = norm(artist);
    const best = albums.find(function (a) {
      const an = norm(a.name);
      const ar = norm((a.artist && a.artist.name) || (a.artists && a.artists[0] && a.artists[0].name) || '');
      if (!wantAlbum) return false;
      const albumOk = an === wantAlbum || an.indexOf(wantAlbum) >= 0 || wantAlbum.indexOf(an) >= 0;
      if (!albumOk) return false;
      if (!wantArtist) return true;
      return ar === wantArtist || ar.indexOf(wantArtist) >= 0 || wantArtist.indexOf(ar) >= 0;
    });
    if (!best || !best.picUrl) return null;
    const coverUrl = String(best.picUrl).replace(/^http:/, 'https:');
    return {
      url: coverUrl + '?param=600y600',
      thumbUrl: coverUrl + '?param=300y300',
      source: '网易云专辑',
      artist: (best.artist && best.artist.name) || artist,
      album: best.name || album,
      title: ''
    };
  } catch (e) { return null; }
}

/**
 * 1.0.20 新增来源 7：酷我「专辑搜索」（ft=album）。
 * 适合单曲搜不到、但专辑名确定的情况；img 是 240px 缩图，把路径里的 /240/ 换成 /500/ 就是大图。
 */
async function searchCoverKuwoAlbum(artist, album) {
  const kw = encodeURIComponent((artist + ' ' + album).trim());
  const url = `https://search.kuwo.cn/r.s?all=${kw}&ft=album&itemset=web_2013&client=kt&pn=0&rn=5&rformat=json&encoding=utf8`;
  try {
    const buf = await httpsGet(url, { timeout: 6000, headers: { 'Referer': 'https://www.kuwo.cn/' } });
    const data = looseJsonParse(buf.toString('utf8'));
    const albums = (data && (data.albumlist || data.abslist)) || [];
    if (!albums.length) return null;
    const norm = (x) => String(x || '').toLowerCase().replace(/[\s·・\-_'’()（）[\]【】]/g, '');
    const wantAlbum = norm(album);
    const wantArtist = norm(artist);
    const best = albums.find(function (a) {
      const an = norm(a.name || a.album || a.falbum);
      if (!wantAlbum) return false;
      const albumOk = an === wantAlbum || an.indexOf(wantAlbum) >= 0 || wantAlbum.indexOf(an) >= 0;
      if (!albumOk) return false;
      const ar = norm(a.artist || a.fartist || '');
      if (!wantArtist) return true;
      return ar === wantArtist || ar.indexOf(wantArtist) >= 0 || wantArtist.indexOf(ar) >= 0;
    });
    if (!best) return null;
    const pic = best.img || best.pic || best.hts_img || '';
    if (!pic) return null;
    const big = String(pic).replace(/\/240\//, '/500/').replace(/^http:/, 'https:');
    const small = String(pic).replace(/^http:/, 'https:');
    return {
      url: big, thumbUrl: small,
      source: '酷我专辑',
      artist: best.artist || best.fartist || artist,
      album: best.name || album,
      title: ''
    };
  } catch (e) { return null; }
}

/**
 * 1.0.20 新增来源 8：360 图片兜底（最后一道）。
 * 前面七个源都查不到（小众歌、现场版、AI 翻唱专辑）才用；只挑标题里带专辑名/歌名、
 * 且尺寸 ≥ 300px 的图，避免随手抓一张无关封面。
 */
async function searchCover360Image(artist, album, title) {
  const q = [artist, album || title, '专辑封面'].filter(Boolean).join(' ');
  const url = 'https://image.so.com/j?q=' + encodeURIComponent(q) + '&src=srp&sn=0&pn=10';
  try {
    const buf = await httpsGet(url, { timeout: 7000, headers: { 'Referer': 'https://image.so.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    const list = (data && data.list) || [];
    if (!list.length) return null;
    const keys = [album, title].filter(Boolean).map(function (x) { return String(x).toLowerCase().replace(/\s/g, ''); });
    const cands = list.filter(function (it) {
      const w = Number(it.width || it.w || 0);
      const h = Number(it.height || it.h || 0);
      // 专辑封面基本是方的：长宽比离谱的（新闻配图、横版海报）一律不要
      if (w && h && (w < 400 || h < 400)) return false;
      if (w && h && (w / h > 1.35 || h / w > 1.35)) return false;
      const t = String(it.title || '').toLowerCase().replace(/\s/g, '');
      if (!keys.length) return true;
      return keys.some(function (k) { return t.indexOf(k) >= 0; });
    });
    // 1.0.20：宁缺勿滥 —— 一张对不上的百度新闻图比没有封面更难看
    if (!cands.length) return null;
    const best = cands.find(function (it) { return it.img || it.thumb; });
    if (!best) return null;
    const pic = String(best.img || best.thumb).replace(/^http:/, 'https:');
    return {
      url: pic, thumbUrl: String(best.thumb || best.img).replace(/^http:/, 'https:'),
      source: '360图片',
      artist: artist, album: album || '', title: title || ''
    };
  } catch (e) { return null; }
}

/**
 * 标题的搜索变体。
 * 曲库里的标题常常不干净：文件名式「标题 - 专辑」、带 (Live)（伴奏）【翻自】这类注记。
 * 这些都会让标题分卡在 TITLE_ACCEPT 门槛之下，导致"明摆着有这首歌却匹配不到"。
 * 这里给出若干个等价标题，主标题搜不到时再退到变体重搜一遍。
 */
function titleVariants(title) {
  const t = String(title || '').trim();
  const out = [];
  const push = (v) => {
    v = String(v || '').trim();
    if (v && v.length >= 2 && !out.includes(v)) out.push(v);
  };
  push(t);
  // 「标题 - 专辑」：只取第一段
  const dashCut = t.split(/\s+[-–—]\s+/);
  if (dashCut.length > 1) push(dashCut[0]);
  // 去括号注记（Live / 伴奏 / 翻自 / Remix / DJ 版…）
  push(t.replace(/[（(\[【〔][^）)\]】〕]*[）)\]】〕]/g, ' ').replace(/\s+/g, ' '));
  // 顺带去掉 feat. / ft. 之后的合作者署名
  push(t.replace(/\s*(?:feat\.?|ft\.?|featuring)\s+.*$/i, ''));
  const dashCut2 = dashCut[0] ? dashCut[0].replace(/[（(\[【〔][^）)\]】〕]*[）)\]】〕]/g, ' ') : '';
  if (dashCut2) push(dashCut2);
  return out;
}

// 主函数：依次尝试多个来源；第一轮用原样标题，全都没命中再用标题变体重搜一轮
// 1.0.20：多了三个源（网易云专辑 / 酷我专辑 / 360 图片兜底），专辑级源只在知道专辑名时才跑
async function searchCover(artist, title, album) {
  artist = cleanMeta(artist);
  if (!artist && !title) return null;
  const sources = [
    { name: 'iTunes', fn: searchCoverITunes },
    { name: '网易云音乐', fn: searchCoverNetEase },
    { name: 'QQ音乐', fn: searchCoverQQ },
    { name: '酷狗音乐', fn: searchCoverKugou },
    { name: '酷我音乐', fn: searchCoverKuwo }
  ];
  const albumSources = album ? [
    { name: '网易云专辑', fn: function (a, t) { return searchCoverNetEaseAlbum(a, album); } },
    { name: '酷我专辑', fn: function (a, t) { return searchCoverKuwoAlbum(a, album); } }
  ] : [];
  const variants = titleVariants(title);
  for (let round = 0; round < variants.length; round++) {
    for (const src of sources.concat(albumSources)) {
      try {
        const result = await src.fn(artist, variants[round]);
        if (result && result.url) return result;
      } catch (e) {
        // 继续尝试下一个来源
      }
    }
  }
  // 最后一道：360 图片（小众歌/现场版/AI 翻唱专缉，正规库里都没有的时候才走这里）
  try {
    const r = await searchCover360Image(artist, album, variants[0] || title);
    if (r && r.url) return r;
  } catch (e) {}
  return null;
}

// 返回所有来源的封面候选（不下载），供首选源图片挂掉时逐个兜底。
// searchCover 只认第一个匹配的源；但那个源的图片 URL 可能失效（CDN 改版、
// 防盗链、规格不支持），此时必须能自动换下一个源，否则整批歌都没封面。
async function searchCoverCandidates(artist, title, album) {
  artist = cleanMeta(artist);
  if (!artist && !title) return [];
  const sources = [
    { name: 'iTunes', fn: searchCoverITunes },
    { name: '网易云音乐', fn: searchCoverNetEase },
    { name: 'QQ音乐', fn: searchCoverQQ },
    { name: '酷狗音乐', fn: searchCoverKugou },
    { name: '酷我音乐', fn: searchCoverKuwo }
  ];
  if (album) {
    sources.push({ name: '网易云专辑', fn: function (a, t) { return searchCoverNetEaseAlbum(a, album); } });
    sources.push({ name: '酷我专辑', fn: function (a, t) { return searchCoverKuwoAlbum(a, album); } });
  }
  const out = [];
  const seen = new Set();
  const variants = titleVariants(title);
  for (let round = 0; round < variants.length; round++) {
    for (const src of sources) {
      try {
        const result = await src.fn(artist, variants[round]);
        if (result && result.url && !seen.has(result.url)) {
          seen.add(result.url);
          out.push(result);
        }
      } catch (e) { /* 换下一个源 */ }
    }
    if (out.length >= 2) break;   // 已经有兜底候选了，不必把变体全跑一遍
  }
  return out;
}

async function downloadCover(url) {
  try {
    const buf = await getBuffer(url, { timeout: 15000 });
    if (buf.length < 1000) return null;
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (e) {
    return null;
  }
}

// ==================== 列表缩略封面专用：快枪版搜索（1.0.13） ====================
// 原 searchCover 是「源 × 标题变体」逐个串行试，一首没命中的歌要串 10 个请求
// （每个还带 6s 超时），列表一屏二十几行就会卡十几秒。
// 这里改成：同一轮里五个源并发抢，谁先给出 cover 就用谁；整体给一个预算，
// 超时立刻认输（认输结果写进负缓存，下次不再浪费请求）。
async function searchCoverFast(artist, title, budgetMs, album) {
  artist = cleanMeta(artist);
  if (!artist && !title) return null;
  const sources = [
    searchCoverITunes,
    searchCoverNetEase,
    searchCoverQQ,
    searchCoverKugou,
    searchCoverKuwo
  ];
  // 1.0.20：知道专辑名就再并两个专辑级源（周杰伦这种单曲搜不到的，专辑库里反而有）
  if (album) {
    sources.push(function (a, t) { return searchCoverNetEaseAlbum(a, album); });
    sources.push(function (a, t) { return searchCoverKuwoAlbum(a, album); });
  }
  const variants = titleVariants(title).slice(0, 2);
  const deadline = Date.now() + (budgetMs || 3200);
  for (let round = 0; round < variants.length; round++) {
    const left = deadline - Date.now();
    if (left <= 300) break;
    const got = await new Promise((resolve) => {
      let finished = false;
      let pending = sources.length;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        resolve(null);
      }, left);
      sources.forEach((fn) => {
        let p;
        try { p = fn(artist, variants[round]); } catch (e) { p = Promise.reject(e); }
        p.then((r) => {
          if (finished) return;
          if (r && (r.url || r.thumbUrl)) {
            finished = true;
            clearTimeout(timer);
            resolve(r);
            return;
          }
          if (--pending === 0 && !finished) {
            finished = true;
            clearTimeout(timer);
            resolve(null);
          }
        }).catch(() => {
          if (--pending === 0 && !finished) {
            finished = true;
            clearTimeout(timer);
            resolve(null);
          }
        });
      });
    });
    if (got) return got;
  }
  return null;
}

// 保存封面到文件
function saveCoverFile(dataUrl, saveDir, artist, title) {
  try {
    if (!saveDir) return null;
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
    const base64 = dataUrl.split(',')[1];
    const buf = Buffer.from(base64, 'base64');
    const fname = safeName(`${artist} - ${title}`) + '.jpg';
    const fpath = path.join(saveDir, fname);
    fs.writeFileSync(fpath, buf);
    return fpath;
  } catch (e) {
    return null;
  }
}

// ---------- 歌词（多源：网易云 + QQ音乐 + 酷狗 + 酷我） ----------

// 来源 1：网易云音乐
async function searchLyricsNetEase(artist, title, duration) {
  const attempt = async (keyword) => {
    const searchUrl = `https://music.163.com/api/search/get?s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=8`;
    const buf = await httpsGet(searchUrl, {
      timeout: 6000,
      headers: { 'Referer': 'https://music.163.com/', 'Cookie': 'appver=2.0.2' }
    });
    const data = JSON.parse(buf.toString('utf8'));
    const songs = data?.result?.songs || [];
    const best = pickBestMatch(songs, artist, title, duration, (s) => ({
      title: s.name || '',
      artist: (s.artists || []).map(x => x.name).join(' / '),
      duration: (s.duration || s.dt || 0) / 1000,
      id: s.id
    }));
    if (!best || !best.id) return null;
    const lyricUrl = `https://music.163.com/api/song/lyric?id=${best.id}&lv=1&kv=1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1`;
    const lbuf = await httpsGet(lyricUrl, { timeout: 6000, headers: { 'Referer': 'https://music.163.com/' } });
    const ldata = JSON.parse(lbuf.toString('utf8'));
    const lrc = ldata?.lrc?.lyric;
    if (!lrc || lrc.trim().length < 10) return null;
    return {
      lrc,
      tlyric: ldata?.tlyric?.lyric || '',
      // 音译（罗马音）：部分日文/韩文歌有，以前没取，全屏「音译」列一直是空的
      rlyric: ldata?.romalrc?.lyric || ldata?.rlyric?.lyric || '',
      // 逐字歌词：网易云新版接口可能返回 yrc（有就带上，没有就走逐行）
      yrc: ldata?.yrc?.lyric || '',
      source: '网易云音乐',
      songName: best.title,
      artist: best.artist
    };
  };
  try {
    // 先用「歌手 + 标题」搜；不达标再用纯标题兜底
    return (await attempt(`${artist} ${title}`.trim())) || (await attempt(title));
  } catch (e) { return null; }
}

// 来源 2：QQ音乐
async function searchLyricsQQ(artist, title, duration) {
  const attempt = async (keyword) => {
    const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(keyword)}&format=json&p=1&n=8`;
    const buf = await httpsGet(searchUrl, {
      timeout: 6000,
      headers: { 'Referer': 'https://y.qq.com/' }
    });
    const data = JSON.parse(buf.toString('utf8'));
    const songs = data?.data?.song?.list || [];
    const best = pickBestMatch(songs, artist, title, duration, (s) => ({
      title: s.songname || '',
      artist: (s.singer || []).map(x => x.name).join(' / '),
      duration: s.interval || 0,
      songmid: s.songmid
    }));
    if (!best || !best.songmid) return null;
    const lyricUrl = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${best.songmid}&format=json&nobase64=1`;
    const lbuf = await httpsGet(lyricUrl, { timeout: 6000, headers: { 'Referer': 'https://y.qq.com/' } });
    let ldata;
    try {
      ldata = JSON.parse(lbuf.toString('utf8'));
    } catch (e) {
      // QQ音乐有时返回 JSONP 格式，尝试提取
      const text = lbuf.toString('utf8');
      const m = text.match(/\{.*\}/);
      if (m) ldata = JSON.parse(m[0]);
      else return null;
    }
    let lrc = ldata?.lyric;
    if (!lrc) return null;
    // QQ音乐歌词可能是 base64
    if (ldata.retcode === 0 && !lrc.includes('[')) {
      try { lrc = Buffer.from(lrc, 'base64').toString('utf8'); } catch (e) { /* ignore */ }
    }
    if (!lrc || lrc.trim().length < 10) return null;
    // QQ音乐的译文在 trans 字段（可能 base64）；以前没取，英文歌切到 QQ 后翻译列一直是空的
    let tlyric = ldata?.trans || '';
    if (tlyric && !tlyric.includes('[')) {
      try { tlyric = Buffer.from(tlyric, 'base64').toString('utf8'); } catch (e) { /* ignore */ }
    }
    return {
      lrc, tlyric: tlyric || '',
      source: 'QQ音乐',
      songName: best.title,
      artist: best.artist
    };
  };
  try {
    return (await attempt(`${artist} ${title}`.trim())) || (await attempt(title));
  } catch (e) { return null; }
}

// 来源 3：酷狗音乐
async function searchLyricsKugou(artist, title, duration) {
  const attempt = async (keyword) => {
    const searchUrl = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}&page=1&pagesize=8&format=json&platform=WebFilter`;
    const buf = await httpsGet(searchUrl, {
      timeout: 6000,
      headers: { 'Referer': 'https://www.kugou.com/' }
    });
    const data = JSON.parse(buf.toString('utf8'));
    const songs = data?.data?.lists || [];
    const best = pickBestMatch(songs, artist, title, duration, (s) => ({
      title: s.SongName || '',
      artist: s.SingerName || '',
      duration: (s.Duration || (s.Timelength ? s.Timelength / 1000 : 0)) || 0,
      hash: s.FileHash
    }));
    if (!best || !best.hash) return null;
    // 酷狗需要先获取歌词访问密钥
    const tokenUrl = `https://krcs.kugou.com/search?ver=1&man=yes&client=pc&hash=${best.hash.toLowerCase()}`;
    const tbuf = await httpsGet(tokenUrl, { timeout: 6000, headers: { 'Referer': 'https://www.kugou.com/' } });
    const tdata = JSON.parse(tbuf.toString('utf8'));
    const candidate = tdata?.candidates?.[0];
    if (!candidate || !candidate.id || !candidate.accesskey) return null;
    // 先尝试逐字歌词（KRC），拿到就用它转出标准 LRC；失败则退回普通 LRC
    let yrcText = '';
    let lrc = '';
    try {
      const krcUrl = `https://lyrics.kugou.com/download?ver=1&client=pc&id=${candidate.id}&accesskey=${candidate.accesskey}&fmt=krc&charset=utf8`;
      const kbuf = await httpsGet(krcUrl, { timeout: 8000, headers: { 'Referer': 'https://www.kugou.com/' } });
      const kdata = JSON.parse(kbuf.toString('utf8'));
      if (kdata && kdata.content) {
        const plain = await decryptKrc(kdata.content);
        if (plain && plain.includes('<')) {
          yrcText = plain;
          lrc = krcToLrc(plain);
        }
      }
    } catch (e) { /* 忽略，走普通 LRC */ }
    if (!lrc || lrc.trim().length < 10) {
      const lyricUrl = `https://lyrics.kugou.com/download?ver=1&client=pc&id=${candidate.id}&accesskey=${candidate.accesskey}&fmt=lrc&charset=utf8`;
      const lbuf = await httpsGet(lyricUrl, { timeout: 6000, headers: { 'Referer': 'https://www.kugou.com/' } });
      const ldata = JSON.parse(lbuf.toString('utf8'));
      lrc = ldata?.content ? __b64ToText(ldata.content) : '';
      if (lrc && !lrc.includes('[')) {
        // 少数情况返回的是纯文本，包一层时间戳由上层兜底
        lrc = '';
      }
      yrcText = '';
    }
    if (!lrc || lrc.trim().length < 10) return null;
    return {
      lrc, tlyric: '', rlyric: '', yrc: yrcText,
      source: '酷狗音乐',
      songName: best.title,
      artist: best.artist
    };
  };
  try {
    return (await attempt(`${artist} ${title}`.trim())) || (await attempt(title));
  } catch (e) { return null; }
}

// 来源 4：酷我音乐
async function searchLyricsKuwo(artist, title, duration) {
  const attempt = async (keyword) => {
    const searchUrl = `https://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=8&rformat=json&encoding=utf8`;
    const buf = await httpsGet(searchUrl, {
      timeout: 6000,
      headers: { 'Referer': 'https://www.kuwo.cn/' }
    });
    let text = buf.toString('utf8');
    // 酷我返回的可能不是标准 JSON，尝试提取
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const m = text.match(/\{.*\}/s);
      if (m) data = JSON.parse(m[0]);
      else return null;
    }
    const songs = data?.abslist || data?.list || [];
    const best = pickBestMatch(songs, artist, title, duration, (s) => ({
      title: s.SONGNAME || s.name || '',
      artist: s.ARTIST || s.artist || '',
      duration: parseFloat(s.DURATION || s.duration || 0) || 0,
      musicId: s.MUSICRID || s.musicrid || s.id
    }));
    if (!best || !best.musicId) return null;
    // 去掉前缀
    const id = String(best.musicId).replace('MUSIC_', '');
    const lyricUrl = `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${id}`;
    const lbuf = await httpsGet(lyricUrl, { timeout: 6000, headers: { 'Referer': 'https://m.kuwo.cn/' } });
    const ldata = JSON.parse(lbuf.toString('utf8'));
    const lrclist = ldata?.data?.lrclist;
    if (!lrclist || lrclist.length === 0) return null;
    // 酷我返回的是逐行对象，需要转成 LRC 格式
    let lrc = '';
    for (const line of lrclist) {
      const time = parseFloat(line.time || 0);
      const text = line.lineLyric || '';
      if (text) {
        const min = Math.floor(time / 60);
        const sec = Math.floor(time % 60);
        const ms = Math.floor((time % 1) * 100);
        lrc += `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(2, '0')}]${text}\n`;
      }
    }
    if (!lrc || lrc.trim().length < 10) return null;
    return {
      lrc, tlyric: '',
      source: '酷我音乐',
      songName: best.title,
      artist: best.artist
    };
  };
  try {
    return (await attempt(`${artist} ${title}`.trim())) || (await attempt(title));
  } catch (e) { return null; }
}

// 把另一份译文时间轴对齐到原文时间轴（±500ms 就近吸附，对不上的行丢弃），
// 供跨源补翻译用：原文是 A 源的、译文是 B 源的，时间戳往往有细微偏差
function alignTlyricToLrc(lrc, tlyric) {
  if (!lrc || !tlyric) return '';
  const parse = (text) => {
    const map = new Map();
    const timeRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    for (const line of String(text).split(/\r?\n/)) {
      const txt = line.replace(timeRe, '').trim();
      if (!txt) continue;
      let m;
      timeRe.lastIndex = 0;
      while ((m = timeRe.exec(line)) !== null) {
        const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
        const time = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + ms / 1000;
        map.set(time, txt);
      }
    }
    return map;
  };
  const origTimes = [...parse(lrc).keys()].sort((a, b) => a - b);
  if (!origTimes.length) return '';
  const out = [];
  for (const [t, txt] of parse(tlyric)) {
    // 找最近的原文时间（歌词行都是顺序的，双指针即可）
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

// 主函数：依次尝试多个来源，优先返回有翻译的歌词
// duration（秒）用于时长约束；返回前再校验一次歌名，宁缺毋滥
async function searchLyrics(artist, title, duration) {
  artist = cleanMeta(artist);
  if (!artist && !title) return null;
  const sources = [
    { name: '网易云音乐', fn: searchLyricsNetEase },
    { name: 'QQ音乐', fn: searchLyricsQQ },
    { name: '酷狗音乐', fn: searchLyricsKugou },
    { name: '酷我音乐', fn: searchLyricsKuwo }
  ];
  let firstResult = null; // 第一个有歌词的结果（可能没有翻译）
  let otherTlyric = '';   // 其他来源拿到的译文（用于给无译文的结果跨源补全）
  const variants = titleVariants(title);
  for (let round = 0; round < variants.length; round++) {
    const qTitle = variants[round];
    // 第二轮开始只是变体重试：上一轮已经拿到可用的原文，就别再拿变体去覆盖它
    const allowTake = round === 0;
    for (const src of sources) {
      try {
        const result = await src.fn(artist, qTitle, duration);
        if (result && result.lrc && result.lrc.trim().length >= 10) {
          // 兜底校验：匹配回来的歌名对不上就丢弃（防再次错配缓存）
          if (result.songName && titleMatchScore(qTitle, result.songName) < TITLE_ACCEPT) continue;
          const hasTranslation = result.tlyric && result.tlyric.trim().length > 0;
          // 有译文就记下来（哪怕这首歌不被选中，译文也能给选中的那首补全）
          if (hasTranslation && !otherTlyric) otherTlyric = result.tlyric;
          // 有翻译的直接返回（优先）
          if (hasTranslation) {
            return {
              lrc: result.lrc,
              tlyric: result.tlyric || '',
              rlyric: result.rlyric || '',
              yrc: result.yrc || '',
              source: result.source || src.name,
              songName: result.songName || '',
              artist: result.artist || ''
            };
          }
          // 没有翻译的记录下来，继续尝试下一个来源
          if (!firstResult && allowTake) {
            firstResult = {
              lrc: result.lrc,
              tlyric: result.tlyric || '',
              rlyric: result.rlyric || '',
              yrc: result.yrc || '',
              source: result.source || src.name,
              songName: result.songName || '',
              artist: result.artist || ''
            };
          }
        }
      } catch (e) {
        // 继续尝试下一个来源
      }
    }
    // 第一轮就有结果且已有译文，够了；没译文则用变体再试一轮，看能不能拿到更好的
    if (firstResult && otherTlyric) break;
  }
  // 所有来源都没有翻译，返回第一个有歌词的结果
  // 但若其他来源有译文（只是它的原文没被选中），把译文时间轴对齐后合并进来
  if (firstResult && !firstResult.tlyric && otherTlyric) {
    const aligned = alignTlyricToLrc(firstResult.lrc, otherTlyric);
    if (aligned) firstResult.tlyric = aligned;
  }
  return firstResult;
}

// 按指定来源获取歌词（用于手动切换来源）
async function searchLyricsFromSource(sourceName, artist, title, duration) {
  artist = cleanMeta(artist);
  if (!artist && !title) return null;
  const sources = {
    '网易云音乐': searchLyricsNetEase,
    'QQ音乐': searchLyricsQQ,
    '酷狗音乐': searchLyricsKugou,
    '酷我音乐': searchLyricsKuwo,
  };
  const fn = sources[sourceName];
  if (!fn) return null;
  try {
    const result = await fn(artist, title, duration);
    if (result && result.lrc && result.lrc.trim().length >= 10) {
      if (result.songName && titleMatchScore(title, result.songName) < TITLE_ACCEPT) return null;
      return {
        lrc: result.lrc,
        tlyric: result.tlyric || '',
        rlyric: result.rlyric || '',
        yrc: result.yrc || '',
        source: sourceName,
        songName: result.songName || '',
        artist: result.artist || ''
      };
    }
  } catch (e) {}
  return null;
}

// 保存歌词到 .lrc 文件
// meta（可选）：{ songName, artist } 实际命中的歌曲信息。
// 落盘时若 LRC 缺 [ti:]/[ar:] 则补上（用命中歌名而非文件名），
// 供下次读缓存时校验"这份歌词是不是这首歌的"，防止错配缓存被反复命中。
function saveLyricsFile(lrc, saveDir, artist, title, meta) {
  try {
    if (!saveDir || !lrc) return null;
    // 兼容两种入参：纯 LRC 字符串，或 { lrc, tlyric, rlyric, yrc } 完整对象。
    // 只要带了附加字段（翻译/音译/逐字），就额外写一个 .lrc.json 边车，
    // 否则命中缓存时逐字和音译会全部丢失（缓存里只有纯 LRC）。
    const payload = (lrc && typeof lrc === 'object') ? lrc : { lrc: String(lrc) };
    let body = payload.lrc || '';
    if (!body) return null;
    // 补元标签：[ti:] 用实际命中的歌名（与曲目名不一致时，读缓存方能发现错配）
    const metaName = (meta && meta.songName) || title || '';
    const metaArtist = (meta && meta.artist) || artist || '';
    if (metaName && !/\[ti:[^\]]*\]/i.test(body)) {
      body = `[ti:${metaName}]\n` + body;
    }
    if (metaArtist && !/\[ar:[^\]]*\]/i.test(body)) {
      body = `[ar:${metaArtist}]\n` + body;
    }
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
    const fname = safeName(`${artist} - ${title}`) + '.lrc';
    const fpath = path.join(saveDir, fname);
    fs.writeFileSync(fpath, body, 'utf8');
    const hasExtra = !!(payload.tlyric || payload.rlyric || payload.yrc);
    const sidecar = fpath + '.json';
    if (hasExtra) {
      try {
        fs.writeFileSync(sidecar, JSON.stringify({
          lrc: body,
          tlyric: payload.tlyric || '',
          rlyric: payload.rlyric || '',
          yrc: payload.yrc || '',
          songName: metaName,
          savedAt: Date.now()
        }), 'utf8');
      } catch (e) { /* 边车写失败不影响主文件 */ }
    } else if (fs.existsSync(sidecar)) {
      // 这次拿到的只有纯文本，别把之前存过的好数据覆盖没了
    }
    return fpath;
  } catch (e) {
    return null;
  }
}

// 把歌词偏移（调速）写进边车 .lrc.json 的 offset 字段（2026-11-20）。
// 配置里的 lyricOffsets 按完整文件路径存，文件挪位置/换盘就丢；
// 边车跟着「歌手 - 标题.lrc」走，路径无关 —— 读缓存时自动取回。
// offset 归 0 时删除字段；没有 .lrc 缓存文件就不写（没边车可挂）。
function saveLyricsOffset(saveDir, artist, title, offset) {
  try {
    if (!saveDir || (!artist && !title)) return false;
    const v = Math.round((Number(offset) || 0) * 10) / 10;
    const fpath = path.join(saveDir, safeName(`${artist} - ${title}`) + '.lrc');
    if (!fs.existsSync(fpath)) return false;
    const sidecar = fpath + '.json';
    let data = {};
    try { data = JSON.parse(fs.readFileSync(sidecar, 'utf8')) || {}; } catch (e) { data = {}; }
    if (typeof data !== 'object') data = {};
    if (Math.abs(v) < 0.001) delete data.offset;
    else data.offset = v;
    data.savedAt = Date.now();
    fs.writeFileSync(sidecar, JSON.stringify(data), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

// 解析 LRC 为带时间戳的行
function parseLRC(lrc) {
  if (!lrc) return [];
  const lines = lrc.split(/\r?\n/);
  const result = [];
  const timeRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of lines) {
    const text = line.replace(timeRe, '').trim();
    if (!text) continue;
    let m;
    timeRe.lastIndex = 0;
    while ((m = timeRe.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
      const time = min * 60 + sec + ms / 1000;
      result.push({ time, text });
    }
  }
  result.sort((a, b) => a.time - b.time);
  return result;
}

// ---------- 字符串相似度（用于自动匹配校验） ----------
// 纯编辑距离比（不含包含捷径）
function levRatio(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  const maxLen = Math.max(m, n);
  return maxLen === 0 ? 1 : 1 - dp[m][n] / maxLen;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  a = String(a).toLowerCase().trim();
  b = String(b).toLowerCase().trim();
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  return levRatio(a, b);
}

// ---------- 最佳匹配挑选（标题精确优先 + 歌手/时长约束） ----------
// 背景：旧逻辑"a.includes(歌手) || n.includes(标题)"命中第一个就 break，
// 于是"你的爱"会被"谢绝推销你的爱"（包含关系）抢走，缓存里就存错了歌。
// 新策略：归一化后给所有候选打分，标题精确 > 去括号精确 > 包含 > 编辑距离，
// 歌手/时长作约束与同分裁决；不达标宁可返回 null（由下一个来源兜底）。
const TITLE_ACCEPT = 0.62;   // 标题分低于此值不接受（防"你的爱"命中"谢绝推销你的爱"）
const ARTIST_ACCEPT = 0.45;  // 指定了歌手时，歌手分低于此值不接受（防同名歌抢标题）

// 归一化：小写、去括号注记（Live/伴奏/翻自…）、去标点空白
function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/g, '')
    .replace(/[\s\u3000·・\.。,，、;；:：!！?？'"'"“”‘’\-—_~`|/\\+&×]/g, '')
    .trim();
}

// 占位 / 无意义的元数据：这些词拼进搜索词只会污染查询。
// 实测（2026-11-19）：artist="未知歌手" + 歌名「乌苏里船歌」→ 搜出来的是 QQ 音乐里同标
// 「未知歌手」的翻唱版本，且因为歌手名完全一致拿到 conf=1.00 的最高置信度，把真正的
// 原唱条目顶掉；改成空歌手后同样的歌能正确匹配到「郭颂 / 原唱经典名曲珍藏1」。
const PLACEHOLDER_META = /^(未知歌手|未知艺术家|未知艺人|未知作者|未知专辑|未知|unknown(\s*(artist|album|title))?|various\s*artists|va|佚名|无|none|null|undefined|n\/a)$/i;
function isPlaceholderMeta(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return true;
  if (PLACEHOLDER_META.test(v)) return true;
  // 允许尾巴上的标点/空格：「未知歌手 」也算
  return PLACEHOLDER_META.test(v.replace(/[\s\-_.·]+$/, ''));
}
// 搜索前清洗：占位值一律当「没有这个信息」，避免污染查询词和打分
function cleanMeta(s) {
  return isPlaceholderMeta(s) ? '' : String(s).trim();
}


function titleMatchScore(query, cand) {
  const q0 = String(query || '').toLowerCase().trim();
  const c0 = String(cand || '').toLowerCase().trim();
  if (!q0 || !c0) return 0;
  if (q0 === c0) return 1;
  const qs = normText(query), cs = normText(cand);
  if (!qs || !cs) return 0;
  if (qs === cs) return 0.93;             // 仅差括号注记（Live/伴奏等）
  if (cs.includes(qs) || qs.includes(cs)) {
    const ratio = Math.min(qs.length, cs.length) / Math.max(qs.length, cs.length);
    return 0.35 + 0.4 * ratio;            // 包含关系打折：越接近等长越可信
  }
  return Math.max(similarity(qs, cs), similarity(q0, c0)) * 0.85;
}

// 拆多歌手：分隔符/空白/feat 切开，任一部分精确相等就算同一歌手
function splitArtists(s) {
  return String(s || '')
    .split(/[/\\;,，、&+×]|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\s+/i)
    .map(x => x.trim())
    .filter(Boolean);
}

function artistMatchScore(query, cand) {
  const qs = normText(query), cs = normText(cand);
  if (!qs || !cs) return 0.5;             // 未知按中性处理
  if (qs === cs) return 1;
  const qParts = splitArtists(query).map(normText).filter(Boolean);
  const cParts = splitArtists(cand).map(normText).filter(Boolean);
  for (const qp of qParts) {
    for (const cp of cParts) {
      if (qp === cp) return 0.95;          // 多歌手里精确命中
    }
  }
  // 包含关系还要求长度接近，防"广东王力宏"蹭"王力宏"这类蹭名歌手
  const pairs = [[qs, cs]];
  for (const qp of qParts) for (const cp of cParts) pairs.push([qp, cp]);
  for (const [a, b] of pairs) {
    if (a && b && (a.includes(b) || b.includes(a))) {
      const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      if (ratio >= 0.7) return 0.85;
    }
  }
  return levRatio(qs, cs) * 0.7;
}

function durationMatchScore(querySec, candSec) {
  const q = Number(querySec), c = Number(candSec);
  if (!(q > 0) || !(c > 0)) return 0.5;   // 缺时长信息按中性处理
  const diff = Math.abs(q - c);
  if (diff <= 3) return 1;
  if (diff <= 8) return 0.75;
  if (diff <= 20) return 0.45;
  if (diff <= 45) return 0.2;
  return 0.05;
}

// 时长硬门槛：双方都有时长且差得离谱（超过 45 秒且超过 25%）就直接否决。
// 网易云搜"你的爱"会给一堆 30~90 秒的翻唱/片段，标题再像也不能要。
function durationOK(querySec, candSec) {
  const q = Number(querySec), c = Number(candSec);
  if (!(q > 0) || !(c > 0)) return true;
  const diff = Math.abs(q - c);
  return diff <= Math.max(45, q * 0.25);
}

// 从候选列表里挑最佳匹配。mapFn 把各源字段映射成 { title, artist, duration }（秒）。
// 门槛：标题分 ≥ TITLE_ACCEPT、（未提供歌手 或 歌手分 ≥ ARTIST_ACCEPT）、时长不离谱。
// 排序：标题分主导，歌手/时长作同段裁决——精确标题永远压过"包含标题"的长名。
function pickBestMatch(cands, artist, title, duration, mapFn) {
  if (!Array.isArray(cands) || !cands.length) return null;
  let best = null;
  for (const c of cands) {
    let m;
    try { m = mapFn(c); } catch (e) { continue; }
    if (!m || !m.title) continue;
    const tScore = titleMatchScore(title, m.title);
    if (tScore < TITLE_ACCEPT) continue;
    const aScore = artistMatchScore(artist, m.artist);
    // 标题精确 + 双方时长都已知时放宽歌手门槛（翻唱/合作署名常见），
    // 此时由时长把关；否则维持严格门槛，防同名歌抢标题
    const durKnown = Number(duration) > 0 && Number(m.duration) > 0;
    const aGate = (tScore >= 0.93 && durKnown) ? 0.25 : ARTIST_ACCEPT;
    if (String(artist || '').trim() && aScore < aGate) continue;
    if (!durationOK(duration, m.duration)) continue;
    const dScore = durationMatchScore(duration, m.duration);
    // 候选自身是占位信息（"未知歌手" / 无专辑）时降权：这类条目基本是没写元数据的翻唱或搬运，
    // 标题再准也不该压过有完整署名和专辑的版本。60 分≈标题分差 0.06，只影响比分接近时的排序，
    // 不会把唯一匹配的结果整个筛掉。
    const metaPenalty = (isPlaceholderMeta(m.artist) ? 60 : 0) + (isPlaceholderMeta(m.album) ? 20 : 0);
    // 时长权重：拿到本地真实时长时提到 150 —— 同名不同版本（民歌 vs 儿歌、DJ 版 vs 原版）
    // 标题分完全一样，只有时长能把它们分开，20 分根本不够翻盘。
    const score = tScore * 1000 + aScore * 120 + dScore * (durKnown ? 150 : 20) - metaPenalty;
    if (!best || score > best._score) {
      best = Object.assign({}, m, { _score: score, _titleScore: tScore, _artistScore: aScore });
    }
  }
  return best;
}

// ---------- 搜索歌曲详细信息（用于自动修复） ----------

// 网易云搜索歌曲详情
async function searchSongInfoNetEase(artist, title, duration) {
  const keyword = encodeURIComponent(`${artist} ${title}`.trim());
  const searchUrl = `https://music.163.com/api/search/get?s=${keyword}&type=1&offset=0&limit=10`;
  try {
    const buf = await httpsGet(searchUrl, { timeout: 6000, headers: { 'Referer': 'https://music.163.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    const songs = data?.result?.songs || [];
    const best = pickBestMatch(songs, artist, title, duration || 0, (s) => ({
      title: s.name || '',
      artist: (s.artists || []).map(x => x.name).join(' / '),
      album: s.album?.name || '',
      songId: s.id || null,
      duration: (s.duration || s.dt || 0) / 1000
    }));
    if (!best) return null;
    // 其余候选（songId + 标题/歌手）：免费链接获取时最佳匹配若只有试听片段，逐个再试
    const candidates = songs
      .filter((s) => s.id && s.id !== best.songId)
      .slice(0, 4)
      .map((s) => ({
        songId: s.id,
        title: s.name || '',
        artist: (s.artists || []).map((x) => x.name).join(' / ')
      }));
    return {
      title: best.title,
      artist: best.artist,
      album: best.album || '',
      songId: best.songId || null,
      candidates,
      source: '网易云音乐',
      confidence: Math.min(1, (best._titleScore * 0.6 + best._artistScore * 0.4))
    };
  } catch (e) { return null; }
}

// ---------- 歌手在线歌曲搜索（2026-11-20）----------
// 给「双击歌手名筛选」追加网络歌曲灰色行用：只搜歌名/歌手/专辑/来源，
// 不取播放地址 —— 试听走平台网页跳转（openPlatformPage）。
async function searchArtistSongsQQ(artist, limit) {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(artist)}&format=json&p=1&n=${limit}`;
  try {
    const buf = await httpsGet(url, { timeout: 6000, headers: { Referer: 'https://y.qq.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    return (data?.data?.song?.list || []).map(s => ({
      title: s.songname || '',
      artist: (s.singer || []).map(x => x.name).join(' / '),
      album: s.albumname || '',
      source: 'qqmusic'
    })).filter(x => x.title);
  } catch (e) { return []; }
}

async function searchArtistSongsNetEase(artist, limit) {
  const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(artist)}&type=1&offset=0&limit=${limit}`;
  try {
    const buf = await httpsGet(url, { timeout: 6000, headers: { Referer: 'https://music.163.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    return (data?.result?.songs || []).map(s => ({
      title: s.name || '',
      artist: (s.artists || []).map(x => x.name).join(' / '),
      album: (s.album && s.album.name) || '',
      source: 'netease'
    })).filter(x => x.title);
  } catch (e) { return []; }
}

// 歌名+歌手归一化 key：用于跨平台去重、以及剔除本地已有的同首歌
function songKeyOf(title, artist) {
  return (String(title || '') + '@' + String(artist || '')).toLowerCase().replace(/\s+/g, '');
}

// 合并 QQ + 网易两源搜索结果：跨平台去重（同一首只留一条，QQ 优先），上限 limit 条
function mergeSongResults(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = songKeyOf(item.title, item.artist);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

async function searchArtistSongs(artist, limit = 12) {
  if (!artist || isPlaceholderMeta(artist)) return [];
  const [qq, ne] = await Promise.all([
    searchArtistSongsQQ(artist, 20),
    searchArtistSongsNetEase(artist, 20)
  ]);
  return mergeSongResults(qq.concat(ne), limit);
}

// ---------- 专辑在线歌曲搜索（2026-11-20）----------
// 给「点击专辑名筛选」追加该专辑的网络歌曲灰色行：拿专辑名当关键词搜歌曲，
// 再按专辑名归一化过滤（专辑字段对不上的不要 —— 同名歌出现在别的合辑里不能混进来）。
function albumKeyOf(name) {
  // 去空白与常见标点，Deluxe/Explicit/版式词不计入匹配（"叶惠美" vs "叶惠美 Deluxe Edition" 应算同专辑）
  return String(name || '').toLowerCase()
    .replace(/[\s（）()【】\[\]·\-—_:.：、'!！?？,，]+/g, '')
    .replace(/(deluxe|deluxeedition|explicit|edition|version|ver|album|专辑|版)/g, '');
}

function albumMatches(query, cand) {
  const q = albumKeyOf(query), c = albumKeyOf(cand);
  if (!q || !c) return false;
  if (q === c) return true;
  // 包含关系 + 长度接近才算（防"精选"蹭正式专辑名）
  if (c.includes(q) || q.includes(c)) {
    return Math.min(q.length, c.length) / Math.max(q.length, c.length) >= 0.7;
  }
  return false;
}

async function searchAlbumSongsQQ(album, limit) {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(album)}&format=json&p=1&n=${limit}`;
  try {
    const buf = await httpsGet(url, { timeout: 6000, headers: { Referer: 'https://y.qq.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    return (data?.data?.song?.list || []).map(s => ({
      title: s.songname || '',
      artist: (s.singer || []).map(x => x.name).join(' / '),
      album: s.albumname || '',
      source: 'qqmusic'
    })).filter(x => x.title && albumMatches(album, x.album));
  } catch (e) { return []; }
}

async function searchAlbumSongsNetEase(album, limit) {
  const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(album)}&type=1&offset=0&limit=${limit}`;
  try {
    const buf = await httpsGet(url, { timeout: 6000, headers: { Referer: 'https://music.163.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    return (data?.result?.songs || []).map(s => ({
      title: s.name || '',
      artist: (s.artists || []).map(x => x.name).join(' / '),
      album: (s.album && s.album.name) || '',
      source: 'netease'
    })).filter(x => x.title && albumMatches(album, x.album));
  } catch (e) { return []; }
}

async function searchAlbumSongs(album, limit = 12) {
  if (!album || isPlaceholderMeta(album)) return [];
  // 多抓一些候选：专辑名搜索会混入不少别的专辑的同名结果，过滤后剩的不多
  const [qq, ne] = await Promise.all([
    searchAlbumSongsQQ(album, 30),
    searchAlbumSongsNetEase(album, 30)
  ]);
  return mergeSongResults(qq.concat(ne), limit);
}

// ---------- 关键词在线歌曲搜索（2026-11-20）----------
// 给主页搜索栏「本地没有时推送网络歌曲」用：直接拿关键词搜歌曲，
// QQ/网易云双源并行，合并去重（上面的歌手/专辑搜索本质都是关键词搜索，直接复用）。
async function searchSongsByKeyword(keyword, limit = 12) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const [qq, ne] = await Promise.all([
    searchArtistSongsQQ(kw, 20),
    searchArtistSongsNetEase(kw, 20)
  ]);
  return mergeSongResults(qq.concat(ne), limit);
}

// ---------- 免费下载链接获取（2026-11-20）----------
// 免费歌（无需会员）直接拿播放直链；会员歌返回 vip 标记，由上层提示。
// 网易云：enhance/player/url 接口，免登录时免费歌返回 url，会员歌 url 为空；
// QQ音乐：vkey.GetVkeyServerBase，免登录时免费歌 purl 非空，会员歌 purl 为空。
async function getNeteaseDownloadUrl(songId) {
  const url = `https://music.163.com/api/song/enhance/player/url?ids=%5B${songId}%5D&id=${songId}&br=320000`;
  try {
    const buf = await httpsGet(url, {
      timeout: 6000,
      headers: { Referer: 'https://music.163.com/', Cookie: 'os=pc; appver=2.9.7' }
    });
    const data = JSON.parse(buf.toString('utf8'));
    const d = data && data.data && data.data[0];
    if (!d || !d.url) return { ok: false, vip: true };
    return { ok: true, url: String(d.url).replace(/^http:/, 'https:'), br: d.br || 0, trial: !!d.freeTrialInfo };
  } catch (e) { return { ok: false }; }
}

async function getQQDownloadUrl(songmid) {
  const guid = String(Math.floor(Math.random() * 9000000000) + 1000000000);
  const payload = JSON.stringify({
    req: { module: 'vkey.GetVkeyServerBase', method: 'CgiGetVkey', guid, songmid: [songmid], songtype: [0], filename: [] }
  });
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(payload)}`;
  try {
    const buf = await httpsGet(url, { timeout: 6000, headers: { Referer: 'https://y.qq.com/' } });
    const j = JSON.parse(buf.toString('utf8'));
    const base = j && j.req && j.req.data;
    const info = base && base.midurlinfo && base.midurlinfo[0];
    if (!info || !info.purl) return { ok: false, vip: true };
    const cdn = (base.cdnurl && String(base.cdnurl).replace(/^http:/, 'https:')) || 'https://dl.stream.qqmusic.qq.com/';
    return { ok: true, url: cdn.replace(/\/$/, '') + '/' + info.purl, trial: false };
  } catch (e) { return { ok: false }; }
}

// 双平台并行：先精确匹配出平台歌曲 ID，再取播放直链。
// 优先完整免费链接（QQ音乐 > 网易云），其次是试听片段（trial，上层提示）；
// 两边都拿不到且带 vip 标记 → 会员歌曲。
async function getFreeDownloadLink(artist, title, duration) {
  const [qqInfo, neInfo] = await Promise.all([
    searchSongInfoQQ(artist, title, duration || 0),
    searchSongInfoNetEase(artist, title, duration || 0)
  ]);
  const results = { qq: null, ne: null };
  const tasks = [];
  if (qqInfo && qqInfo.songmid) {
    tasks.push(getQQDownloadUrl(qqInfo.songmid).then(r => { results.qq = r; }).catch(() => {}));
  }
  if (neInfo && neInfo.songId) {
    tasks.push(getNeteaseDownloadUrl(neInfo.songId).then(r => { results.ne = r; }).catch(() => {}));
  }
  await Promise.all(tasks);
  const order = [['qq', 'QQ音乐'], ['ne', '网易云音乐']];
  for (const [key, plat] of order) {
    const r = results[key];
    if (r && r.ok && !r.trial) return { ok: true, platform: plat, url: r.url, br: r.br || 0 };
  }
  // 网易云最佳匹配只有试听片段时：把其余候选逐个再试（同一首歌常有免试听的版本）
  if (results.ne && results.ne.trial && neInfo && Array.isArray(neInfo.candidates)) {
    for (const c of neInfo.candidates) {
      if (!c.songId) continue;
      const r = await getNeteaseDownloadUrl(c.songId).catch(() => null);
      if (r && r.ok && !r.trial) {
        return { ok: true, platform: '网易云音乐', url: r.url, br: r.br || 0, viaCandidate: c.title };
      }
    }
  }
  for (const [key, plat] of order) {
    const r = results[key];
    if (r && r.ok && r.trial) return { ok: true, platform: plat, url: r.url, trial: true };
  }
  return { ok: false, vip: !!(results.qq && results.qq.vip) || !!(results.ne && results.ne.vip) };
}

// QQ音乐搜索歌曲详情
async function searchSongInfoQQ(artist, title, duration) {
  const keyword = encodeURIComponent(`${artist} ${title}`.trim());
  const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${keyword}&format=json&p=1&n=10`;
  try {
    const buf = await httpsGet(searchUrl, { timeout: 6000, headers: { 'Referer': 'https://y.qq.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    const songs = data?.data?.song?.list || [];
    const best = pickBestMatch(songs, artist, title, duration || 0, (s) => ({
      title: s.songname || '',
      artist: (s.singer || []).map(x => x.name).join(' / '),
      album: s.albumname || '',
      songmid: s.songmid || null,
      duration: s.interval || 0
    }));
    if (!best) return null;
    return {
      title: best.title,
      artist: best.artist,
      album: best.album || '',
      songmid: best.songmid || null,
      source: 'QQ音乐',
      confidence: Math.min(1, (best._titleScore * 0.6 + best._artistScore * 0.4))
    };
  } catch (e) { return null; }
}

// 酷狗搜索歌曲详情
async function searchSongInfoKugou(artist, title, duration) {
  const keyword = encodeURIComponent(`${artist} ${title}`.trim());
  const searchUrl = `https://songsearch.kugou.com/song_search_v2?keyword=${keyword}&page=1&pagesize=10&format=json&platform=WebFilter`;
  try {
    const buf = await httpsGet(searchUrl, { timeout: 6000, headers: { 'Referer': 'https://www.kugou.com/' } });
    const data = JSON.parse(buf.toString('utf8'));
    const songs = data?.data?.lists || [];
    const best = pickBestMatch(songs, artist, title, duration || 0, (s) => ({
      title: s.SongName || '',
      artist: s.SingerName || '',
      album: s.AlbumName || '',
      duration: (s.Duration || (s.Timelength ? s.Timelength / 1000 : 0)) || 0
    }));
    if (!best) return null;
    return {
      title: best.title,
      artist: best.artist,
      album: best.album || '',
      source: '酷狗音乐',
      confidence: Math.min(1, (best._titleScore * 0.6 + best._artistScore * 0.4))
    };
  } catch (e) { return null; }
}

// 主函数：多源搜索歌曲详情，返回最匹配的结果
async function searchSongInfo(artist, title, duration) {
  artist = cleanMeta(artist);
  if (!artist && !title) return null;
  const sources = [
    { name: '网易云音乐', fn: searchSongInfoNetEase },
    { name: 'QQ音乐', fn: searchSongInfoQQ },
    { name: '酷狗音乐', fn: searchSongInfoKugou }
  ];
  let best = null;
  for (const src of sources) {
    try {
      const result = await src.fn(artist, title, duration);
      if (result && (!best || result.confidence > best.confidence)) {
        best = result;
      }
      // 如果找到高置信度结果，提前返回
      if (best && best.confidence >= 0.85) break;
    } catch (e) { /* 继续尝试下一个来源 */ }
  }
  return best;
}

// 自动修复歌曲信息：返回修复后的结果和是否需要修复
async function autoFixTrackInfo(artist, title, album, duration) {
  // 本地是「未知歌手 / 未知专辑」时按「没有这个信息」处理：否则既污染搜索词，
  // 又会在 artistOk 校验里恒为 false（虽然会触发修复，但搜不到正确结果也白修）
  artist = cleanMeta(artist);
  album = cleanMeta(album);
  const result = await searchSongInfo(artist, title, duration);
  if (!result) return { needFix: false, reason: '未找到匹配的歌曲信息' };
  // 校验当前信息是否正确
  const titleOk = similarity(title, result.title) >= 0.8;
  const artistOk = similarity(artist, result.artist) >= 0.7;
  const albumOk = !album || !result.album || similarity(album, result.album) >= 0.7;
  const needFix = !titleOk || !artistOk || !albumOk;
  return {
    needFix,
    original: { title, artist, album },
    fixed: {
      title: result.title,
      artist: result.artist,
      album: result.album
    },
    source: result.source,
    confidence: result.confidence,
    checks: { titleOk, artistOk, albumOk }
  };
}

// ---------- 补全歌曲信息（歌名 / 歌手 / 专辑） ----------
// 用「歌名 + 歌手」反查平台，一次搜索同时拿到专辑名与专辑候选。
// 注意：同一首歌常同时属于专辑版 / 单曲 / EP / 精选 / 巡演，所以不止返回"最可能的那张"，
// 还把命中的其它专辑按分数排好一起返回，由渲染层结合本地曲库已有专辑名收敛。

// 专辑名归一化（判断两张专辑是否同一张）：
// 借用 normText 去掉括号注记（(Deluxe) / (Live) / 【】），再额外去掉书名号
function albumKey(s) {
  return normText(String(s || '').replace(/[《》〈〉]/g, ''));
}

// 拿到两家平台的歌曲搜索原始候选（含专辑名与时长）
async function collectSongCandidates(artist, title) {
  const kw = `${artist || ''} ${title || ''}`.trim();
  const out = [];
  try {
    const r = await neSearch(1, kw, 15);
    for (const s of (r.songs || [])) {
      out.push({
        title: s.name || '',
        artist: (s.artists || []).map((x) => x.name).join(' / '),
        album: (s.album && s.album.name) || '',
        duration: (s.duration || 0) / 1000,
        source: '网易云音乐'
      });
    }
  } catch (e) { /* 换 QQ */ }
  try {
    const list = await qqSearchList('song', kw, 15);
    for (const s of list) {
      out.push({
        title: s.songname || '',
        artist: (s.singer || []).map((x) => x.name).join(' / '),
        album: s.albumname || '',
        duration: s.interval || 0,
        source: 'QQ音乐'
      });
    }
  } catch (e) { /* 两家都挂就返回空 */ }
  return out;
}

// 返回 { ok, best:{title,artist,album,duration,source}, albums:[{name,source,score,duration}], confidence }
async function completeTrackInfo({ title, artist, album, duration } = {}) {
  const qTitle = String(title || '').trim();
  if (!qTitle) return { ok: false, error: '缺少歌名，无法匹配' };
  const qArtist = cleanMeta(artist);

  const cands = await collectSongCandidates(qArtist, qTitle);
  if (!cands.length) return { ok: false, error: '联网搜索没有拿到结果（可能网络不通）' };

  const scored = [];
  for (const c of cands) {
    if (!c.title) continue;
    const tScore = titleMatchScore(qTitle, c.title);
    if (tScore < TITLE_ACCEPT) continue;
    const aScore = artistMatchScore(qArtist, c.artist);
    // 歌手未知（库里写的是"未知歌手"时 qArtist 可能是空）就不卡歌手门槛
    if (qArtist && aScore < ARTIST_ACCEPT) continue;
    const dScore = durationMatchScore(duration, c.duration);
    scored.push(Object.assign({}, c, {
      _t: tScore, _a: aScore, _score: tScore * 1000 + aScore * 120 + dScore * 20
    }));
  }
  if (!scored.length) return { ok: false, error: '没搜到匹配的歌曲' };

  scored.sort((x, y) => y._score - x._score);
  const best = scored[0];

  // 专辑候选合并（同名专辑只留最高分那条），最多给 6 个
  const albums = [];
  const seen = new Map();
  for (const s of scored) {
    const k = albumKey(s.album);
    if (!k) continue;
    const hit = seen.get(k);
    if (hit) {
      if (s._score > hit.score) { hit.score = s._score; hit.source = s.source; hit.duration = s.duration; }
      continue;
    }
    const item = { name: s.album, source: s.source, score: s._score, duration: s.duration };
    seen.set(k, item);
    albums.push(item);
  }

  return {
    ok: true,
    best: {
      title: best.title,
      artist: best.artist,
      // QQ 上数字单曲/无专辑条目会返回空 albumname，此时退回分数最高的专辑候选
      album: best.album || (albums[0] ? albums[0].name : ''),
      duration: best.duration || 0,
      source: best.source
    },
    albums: albums.slice(0, 6).map((a) => ({ name: a.name, source: a.source, score: Math.round(a.score), duration: a.duration })),
    confidence: Math.min(1, best._t * 0.6 + best._a * 0.4),
    current: { title: qTitle, artist: qArtist, album: String(album || '') }
  };
}

// ---------- 在线页面解析（右键「联网查看」→ 单曲 / 歌手 / 专辑） ----------
// 思路：优先拿平台自己的搜索接口解析出 mid/id，拼成精确页面地址；
// 解析失败再用搜索页兜底，保证点下去永远有反应。

function onlineSearchUrl(platform, want, keyword) {
  const kw = encodeURIComponent(String(keyword || '').trim());
  if (platform === 'qqmusic') {
    const t = want === 'album' ? 'album' : want === 'artist' ? 'singer' : 'song';
    return 'https://y.qq.com/n/ryqq/search?w=' + kw + '&t=' + t;
  }
  const type = want === 'album' ? 10 : want === 'artist' ? 100 : 1;
  return 'https://music.163.com/#/search/m/?s=' + kw + '&type=' + type;
}

// QQ 搜索：kind = song | singer | album（t=8 专辑、t=9 歌手，缺省是歌曲）
async function qqSearchList(kind, keyword, limit = 8) {
  const t = kind === 'album' ? 8 : kind === 'singer' ? 9 : 0;
  let url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' +
    encodeURIComponent(String(keyword || '').trim()) + '&format=json&p=1&n=' + limit;
  if (t) url += '&t=' + t;
  const buf = await httpsGet(url, { timeout: 6000, headers: { Referer: 'https://y.qq.com/' } });
  const data = JSON.parse(buf.toString('utf8'));
  const d = (data && data.data) || {};
  if (kind === 'album') return (d.album && d.album.list) || [];
  if (kind === 'singer') return (d.singer && d.singer.list) || [];
  return (d.song && d.song.list) || [];
}

// 网易云搜索：type 1 歌曲 / 100 歌手 / 10 专辑
async function neSearch(type, keyword, limit = 10) {
  const url = 'https://music.163.com/api/search/get?s=' +
    encodeURIComponent(String(keyword || '').trim()) + '&type=' + type + '&offset=0&limit=' + limit;
  const buf = await httpsGet(url, {
    timeout: 6000,
    headers: { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' }
  });
  const data = JSON.parse(buf.toString('utf8'));
  return (data && data.result) || {};
}

async function resolveQQPage({ title, artist, album, want, songmid }) {
  if (want === 'song') {
    // 歌单导入的占位曲目自带 songmid：不用联网，直接拼单曲页
    if (songmid) {
      return { url: 'https://y.qq.com/n/ryqq/songDetail/' + songmid, label: title, id: songmid };
    }
    const list = await qqSearchList('song', [artist, title].filter(Boolean).join(' '));
    const best = pickBestMatch(list, artist, title, 0, (s) => ({
      title: s.songname || '',
      artist: (s.singer || []).map((x) => x.name).join(' / '),
      duration: s.interval || 0,
      id: s.songmid
    }));
    if (!best || !best.id) return null;
    return { url: 'https://y.qq.com/n/ryqq/songDetail/' + best.id, label: best.title, id: best.id };
  }

  if (want === 'artist') {
    if (!artist) return null;
    const list = await qqSearchList('singer', artist);
    let best = null;
    for (const s of list) {
      const sc = titleMatchScore(artist, s.singerName || '');
      if (!s.singerMID || sc < 0.78) continue;
      if (!best || sc > best.sc) best = { sc, id: s.singerMID, name: s.singerName };
    }
    if (!best) return null;
    return { url: 'https://y.qq.com/n/ryqq/singer/' + best.id, label: best.name, id: best.id };
  }

  // want === 'album'
  if (!album) return null;
  const list = await qqSearchList('album', [artist, album].filter(Boolean).join(' '));
  let best = null;
  for (const a of list) {
    const nameSc = titleMatchScore(album, a.albumName || '');
    if (!a.albumMID || nameSc < 0.78) continue;   // 「依然范特西」不能被「范特西」抢走
    const arName = (a.singer_list || []).map((x) => x.name).join(' / ') || a.singerName || '';
    const arSc = artist ? artistMatchScore(artist, arName) : 0.6;
    if (artist && arSc < 0.45) continue;
    const sc = nameSc * 0.7 + arSc * 0.3;
    if (!best || sc > best.sc) best = { sc, id: a.albumMID, name: a.albumName };
  }
  if (!best) return null;
  return { url: 'https://y.qq.com/n/ryqq/albumDetail/' + best.id, label: best.name, id: best.id };
}

async function resolveNeteasePage({ title, artist, album, want }) {
  if (want === 'song') {
    const r = await neSearch(1, [artist, title].filter(Boolean).join(' '));
    const best = pickBestMatch(r.songs || [], artist, title, 0, (s) => ({
      title: s.name || '',
      artist: (s.artists || s.ar || []).map((x) => x.name).join(' / '),
      duration: (s.duration || s.dt || 0) / 1000,
      id: s.id
    }));
    if (!best || !best.id) return null;
    return { url: 'https://music.163.com/#/song?id=' + best.id, label: best.title, id: best.id };
  }

  if (want === 'artist') {
    if (!artist) return null;
    const r = await neSearch(100, artist);
    let best = null;
    for (const a of r.artists || []) {
      const sc = titleMatchScore(artist, a.name || '');
      if (!a.id || sc < 0.78) continue;
      if (!best || sc > best.sc) best = { sc, id: a.id, name: a.name };
    }
    if (!best) return null;
    return { url: 'https://music.163.com/#/artist?id=' + best.id, label: best.name, id: best.id };
  }

  if (!album) return null;
  const r = await neSearch(10, [artist, album].filter(Boolean).join(' '));
  let best = null;
  for (const a of r.albums || []) {
    const nameSc = titleMatchScore(album, a.name || '');
    if (!a.id || nameSc < 0.78) continue;
    const arName = (a.artist && a.artist.name) || (a.artists || []).map((x) => x.name).join(' / ') || '';
    const arSc = artist ? artistMatchScore(artist, arName) : 0.6;
    if (artist && arSc < 0.45) continue;
    const sc = nameSc * 0.7 + arSc * 0.3;
    if (!best || sc > best.sc) best = { sc, id: a.id, name: a.name };
  }
  if (!best) return null;
  return { url: 'https://music.163.com/#/album?id=' + best.id, label: best.name, id: best.id };
}

// 主入口：先按曲目来源平台解析，失败自动换另一家，最后兜底搜索页
async function resolveOnlineLinks(payload = {}) {
  const want = (payload.want === 'artist' || payload.want === 'album') ? payload.want : 'song';
  const platform = payload.platform === 'qqmusic' ? 'qqmusic' : 'netease';
  const args = {
    title: payload.title || '',
    artist: payload.artist || '',
    album: payload.album || '',
    songmid: payload.songmid || '',
    want
  };
  // strictPlatform：用户显式选了平台（如评论入口选网易云）时只查那一家，
  // 搜不到就交给调用方提示换平台，不再偷偷跳到另一家。普通「联网查看」仍自动兜底。
  const order = payload.strictPlatform
    ? [platform]
    : (platform === 'qqmusic' ? ['qqmusic', 'netease'] : ['netease', 'qqmusic']);
  let lastError = '';
  for (const p of order) {
    try {
      const hit = p === 'qqmusic' ? await resolveQQPage(args) : await resolveNeteasePage(args);
      if (hit && hit.url) return Object.assign({ ok: true, platform: p, want }, hit);
    } catch (e) {
      lastError = e.message || String(e);
    }
  }
  const kw = want === 'artist' ? args.artist
    : want === 'album' ? (args.artist + ' ' + args.album).trim()
    : (args.artist + ' ' + args.title).trim();
  return {
    ok: true,
    platform: order[0],
    want,
    fallback: true,
    url: onlineSearchUrl(order[0], want, kw || args.title),
    label: kw || args.title,
    error: lastError
  };
}

// ---------- 抓取歌单顺序 ----------

// 从QQ音乐链接中提取歌单ID
function extractQQPlaylistId(url) {
  if (!url) return null;
  // 支持多种格式：id=xxx、playlist/xxx、disstid=xxx
  const patterns = [
    /[?&]id=(\d+)/,
    /playlist\/(\d+)/,
    /disstid=(\d+)/,
    /^(\d+)$/  // 纯数字
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// 从网易云链接中提取歌单ID
function extractNetEasePlaylistId(url) {
  if (!url) return null;
  const patterns = [
    /[?&]id=(\d+)/,
    /playlist\/(\d+)/,
    /^(\d+)$/  // 纯数字
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// 抓取QQ音乐歌单
async function fetchQQPlaylist(playlistId) {
  if (!playlistId) return null;
  const url = `https://c6.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${playlistId}&format=jsonp&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0`;
  try {
    const buf = await httpsGet(url, {
      timeout: 10000,
      headers: { 'Referer': 'https://y.qq.com/' }
    });
    let text = buf.toString('utf8');
    // 可能是 JSONP 格式，提取 JSON
    const jsonMatch = text.match(/\{.*\}/);
    if (jsonMatch) text = jsonMatch[0];
    const data = JSON.parse(text);
    const cdlist = data?.cdlist;
    if (!cdlist || cdlist.length === 0) return null;
    const cd = cdlist[0];
    const songs = cd?.songlist || [];
    const playlistName = cd?.dissname || 'QQ音乐歌单';
    const result = {
      platform: 'qqmusic',
      playlistId,
      playlistName,
      total: songs.length,
      songs: songs.map((s, idx) => ({
        index: idx + 1,
        name: s.songname || s.name || '',
        singer: s.singer?.map(x => x.name).join(' / ') || s.artist || '',
        album: s.albumname || s.album || '',
        duration: s.interval || 0,
        songid: s.songid || '',
        songmid: s.songmid || ''
      }))
    };
    return result;
  } catch (e) {
    console.error('抓取QQ音乐歌单失败:', e);
    return null;
  }
}

// 抓取网易云音乐歌单
async function fetchNetEasePlaylist(playlistId) {
  if (!playlistId) return null;
  const url = `https://music.163.com/api/playlist/detail?id=${playlistId}&n=10000`;
  try {
    const buf = await httpsGet(url, {
      timeout: 10000,
      headers: {
        'Referer': 'https://music.163.com/',
        'Cookie': 'appver=2.0.2'
      }
    });
    const data = JSON.parse(buf.toString('utf8'));
    const playlist = data?.result;
    if (!playlist) return null;
    const tracks = playlist?.tracks || [];
    const playlistName = playlist?.name || '网易云歌单';
    const result = {
      platform: 'netease',
      playlistId,
      playlistName,
      total: tracks.length,
      songs: tracks.map((s, idx) => ({
        index: idx + 1,
        name: s.name || '',
        singer: s.ar?.map(x => x.name).join(' / ') || '',
        album: s.al?.name || '',
        duration: Math.floor((s.dt || 0) / 1000),
        songid: s.id || '',
        songmid: ''
      }))
    };
    return result;
  } catch (e) {
    console.error('抓取网易云歌单失败:', e);
    return null;
  }
}

// 根据URL自动识别平台并抓取歌单
async function fetchPlaylistByUrl(url) {
  if (!url) return null;
  // 判断平台
  if (url.includes('qq.com') || url.includes('y.qq') || url.includes('qqmusic')) {
    const id = extractQQPlaylistId(url);
    if (!id) return { error: '无法从链接中提取QQ音乐歌单ID' };
    const result = await fetchQQPlaylist(id);
    return result || { error: '抓取QQ音乐歌单失败' };
  } else if (url.includes('music.163.com') || url.includes('netease') || url.includes('163.com')) {
    const id = extractNetEasePlaylistId(url);
    if (!id) return { error: '无法从链接中提取网易云歌单ID' };
    const result = await fetchNetEasePlaylist(id);
    return result || { error: '抓取网易云歌单失败' };
  } else {
    // 尝试纯数字ID，默认QQ音乐
    if (/^\d+$/.test(url.trim())) {
      const result = await fetchQQPlaylist(url.trim());
      if (result) return result;
    }
    return { error: '无法识别的歌单链接，请输入QQ音乐或网易云的歌单链接' };
  }
}

  // ==================== 对外 API（给 bridge.js 用） ====================
  // 诊断用：单独暴露每个封面源，方便测各源延迟（bridge 的列表缩略图不依赖它）
  window.__coverSources = {
    iTunes: searchCoverITunes, netease: searchCoverNetEase, qq: searchCoverQQ,
    kugou: searchCoverKugou, kuwo: searchCoverKuwo,
    // 1.0.20 新增
    neteaseAlbum: searchCoverNetEaseAlbum, kuwoAlbum: searchCoverKuwoAlbum,
    img360: searchCover360Image
  };
  window.__online = {
    searchCover, searchCoverCandidates, searchCoverFast, downloadCover,
    searchLyrics, searchLyricsFromSource,
    searchSongInfo, autoFixTrackInfo, completeTrackInfo,
    searchArtistSongs, searchAlbumSongs, searchSongsByKeyword,
    getFreeDownloadLink, resolveOnlineLinks, fetchPlaylistByUrl,
    parseLRC, safeName, titleMatchScore, similarity, pickBestMatch
  };
})();