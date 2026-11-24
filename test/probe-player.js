(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const audio = document.getElementById('audio');

  // 打开全屏播放页：点左下角封面
  document.getElementById('cover').click();
  await wait(900);
  out.pfOpen = !!pf.open;
  out.lyricsMode = S.lyricsMode;
  out.disp = JSON.stringify(S.lyricsDisplay || null);
  out.wordOn = !!S.settings.wordLyrics;

  // 翻译 / 原文
  document.querySelector('.pf-lyrics-mode[data-mode="trans"]').click();
  await wait(700);
  out.afterTrans = { lyricsMode: S.lyricsMode, disp: JSON.stringify(S.lyricsDisplay || null) };
  document.querySelector('.pf-lyrics-mode[data-mode="orig"]').click();
  await wait(700);
  out.afterOrig = { lyricsMode: S.lyricsMode, disp: JSON.stringify(S.lyricsDisplay || null) };

  // 逐字
  document.getElementById('pf-word-toggle').click();
  await wait(500);
  out.wordAfter = !!S.settings.wordLyrics;
  document.getElementById('pf-word-toggle').click();
  await wait(400);

  // 收藏（播放页内）
  document.getElementById('pf-fav').click();
  await wait(500);
  out.fav1 = S.favorites.size;
  document.getElementById('pf-fav').click();
  await wait(400);
  out.fav2 = S.favorites.size;

  // 歌词速度 +/-
  const lo = document.querySelector('[data-lo="1"]');
  lo.click();
  await wait(500);
  out.loAfter = document.querySelector('[data-lo-val]').textContent;
  document.querySelector('[data-lo="-1"]').click();
  await wait(400);
  out.loBack = document.querySelector('[data-lo-val]').textContent;

  // 字号 A+/A-
  document.querySelector('[data-fs="1"]').click();
  await wait(400);
  out.fsAfter = document.querySelector('[data-fs-val]').textContent;
  document.querySelector('[data-fs="-1"]').click();
  await wait(300);
  out.fsBack = document.querySelector('[data-fs-val]').textContent;

  // 行距滑块
  const sp = document.getElementById('pf-spacing-single');
  out.spBefore = document.getElementById('pf-spacing-single-val').textContent;
  sp.value = '1.6';
  sp.dispatchEvent(new Event('input', { bubbles: true }));
  sp.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(500);
  out.spAfter = document.getElementById('pf-spacing-single-val').textContent;

  // 播放页内 下一首/上一首/播放暂停/进度
  const cur0 = S.current;
  document.getElementById('pf-next').click();
  await wait(800);
  out.nextChanged = S.current !== cur0;
  document.getElementById('pf-prev').click();
  await wait(800);
  out.prevChanged = S.current !== cur0;
  document.getElementById('pf-play').click();
  await wait(800);
  out.pfPaused = audio.paused;
  document.getElementById('pf-play').click();
  await wait(800);
  out.pfPaused2 = audio.paused;

  // 播放页返回
  document.getElementById('pf-close').click();
  await wait(700);
  out.pfClosed = !pf.open;

  return JSON.stringify(out);
})()
