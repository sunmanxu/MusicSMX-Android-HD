// 1.0.24：验证「自动修复记忆」——同一批歌第二次调用是否零网络、耗时降下来
(async () => {
  const sample = [];
  for (let i = 0; i < S.tracks.length && sample.length < 12; i++) {
    const t = S.tracks[i];
    if (!t || !t.path || t.isPlaceholder) continue;
    sample.push(t);
  }
  const run = async () => {
    const t0 = Date.now();
    const res = [];
    for (const t of sample) {
      const r = await mb.autoFixTrack(t.artist, t.title, t.album || '', Number(t.duration) || 0);
      res.push({ title: t.title, needFix: !!r.needFix, memo: !!r.memo });
    }
    return { ms: Date.now() - t0, res };
  };
  const first = await run();
  await new Promise((r) => setTimeout(r, 4000));   // 等记忆落盘
  const second = await run();
  const memo = window.__mbAutoFixMemo || {};
  return JSON.stringify({
    sample: sample.length,
    firstMs: first.ms,
    secondMs: second.ms,
    firstNeedFix: first.res.filter((x) => x.needFix).map((x) => x.title),
    secondMemoHits: second.res.filter((x) => x.memo).length,
    stats: memo,
    memoSize: Object.keys(JSON.parse(localStorage.getItem('mb_autofix_memo_v1') || '{}')).length
  }, null, 1);
})()
