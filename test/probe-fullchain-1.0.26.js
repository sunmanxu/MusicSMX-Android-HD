(async () => {
  const cases = [
    { a: '单依纯', al: '喂', t: '喂' },
    { a: 'Mikann耙耙柑', al: '生音记忆II·原声', t: '醒' },
    { a: 'Machine Gun Kelly', al: 'Bright_ The Album', t: 'Home' },
    { a: '美波', al: 'Kawakiwoameku', t: 'Kawakiwoameku' },
    { a: '末廣健一郎', al: 'TBS系 火曜ドラマ「逃げるは恥だが役に立つ」オリジナル・サウンドトラック Vol.2', t: '恋' },
  ];
  const out = [];
  for (const c of cases) {
    const t0 = Date.now();
    let r = null, err = '';
    try { r = await window.__online.searchCover(c.a, c.t, c.al); } catch (e) { err = String(e && e.message || e); }
    out.push({ alb: c.a + '/' + c.al.slice(0, 12), ms: Date.now() - t0, src: r && r.source, url: r && r.url, err });
  }
  return JSON.stringify(out, null, 1);
})()
