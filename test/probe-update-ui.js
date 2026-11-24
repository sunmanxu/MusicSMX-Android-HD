// 1.0.21 更新中心自检：点按钮 → 读状态行 → 直接调 checkUpdate 看原始返回
(async () => {
  const out = {};
  const line = () => {
    const el = document.getElementById('mb-update-line');
    return el ? { text: el.textContent, kind: el.getAttribute('data-kind') } : null;
  };
  out.buttonFound = !!document.querySelector('[data-mb-upd="1"]');
  out.btnText0 = (document.getElementById('btn-check-update') || {}).textContent;
  out.line0 = line();

  // 1) 点一下按钮（走完整 UI 流程）
  const btn = document.getElementById('btn-check-update');
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 1500));
  out.afterClickBtn = btn.textContent;
  out.afterClickLine = line();

  await new Promise((r) => setTimeout(r, 8000));
  out.afterWaitBtn = btn.textContent;
  out.afterWaitLine = line();

  // 2) 原始接口
  out.raw = await mb.checkUpdate();
  return JSON.stringify(out);
})()
