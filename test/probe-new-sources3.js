(async () => {
  const call = (url, headers) => window.Capacitor.Plugins.MusicBridge.httpFetch({ url: url, headers: headers || {}, timeoutMs: 9000 });
  const raw = async (url, headers) => { const r = await call(url, headers); const s = atob(r.base64 || ''); return s; };
  const out = {};
  // 酷我专辑搜索：看 albumlist 里的封面字段
  try {
    const s = await raw('https://search.kuwo.cn/r.s?all=' + encodeURIComponent('周杰伦 十一月的萧邦') + '&ft=album&itemset=web_2013&client=kt&pn=0&rn=2&rformat=json&encoding=utf8', { Referer: 'https://www.kuwo.cn/' });
    const j = JSON.parse(s.replace(/'/g, '"').replace(/&nbsp;/g, ' ').replace(/&apos;/g, "'").replace(/None/g, 'null').replace(/False/g, 'false').replace(/True/g, 'true'));
    out.kuwoAlbumKeys = Object.keys(j.albumlist[0] || {});
    out.kuwoAlbumFirst = JSON.stringify(j.albumlist[0]).slice(0, 900);
  } catch (e) { out.kuwoErr = String(e).slice(0, 150); }
  // QQ 专辑搜索
  try {
    const s = await raw('https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent('十一月的萧邦') + '&t=9&format=json&p=1&n=3', { Referer: 'https://y.qq.com/' });
    const j = JSON.parse(s);
    out.qqAlbumKeys = Object.keys((j.data.album && j.data.album.list && j.data.album.list[0]) || {});
    out.qqAlbumFirst = JSON.stringify((j.data.album && j.data.album.list && j.data.album.list[0]) || null).slice(0, 700);
  } catch (e) { out.qqErr = String(e).slice(0, 150); }
  // Cover Art Archive：用 musicbrainz 查到的 release 试一下
  try {
    const r1 = await raw('https://musicbrainz.org/ws/2/recording?query=' + encodeURIComponent('发如雪 AND artist:周杰伦') + '&fmt=json&limit=1&inc=releases', { 'User-Agent': 'MusicSMX/1.0 (https://sunmanxu.cn)' });
    const j1 = JSON.parse(r1);
    const rec = j1.recordings[0];
    out.mbReleaseCount = rec.releases ? rec.releases.length : 0;
    out.mbReleaseKeys = rec.releases ? Object.keys(rec.releases[0] || {}) : [];
    out.mbRelease = JSON.stringify((rec.releases || [])[0] || null).slice(0, 500);
    if (rec.releases && rec.releases[0]) {
      const rgid = rec.releases[0].id;
      const r2 = await call('https://coverartarchive.org/release/' + rgid + '/front-500', {});
      out.caa = { ok: r2.ok, status: r2.status, bytes: r2.base64 ? r2.base64.length : 0 };
    }
  } catch (e) { out.mbErr = String(e).slice(0, 150); }
  return out;
})()
