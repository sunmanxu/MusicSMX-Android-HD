(async () => {
  const t = S.tracks[16];
  const out = { title: t.title, album: t.album, albumField: t.album, key: 'albv18:' + ((t.artist || '') + '|' + (t.album || t.title || '')).toLowerCase() };
  let neg = {};
  try { neg = JSON.parse(localStorage.getItem('mb_thumb_neg_v2') || '{}'); } catch (e) {}
  out.negTotal = Object.keys(neg).length;
  out.negRec = neg[out.key] || null;

  const srcs = window.__coverSources || {};
  out.newSources = {};
  for (const k of ['neteaseAlbum', 'kuwoAlbum', 'img360', 'kuwo']) {
    if (!srcs[k]) { out.newSources[k] = 'missing'; continue; }
    try {
      const r = await srcs[k](t.artist, t.album, t.title);
      out.newSources[k] = r ? { ok: true, source: r.source, url: String(r.url).slice(0, 100) } : { ok: false };
    } catch (e) { out.newSources[k] = { err: String(e && e.message || e).slice(0, 90) }; }
  }
  try {
    const f = await window.__online.searchCoverFast(t.artist, t.title, 3200, t.album);
    out.fast = f ? { source: f.source, url: String(f.url).slice(0, 100) } : null;
  } catch (e) { out.fast = { err: String(e).slice(0, 90) }; }
  // 真的播放它，看列表行/左下角能不能出图
  playAt(16);
  await new Promise(r => setTimeout(r, 3500));
  const row = document.querySelector('.track-row[data-idx="16"]');
  out.row = row ? { present: true, img: !!row.querySelector('.mb-row-cover img'), from: row.dataset.mbCoverFrom || '' } : { present: false };
  out.trackCover = !!S.tracks[16].cover;
  out.footerImg = !!document.getElementById('cover').querySelector('img');
  return out;
})()
