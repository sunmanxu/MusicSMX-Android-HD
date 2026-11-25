// 1.0.26 真机验证：23 个曾经抓不到图的专辑，用新的源链路再试一次
(async () => {
  const list = [{a:'Sinéad O\'Connor',al:'How About I Be Me (And You Be You)_(Deluxe Edition)',t:'Reason With Me'},{a:'Aaron Smith',al:'最新热歌慢摇77',t:'DANCIN KRONO REMIX'},{a:'Kiiara',al:'L___ Is A Bad Word',t:'L___ Is A Bad Word'},{a:'纯音乐',al:'未知专辑',t:'PIPA VIS PHONK (Single Version)_L'},{a:'花澤香菜',al:'「囮物語」劇伴音楽集 & あとがたり',t:'もうそう♥えくすぷれす'},{a:'Vitamin String Quartet',al:'Merry Go Round of Life',t:'Howl\'s Moving Castle'},{a:'杨振宇',al:'伍六七 原声大碟',t:'连备胎都不是'},{a:'染岚刀',al:'未知专辑',t:'Free Loop (口琴版)_H'},{a:'BOOSIN',al:'Black Water',t:'Drunk Groove'},{a:'单依纯',al:'喂',t:'喂'},{a:'Mikann耙耙柑',al:'生音记忆II·原声',t:'醒'},{a:'明熹Milo',al:'二胡',t:'神经病之歌'},{a:'Anne-Sophie Mutter _ Herbert von Karajan _ Peter Alward _ Wiener Philharmoniker',al:'Vivaldi_ Die vier Jahreszeiten',t:'The Four Seasons, Violin Concerto in G Minor, Op. 8 No. 2, RV 315 _Summer__III. Presto'},{a:'SawanoHiroyuki[nZk]',al:'A_Z_aLIEz',t:'アライズ'},{a:'A Rusty Dream',al:'未知专辑',t:'DOUDOU'},{a:'科普知识',al:'未知专辑',t:'My Soul'},{a:'Machine Gun Kelly',al:'Bright_ The Album',t:'Home'},{a:'Yael Naim',al:'Older',t:'Walk Walk'},{a:'Vivaldi String Orchestra',al:'Walter Rinaldi_ Piano Concertos & Orchestral Works _ Vivaldi_ The Four Seasons',t:'The Four Seasons, Concerto for Violin, Strings and Continuo in F Minor, No. 4, Op. 8, RV 297, “L’ In'},{a:'Taylor Swift',al:'...Ready For It? (BloodPop® Remix)',t:'...Ready For It? (BloodPop® Remix)'},{a:'末廣健一郎',al:'TBS系 火曜ドラマ「逃げるは恥だが役に立つ」オリジナル・サウンドトラック Vol.2',t:'恋'},{a:'美波',al:'Kawakiwoameku',t:'Kawakiwoameku'},{a:'那英',al:'默',t:'默'}];
  const O = window.__online;
  const out = [];
  for (const m of list) {
    const t0 = Date.now();
    let r = null;
    try { r = await O.searchCover(m.a, m.t, m.al); } catch (e) { r = { err: String(e) }; }
    let dl = 0;
    if (r && r.url) { try { const d = await O.downloadCover(r.url); dl = d ? d.length : 0; } catch (e) { dl = -1; } }
    out.push({ alb: m.a + ' / ' + m.al, src: (r && r.source) || 'MISS', url: (r && r.url) || '', ms: Date.now() - t0, dl });
  }
  const hit = out.filter((x) => x.dl > 1000).length;
  return JSON.stringify({ hit, total: out.length, rows: out });
})()
