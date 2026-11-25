// 诊断：缩略图下载为什么失败（补丁 window.__online.downloadCover 统计 URL/耗时/失败）
(async () => {
  const O = window.__online;
  if (!O.__dlPatched) {
    O.__dlPatched = true;
    O.__dlLog = [];
    const orig = O.downloadCover;
    O.downloadCover = function (url) {
      const t0 = Date.now();
      return orig.apply(this, arguments).then((r) => {
        O.__dlLog.push({ url: String(url).slice(0, 110), ms: Date.now() - t0, ok: !!r, len: r ? r.length : 0 });
        return r;
      });
    };
  }
  const list = document.getElementById('track-list');
  list.scrollTop = list.scrollHeight * 0.42;
  await new Promise((r) => setTimeout(r, 25000));
  const log = O.__dlLog;
  const host = (u) => { try { return new URL(u).host; } catch (e) { return 'x'; } };
  const byHost = {};
  log.forEach((r) => {
    const h = host(r.url);
    byHost[h] = byHost[h] || { ok: 0, fail: 0, avgMs: 0, n: 0 };
    byHost[h][r.ok ? 'ok' : 'fail']++;
    byHost[h].avgMs += r.ms; byHost[h].n++;
  });
  Object.keys(byHost).forEach((h) => { byHost[h].avgMs = Math.round(byHost[h].avgMs / byHost[h].n); });
  const fails = log.filter((r) => !r.ok).slice(-12);
  return JSON.stringify({ total: log.length, byHost, fails }, null, 1);
})()
