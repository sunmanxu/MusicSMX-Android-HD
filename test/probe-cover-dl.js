(async () => {
  const urls = {
    qq: 'https://y.gtimg.cn/music/photo_new/T002R800x800M0000024bjiL2aocxT.jpg?max_age=2592000',
    qq300: 'https://y.gtimg.cn/music/photo_new/T002R300x300M0000024bjiL2aocxT.jpg',
    kugou: 'https://imge.kugou.com/stdmusic/600/1F7E7659B9FFF4FB6F71562A61BBC25F.jpg',
  };
  const call = (url, headers) => window.Capacitor.Plugins.MusicBridge.httpFetch({ url: url, headers: headers || {}, timeoutMs: 8000 });
  const safe = async (p) => { try { const r = await p; return { ok: !!r.ok, status: r.status, bytes: r.base64 ? r.base64.length : 0, error: r.error || '' }; } catch (e) { return { thrown: String(e && e.message || e).slice(0, 120) }; } };
  const out = {}; const out2 = {};
  for (const k of Object.keys(urls)) out[k] = await safe(call(urls[k], {}));
  out2.qq = await safe(call(urls.qq, { Referer: 'https://y.qq.com/' }));
  out2.kugou = await safe(call(urls.kugou, { Referer: 'https://www.kugou.com/' }));
  // 真正走 App 自己的封面流程看它拿到的结果
  const t = S.tracks[16];
  const fc = await window.mb.fetchCover(t.artist, t.title).catch(e => ({ ok: false, err: String(e) }));
  return { noRef: out, withRef: out2, mbFetchCover: { ok: !!fc.ok, source: (fc.info || {}).source, len: fc.dataUrl ? fc.dataUrl.length : 0 } };
})()
