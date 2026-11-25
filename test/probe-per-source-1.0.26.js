// 逐个源诊断 9 个 MISS 专辑，看每个源在设备上返回什么
(async () => {
  const cases = [
    { a: '单依纯', al: '喂', t: '喂' },
    { a: 'Mikann耙耙柑', al: '生音记忆II·原声', t: '醒' },
    { a: 'Machine Gun Kelly', al: 'Bright_ The Album', t: 'Home' },
    { a: '美波', al: 'Kawakiwoameku', t: 'Kawakiwoameku' },
    { a: '末廣健一郎', al: 'TBS系 火曜ドラマ「逃げるは恥だが役に立つ」オリジナル・サウンドトラック Vol.2', t: '恋' },
  ];
  const S = window.__coverSources;
  const out = [];
  for (const c of cases) {
    const row = { alb: c.a + ' / ' + c.al.slice(0, 20), srcs: {} };
    for (const [name, fn] of Object.entries(S)) {
      const t0 = Date.now();
      let r = null, err = '';
      try {
        if (name === 'kugouAlbum') r = await fn(c.a, c.al);
        else if (name === 'neteaseAlbum' || name === 'kuwoAlbum') r = await fn(c.a, c.al);
        else if (name === 'img360') r = await fn(c.a, c.al, c.t);
        else if (name === 'qqSmartbox') r = await fn(c.a, c.al, true);
        else r = await fn(c.a, c.t);
      } catch (e) { err = String(e && e.message || e); }
      row.srcs[name] = (r && r.url ? 'HIT ' : 'no  ') + (Date.now() - t0) + 'ms' + (err ? ' err:' + err : '');
    }
    out.push(row);
  }
  return JSON.stringify(out, null, 1);
})()
