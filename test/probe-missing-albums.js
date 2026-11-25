// 列出「没有磁盘缩略图」的专辑（artist/album/示例歌名），给离线测源用
//   albumKeyOf 在 bridge 闭包里取不到，这里按同一规则自己拼：'albv18:' + 歌手|专辑 的小写
(async () => {
  const keyOf = (t) => 'albv18:' + ((t.artist || '') + '|' + (t.album || t.title || '')).toLowerCase();
  const groups = new Map();
  for (const t of S.tracks) {
    if (t.isPlaceholder) continue;
    const k = keyOf(t);
    if (!groups.has(k)) groups.set(k, { key: k, artist: t.artist || '', album: t.album || '', title: t.title || '', n: 0 });
    groups.get(k).n++;
  }
  const keys = [...groups.keys()];
  const missing = [];
  const B = 40;
  for (let i = 0; i < keys.length; i += B) {
    const batch = keys.slice(i, i + B);
    const res = await Promise.all(batch.map((k) => window.mb.readThumb('', 96, k).catch(() => null)));
    res.forEach((r, j) => { if (!(r && r.ok && r.dataUrl)) missing.push(groups.get(batch[j])); });
  }
  return JSON.stringify({ total: keys.length, missingCount: missing.length, missing });
})()
