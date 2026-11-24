(async () => {
  const call = (url, headers) => window.Capacitor.Plugins.MusicBridge.httpFetch({ url: url, headers: headers || {}, timeoutMs: 9000 });
  const txt = async (url, headers) => {
    try { const r = await call(url, headers); if (!r.ok) return { ok: false, status: r.status, err: String(r.error).slice(0, 90) }; return { ok: true, status: r.status, body: atob(r.base64 || '').slice(0, 500) }; }
    catch (e) { return { err: String(e && e.message || e).slice(0, 90) }; }
  };
  const out = {};
  out.kuwoAlbum = await txt('https://search.kuwo.cn/r.s?all=' + encodeURIComponent('周杰伦 十一月的萧邦') + '&ft=album&itemset=web_2013&client=kt&pn=0&rn=3&rformat=json&encoding=utf8', { Referer: 'https://www.kuwo.cn/' });
  out.musicbrainz = await txt('https://musicbrainz.org/ws/2/recording?query=' + encodeURIComponent('发如雪 AND artist:周杰伦') + '&fmt=json&limit=3', { 'User-Agent': 'MusicSMX/1.0 (https://sunmanxu.cn)' });
  out.sogou = await txt('https://pic.sogou.com/napi/pc/searchList?query=' + encodeURIComponent('周杰伦 十一月的萧邦 专辑封面') + '&mode=1&start=0&xml_len=5', { Referer: 'https://pic.sogou.com/' });
  return out;
})()
