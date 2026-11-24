// 1.0.21 端到端：点检查更新 → 等发现新版本 → 点下载安装 → 读进度/结果
(async () => {
  const log = [];
  const btn = () => document.getElementById('btn-check-update');
  const line = () => {
    const el = document.getElementById('mb-update-line');
    return el ? el.getAttribute('data-kind') + '|' + el.textContent : 'null';
  };
  const snap = (tag) => log.push(tag + ' >> btn=' + (btn() ? btn().textContent : '?') + ' | ' + line());

  snap('t0');
  // 第一下：检查
  btn().click();
  for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 1500)); snap('check+' + (i + 1) * 1.5 + 's'); }

  // 第二下：下载并安装
  if (btn().textContent.indexOf('下载') >= 0) {
    btn().click();
    for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 1500)); snap('dl+' + (i + 1) * 1.5 + 's'); }
  } else {
    log.push('按钮不是「下载」状态，跳过下载');
  }
  return JSON.stringify(log, null, 1);
})()
