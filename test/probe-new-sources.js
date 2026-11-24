(async () => {
  const call = (url, headers) => window.Capacitor.Plugins.MusicBridge.httpFetch({ url: url, headers: headers || {}, timeoutMs: 9000 });
  const txt = async (url, headers) => {
    try { const r = await call(url, headers); if (!r.ok) return { ok: false, status: r.status, err: r.error }; return { ok: true, status: r.status, body: atob(r.base64 || '').slice(0, 600) }; }
    catch (e) { return { err: String(e && e.message || e).slice(0, 100) }; }
  };
  const kw = encodeURIComponent('周杰伦 发如雪');
  const out = {};
  out.deezer = await txt('https://api.deezer.com/search?q=' + kw + '&limit=3');
  out.kugouAlbum = await txt('https://msearchcdn.kugou.com/api/v3/search/album?keyword=' + kw + '&page=1&pagesize=3', { Referer: 'https://www.kugou.com/' });
  out.qqAlbum = await txt('https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + kw + '&t=9&format=json&p=1&n=3', { Referer: 'https://y.qq.com/' });
  out.neteaseAlbum = await txt('https://music.163.com/api/search/get?s=' + kw + '&type=10&limit=3', { Referer: 'https://music.163.com/' });
  out.migu = await txt('https://music.migu.cn/v3/api/music/search?keyword=' + kw + '&pageSize=3', { Referer: 'https://music.migu.cn/' });
  return out;
})()
