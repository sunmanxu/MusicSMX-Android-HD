(async () => {
  const out = { tracks: [], sources: {}, fast: null };
  for (let i = 0; i < S.tracks.length; i++) {
    const t = S.tracks[i];
    if (t && t.title && t.title.indexOf('发如雪') >= 0) {
      out.tracks.push({ idx: i, title: t.title, artist: t.artist, album: t.album, path: t.path, cover: !!t.cover });
    }
  }
  const first = out.tracks[0];
  if (!first) return out;
  const srcs = window.__coverSources || {};
  for (const k of Object.keys(srcs)) {
    try {
      const r = await srcs[k](first.artist, first.title);
      out.sources[k] = r ? { ok: true, source: r.source, album: r.album, url: String(r.url).slice(0, 90) } : { ok: false };
    } catch (e) {
      out.sources[k] = { err: String(e && e.message || e).slice(0, 120) };
    }
  }
  try {
    const r = await window.__online.searchCover(first.artist, first.title);
    out.slow = r ? { url: String(r.url).slice(0, 90), source: r.source } : null;
  } catch (e) { out.slow = { err: String(e).slice(0, 100) }; }
  return out;
})()
