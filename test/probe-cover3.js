(async () => {
  const measure = (src) => new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const N = 32;
      const cv = document.createElement('canvas');
      cv.width = N; cv.height = N;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, N, N);
      const d = ctx.getImageData(0, 0, N, N).data;
      let white = 0, total = 0, cs = 0, cn = 0, gray = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const k = (y * N + x) * 4;
          const r = d[k], g = d[k + 1], b = d[k + 2];
          if (r > 235 && g > 235 && b > 235) white++;
          const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
          if (mx - mn < 14) gray++;
          total++;
          if (x > N * 0.32 && x < N * 0.68 && y > N * 0.32 && y < N * 0.68) { cs += (r + g + b) / 3; cn++; }
        }
      }
      resolve({ w: img.naturalWidth, whiteFrac: Number((white / total).toFixed(2)), grayFrac: Number((gray / total).toFixed(2)), center: Math.round(cs / cn) });
    };
    img.onerror = () => resolve({ decode: false });
    img.src = src;
  });
  const out = {};
  // 1) 打上花火 专辑缓存里那张（疑似默认黑胶）
  out.cachedPika = await measure((window.__thumbStats ? null : null) || (await (async()=>{ const r=await window.Capacitor.Plugins.MusicBridge.readThumb('', 96, 'alb:daoko/米津玄師|打上花火'); return r && r.dataUrl ? r.dataUrl : null; })()));
  // 2) 当前行上真实渲染的图（就是 t.cover）
  out.trackPika = await measure(S.tracks[6].cover);
  // 3) 真封面样本：网易云刚下的
  const good = await window.__online.downloadCover('https://p1.music.126.net/ZUCE_1Tl_hkbtamKmSNXEg==/109951163009282836.jpg?param=200y200');
  out.goodPika = await measure(good);
  return out;
})()

