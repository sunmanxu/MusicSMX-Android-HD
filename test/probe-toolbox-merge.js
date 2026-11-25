// 1.0.23 工具菜单合并：验证「点自动修复 → 修完接着缓存封面歌词」的接线（不动任何音乐文件）
(async () => {
  const out = {};

  // A) 取消路径：确认框返回 false，原版 autoFixAll 会立刻 return，不会碰文件
  const realFix = window.autoFixAll;
  const realConfirm = window.showConfirm;
  window.__bdCalls = 0;
  const realDl = window.startBatchDownload;
  window.startBatchDownload = function () { window.__bdCalls++; return Promise.resolve(); };
  window.showConfirm = function () { return Promise.resolve(false); };
  await realFix();
  out.cancel = { confirmedFlag: window.__mbAutoFixConfirmed, batchDlCalls: window.__bdCalls };

  // B) 成功路径：用替身顶掉 autoFixAll，重跑一次安装，看是否真的接着调 startBatchDownload
  window.showConfirm = realConfirm;
  window.autoFixAll = function () { window.__mbAutoFixConfirmed = true; return Promise.resolve(); };
  window.__mbAutoFixMerged = false;
  window.__mbConfirmHooked = true;
  if (typeof window.__mbToolboxMerge === 'function') window.__mbToolboxMerge();
  await window.autoFixAll();
  await new Promise((r) => setTimeout(r, 500));
  out.success = { batchDlCalls: window.__bdCalls, merged: !!window.__mbAutoFixMerged };

  // 还原（不还原也只是内存里的替身，重启即恢复）
  window.autoFixAll = realFix;
  window.startBatchDownload = realDl;
  return JSON.stringify(out);
})()
