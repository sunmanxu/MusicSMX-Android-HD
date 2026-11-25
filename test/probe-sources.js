// 候选封面源的连通性探测（直连，不走代理），只打印每个源的头几十字节/关键字段
const https = require('https');
const http = require('http');
const UA = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

function get(url, headers, timeout = 6000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const t0 = Date.now();
    const req = mod.get(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}) }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d.toString(); if (buf.length > 300000) req.destroy(); });
      res.on('end', () => resolve({ url, status: res.statusCode, ms: Date.now() - t0, body: buf }));
      res.on('error', (e) => resolve({ url, err: e.message, ms: Date.now() - t0 }));
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve({ url, err: 'timeout', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ url, err: e.message, ms: Date.now() - t0 }));
  });
}

(async () => {
  const ART = '周杰伦';
  const ALB = '范特西';
  const cases = [
    ['kugou-song-search', 'http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=' + encodeURIComponent(ART + ' ' + ALB) + '&page=1&pagesize=5'],
    ['qq-smartbox', 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=' + encodeURIComponent(ALB) + '&g_tk=5381&format=json'],
    ['musicbrainz', 'https://musicbrainz.org/ws/2/release?query=' + encodeURIComponent('artist:"' + ART + '" AND release:"' + ALB + '"') + '&fmt=json&limit=3'],
    ['netease-album-search', 'https://music.163.com/api/search/get?type=10&s=' + encodeURIComponent(ART + ' ' + ALB) + '&limit=3'],
    ['kugou-album-search', 'http://mobilecdn.kugou.com/api/v3/search/album?format=json&keyword=' + encodeURIComponent(ART) + '&page=1&pagesize=5'],
    ['douban-search', 'https://www.douban.com/j/search?q=' + encodeURIComponent(ART + ' ' + ALB) + '&start=0&cat=1003'],
  ];
  for (const [name, url] of cases) {
    const r = await get(url, name === 'musicbrainz' ? { 'User-Agent': 'MusicSMX/1.0.25 (https://github.com/sunmanxu)' } : null);
    console.log('---', name, r.status || r.err, r.ms + 'ms', (r.body || '').slice(0, 220).replace(/\s+/g, ' '));
  }
  // 找到 MB 的 release id 后试 coverartarchive
  const mb = await get('https://musicbrainz.org/ws/2/release?query=' + encodeURIComponent('artist:"周杰伦" AND release:"范特西"') + '&fmt=json&limit=3', { 'User-Agent': 'MusicSMX/1.0.25' });
  let id = null;
  try { id = JSON.parse(mb.body).releases[0].id; } catch (e) {}
  console.log('mb first release id =', id);
  if (id) {
    for (const u of ['https://coverartarchive.org/release/' + id + '/front-250', 'https://coverartarchive.org/release/' + id]) {
      const r = await get(u, null, 8000);
      console.log('--- CAA', u, r.status || r.err, r.ms + 'ms', (r.body || '').slice(0, 160).replace(/\s+/g, ' '));
    }
  }
  // QQ 专辑中 mid → 直出 T002 图
  const sb = JSON.parse((await get('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=' + encodeURIComponent('范特西') + '&g_tk=5381&format=json')).body.replace(/^callback\(|\)$/g, '') || '{}');
  console.log('smartbox keys =', Object.keys(sb.data || {}).join(','));
  const mid = sb.data && sb.data.album && sb.data.album.itemlist && sb.data.album.itemlist[0] && sb.data.album.itemlist[0].mid;
  console.log('qq album mid =', mid);
  if (mid) {
    const r = await get('https://y.gtimg.cn/music/photo_new/T002R300x300M000' + mid + '.jpg');
    console.log('--- qq T002 img', r.status || r.err, r.ms + 'ms len=' + (r.body || '').length);
  }
})();
