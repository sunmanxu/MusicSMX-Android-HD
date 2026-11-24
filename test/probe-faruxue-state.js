(async () => {
  const t = S.tracks[16];
  const key = 'albv18:' + ((t.artist || '') + '|' + (t.album || t.title || '')).toLowerCase();
  let neg = {};
  try { neg = JSON.parse(localStorage.getItem('mb_thumb_neg_v1') || '{}'); } catch (e) {}
  const row = document.querySelector('.track-row[data-idx="16"]');
  const memHas = !!window.__thumbStats && undefined;
  const out = {
    key: key,
    negRec: neg[key] || null,
    negTotal: Object.keys(neg).length,
    trackCover: !!t.cover,
    rowPresent: !!row,
    rowImg: !!(row && row.querySelector('.mb-row-cover img')),
    rowCoverFrom: row ? (row.dataset.mbCoverFrom || '') : '',
    stats: window.__thumbStats ? JSON.parse(JSON.stringify(window.__thumbStats)) : null,
  };
  // 读磁盘上这个 key 有没有 thumbs 文件
  try {
    const r = await window.mb.readThumb('', 96, key);
    out.diskThumb = !!(r && r.ok && r.dataUrl);
  } catch (e) { out.diskThumb = 'err ' + e; }
  return out;
})()
