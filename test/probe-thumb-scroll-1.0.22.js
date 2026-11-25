// 1.0.22 滚动巡检：逐屏下滚，每屏停 20s 看缩略图能不能自己长出来（全程不点歌、不播放）
(async () => {
  const list = document.getElementById('track-list');
  const count = () => {
    const rows = [...list.getElementsByClassName('track-row')];
    let ready = 0, ph = 0;
    for (const r of rows) {
      const b = r.querySelector('.mb-row-cover');
      if (b && b.dataset.ready === '1') ready++;
      else if (b && b.querySelector('.mb-cover-ph')) ph++;
    }
    return { rows: rows.length, ready, ph };
  };
  const out = [];
  for (const frac of [0, 0.15, 0.35, 0.55, 0.75]) {
    list.scrollTop = list.scrollHeight * frac;
    await new Promise((r) => setTimeout(r, 1000));
    const t0 = count();
    await new Promise((r) => setTimeout(r, 20000));
    out.push({ frac, at1s: t0.ready + '/' + t0.rows, at21s: count().ready + '/' + count().rows, ph: count().ph });
  }
  const st = window.__thumbStats;
  return JSON.stringify({ screens: out, stats: { ok: st.ok, searchFail: st.searchFail, dlFail: st.dlFail, timeout: st.timeout, drop: st.drop } }, null, 1);
})()
