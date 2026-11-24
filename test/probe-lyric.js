(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const audio = document.getElementById('audio');

  // 先播起来（双键切：当前暂停就点播放）
  if (audio.paused) document.getElementById('btn-play').click();
  await wait(1600);
  out.playing = !audio.paused;
  out.title = (S.tracks[S.current] || {}).title;

  // 走渲染层自己的入口打开"任务栏歌词"（桌面版点一下就开 taskbar）
  document.getElementById('btn-desktop-lyric').click();
  await wait(500);
  out.menuOpen = !document.getElementById('desktop-lyric-menu').hidden;
  document.querySelector('#desktop-lyric-menu .dlm-modes button[data-mode="taskbar"]').click();
  await wait(1200);
  out.mode = S.settings.desktopLyric;
  out.overlay = await window.Capacitor.Plugins.MusicBridge.topLyricCanDraw({});
  out.shown = await window.Capacitor.Plugins.MusicBridge.topLyricCanDraw({});
  out.lyric = (typeof currentLyric === 'object') ? null : (function () {
    try { return S.lyrics && S.lyrics.length ? S.lyrics.map(l => l.text).slice(0, 3).join(' / ') : 'no-lyrics'; } catch (e) { return 'err'; }
  })();
  return JSON.stringify(out);
})()
