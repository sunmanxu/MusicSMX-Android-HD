(async () => {
  const keys = ['albv18:sinéad o\'connor|how about i be me (and you be you)_(deluxe edition)','albv18:aaron smith|最新热歌慢摇77','albv18:kiiara|l___ is a bad word','albv18:纯音乐|未知专辑','albv18:花澤香菜|「囮物語」劇伴音楽集 & あとがたり','albv18:vitamin string quartet|merry go round of life','albv18:杨振宇|伍六七 原声大碟','albv18:染岚刀|未知专辑','albv18:boosin|black water','albv18:单依纯|喂','albv18:mikann耙耙柑|生音记忆ii·原声','albv18:明熹milo|二胡','albv18:anne-sophie mutter _ herbert von karajan _ peter alward _ wiener philharmoniker|vivaldi_ die vier jahreszeiten','albv18:sawanohiroyuki[nzk]|a_z_aliez','albv18:a rusty dream|未知专辑','albv18:科普知识|未知专辑','albv18:machine gun kelly|bright_ the album','albv18:yael naim|older','albv18:vivaldi string orchestra|walter rinaldi_ piano concertos & orchestral works _ vivaldi_ the four seasons','albv18:taylor swift|...ready for it? (bloodpop® remix)','albv18:末廣健一郎|tbs系 火曜ドラマ「逃げるは恥だが役に立つ」オリジナル・サウンドトラック vol.2','albv18:美波|kawakiwoameku','albv18:那英|默'];
  const neg = JSON.parse(localStorage.getItem('mb_thumb_neg_v3') || '{}');
  const weak = JSON.parse(localStorage.getItem('mb_thumb_weak_v1') || '{}');
  let n = 0, w = 0;
  keys.forEach((k) => { if (neg[k]) { delete neg[k]; n++; } if (weak[k]) { delete weak[k]; w++; } });
  localStorage.setItem('mb_thumb_neg_v3', JSON.stringify(neg));
  localStorage.setItem('mb_thumb_weak_v1', JSON.stringify(weak));
  const st = window.__thumbStats;
  const b = { ok: st.ok, weak: st.weakMemoHit };
  const list = document.getElementById('track-list');
  for (let i = 0; i < 30; i++) { list.scrollTop = list.scrollHeight * (i / 29) * 0.98; await new Promise((r) => setTimeout(r, 3000)); }
  list.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 30000));
  return JSON.stringify({ clearedNeg: n, clearedWeak: w, okDelta: st.ok - b.ok, weakHit: st.weakMemoHit - b.weak });
})()
