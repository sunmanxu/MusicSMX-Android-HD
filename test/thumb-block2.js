  // ---------------- 1.0.12/1.0.13：列表行左侧缩略封面 ----------------
  // 只留 96px 小图（约 3~5KB），不把原图塞进 WebView。取图顺序按「最快出图」排：
  //  1) 磁盘上已有的专辑缩略图（key = alb:歌手|专辑）—— 重启后第一批全靠它，零网络；
  //  2) 联网「快枪」搜索（online.js 的 searchCoverFast：五个源并发抢 + 3.2s 预算），
  //     并且直接下源给的 thumbUrl（200/300px），不再下 600~800 的大图；
  //  3) 前面都没出图，才去读文件内嵌封面（实测这批曲库基本没有内嵌封面，只是兜底）；
  //  搜不到的专辑写入负缓存（localStorage，7 天），下次启动不再浪费请求。
  const THUMB = {
    mem: new Map(),        // albumKey -> dataUrl
    missFile: new Set(),   // path -> 内嵌封面确认没有
    jobs: new Map(),       // albumKey -> job（同一专辑只跑一次）
    dead: new Set(),       // 本次运行确认拿不到的专辑，别再重排
    queue: [],
    inflight: 0,
    max: 3,
    neg: {},
    negLoaded: false,
  };

  function loadThumbNeg() {
    if (THUMB.negLoaded) return;
    THUMB.negLoaded = true;
    try {
      const raw = localStorage.getItem('mb_thumb_neg_v1');
      THUMB.neg = raw ? JSON.parse(raw) : {};
    } catch (e) { THUMB.neg = {}; }
  }

  function saveThumbNeg() {
    try { localStorage.setItem('mb_thumb_neg_v1', JSON.stringify(THUMB.neg)); } catch (e) {}
  }

  function markThumbNeg(key) {
    loadThumbNeg();
    THUMB.neg[key] = Date.now();
    // 负缓存别无限长，超过 300 条就清掉最旧的一半
    const keys = Object.keys(THUMB.neg);
    if (keys.length > 300) {
      keys.sort(function (a, b) { return THUMB.neg[a] - THUMB.neg[b]; });
      for (let i = 0; i < 150; i++) delete THUMB.neg[keys[i]];
    }
    saveThumbNeg();
  }

  function clearThumbNeg(key) {
    loadThumbNeg();
    if (THUMB.neg[key]) { delete THUMB.neg[key]; saveThumbNeg(); }
  }

  function thumbNegFresh(key) {
    loadThumbNeg();
    const ts = THUMB.neg[key];
    return !!(ts && (Date.now() - ts < 7 * 864e5));
  }

  function thumbBox(row) {
    let box = row.querySelector('.mb-row-cover');
    if (!box) {
      box = document.createElement('div');
      box.className = 'mb-row-cover';
      box.innerHTML = '<span class="mb-cover-ph">&#9835;</span>';
      row.insertBefore(box, row.firstChild);
    }
    return box;
  }

  function paintThumb(row, url) {
    const box = thumbBox(row);
    if (box.dataset.ready === '1' && box.firstChild && box.firstChild.tagName === 'IMG') return;
    box.dataset.ready = '1';
    box.innerHTML = '';
    const img = document.createElement('img');
    img.decoding = 'async';
    img.src = url;
    box.appendChild(img);
  }

  function albumKeyOf(t) {
    return 'alb:' + ((t.artist || '') + '|' + (t.album || t.title || '')).toLowerCase();
  }

  function rowTrack(row) {
    try {
      const idx = parseInt(row.dataset.idx, 10);
      if (isNaN(idx) || typeof S === 'undefined' || !S.tracks) return null;
      const t = S.tracks[idx];
      if (!t || !t.path || t.isOnline) return null;
      return t;
    } catch (e) { return null; }
  }

  /** 把任意尺寸的封面 dataUrl 居中裁方缩到 size，返回 JPEG dataUrl */
  function downscaleCover(dataUrl, size) {
    return new Promise(function (resolve) {
      try {
        const img = new Image();
        img.onload = function () {
          try {
            const c = document.createElement('canvas');
            c.width = size;
            c.height = size;
            const g = c.getContext('2d');
            const side = Math.min(img.width, img.height);
            g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
            resolve(c.toDataURL('image/jpeg', 0.78));
          } catch (e) { resolve(null); }
        };
        img.onerror = function () { resolve(null); };
        img.src = dataUrl;
      } catch (e) { resolve(null); }
    });
  }

  // 联网取缩略图：快枪搜索 → 下 thumbUrl（小图）→ canvas 缩到 96px → 写盘
  function fetchThumbOnline(job) {
    return new Promise(function (resolve) {
      const O = window.__online;
      let auto = true;
      try { auto = S && S.settings ? S.settings.autoCover !== false : true; } catch (e) {}
      if (!O || !auto) { resolve(null); return; }
      const search = O.searchCoverFast || O.searchCover;
      if (typeof search !== 'function') { resolve(null); return; }
      search(job.artist, job.title, 3200).then(function (info) {
        if (!info) { resolve(null); return; }
        // 源已经给了 200/300px 的 thumbUrl，别去下 600~800 的大图再缩：白等好几倍流量
        const url = info.thumbUrl || info.url;
        if (!url) { resolve(null); return; }
        return O.downloadCover(url).then(function (dataUrl) {
          if (!dataUrl) { resolve(null); return; }
          downscaleCover(dataUrl, 96).then(function (small) {
            if (small) mb.saveThumb(job.key, small).catch(function () {});
            resolve(small);
          });
        });
      }).catch(function () { resolve(null); });
    });
  }

  function runThumbJob(job) {
    THUMB.inflight++;
    let settled = false;
    const done = function (url) {
      if (settled) return;
      settled = true;
      THUMB.inflight--;
      THUMB.jobs.delete(job.key);
      if (url) {
        clearThumbNeg(job.key);
        if (THUMB.mem.size > 600) THUMB.mem.clear();
        THUMB.mem.set(job.key, url);
      } else {
        THUMB.dead.add(job.key);
      }
      scheduleThumbPass();
      pumpThumbs();
    };
    const tryFile = function () {
      if (THUMB.missFile.has(job.path)) { done(null); return; }
      mb.readThumb(job.path, 96).then(function (r) {
        if (r && r.ok && r.dataUrl) {
          done(r.dataUrl);
          mb.saveThumb(job.key, r.dataUrl).catch(function () {});
          return;
        }
        THUMB.missFile.add(job.path);
        done(null);
      }).catch(function () { done(null); });
    };
    // 1) 磁盘里已有的专辑缩略图
    mb.readThumb('', 96, job.key).then(function (r) {
      if (r && r.ok && r.dataUrl) { done(r.dataUrl); return; }
      // 2) 联网（负缓存里的 7 天内直接跳过，别再空跑一次搜索）
      if (thumbNegFresh(job.key)) { tryFile(); return; }
      fetchThumbOnline(job).then(function (url) {
        if (url) { done(url); return; }
        markThumbNeg(job.key);
        tryFile();
      }).catch(function () { tryFile(); });
    }).catch(function () { done(null); });
  }

  function pumpThumbs() {
    while (THUMB.inflight < THUMB.max && THUMB.queue.length) {
      const job = THUMB.queue.shift();
      if (!job) break;
      runThumbJob(job);
    }
  }

  function syncRowCover(row) {
    if (row.classList.contains('online-row')) return;
    const t = rowTrack(row);
    if (!t) return;
    const key = albumKeyOf(t);
    let box = row.querySelector('.mb-row-cover');
    if (row.dataset.mbCoverKey !== key) {
      row.dataset.mbCoverKey = key;
      if (box) { box.dataset.ready = '0'; box.innerHTML = '<span class="mb-cover-ph">&#9835;</span>'; }
    }
    if (box && box.dataset.ready === '1') return;
    const url = t.cover || THUMB.mem.get(key);
    if (url) { paintThumb(row, url); return; }
    thumbBox(row);                              // 先占位，行高不抖
    if (THUMB.jobs.has(key) || THUMB.dead.has(key)) return;
    const job = { key: key, path: t.path, artist: t.artist || '', title: t.title || '' };
    THUMB.jobs.set(key, job);
    THUMB.queue.push(job);
    pumpThumbs();
  }

  // 往下多抓一点：可见区域之后 24 首涉及的专辑提前排队，
  // 用户往下滑的时候不用等（上限 40 个待办，别一次排太多把接口打爆）
  function prefetchAhead(maxVisibleIdx) {
    if (typeof S === 'undefined' || !S.tracks || maxVisibleIdx < 0) return;
    const end = Math.min(S.tracks.length - 1, maxVisibleIdx + 24);
    for (let i = maxVisibleIdx + 1; i <= end; i++) {
      if (THUMB.queue.length >= 40) break;
      const t = S.tracks[i];
      if (!t || !t.path || t.isOnline) continue;
      const key = albumKeyOf(t);
      if (THUMB.mem.has(key) || THUMB.jobs.has(key) || THUMB.dead.has(key) || thumbNegFresh(key)) continue;
      THUMB.jobs.set(key, { key: key, path: t.path, artist: t.artist || '', title: t.title || '' });
      THUMB.queue.push(THUMB.jobs.get(key));
    }
    pumpThumbs();
  }

  let thumbRaf = 0;
  function scheduleThumbPass() {
    if (thumbRaf) return;
    thumbRaf = requestAnimationFrame(function () {
      thumbRaf = 0;
      try {
        const list = document.getElementById('track-list');
        if (!list) return;
        const rows = list.getElementsByClassName('track-row');
        let maxIdx = -1;
        for (let i = 0; i < rows.length; i++) {
          syncRowCover(rows[i]);
          const idx = parseInt(rows[i].dataset.idx, 10);
          if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
        }
        prefetchAhead(maxIdx);
      } catch (e) {}
    });
  }

  function installRowCovers() {
    if (installRowCovers._done) { scheduleThumbPass(); return; }
    const list = document.getElementById('track-list');
    if (!list) return;
    installRowCovers._done = true;
    loadThumbNeg();
    // 虚拟列表每次滚动都会增删行 → MutationObserver + rAF 合并，只处理可见的那几十行
    try {
      new MutationObserver(scheduleThumbPass).observe(list, { childList: true });
    } catch (e) {}
    list.addEventListener('scroll', scheduleThumbPass, { passive: true });
    scheduleThumbPass();
    setTimeout(scheduleThumbPass, 600);
    setTimeout(scheduleThumbPass, 2000);
  }

