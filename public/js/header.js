/* 窄屏导航抽屉增强：<details> 原生负责窄屏展开/收起，这里补上
 * 桌面端默认展开、点击外部/按 Esc 关闭，以及断点切换时复位。 */
(function () {
  var drawers = document.querySelectorAll('.nav-drawer');
  if (!drawers.length) return;

  var wide = window.matchMedia('(min-width: 1025px)');

  function close(drawer, restoreFocus) {
    if (!drawer.open) return;
    drawer.open = false;
    if (restoreFocus) {
      var summary = drawer.querySelector('summary');
      if (summary) summary.focus();
    }
  }

  // 桌面端链接直接平铺在头部；窄屏保持收起，等待用户点开。
  function sync() {
    drawers.forEach(function (drawer) { drawer.open = wide.matches; });
  }
  sync();

  document.addEventListener('click', function (e) {
    if (wide.matches) return;
    drawers.forEach(function (drawer) {
      if (!drawer.contains(e.target)) close(drawer, false);
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || wide.matches) return;
    drawers.forEach(function (drawer) { close(drawer, true); });
  });

  if (wide.addEventListener) wide.addEventListener('change', sync);
  else wide.addListener(sync); // 旧版 Safari
})();
