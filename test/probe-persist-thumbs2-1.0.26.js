// 同上，但图片先用原生 httpFetch 取成 dataURL（避免 canvas 跨域污染）
(async () => {
  const items = [{k:'albv18:sinéad o\'connor|how about i be me (and you be you)_(deluxe edition)',u:'http://imge.kugou.com/stdmusic/600/20190225/20190225190603452549.jpg'},{k:'albv18:aaron smith|最新热歌慢摇77',u:'http://imge.kugou.com/stdmusic/600/20190809/20190809160202948763.jpg'},{k:'albv18:kiiara|l___ is a bad word',u:'https://y.gtimg.cn/music/photo_new/T002R800x800M0000020TrIS1kQ9bd.jpg?max_age=2592000'},{k:'albv18:纯音乐|未知专辑',u:'https://p2.music.126.net/-ClebWRm8-Yt3aYrAFNO3w==/109951171293511382.jpg?param=600y600'},{k:'albv18:花澤香菜|「囮物語」劇伴音楽集 & あとがたり',u:'http://imge.kugou.com/stdmusic/600/20161029/20161029045319660217.jpg'},{k:'albv18:vitamin string quartet|merry go round of life',u:'https://img2.sycdn.kuwo.cn/star/albumcover/500/s4s58/59/3939021184.jpg'},{k:'albv18:杨振宇|伍六七 原声大碟',u:'https://p2.music.126.net/0W-41RPrcJ6AzyhI8LnfeA==/109951168544079115.jpg?param=600y600'},{k:'albv18:染岚刀|未知专辑',u:'https://img2.sycdn.kuwo.cn/star/albumcover/500/s3s0/57/1321520931.jpg'},{k:'albv18:boosin|black water',u:'http://imge.kugou.com/stdmusic/600/20261021/20261021023703152114.jpg'},{k:'albv18:单依纯|喂',u:'https://y.gtimg.cn/music/photo_new/T002R800x800M000001YCkAn283bTO.jpg?max_age=2592000'},{k:'albv18:mikann耙耙柑|生音记忆ii·原声',u:'https://y.gtimg.cn/music/photo_new/T002R800x800M000001OhmNa2FWk4B.jpg?max_age=2592000'},{k:'albv18:明熹milo|二胡',u:'https://y.gtimg.cn/music/photo_new/T002R500x500M000001XD9in2NJDsJ.jpg'},{k:'albv18:sawanohiroyuki[nzk]|a_z_aliez',u:'https://y.gtimg.cn/music/photo_new/T002R500x500M000003N3bx24AzMCn.jpg'},{k:'albv18:a rusty dream|未知专辑',u:'https://img2.sycdn.kuwo.cn/star/albumcover/500/s3s0/57/1321520931.jpg'},{k:'albv18:科普知识|未知专辑',u:'https://y.gtimg.cn/music/photo_new/T002R500x500M000001qRst64ezSyh.jpg'},{k:'albv18:yael naim|older',u:'https://y.gtimg.cn/music/photo_new/T002R800x800M000003XKh584G1RCU.jpg?max_age=2592000'},{k:'albv18:vivaldi string orchestra|walter rinaldi_ piano concertos & orchestral works _ vivaldi_ the four seasons',u:'http://imge.kugou.com/stdmusic/400/20230316/20230316094004731452.jpg'},{k:'albv18:taylor swift|...ready for it? (bloodpop® remix)',u:'http://imge.kugou.com/stdmusic/600/20210804/20210804093001733041.jpg'},{k:'albv18:末廣健一郎|tbs系 火曜ドラマ「逃げるは恥だが役に立つ」オリジナル・サウンドトラック vol.2',u:'https://y.gtimg.cn/music/photo_new/T002R800x800M0000015zlUD2NKrOm.jpg?max_age=2592000'},{k:'albv18:那英|默',u:'https://y.gtimg.cn/music/photo_new/T002R800x800M000003YaJPm3IojAP.jpg?max_age=2592000'}];
  const MB = window.Capacitor.Plugins.MusicBridge;
  const shrink = (dataUrl) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 96; c.height = 96;
        const ctx = c.getContext('2d');
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 96, 96);
        resolve(c.toDataURL('image/jpeg', 0.82));
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
  const out = { saved: 0, failed: [] };
  for (const it of items) {
    const got = await MB.httpFetch({ url: it.u, headers: {}, timeoutMs: 12000 }).catch(() => null);
    if (!got || !got.base64) { out.failed.push('fetch:' + it.k); continue; }
    const dataUrl = await shrink('data:image/jpeg;base64,' + got.base64);
    if (!dataUrl) { out.failed.push('shrink:' + it.k); continue; }
    const r = await window.mb.saveThumb(it.k, dataUrl).catch(() => null);
    if (r && r.ok !== false) out.saved++; else out.failed.push('save:' + it.k);
  }
  return JSON.stringify(out);
})()
