(async () => {
  const O = window.__online;
  const out = {};
  const probe = async (artist, title, tag) => {
    const r = await O.searchCover(artist, title);
    if (!r) { out[tag] = { found: false }; return; }
    const dataUrl = await O.downloadCover(r.thumbUrl || r.url);
    const res = await new Promise((resolve) => {
      if (!dataUrl) return resolve({ dl: false });
      const img = new Image();
      img.onload = () => {
        const N = 32;
        const cv = document.createElement('canvas');
        cv.width = N; cv.height = N;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        let white = 0, total = 0, cs = 0, cn = 0;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            const k = (y * N + x) * 4;
            const r0 = d[k], g0 = d[k + 1], b0 = d[k + 2];
            if (r0 > 235 && g0 > 235 && b0 > 235) white++;
            total++;
            if (x >= N * 0.3 && x <= N * 0.7 && y >= N * 0.3 && y <= N * 0.7) { cs += (r0 + g0 + b0) / 3; cn++; }
          }
        }
        resolve({ dl: true, w: img.naturalWidth, whiteFrac: Number((white / total).toFixed(2)), center: Math.round(cs / cn) });
      };
      img.onerror = () => resolve({ dl: true, decode: false });
      img.src = dataUrl;
    });
    out[tag] = { found: true, src: r.source, url: (r.thumbUrl || r.url || '').slice(0, 90), ...res };
  };
  await probe('ヨルシカ', '又三郎', 'matatan');
  await probe('Daoko', '打上花火', 'pika');
  return out;
})()
