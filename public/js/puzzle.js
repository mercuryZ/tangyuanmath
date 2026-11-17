/* 每周趣题组件：填空作答 + 小星星奖励（不进 learn.js，仅趣题页加载）
 *
 * 页面声明方式（与 learn.js 的 data-widget 模式一致，文案全部来自 data-config，
 * 中英页面各写各的，无需构建步骤；JSON 里撇号用 ’，避免打碎属性引号）：
 *
 *   <div data-widget="puzzle-answer" data-config='{
 *     "puzzleId":"chicken-rabbit",
 *     "formTitle":"输入你的答案",
 *     "inputs":[{"label":"鸡（只）","answer":7},{"label":"兔（只）","answer":5}],
 *     "checkText":"检查答案",
 *     "retryText":"还没有全对，再想一想。可以点开上面的提示看看。",
 *     "successText":"答对啦！这颗小星星送给你！",
 *     "againText":"这道题你已经点亮过小星星啦。",
 *     "reveal":"answer-solution"
 *   }'></div>
 *
 *   <div data-widget="puzzle-stars" data-config='{
 *     "text":"已收集","unit":"颗星","zeroText":"还没有小星星，答对一道趣题就能点亮第一颗！"
 *   }'></div>
 *
 * 星星记录在 localStorage（key: tm_puzzle_stars，值为 puzzleId 数组），只存在
 * 孩子自己的浏览器里——与全站「数据留在本地」的隐私口径一致。
 */
(function () {
  'use strict';

  var STAR_KEY = 'tm_puzzle_stars';

  function loadStars() {
    try {
      var raw = JSON.parse(localStorage.getItem(STAR_KEY));
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }

  function saveStar(id) {
    var list = loadStars();
    if (list.indexOf(id) !== -1) return;
    list.push(id);
    try { localStorage.setItem(STAR_KEY, JSON.stringify(list)); } catch (e) { /* 隐私模式等：静默跳过 */ }
  }

  /* 手绘五角星（viewBox 0 0 256 256，随 currentColor 上色），不改动全站图标 sprite */
  var STAR_SVG =
    '<svg class="pz-star" viewBox="0 0 256 256" aria-hidden="true">' +
    '<polygon fill="currentColor" stroke="currentColor" stroke-width="10" stroke-linejoin="round" ' +
    'points="128,24 154,92 227,96 170,142 189,212 128,172 67,212 86,142 29,96 102,92"/></svg>';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toNumber(v) {
    var s = String(v).trim().replace(/^[+　\s]+/, '');
    if (s === '') return NaN;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  /* ---------- puzzle-answer：填空验证 ---------- */
  function renderAnswer(host, cfg) {
    var uid = 'pz-' + Math.random().toString(36).slice(2, 8);
    var inputs = Array.isArray(cfg.inputs) ? cfg.inputs : [];
    var fieldsHtml = inputs.map(function (f, i) {
      return '<div class="pz-field">' +
        '<label for="' + uid + '-' + i + '">' + esc(f.label) + '</label>' +
        '<input id="' + uid + '-' + i + '" type="text" inputmode="numeric" autocomplete="off">' +
        '</div>';
    }).join('');

    host.innerHTML =
      '<form class="pz-form" novalidate>' +
      (cfg.formTitle ? '<p class="pz-form-title">' + esc(cfg.formTitle) + '</p>' : '') +
      '<div class="pz-fields">' + fieldsHtml + '</div>' +
      '<div class="pz-actions">' +
      '<button type="submit" class="btn btn-primary">' + esc(cfg.checkText || 'OK') + '</button>' +
      '<p class="pz-feedback" aria-live="polite"></p>' +
      '</div>' +
      '</form>';

    var form = host.querySelector('form');
    var fields = host.querySelectorAll('.pz-field input');
    var actions = host.querySelector('.pz-actions');
    var feedback = host.querySelector('.pz-feedback');
    var solved = false;

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (solved) return;

      var allOk = true;
      inputs.forEach(function (f, i) {
        var ok = toNumber(fields[i].value) === Number(f.answer);
        fields[i].classList.toggle('pz-no', !ok);
        if (!ok) allOk = false;
      });

      if (!allOk) {
        feedback.textContent = cfg.retryText || '再想一想！';
        return;
      }

      /* 全对：点亮小星星、庆祝、自动展开完整解析 */
      solved = true;
      fields.forEach(function (f) { f.disabled = true; f.classList.remove('pz-no'); });
      if (cfg.puzzleId) saveStar(cfg.puzzleId);
      actions.innerHTML =
        '<div class="pz-success">' +
        '<span class="pz-star-wrap">' + STAR_SVG + '</span>' +
        '<span>' + esc(cfg.successText || '答对啦！') + '</span>' +
        '</div>';
      if (cfg.reveal) {
        var box = document.getElementById(cfg.reveal);
        if (box) box.open = true;
      }
    });

    /* 之前答对过：温和地告知星星已点亮，但仍可重新验证（弟弟妹妹可再玩） */
    if (cfg.puzzleId && loadStars().indexOf(cfg.puzzleId) !== -1) {
      feedback.textContent = cfg.againText || '';
    }
  }

  /* ---------- puzzle-stars：栏目页的集星徽章 ---------- */
  function renderStars(host, cfg) {
    var n = loadStars().length;
    if (n > 0) {
      host.innerHTML =
        '<span class="pz-stars-badge">' +
        '<span class="pz-star-wrap">' + STAR_SVG + '</span>' +
        '<span>' + esc(cfg.text || '') + ' <b>' + n + '</b> ' + esc(cfg.unit || '') + '</span>' +
        '</span>';
    } else {
      host.innerHTML = '<span class="pz-stars-badge">' + esc(cfg.zeroText || '') + '</span>';
    }
  }

  /* ---------- 扫描 data-widget（与 learn.js 同一套声明式约定） ---------- */
  function mount(root) {
    var nodes = (root || document).querySelectorAll('[data-widget]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.dataset.pzMounted) continue;
      var kind = el.getAttribute('data-widget');
      var cfg = {};
      try { cfg = JSON.parse(el.getAttribute('data-config') || '{}'); } catch (e) { /* 配置坏了解析为空 */ }
      if (kind === 'puzzle-answer') { renderAnswer(el, cfg); el.dataset.pzMounted = '1'; }
      if (kind === 'puzzle-stars') { renderStars(el, cfg); el.dataset.pzMounted = '1'; }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(document); });
  } else {
    mount(document);
  }
})();
