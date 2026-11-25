// 给「没有磁盘缩略图」的专辑逐个试源，看新源（酷狗 mobilecdn / QQ smartbox）能不能补上
//   用法：node test/eval-sources.js test/missing-albums.json
const fs = require('fs');
const https = require('https');
const http = require('http');
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

function raw(url, headers, timeout = 8000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const t0 = Date.now();
    const req = mod.get(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(raw(new URL(res.headers.location, url).href, headers, timeout));
        return;
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0, buf: Buffer.concat(chunks), ctype: res.headers['content-type'] || '' }));
      res.on('error', (e) => resolve({ err: e.message, ms: Date.now() - t0 }));
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve({ err: 'timeout', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ err: e.message, ms: Date.now() - t0 }));
  });
}
async function json(url, headers, timeout) {
  const r = await raw(url, headers, timeout);
  if (!r.buf) return null;
  const txt = r.buf.toString('utf8').replace(/^callback\((.*)\)$/s, '$1').replace(/^[^[{]*\(/, '').replace(/\);?\s*$/, '');
  try { return JSON.parse(txt); } catch (e) { return null; }
}
async function validImage(url) {
  if (!url) return null;
  const r = await raw(url, { Referer: 'https://y.qq.com/' }, 9000);
  if (!r.buf || r.status !== 200) return null;
  const isImg = /image|octet-stream/.test(r.ctype) || r.buf.length > 4000;
  return isImg && r.buf.length > 6000 ? { len: r.buf.length, ms: r.ms, ctype: r.ctype } : null;
}
const norm = (s) => (s || '').toLowerCase().replace(/[\s_\-–—·・\.\,\!\?\'\"“”‘’\(\)\[\]\/\\:&@#♥★☆]/g, '').replace(/未知专辑/g, '');
const sim = (a, b) => {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 4 && y.includes(x)) return 0.8;
  if (y.length >= 4 && x.includes(y)) return 0.8;
  let common = 0;
  for (const ch of x) if (y.includes(ch)) common++;
  return (common / Math.max(x.length, y.length)) * 0.6;
};

// 源 A：酷狗专辑搜索（新）
async function srcKugouAlbum(artist, album) {
  const j = await json('http://mobilecdn.kugou.com/api/v3/search/album?format=json&keyword=' + encodeURIComponent((artist + ' ' + album).trim()) + '&page=1&pagesize=8');
  const items = (j && j.data && j.data.info) || [];
  let best = null, bs = 0;
  for (const it of items) {
    const s = sim(it.albumname, album) * 0.7 + sim(it.singername, artist) * 0.3;
    if (s > bs) { bs = s; best = it; }
  }
  if (!best || bs < 0.55 || !best.imgurl) return null;
  const url = best.imgurl.replace('{size}', '400');
  const v = await validImage(url);
  return v ? { src: 'kugou-album', url, score: bs.toFixed(2), len: v.len } : null;
}

// 源 B：酷狗单曲搜索 → album_id → album/info（新，替代已失效的 songsearch + www.kugou.com/yy/html/api）
async function srcKugouSong(artist, title) {
  const j = await json('http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=' + encodeURIComponent((artist + ' ' + title).trim()) + '&page=1&pagesize=6');
  const items = (j && j.data && j.data.info) || [];
  let best = null, bs = 0;
  for (const it of items) {
    const s = sim(it.songname, title) * 0.7 + sim(it.singername, artist) * 0.3;
    if (s > bs) { bs = s; best = it; }
  }
  if (!best || bs < 0.6 || !best.album_id) return null;
  const info = await json('http://mobilecdn.kugou.com/api/v3/album/info?format=json&albumid=' + best.album_id);
  let img = info && info.data && (info.data.imgurl || (info.data.imgurls && info.data.imgurls[0]));
  if (!img) return null;
  img = img.replace('{size}', '400');
  const v = await validImage(img);
  return v ? { src: 'kugou-song', url: img, score: bs.toFixed(2), len: v.len } : null;
}

// 源 C：QQ smartbox 按专辑名找 album mid → T002 图（新）
async function srcQQSmartboxAlbum(artist, album) {
  const j = await json('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=' + encodeURIComponent(album) + '&g_tk=5381&format=json', { Referer: 'https://y.qq.com/' });
  const list = (j && j.data && j.data.album && j.data.album.itemlist) || [];
  let best = null, bs = 0;
  for (const it of list) {
    const s = sim(it.name, album) * 0.7 + sim(it.singer, artist) * 0.3;
    if (s > bs) { bs = s; best = it; }
  }
  if (!best || bs < 0.55 || !best.mid) return null;
  const url = 'https://y.gtimg.cn/music/photo_new/T002R500x500M000' + best.mid + '.jpg';
  const v = await validImage(url);
  return v ? { src: 'qq-smartbox-album', url, score: bs.toFixed(2), len: v.len } : null;
}

// 源 D：QQ smartbox 按歌名找 → album mid（新）
async function srcQQSmartboxSong(artist, title) {
  const j = await json('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=' + encodeURIComponent(title) + '&g_tk=5381&format=json', { Referer: 'https://y.qq.com/' });
  const albums = (j && j.data && j.data.album && j.data.album.itemlist) || [];
  let best = null, bs = 0;
  for (const it of albums) {
    const s = sim(it.name, title) * 0.5 + sim(it.singer, artist) * 0.5;
    if (s > bs) { bs = s; best = it; }
  }
  if (!best || bs < 0.5 || !best.mid) return null;
  const url = 'https://y.gtimg.cn/music/photo_new/T002R500x500M000' + best.mid + '.jpg';
  const v = await validImage(url);
  return v ? { src: 'qq-smartbox-song', url, score: bs.toFixed(2), len: v.len } : null;
}

// 源 E：QQ 老单曲搜索（现有）
async function srcQQOld(artist, title) {
  const j = await json('https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent((artist + ' ' + title).trim()) + '&format=json&p=1&n=5', { Referer: 'https://y.qq.com/' });
  const songs = (j && j.data && j.data.song && j.data.song.list) || [];
  let best = null, bs = 0;
  for (const s0 of songs) {
    const s = sim(s0.songname, title) * 0.7 + sim((s0.singer || []).map((x) => x.name).join('/'), artist) * 0.3;
    if (s > bs) { bs = s; best = s0; }
  }
  if (!best || bs < 0.6 || !best.albummid) return null;
  const url = 'https://y.gtimg.cn/music/photo_new/T002R800x800M000' + best.albummid + '.jpg';
  const v = await validImage(url);
  return v ? { src: 'qq-old', url, score: bs.toFixed(2), len: v.len } : null;
}

// 源 F：网易云专辑搜索（现有）
async function srcNeteaseAlbum(artist, album) {
  const j = await json('https://music.163.com/api/search/get?type=10&s=' + encodeURIComponent((artist + ' ' + album).trim()) + '&limit=5', { Referer: 'https://music.163.com/' });
  const list = (j && j.result && j.result.albums) || [];
  let best = null, bs = 0;
  for (const it of list) {
    const s = sim(it.name, album) * 0.7 + sim(it.artist && it.artist.name, artist) * 0.3;
    if (s > bs) { bs = s; best = it; }
  }
  if (!best || bs < 0.55) return null;
  const pic = best.picUrl || best.blurPicUrl;
  if (!pic) return null;
  const v = await validImage(pic + '?param=500y500');
  return v ? { src: 'netease-album', url: pic, score: bs.toFixed(2), len: v.len } : null;
}

// 源 G：iTunes（现有）
async function srcITunes(artist, title) {
  const j = await json('https://itunes.apple.com/search?term=' + encodeURIComponent((artist + ' ' + title).trim()) + '&entity=song&limit=5&country=cn');
  const list = (j && j.results) || [];
  let best = null, bs = 0;
  for (const it of list) {
    const s = sim(it.trackName, title) * 0.7 + sim(it.artistName, artist) * 0.3;
    if (s > bs) { bs = s; best = it; }
  }
  if (!best || bs < 0.6 || !best.artworkUrl100) return null;
  const url = best.artworkUrl100.replace(/100x100bb/, '600x600bb');
  const v = await validImage(url);
  return v ? { src: 'itunes', url, score: bs.toFixed(2), len: v.len } : null;
}

(async () => {
  const file = process.argv[2] || 'test/missing-albums.json';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const m of data.missing) {
    const row = { album: m.artist + ' / ' + m.album, hits: [] };
    const tries = [
      ['kugou-album', () => srcKugouAlbum(m.artist, m.album)],
      ['qq-smartbox-album', () => srcQQSmartboxAlbum(m.artist, m.album)],
      ['kugou-song', () => srcKugouSong(m.artist, m.title)],
      ['qq-smartbox-song', () => srcQQSmartboxSong(m.artist, m.title)],
      ['qq-old', () => srcQQOld(m.artist, m.title)],
      ['netease-album', () => srcNeteaseAlbum(m.artist, m.album)],
      ['itunes', () => srcITunes(m.artist, m.title)],
    ];
    for (const [name, fn] of tries) {
      let r = null;
      try { r = await fn(); } catch (e) { r = null; }
      if (r) row.hits.push(r);
    }
    out.push(row);
    console.log((row.hits.length ? 'HIT  ' : 'MISS ') + row.album + '  <- ' + (row.hits.map((h) => h.src + '(' + h.len + 'B,score' + h.score + ')').join(', ') || '无'));
  }
  const hit = out.filter((r) => r.hits.length).length;
  const byNew = out.filter((r) => r.hits.some((h) => /kugou-album|qq-smartbox/.test(h.src))).length;
  console.log('\n==== 命中 ' + hit + '/' + out.length + '，其中新源独有贡献 ' + byNew + ' 个 ====');
  fs.writeFileSync('test/eval-sources-result.json', JSON.stringify(out, null, 1));
})();
