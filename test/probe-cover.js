(async () => {
  const t = S.tracks[6];
  const load = (src) => new Promise((res) => {
    const p = new Image();
    p.onload = () => res(p);
    p.onerror = () => res(null);
    p.src = src;
  });
  const img = await load(t.cover);
  if (!img) return { err: 'decode' };
  const N = 20;
  const cv = document.createElement('canvas');
  cv.width = N; cv.height = N;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;
  const rows = [];
  const sat = [];
  for (let y = 0; y < N; y++) {
    let s = '';
    for (let x = 0; x < N; x++) {
      const k = (y * N + x) * 4;
      const r = d[k], g = d[k + 1], b = d[k + 2];
      const v = (r + g + b) / 3;
      const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
      sat.push(mx === 0 ? 0 : (mx - mn) / mx);
      s += v > 210 ? '#' : v > 140 ? '+' : v > 70 ? '-' : '.';
    }
    rows.push(s);
  }
  const grayFrac = sat.filter((v) => v < 0.1).length / sat.length;
  const corners = [d[0], d[5], d[(N - 1) * N * 4], d[((N * N) - 1) * 4]].map((v) => v);
  return { w: img.naturalWidth, h: img.naturalHeight, grayFrac: Number(grayFrac.toFixed(2)), rows, trackKeys: Object.keys(t) };
})()
