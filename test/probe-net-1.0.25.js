// 1.0.25 冷启动「翻歌单到底有没有联网」总账：把 __online 的搜索/下载接口全部打点，
// 分清是缩略图管道调的，还是 app.js 自己调的（含歌词），然后再扫一遍歌单。
(async () => {
  const O = window.__online;
  const cnt = { searchCover: 0, searchCoverFast: 0, downloadCover: 0, searchLyrics: 0, fetchLyrics: 0, readThumb: 0, other: {} };
  const stackHasThumb = () => (new Error().stack || '').indexOf('bridge') >= 0;
  ['searchCover', 'searchCoverFast', 'downloadCover', 'searchLyrics'].forEach((fn) => {
    const orig = O && O[fn];
    if (typeof orig !== 'function') return;
    O[fn] = function () {
      cnt[fn]++;
      cnt.other[fn + ':thumbPipe'] = (cnt.other[fn + ':thumbPipe'] || 0) + (stackHasThumb() ? 1 : 0);
      return orig.apply(this, arguments);
    };
  });
  const mbFetch = window.mb && window.mb.fetchLyrics;
  if (typeof mbFetch === 'function') {
    window.mb.fetchLyrics = function () { cnt.fetchLyrics++; return mbFetch.apply(this, arguments); };
  }
  const mbRead = window.mb && window.mb.readThumb;
  if (typeof mbRead === 'function') {
    window.mb.readThumb = function () { cnt.readThumb++; return mbRead.apply(this, arguments); };
  }
  const st = window.__thumbStats;
  const b = { ok: st.ok, searchFail: st.searchFail, weakMemoHit: st.weakMemoHit };
  const list = document.getElementById('track-list');
  for (let i = 0; i < 24; i++) {
    list.scrollTop = list.scrollHeight * (i / 23) * 0.98;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await new Promise((r) => setTimeout(r, 20000));
  return JSON.stringify({
    calls: cnt,
    thumbStats: { ok: st.ok - b.ok, searchFail: st.searchFail - b.searchFail, weakMemoHit: st.weakMemoHit - b.weakMemoHit },
    state: window.__mbThumbState(),
  });
})()
