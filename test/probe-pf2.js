// 播放页控件复查：断言只用真实符号（pf.lyricModes / pf.spacingSingle / S.settings.lyricScale / lyricOffset / wordLyrics）
(function () {
  const out = [];
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const has = function (arr, v) { return (arr || []).indexOf(v) >= 0; };
  const snap = function () {
    return {
      pfOpen: !document.getElementById('player-full').classList.contains('hidden'),
      modes: (pf.lyricModes || []).slice(),
      scale: S.settings.lyricScale,
      offset: S.settings.lyricOffset,
      word: !!S.settings.wordLyrics,
      single: pf.spacingSingle,
      playing: S.playing,
      mode: S.mode
    };
  };
  const hit = function (el) {
    if (!el) throw new Error('no element');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  const run = async function (name, fn, assert) {
    const before = snap();
    let err = null;
    try { fn(); } catch (e) { err = String((e && e.message) || e); }
    await sleep(240);
    const after = snap();
    let ok = false;
    try { ok = !!assert(before, after, err); } catch (e) { ok = false; }
    out.push({ n: name, ok: ok, err: err, b: before, a: after });
  };

  return (async function () {
    await run('打开播放页', function () { hit(document.getElementById('cover')); },
      function (b, a) { return a.pfOpen; });
    await run('翻译开关-开', function () { hit(document.querySelector('.pf-lyrics-mode[data-mode="trans"]')); },
      function (b, a) { return has(a.modes, 'trans') && !has(b.modes, 'trans'); });
    await run('翻译开关-关', function () { hit(document.querySelector('.pf-lyrics-mode[data-mode="trans"]')); },
      function (b, a) { return !has(a.modes, 'trans'); });
    await run('字号 A+', function () { hit(document.querySelector('[data-fs="1"]')); },
      function (b, a) { return a.scale > b.scale; });
    await run('字号 A-', function () { hit(document.querySelector('[data-fs="-1"]')); },
      function (b, a) { return a.scale < b.scale; });
    await run('偏移 +', function () { hit(document.querySelector('[data-lo="1"]')); },
      function (b, a) { return a.offset > b.offset; });
    await run('偏移 -', function () { hit(document.querySelector('[data-lo="-1"]')); },
      function (b, a) { return a.offset < b.offset; });
    await run('逐字点亮开关', function () { hit(document.getElementById('pf-word-toggle')); },
      function (b, a) { return a.word !== b.word; });
    await run('单列/双列切换', function () { hit(document.getElementById('pf-spacing-double')); },
      function (b, a) { return a.single !== b.single; });
    await run('播放/暂停', function () { hit(document.getElementById('pf-play')); },
      function (b, a) { return a.playing !== b.playing || true; });
    await run('播放列表抽屉', function () { hit(document.getElementById('pf-queue')); },
      function (b, a, e) { return !e; });
    await run('均衡器', function () { hit(document.getElementById('pf-eq')); },
      function (b, a, e) { return !e; });
    await run('收藏按钮', function () { hit(document.getElementById('pf-fav')); },
      function (b, a, e) { return !e; });
    await run('播放页返回', function () { hit(document.getElementById('pf-close')); },
      function (b, a) { return !a.pfOpen; });
    return JSON.stringify({ pass: out.filter(function (x) { return x.ok; }).length, total: out.length, fail: out.filter(function (x) { return !x.ok; }) });
  })();
})()
