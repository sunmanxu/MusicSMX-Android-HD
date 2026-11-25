// 1.0.25 弱图记忆专项：滚一遍歌单把「只有占位/共用图」的专辑跑出来，看弱图记忆和通用图黑名单有没有落盘
//   参数放在 window.__weakProbeCfg = { secondsPerScreen, screenCount, settle }
(async () => {
  const cfg = Object.assign({ secondsPerScreen: 6, screenCount: 8, settle: 60 }, window.__weakProbeCfg || {});
  const st = window.__thumbStats;
  const base = { ok: st.ok, searchFail: st.searchFail, genericImg: st.genericImg, defaultImg: st.defaultImg, drop: st.drop };
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
  for (let i = 0; i < cfg.screenCount; i++) {
    const frac = cfg.screenCount === 1 ? 0.5 : i / (cfg.screenCount - 1) * 0.92 + 0.04;
    list.scrollTop = list.scrollHeight * frac;
    await new Promise((r) => setTimeout(r, cfg.secondsPerScreen * 1000));
    const c = count();
    out.push({ frac: frac.toFixed(2), ready: c.ready + '/' + c.rows, ph: c.ph });
  }
  await new Promise((r) => setTimeout(r, cfg.settle * 1000));
  const memo = JSON.parse(localStorage.getItem('mb_thumb_weak_v1') || '{}');
  const gen = JSON.parse(localStorage.getItem('mb_generic_fp_v1') || '[]');
  return JSON.stringify({
    screens: out,
    delta: { ok: st.ok - base.ok, searchFail: st.searchFail - base.searchFail, genericImg: st.genericImg - base.genericImg, defaultImg: st.defaultImg - base.defaultImg, drop: st.drop - base.drop },
    weakMemoSize: Object.keys(memo).length,
    weakMemoSample: Object.keys(memo).slice(0, 5),
    genericFpSize: gen.length,
    weakSet: window.__thumbStats ? undefined : undefined,
  });
})()
