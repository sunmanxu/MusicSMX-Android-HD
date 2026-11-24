(async () => {
  const call = (url, headers) => window.Capacitor.Plugins.MusicBridge.httpFetch({ url: url, headers: headers || {}, timeoutMs: 9000 });
  const raw = async (url, headers) => { try { const r = await call(url, headers); return { ok: r.ok, status: r.status, s: atob(r.base64 || '') }; } catch (e) { return { err: String(e && e.message || e).slice(0, 90) }; } };
  const out = {};
  const q = encodeURIComponent('周杰伦 十一月的萧邦 专辑封面');
  const so = await raw('https://image.so.com/j?q=' + q + '&src=srp&correct=' + q + '&sn=0&pn=8', { Referer: 'https://image.so.com/' });
  out.so360 = so.ok ? { status: so.status, len: so.s.length, head: so.s.slice(0, 300) } : so;
  const bing = await raw('https://cn.bing.com/images/async?q=' + q + '&first=1&count=8&mmasync=1', { 'User-Agent': 'Mozilla/5.0', Referer: 'https://cn.bing.com/' });
  out.bing = bing.ok ? { status: bing.status, len: bing.s.length, hasMurl: /murl&quot;:&quot;/i.test(bing.s), sample: (bing.s.match(/murl&quot;:&quot;([^&]+)/i) || [])[1] || '' } : bing;
  const baidu = await raw('https://image.baidu.com/search/acjson?tn=resultjson_com&word=' + q + '&pn=0&rn=8', { 'User-Agent': 'Mozilla/5.0', Referer: 'https://image.baidu.com/' });
  out.baidu = baidu.ok ? { status: baidu.status, len: baidu.s.length, head: baidu.s.slice(0, 200) } : baidu;
  return out;
})()
