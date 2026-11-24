(() => {
  const out = { wrapped: !!window.__mbNpWrapped, hasNp: typeof window.updateNowPlaying };
  // 找一个「从来没抓过封面」的歌：t.cover 空 + coverCache 没有 + 不是占位壳
  let idx = -1;
  for (let i = 0; i < S.tracks.length; i++) {
    const t = S.tracks[i];
    if (!t || t.isPlaceholder || t.isOnline) continue;
    if (t.cover || S.coverCache.has(t.path)) continue;
    idx = i; break;
  }
  out.idx = idx;
  if (idx < 0) return out;

  const t = S.tracks[idx];
  out.track = { title: t.title, artist: t.artist, album: t.album };

  const el = document.getElementById('cover');
  const snap = (tag) => ({
    tag,
    ms: Math.round(perfNow()),
    hasImg: !!el.querySelector('img'),
    fast: (el.querySelector('img') || {}).dataset ? (el.querySelector('img').dataset.mbFast || '') : '',
    src: (() => { const im = el.querySelector('img'); return im ? String(im.src).slice(0, 24) : ''; })(),
  });
  function perfNow() { return performance.now(); }
  const t0 = performance.now();
  const marks = [];
  marks.push({ tag: 'before', ms: 0, hasImg: !!el.querySelector('img') });
  playAt(idx);
  marks.push({ tag: 'after-playAt', ms: Math.round(performance.now() - t0), hasImg: !!el.querySelector('img') });
  for (const d of [0, 50, 150, 400, 1000, 2000]) {
    setTimeout(() => {
      const im = el.querySelector('img');
      marks.push({ tag: d + 'ms', ms: Math.round(performance.now() - t0), hasImg: !!im, fast: im ? (im.dataset.mbFast || '') : '', srcHead: im ? String(im.src).slice(0, 20) : '' });
      if (d === 2000) {
        out.marks = marks;
        out.finalCover = !!S.tracks[idx].cover;
        window.__footerProbe = out;
      }
    }, d);
  }
  return { started: true, idx };
})()
