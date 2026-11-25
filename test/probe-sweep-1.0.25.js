// 1.0.25 A/B 扫库：整库从头扫到尾，只统计「这次扫库新增了多少次网络下载」和「弱图记忆命中多少」
//   用法（CDP 里执行）：window.__sweepCfg = { screens: 30, sec: 4, settle: 45 }
(async () => {
  const cfg = Object.assign({ screens: 30, sec: 4, settle: 45 }, window.__sweepCfg || {});
  const st = window.__thumbStats;
  const b = { ok: st.ok, searchFail: st.searchFail, genericImg: st.genericImg, defaultImg: st.defaultImg, weakMemoHit: st.weakMemoHit, drop: st.drop };
  const list = document.getElementById('track-list');
  const count = () => {
    const rows = [...list.getElementsByClassName('track-row')];
    let ready = 0, ph = 0;
    for (const r of rows) {
      const box = r.querySelector('.mb-row-cover');
      if (box && box.dataset.ready === '1') ready++;
      else if (box && box.querySelector('.mb-cover-ph')) ph++;
    }
    return { rows: rows.length, ready, ph };
  };
  for (let i = 0; i < cfg.screens; i++) {
    list.scrollTop = list.scrollHeight * (i / (cfg.screens - 1)) * 0.98;
    await new Promise((r) => setTimeout(r, cfg.sec * 1000));
  }
  list.scrollTop = 0;
  await new Promise((r) => setTimeout(r, cfg.settle * 1000));
  const memo = JSON.parse(localStorage.getItem('mb_thumb_weak_v1') || '{}');
  const gen = JSON.parse(localStorage.getItem('mb_generic_fp_v1') || '[]');
  const ng = JSON.parse(localStorage.getItem('mb_thumb_neg_v3') || '{}');
  return JSON.stringify({
    delta: { ok: st.ok - b.ok, searchFail: st.searchFail - b.searchFail, genericImg: st.genericImg - b.genericImg, defaultImg: st.defaultImg - b.defaultImg, weakMemoHit: st.weakMemoHit - b.weakMemoHit, drop: st.drop - b.drop },
    weakMemoSize: Object.keys(memo).length,
    genericFpSize: gen.length,
    negSize: Object.keys(ng).length,
    state: window.__mbThumbState(),
    view: count(),
  });
})()
