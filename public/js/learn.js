/* Tangyuan Math — 乘法启蒙课（Learn course）互动组件
 * 课程页（/en/learn/）共用，页面以 data-widget="名称" + data-config='{...}' 声明：
 *   groups-builder  分组器（第 1 课：几组几 = 连加 = 乘法）
 *   array-play      点阵生成器（第 2/4 课：行×列，可旋转看交换律）
 *   number-line-hops 数轴跳格（第 3 课：跳着数）
 *   nines-frame     九的十帧（第 6 课：×9 = ×10 减一组）
 *   array-splitter  数组切分（第 7 课：拆一拆）
 *   table-crosser   乘法表盘点（第 8 课：划掉已知，数数还剩几个）
 *   quick-check     小考验（点选题，温和反馈、不计时不打分，DESIGN 2.3）
 *   course-progress 课程主页进度渲染（卡片打勾 + 继续学习按钮）
 * 文案全部来自各页面 data-config（不进 locales 包），中文镜像页自带中文文案。
 * UMD：浏览器挂 window.TMLearn；纯计算函数与进度存储在 Node 供 tests/learn.test.js require。
 */
(function (global) {
  'use strict';

  var PROGRESS_KEY = 'tm_learn_progress';

  /* ---------- 进度存储 ---------- */

  function safeStorage() {
    try {
      var s = global.localStorage;
      var k = '__tm_learn_probe__';
      s.setItem(k, '1');
      s.removeItem(k);
      return s;
    } catch (e) { // 隐私模式等：退回内存对象，本次会话内仍可用
      var mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  }

  function loadProgress(storage) {
    var out = {};
    try {
      var raw = JSON.parse(storage.getItem(PROGRESS_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach(function (k) {
          if (typeof raw[k] === 'string') out[k] = raw[k];
        });
      }
    } catch (e) { /* 损坏数据当作空进度 */ }
    return out;
  }

  function saveProgress(map, storage) {
    try { storage.setItem(PROGRESS_KEY, JSON.stringify(map)); } catch (e) { /* 忽略 */ }
  }

  function toggleDone(map, slug) {
    var next = {};
    Object.keys(map).forEach(function (k) { next[k] = map[k]; });
    if (next[slug]) delete next[slug];
    else next[slug] = new Date().toISOString();
    return next;
  }

  function completedCount(map) { return Object.keys(map).length; }

  function nextLesson(order, map) {
    for (var i = 0; i < order.length; i++) {
      if (!map[order[i]]) return order[i];
    }
    return null;
  }

  /* ---------- 纯计算（供测试） ---------- */

  function intIn(v, lo, hi) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= lo && v <= hi;
  }

  /* 第 1 课：groups 组、每组 size 个 → 连加算式与总数 */
  function groupsMath(groups, size) {
    if (!intIn(groups, 0, 12) || !intIn(size, 1, 12)) return null;
    var terms = [];
    for (var i = 0; i < groups; i++) terms.push(size);
    return { groups: groups, size: size, terms: terms, total: groups * size };
  }

  /* 第 2/4 课：rows 行 × cols 列 的点阵 */
  function arrayMath(rows, cols) {
    if (!intIn(rows, 1, 12) || !intIn(cols, 1, 12)) return null;
    return { rows: rows, cols: cols, total: rows * cols };
  }

  /* 第 3 课：按 step 跳 hops 次的落点序列 */
  function hopsMath(step, hops) {
    if (!intIn(step, 1, 10) || !intIn(hops, 0, 12)) return null;
    var landings = [];
    for (var i = 1; i <= hops; i++) landings.push(i * step);
    return { step: step, hops: hops, landings: landings, total: hops * step };
  }

  /* 第 7 课：rows×cols 的数组在第 split 列切开（split ∈ 1..cols-1） */
  function splitEquation(rows, cols, split) {
    if (!intIn(rows, 1, 12) || !intIn(cols, 2, 12) || !intIn(split, 1, cols - 1)) return null;
    return {
      rows: rows, cols: cols, split: split,
      leftCols: split, rightCols: cols - split,
      left: rows * split, right: rows * (cols - split), total: rows * cols
    };
  }

  /* 第 6 课：n×9 = n×10 − n；积的十位是 n−1、个位是 10−n（n ∈ 1..10） */
  function ninesBreakdown(n) {
    if (!intIn(n, 1, 10)) return null;
    return {
      n: n, tenTimes: n * 10, product: n * 9,
      tensDigit: n - 1, onesDigit: 10 - n
    };
  }

  /* 第 8 课：乘法表盘点。
   * applied 是 ['x1','x2','x4','x5','x9','x10','swap'] 的子集：
   *   xN —— 该因子整行/列已掌握（×1 是自身、×10 加个零、×2 翻倍、×4 翻倍再翻倍、
   *          ×5 五五跳数、×9 第 6 课的窍门）
   *   swap —— 交换律：下三角（b<a）与上三角孪生，免费
   * 返回：considered 计入的格子数、crossedCount 已划掉数、remaining 剩下要真记的算式列表。 */
  var CROSSOUT_RULES = ['x1', 'x2', 'x4', 'x5', 'x9', 'x10', 'swap'];

  function crossoutCounts(applied, size) {
    size = intIn(size, 2, 12) ? size : 10;
    var set = Object.create(null);
    (applied || []).forEach(function (r) { set[r] = true; });

    function crossed(a, b) {
      if (set.x1 && (a === 1 || b === 1)) return true;
      if (set.x2 && (a === 2 || b === 2)) return true;
      if (set.x4 && (a === 4 || b === 4)) return true;
      if (set.x5 && (a === 5 || b === 5)) return true;
      if (set.x9 && (a === 9 || b === 9)) return true;
      if (set.x10 && (a === size || b === size)) return true;
      return false;
    }

    var considered = 0, crossedCount = 0, remaining = [];
    for (var a = 1; a <= size; a++) {
      for (var b = 1; b <= size; b++) {
        if (set.swap && b < a) continue; // 交换律：只数上三角
        considered++;
        if (crossed(a, b)) crossedCount++;
        else remaining.push({ a: a, b: b });
      }
    }
    return {
      considered: considered, crossedCount: crossedCount,
      remainingCount: remaining.length, remaining: remaining
    };
  }

  /* 小模板：fmt('{g} groups of {s}', {g:3, s:4}) */
  function fmt(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] === undefined ? '' : vars[k];
    });
  }

  /* ---------- DOM 组件（浏览器端） ---------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function eqLine(text, sub) {
    var box = el('div', 'lw-eq');
    box.appendChild(el('div', null, text));
    if (sub) box.appendChild(el('div', 'lw-sub', sub));
    return box;
  }

  /* 分组器 */
  function renderGroupsBuilder(root, cfg) {
    var size = cfg.size || 4;
    var max = cfg.max || 6;
    var groups = 0;
    var body = el('div', 'lw-groups');
    var msg = el('div', 'lw-msg');
    var eq = el('div');

    function draw() {
      body.innerHTML = '';
      for (var g = 0; g < groups; g++) {
        var plate = el('span', 'lw-plate');
        for (var i = 0; i < size; i++) {
          var img = el('img');
          img.src = cfg.img || '/img/tangyuan_small.png';
          img.alt = '';
          plate.appendChild(img);
        }
        body.appendChild(plate);
      }
      eq.innerHTML = '';
      if (groups === 0) {
        msg.textContent = cfg.s.empty;
      } else {
        msg.textContent = '';
        var m = groupsMath(groups, size);
        var sum = m.terms.join(' + ') + ' = ' + m.total;
        eq.appendChild(eqLine(sum, fmt(cfg.s.groupsOf, { g: groups, s: size })));
        eq.appendChild(eqLine(fmt(cfg.s.mult, { g: groups, s: size, t: m.total })));
      }
    }

    var minus = el('button', 'lw-btn');
    minus.type = 'button';
    minus.textContent = cfg.s.remove;
    var plus = el('button', 'lw-btn');
    plus.type = 'button';
    plus.textContent = cfg.s.add;
    minus.addEventListener('click', function () { if (groups > 0) { groups--; draw(); } });
    plus.addEventListener('click', function () { if (groups < max) { groups++; draw(); } });

    var controls = el('div', 'lw-controls');
    controls.appendChild(minus);
    controls.appendChild(plus);
    root.appendChild(controls);
    root.appendChild(body);
    root.appendChild(msg);
    root.appendChild(eq);
    draw();
  }

  /* 点阵生成器（可选旋转） */
  function renderArrayPlay(root, cfg) {
    var min = cfg.min || 1, max = cfg.max || 10;
    var rows = cfg.rows || 3, cols = cfg.cols || 4;
    var grid = el('div', 'lw-array');
    var eq = el('div');
    var valueLabels = []; // stepper 的「行/列 值」标签，draw 时统一刷新

    function draw(rotatedNote) {
      var m = arrayMath(rows, cols);
      grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
      grid.innerHTML = '';
      for (var i = 0; i < m.total; i++) grid.appendChild(el('span', 'lw-dot'));
      eq.innerHTML = '';
      eq.appendChild(eqLine(
        fmt(cfg.s.eq, { r: rows, c: cols, t: m.total }),
        rotatedNote || fmt(cfg.s.hint, { r: rows, c: cols })
      ));
      valueLabels.forEach(function (v) { v(); });
      buttons.forEach(function (b) { b.sync(); });
    }

    var buttons = [];
    function stepper(label, get, set) {
      var box = el('span', 'lw-stepper');
      var dec = el('button', 'lw-btn lw-btn-sm');
      dec.type = 'button';
      dec.textContent = '−';
      dec.setAttribute('aria-label', fmt(cfg.s.less, { w: label }));
      var val = el('b');
      valueLabels.push(function () { val.textContent = label + ' ' + get(); });
      var inc = el('button', 'lw-btn lw-btn-sm');
      inc.type = 'button';
      inc.textContent = '+';
      inc.setAttribute('aria-label', fmt(cfg.s.more, { w: label }));
      dec.addEventListener('click', function () { if (get() > min) { set(get() - 1); draw(); } });
      inc.addEventListener('click', function () { if (get() < max) { set(get() + 1); draw(); } });
      box.appendChild(dec); box.appendChild(val); box.appendChild(inc);
      return { box: box, sync: function () { dec.disabled = get() <= min; inc.disabled = get() >= max; } };
    }

    var rStep = stepper(cfg.s.rowsWord, function () { return rows; }, function (v) { rows = v; });
    var cStep = stepper(cfg.s.colsWord, function () { return cols; }, function (v) { cols = v; });
    buttons.push(rStep, cStep);

    var controls = el('div', 'lw-controls');
    controls.appendChild(rStep.box);
    controls.appendChild(cStep.box);
    if (cfg.rotate) {
      var rot = el('button', 'lw-btn');
      rot.type = 'button';
      rot.textContent = cfg.s.rotate;
      rot.addEventListener('click', function () {
        var tmp = rows; rows = cols; cols = tmp;
        draw(cfg.s.rotatedNote);
      });
      controls.appendChild(rot);
    }

    root.appendChild(controls);
    root.appendChild(grid);
    root.appendChild(eq);
    draw();
  }

  /* 数轴跳格 */
  function renderNumberLineHops(root, cfg) {
    var steps = cfg.steps || [2, 3, 5, 10];
    var maxHops = cfg.maxHops || 10;
    var step = steps[0], hops = 0;

    var pick = el('div', 'lw-controls');
    steps.forEach(function (st) {
      var b = el('button', 'lw-btn lw-btn-sm');
      b.type = 'button';
      b.textContent = fmt(cfg.s.stepBtn, { n: st });
      b.setAttribute('aria-pressed', st === step ? 'true' : 'false');
      b.addEventListener('click', function () {
        step = st; hops = 0;
        pick.querySelectorAll('button').forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        draw();
      });
      pick.appendChild(b);
    });

    var track = el('div', 'lw-numline');
    var hopper = el('span', 'lw-hopper');
    var hopperImg = el('img');
    hopperImg.src = cfg.img || '/img/happy.png';
    hopperImg.alt = '';
    hopper.appendChild(hopperImg);
    var eq = el('div');
    var msg = el('div', 'lw-msg');

    var hopBtn = el('button', 'lw-btn');
    hopBtn.type = 'button';
    hopBtn.textContent = cfg.s.hop;
    var resetBtn = el('button', 'lw-btn');
    resetBtn.type = 'button';
    resetBtn.textContent = cfg.s.reset;

    hopBtn.addEventListener('click', function () {
      if (hops < maxHops) { hops++; draw(); }
    });
    resetBtn.addEventListener('click', function () { hops = 0; draw(); });

    function draw() {
      var m = hopsMath(step, hops);
      var end = step * maxHops;
      track.innerHTML = '';
      for (var k = 0; k <= maxHops; k++) {
        var pos = (k / maxHops) * 100;
        var tick = el('span', 'lw-tick' + (k <= hops ? ' hit' : ''));
        tick.style.left = pos + '%';
        tick.appendChild(el('i'));
        tick.appendChild(el('span', null, String(k * step)));
        track.appendChild(tick);
      }
      track.appendChild(hopper);
      hopper.style.left = (hops === 0 ? 0 : (hops / maxHops) * 100) + '%';
      eq.innerHTML = '';
      eq.appendChild(eqLine(
        hops === 0 ? cfg.s.ready : fmt(cfg.s.sentence, { h: hops, st: step, t: m.total })
      ));
      hopBtn.disabled = hops >= maxHops;
      msg.textContent = hops >= maxHops ? cfg.s.full : '';
    }

    var controls = el('div', 'lw-controls');
    controls.appendChild(hopBtn);
    controls.appendChild(resetBtn);
    root.appendChild(pick);
    root.appendChild(track);
    root.appendChild(controls);
    root.appendChild(eq);
    root.appendChild(msg);
    draw();
  }

  /* 九的十帧：n 行十个，每行末尾缺一个 */
  function renderNinesFrame(root, cfg) {
    var n = cfg.n || 3;
    var frame = el('div', 'lw-nines');
    var eq = el('div');

    var pick = el('div', 'lw-controls');
    for (var i = 1; i <= 10; i++) {
      (function (i2) {
        var b = el('button', 'lw-btn lw-btn-sm');
        b.type = 'button';
        b.textContent = String(i2);
        b.setAttribute('aria-pressed', i2 === n ? 'true' : 'false');
        b.addEventListener('click', function () {
          n = i2;
          pick.querySelectorAll('button').forEach(function (x) {
            x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
          });
          draw();
        });
        pick.appendChild(b);
      })(i);
    }

    function draw() {
      var m = ninesBreakdown(n);
      frame.innerHTML = '';
      frame.style.gridTemplateColumns = 'repeat(10, 1fr)';
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < 10; c++) {
          frame.appendChild(el('span', 'lw-dot' + (c === 9 ? ' miss' : '')));
        }
      }
      eq.innerHTML = '';
      eq.appendChild(eqLine(
        fmt(cfg.s.eq, { n: n, tt: m.tenTimes, p: m.product }),
        fmt(cfg.s.digit, { d1: m.tensDigit, d2: m.onesDigit })
      ));
    }

    root.appendChild(pick);
    root.appendChild(frame);
    root.appendChild(eq);
    draw();
  }

  /* 数组切分 */
  function renderArraySplitter(root, cfg) {
    var rows = cfg.rows || 7, cols = cfg.cols || 8;
    var split = Math.floor(cols / 2);
    var grid = el('div', 'lw-array');
    var eq = el('div');
    var slider = el('input', 'lw-slider');
    slider.type = 'range';
    slider.min = 1;
    slider.max = cols - 1;
    slider.value = split;
    slider.setAttribute('aria-label', cfg.s.sliderLabel);

    function draw() {
      split = Number(slider.value);
      var m = splitEquation(rows, cols, split);
      grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
      grid.innerHTML = '';
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          grid.appendChild(el('span', 'lw-dot' + (c < split ? ' a' : ' b')));
        }
      }
      eq.innerHTML = '';
      eq.appendChild(eqLine(
        fmt(cfg.s.eq, {
          r: rows, c: cols, lc: m.leftCols, rc: m.rightCols,
          l: m.left, rr: m.right, t: m.total
        }),
        fmt(cfg.s.hint, { r: rows })
      ));
    }

    slider.addEventListener('input', draw);
    var controls = el('div', 'lw-controls');
    controls.appendChild(slider);
    root.appendChild(controls);
    root.appendChild(grid);
    root.appendChild(eq);
    draw();
  }

  /* 乘法表盘点 */
  function renderTableCrosser(root, cfg) {
    var size = cfg.size || 10;
    var applied = [];
    var wrap = el('div', 'lw-table-wrap');
    var table = el('div', 'lw-table');
    var counter = el('div', 'lw-counter');

    var buttons = {};
    var bar = el('div', 'lw-controls');
    cfg.rules.forEach(function (rule) {
      var b = el('button', 'lw-btn lw-btn-sm');
      b.type = 'button';
      b.textContent = rule.label;
      b.title = rule.tip || '';
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () {
        var i = applied.indexOf(rule.key);
        if (i === -1) applied.push(rule.key); else applied.splice(i, 1);
        b.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
        draw();
      });
      buttons[rule.key] = b;
      bar.appendChild(b);
    });

    function draw() {
      var set = Object.create(null);
      applied.forEach(function (k) { set[k] = true; });
      var counts = crossoutCounts(applied, size);
      function crossed(a, b) {
        if (set.x1 && (a === 1 || b === 1)) return true;
        if (set.x2 && (a === 2 || b === 2)) return true;
        if (set.x4 && (a === 4 || b === 4)) return true;
        if (set.x5 && (a === 5 || b === 5)) return true;
        if (set.x9 && (a === 9 || b === 9)) return true;
        if (set.x10 && (a === size || b === size)) return true;
        return false;
      }
      table.innerHTML = '';
      table.style.gridTemplateColumns = 'auto repeat(' + size + ', 1fr)';
      table.appendChild(el('span', 'lw-cell head'));
      for (var h = 1; h <= size; h++) table.appendChild(el('span', 'lw-cell head', String(h)));
      for (var a = 1; a <= size; a++) {
        table.appendChild(el('span', 'lw-cell head', String(a)));
        for (var b = 1; b <= size; b++) {
          var twin = set.swap && b < a;
          var cls = 'lw-cell';
          if (twin) cls += ' twin';
          else if (crossed(a, b)) cls += ' crossed';
          table.appendChild(el('span', cls, String(a * b)));
        }
      }
      counter.innerHTML = '';
      counter.appendChild(el('span', null, fmt(cfg.s.remaining, { n: counts.remainingCount })));
      if (counts.remainingCount === cfg.goalN) {
        counter.appendChild(el('b', null, ' ' + cfg.s.goal));
      }
    }

    root.appendChild(bar);
    wrap.appendChild(table);
    root.appendChild(wrap);
    root.appendChild(counter);
    draw();
  }

  /* 小考验 */
  function renderQuickCheck(root, cfg) {
    cfg.questions.forEach(function (q) {
      var box = el('div', 'lw-quiz');
      box.appendChild(el('p', 'lw-quiz-q', q.q));
      var opts = el('div', 'lw-quiz-opts');
      var why = el('p', 'lw-why');
      why.innerHTML = q.why || ''; // 内容为课程页面自带，允许 <i>/<b> 等简单强调
      why.hidden = true;
      var solved = false;
      q.options.forEach(function (opt, idx) {
        var b = el('button', 'lw-opt');
        b.type = 'button';
        b.textContent = opt;
        b.addEventListener('click', function () {
          if (solved) return;
          if (idx === q.answer) {
            solved = true;
            b.classList.add('ok');
            why.hidden = false;
            opts.querySelectorAll('button').forEach(function (x) { x.disabled = x !== b; });
          } else {
            b.classList.add('no');
            global.setTimeout(function () { b.classList.remove('no'); }, 500);
          }
        });
        opts.appendChild(b);
      });
      box.appendChild(opts);
      box.appendChild(why);
      root.appendChild(box);
    });
  }

  /* 课程主页进度 */
  function renderCourseProgress(root, cfg, api) {
    var order = cfg.entries.map(function (e) { return e.slug; });
    cfg.entries.forEach(function (e) {
      var card = document.querySelector('[data-lesson-card="' + e.slug + '"]');
      if (card && api.progress[e.slug]) card.classList.add('done');
    });
    var cta = document.getElementById(cfg.ctaId);
    var next = nextLesson(order, api.progress);
    if (cta) {
      if (!next) {
        cta.textContent = cfg.s.allDone;
        if (cfg.playUrl) cta.setAttribute('href', cfg.playUrl);
      } else {
        var idx = order.indexOf(next);
        var entry = cfg.entries[idx];
        cta.textContent = idx === 0 ? cfg.s.start : fmt(cfg.s.continue, { n: idx + 1 });
        cta.setAttribute('href', entry.url);
      }
    }
    var fill = document.getElementById(cfg.barId);
    var text = document.getElementById(cfg.textId);
    var done = order.filter(function (s) { return api.progress[s]; }).length;
    if (fill) fill.style.width = (done / order.length * 100) + '%';
    if (text) text.textContent = fmt(cfg.s.progressLabel, { d: done, t: order.length });
  }

  var RENDERERS = {
    'groups-builder': renderGroupsBuilder,
    'array-play': renderArrayPlay,
    'number-line-hops': renderNumberLineHops,
    'nines-frame': renderNinesFrame,
    'array-splitter': renderArraySplitter,
    'table-crosser': renderTableCrosser,
    'quick-check': renderQuickCheck
  };

  function init() {
    var api = { storage: safeStorage() };
    api.progress = loadProgress(api.storage);

    document.querySelectorAll('[data-widget]').forEach(function (node) {
      var name = node.getAttribute('data-widget');
      var cfg;
      try { cfg = JSON.parse(node.getAttribute('data-config') || '{}'); }
      catch (e) { cfg = {}; }
      try {
        if (RENDERERS[name]) RENDERERS[name](node, cfg);
        else if (name === 'course-progress') renderCourseProgress(node, cfg, api);
      } catch (e) {
        // 单个组件失败不影响其余内容
        if (global.console) console.warn('learn widget failed:', name, e);
      }
    });
  }

  var api = {
    PROGRESS_KEY: PROGRESS_KEY,
    loadProgress: loadProgress,
    saveProgress: saveProgress,
    toggleDone: toggleDone,
    completedCount: completedCount,
    nextLesson: nextLesson,
    groupsMath: groupsMath,
    arrayMath: arrayMath,
    hopsMath: hopsMath,
    splitEquation: splitEquation,
    ninesBreakdown: ninesBreakdown,
    CROSSOUT_RULES: CROSSOUT_RULES,
    crossoutCounts: crossoutCounts,
    fmt: fmt,
    init: init
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TMLearn = api;
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
