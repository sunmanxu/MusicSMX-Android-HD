// 1.0.24：不动网络，纯算「这一次点自动修复/缓存，到底要处理多少首、能跳过多少首」
(function () {
  const key = (a, t) => (String(a || '') + ' - ' + String(t || '')).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120).toLowerCase();
  const s = S.settings || {};
  let ph = 0, locked = 0, fixed = 0, fixNeed = 0;
  let coverSkip = 0, coverNeed = 0, lyrSkip = 0, lyrNeed = 0;
  for (const t of S.tracks) {
    if (!t || !t.path) continue;
    if (t.isPlaceholder) { ph++; continue; }
    if (s.lockedTracks && s.lockedTracks[t.path]) { locked++; continue; }
    if (s.fixedTracks && s.fixedTracks[t.path]) { fixed++; continue; }
    fixNeed++;
    const k = key(t.artist, t.title);
    if (S.coverCache.has(t.path) || S.localCoverFiles.has(k)) coverSkip++; else coverNeed++;
    if (S.lyricsCache.has(t.path) || S.localLyricsFiles.has(k)) lyrSkip++; else lyrNeed++;
  }
  const memo = Object.keys(JSON.parse(localStorage.getItem('mb_autofix_memo_v1') || '{}')).length;
  return JSON.stringify({
    total: S.tracks.length,
    自动修复: { 占位跳过: ph, 已锁定跳过: locked, 已修复跳过: fixed, 需要联网核对: fixNeed, 本地记忆已存: memo },
    缓存封面: { 可跳过: coverSkip, 需下载: coverNeed },
    缓存歌词: { 可跳过: lyrSkip, 需下载: lyrNeed }
  }, null, 1);
})()
