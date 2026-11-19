/* 练习落地页（/en/practice/times-tables/）的课程范围预设。
 * 课程/单表页带 ?amin=…&amax=…&bmin=…&bmax=… 到达时，把「开始练习」按钮指向
 * 预选好范围的 /play/ 深链（hash 只承载游戏交互状态）。CSP 禁止内联脚本，故独立成文件。 */
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  if (qs.get('amin') === null) return;
  function num(k, d) {
    var v = Number(qs.get(k));
    return Number.isInteger(v) && v >= 1 && v <= 99 ? v : d;
  }
  var a = [num('amin', 1), num('amax', 10)], b = [num('bmin', 1), num('bmax', 10)];
  if (a[0] > a[1]) a = [a[1], a[0]];
  if (b[0] > b[1]) b = [b[1], b[0]];
  var start = document.getElementById('practiceStart');
  if (start) start.href = '/play/#/setup?amin=' + a[0] + '&amax=' + a[1] + '&bmin=' + b[0] + '&bmax=' + b[1];
  var note = document.getElementById('presetNote');
  if (note) note.hidden = false;
})();
