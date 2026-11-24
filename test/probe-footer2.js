(() => {
  const rows = Array.from(document.querySelectorAll('.track-row'));
  const cands = [];
  for (const row of rows) {
    const idx = parseInt(row.dataset.idx, 10);
    const t = S.tracks[idx];
    if (!t || t.isPlaceholder || t.isOnline) continue;
    const img = row.querySelector('.mb-row-cover img');
    if (!img) continue;                 // 行里还没图
    if (t.cover || S.coverCache.has(t.path)) continue;  // 已有正式封面 → 本来就会瞬间出图
    cands.push({ idx: idx, title: t.title, src: String(img.getAttribute('src')).slice(0, 20) });
  }
  if (!cands.length) return { ok: false, visibleRows: rows.length };
  const c = cands[0];
  const el = document.getElementById('cover');
  const t0 = performance.now();
  playAt(c.idx);
  const snap = (d) => {
    const im = el.querySelector('img');
    return { tag: d, hasImg: !!im, fast: im ? (im.dataset.mbFast || '') : '', from: im ? (im.dataset.mbSrc || '') : '' };
  };
  const marks = [snap('immediately')];
  [0, 30, 80, 200, 600].forEach((d) => setTimeout(() => {
    marks.push(Object.assign({ ms: Math.round(performance.now() - t0) }, snap(d)));
    if (d === 600) window.__footerProbe2 = { cand: c, marks: marks };
  }, d));
  return { ok: true, cand: c, immediate: marks[0] };
})()
