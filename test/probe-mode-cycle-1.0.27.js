(async () => {
  const out = { chip: document.querySelector('#mb-ver-chip').textContent, wrapped: !!window.cycleMode.__mbWrapped, btnBound: document.getElementById('btn-mode').dataset.mbModeBound, pfBound: document.getElementById('pf-mode').dataset.mbModeBound, start: S.mode };
  const seq = [];
  for (let i = 0; i < 4; i++) {
    document.getElementById('btn-mode').click();
    await new Promise((r) => setTimeout(r, 300));
    seq.push(S.mode + '/' + (document.getElementById('btn-mode').title || '').slice(-8) + '/shuffleOrder=' + (S.shuffleOrder || []).length);
  }
  out.seq = seq;
  // 播放页那个按钮也要一样
  document.getElementById('pf-mode').click();
  await new Promise((r) => setTimeout(r, 300));
  out.afterPfClick = S.mode;
  out.savedMode = (window.__mbSavedModeHint || null);
  return JSON.stringify(out);
})()
