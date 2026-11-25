(async () => {
  const keys = ['albv18:纯音乐|未知专辑', 'albv18:科普知识|未知专辑'];
  const out = {};
  for (const k of keys) { const r = await window.mb.readThumb('', 96, k).catch(() => null); out[k] = (r && r.dataUrl) || ''; }
  return JSON.stringify(out);
})()
