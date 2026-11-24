  // ---------------- 1.0.12：列表行左侧缩略封面 ----------------
  // 三级来源，全部只用 96px 小图（原生读盘 / 内存 Map），不把原图塞进 WebView：
  //  1) 已落盘的「专辑缩略图」（key = alb:歌手|专辑）→ 有就秒出；
  //  2) 文件内嵌封面（原生 readThumb 现场解标签 + 居中裁方 + 缩图，带磁盘缓存）；
  //  3) 上面都没有才联网补（沿用 S.settings.autoCover 的设置），抓回来 canvas 缩到 96px
  //     再写回磁盘，一共只抓一次。并发压到 2，按「专辑」去重，避免 1380 首把接口打爆。
  const THUMB = {
    mem: new Map(),        // albumKey -> dataUrl
    missFile: new Set(),   // path -> 内嵌封面确认没有
    triedOnline: new Set(),// albumKey -> 已经联网试过（失败别再试）
    jobs: new Map(),       // albumKey -> job（同一专辑只跑一次）
    queue: [],
    inflight: 0,
    max: 2,
  };

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

  function runThumbJob(job) {
    THUMB.inflight++;
    const done = function (url) {
      THUMB.inflight--;
      THUMB.jobs.delete(job.key);
      if (url) {
        if (THUMB.mem.size > 600) THUMB.mem.clear();
        THUMB.mem.set(job.key, url);
      }
      scheduleThumbPass();
      pumpThumbs();
    };
    // 1) 已落盘的专辑缩略图
    mb.readThumb('', 96, job.key).then(function (r) {
      if (r && r.ok && r.dataUrl) { done(r.dataUrl); return true; }
      return false;
    }).catch(function () { return false; }).then(function (hit) {
      if (hit) return;
      // 2) 文件内嵌封面
      if (THUMB.missFile.has(job.path)) return step3();
      return mb.readThumb(job.path, 96).then(function (r) {
        if (r && r.ok && r.dataUrl) {
          done(r.dataUrl);
          mb.saveThumb(job.key, r.dataUrl).catch(function () {});
          return 'stop';
        }
        THUMB.missFile.add(job.path);
        return step3();
      }).catch(function () { return step3(); });
    }).catch(function () { done(null); });

    function step3() {
      // 3) 联网补（尊重「自动获取封面」开关）
      let auto = true;
      try { auto = S && S.settings ? S.settings.autoCover !== false : true; } catch (e) {}
      if (!auto || THUMB.triedOnline.has(job.key) || typeof mb.fetchCover !== 'function') { done(null); return; }
      THUMB.triedOnline.add(job.key);
      mb.fetchCover(job.artist, job.title).then(function (r) {
        if (!r || !r.ok || !r.dataUrl) { done(null); return; }
        return downscaleCover(r.dataUrl, 96).then(function (small) {
          if (!small) { done(null); return; }
          done(small);
          nativeCall('saveThumb', { key: job.key, dataUrl: small }).catch(function () {});
        });
      }).catch(function () { done(null); });
    }
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
    if (THUMB.jobs.has(key)) return;            // 这张专辑已经在跑了
    const job = { key: key, path: t.path, artist: t.artist || '', title: t.title || '' };
    THUMB.jobs.set(key, job);
    THUMB.queue.push(job);
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
        for (let i = 0; i < rows.length; i++) syncRowCover(rows[i]);
      } catch (e) {}
    });
  }

  function installRowCovers() {
    if (installRowCovers._done) { scheduleThumbPass(); return; }
    const list = document.getElementById('track-list');
    if (!list) return;
    installRowCovers._done = true;
    // 虚拟列表每次滚动都会增删行 → MutationObserver + rAF 合并，只处理可见的那几十行
    try {
      new MutationObserver(scheduleThumbPass).observe(list, { childList: true });
    } catch (e) {}
    list.addEventListener('scroll', scheduleThumbPass, { passive: true });
    scheduleThumbPass();
    setTimeout(scheduleThumbPass, 600);
    setTimeout(scheduleThumbPass, 2000);
  }

