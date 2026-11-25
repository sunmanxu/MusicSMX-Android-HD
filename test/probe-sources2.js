const https = require('https');
const http = require('http');
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
function get(url, headers, timeout = 8000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const t0 = Date.now();
    const req = mod.get(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}) }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d.toString(); if (buf.length > 400000) req.destroy(); });
      res.on('end', () => resolve({ url, status: res.statusCode, ms: Date.now() - t0, body: buf, headers: res.headers }));
      res.on('error', (e) => resolve({ url, err: e.message, ms: Date.now() - t0 }));
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve({ url, err: 'timeout', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ url, err: e.message, ms: Date.now() - t0 }));
  });
}
(async () => {
  // 1) 酷狗专辑搜索 → 字段
  const ks = await get('http://mobilecdn.kugou.com/api/v3/search/album?format=json&keyword=' + encodeURIComponent('周杰伦 范特西') + '&page=1&pagesize=3');
  try {
    const j = JSON.parse(ks.body);
    console.log('kugou album search item0 keys:', Object.keys(j.data.info[0]).join(','));
    console.log('kugou item0:', JSON.stringify(j.data.info[0]).slice(0, 400));
  } catch (e) { console.log('kugou parse fail', ks.body.slice(0, 200)); }
  // 2) 酷狗专辑详情
  const ki = await get('http://mobilecdn.kugou.com/api/v3/album/info?format=json&albumid=960399');
  console.log('kugou album info:', ki.status, (ki.body || '').slice(0, 400).replace(/\s+/g, ' '));
  // 3) MusicBrainz → CAA
  const mb = await get('https://musicbrainz.org/ws/2/release?query=' + encodeURIComponent('artist:"Taylor Swift" AND release:"1989"') + '&fmt=json&limit=3', { 'User-Agent': 'MusicSMX/1.0.25 ( sunmanxu@github )' });
  console.log('mb status', mb.status, 'len', mb.body.length);
  let id = null;
  try { const j = JSON.parse(mb.body); id = j.releases && j.releases[0] && j.releases[0].id; console.log('mb releases', j.count, 'first', id); } catch (e) { console.log('mb parse fail', mb.body.slice(0, 120)); }
  if (id) {
    const caa = await get('https://coverartarchive.org/release/' + id + '/front-250', null, 10000);
    console.log('CAA front-250:', caa.status, caa.ms + 'ms', 'ctype=' + (caa.headers && caa.headers['content-type']), 'location=' + (caa.headers && caa.headers.location));
    const meta = await get('https://coverartarchive.org/release/' + id + '/', { Accept: 'application/json' });
    console.log('CAA meta:', meta.status, (meta.body || '').slice(0, 200).replace(/\s+/g, ' '));
  }
  // 4) 酷狗图片直出
  const img = await get('https://imge.kugou.com/stdmusic/240/20150710/20150710115127123374.jpg', null, 10000);
  console.log('kugou img:', img.status, img.ms + 'ms len=' + (img.body || '').length);
  // 5) 网易云专辑图取法（现有）：song search type=1 → album picId?
  const ne = await get('https://music.163.com/api/search/get?type=10&s=' + encodeURIComponent('Taylor Swift 1989') + '&limit=3');
  try { const j = JSON.parse(ne.body); console.log('netease album picUrl sample:', j.result.albums.map(a => (a.picUrl || a.blurPicUrl || '').slice(0, 90)).join('\n  ')); } catch (e) {}
})();
