const https = require('https'); const http = require('http');
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
function get(url, headers, timeout = 8000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const t0 = Date.now();
    const req = mod.get(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}) }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d.toString(); if (buf.length > 400000) req.destroy(); });
      res.on('end', () => resolve({ url, status: res.statusCode, ms: Date.now() - t0, body: buf }));
      res.on('error', (e) => resolve({ url, err: e.message, ms: Date.now() - t0 }));
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve({ url, err: 'timeout', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ url, err: e.message, ms: Date.now() - t0 }));
  });
}
(async () => {
  const kw = encodeURIComponent('周杰伦 发如雪');
  const cases = [
    ['kugou-songsearch-v2 (现有源码用的)', `https://songsearch.kugou.com/song_search_v2?keyword=${kw}&page=1&pagesize=5&format=json&platform=WebFilter`, { Referer: 'https://www.kugou.com/' }],
    ['kugou-album-html-api (现有备用)', 'https://www.kugou.com/yy/html/api/album?album_id=960399', { Referer: 'https://www.kugou.com/' }],
    ['kugou-mobile-song (新)', `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${kw}&page=1&pagesize=5`, null],
    ['kugou-mobile-album-info (新)', 'http://mobilecdn.kugou.com/api/v3/album/info?format=json&albumid=958706', null],
    ['kuwo-single (现有)', `https://search.kuwo.cn/r.s?all=${kw}&ft=music&itemset=web_2013&client=kt&pn=0&rn=5&rformat=json&encoding=utf8`, { Referer: 'https://www.kuwo.cn/' }],
    ['qq-smartbox-song (新)', 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=' + encodeURIComponent('发如雪') + '&g_tk=5381&format=json', { Referer: 'https://y.qq.com/' }],
  ];
  for (const [name, url, h] of cases) {
    const r = await get(url, h);
    console.log('---', name, r.status || r.err, r.ms + 'ms', (r.body || '').slice(0, 180).replace(/\s+/g, ' '));
  }
})();
