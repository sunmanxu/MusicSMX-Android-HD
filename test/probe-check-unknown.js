(async () => {
  const keys = ['albv18:纯音乐|未知专辑', 'albv18:科普知识|未知专辑', 'albv18:染岚刀|未知专辑'];
  const out = [];
  for (const k of keys) {
    const r = await window.mb.readThumb('', 96, k).catch(() => null);
    out.push({ k, ok: !!(r && r.ok), head: (r && r.dataUrl || '').slice(0, 30) });
  }
  return JSON.stringify(out);
})()
