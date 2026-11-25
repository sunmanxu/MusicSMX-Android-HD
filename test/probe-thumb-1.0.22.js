// 1.0.22 缩略图自检：不点歌，只看列表自己长不长图
// 统计：可见行里有图/无图 数量、thumbStats 各阶段计数、队列与失败态
(async () => {
  const list = () => document.getElementById('track-list');
  function stats() {
    const s = window.__thumbStats || {};
    const rows = list() ? list().getElementsByClassName('track-row') : [];
    let withCover = 0, without = 0, placeholders = 0;
    for (let i = 0; i < rows.length; i++) {
      const box = rows[i].querySelector('.mb-row-cover');
      const img = box && box.querySelector('img');
      if (img && img.src && img.getAttribute('src')) withCover++;
      else if (box && box.querySelector('.mb-cover-ph')) { placeholders++; without++; }
      else without++;
    }
    return {
      rows: rows.length,
      withCover: withCover,
      without: without,
      placeholders: placeholders,
      ok: s.ok || 0,
      searchFail: s.searchFail || 0,
      dlFail: s.dlFail || 0,
      timeout: s.timeout || 0,
      drop: s.drop || 0,
    };
  }
  const snaps = [];
  snaps.push(['t0', stats()]);
  for (let i = 1; i <= 8; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    snaps.push(['+' + i * 5 + 's', stats()]);
  }
  return JSON.stringify(snaps, null, 1);
})()
