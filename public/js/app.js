/* Tangyuan Math — 应用 UI 层（视图路由 / 首页 / 设置 / 统计 / 弹窗与焦点管理）
 * 无障碍（DESIGN 2.5）：弹窗打开时移入焦点、关闭后返回触发按钮、Esc 可关；
 * 手动「减少动画」与系统 prefers-reduced-motion 双通道。
 */
(function (global) {
  'use strict';

  function t(key, vars) { return global.TMI18N.t(key, vars); }
  function $(id) { return document.getElementById(id); }

  /* 语言注册表：新增语言时在此加一项，并在 i18n.js 的 SUPPORTED 与 locales/ 中登记。
     语言名使用该语言自身的写法（endonym），方便用户找到自己的语言。 */
  var LANGS = [
    { code: 'en', short: 'EN', label: 'English' },
    { code: 'zh', short: '中文', label: '中文' }
  ];

  /* ---------- 设置存储 ---------- */
  var SETTINGS_KEY = 'tm_settings';
  var settings = { difficulty: 'times_tables_10', count: 10, stopwatch: false, reduceMotion: null };
  try {
    var raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch (e) { /* 忽略 */ }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
  }

  function systemReducesMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function reduceMotion() {
    return settings.reduceMotion === null ? systemReducesMotion() : !!settings.reduceMotion;
  }
  function applyMotion() {
    document.documentElement.classList.toggle('reduce-motion', reduceMotion());
  }

  /* ---------- TMUI：供 game.js 调用的界面能力 ---------- */
  var lastFocus = null;
  var confirmOpen = false; // 确认弹窗同一时间只允许一个
  // 确认弹窗默认头像（相对 /play/ 解析），单次调用可用 opts.img 覆盖
  var CONFIRM_AVATAR = '../img/tangyuan_web.png';

  /* 弹窗角标 emoji → Phosphor 图标 id（去 FE0F 变体选择符归一化） */
  var EMOTE_ICONS = { '\u{1F389}': 'ico-confetti', '\u{1F3C6}': 'ico-trophy', '⏰': 'ico-alarm', '\u{1F914}': 'ico-question', '⚠': 'ico-warning' };
  function emoteHtml(em) {
    var key = String(em || '').replace(/️/g, '');
    return '<svg class="ico" aria-hidden="true"><use href="#' + (EMOTE_ICONS[key] || 'ico-question') + '"/></svg>';
  }

  function openOverlay(ov) {
    lastFocus = document.activeElement;
    ov.classList.add('show');
    // 焦点落在关闭/主按钮上，避免误触第一个功能按钮（如语言切换）
    var btn = ov.querySelector('.btn') || ov.querySelector('button');
    if (btn) btn.focus();
  }
  function closeOverlay(ov) {
    ov.classList.remove('show');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  var TMUI = {
    showView: function (name) {
      document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
      var el = $('view-' + name);
      if (el) el.classList.add('active');
      if (location.hash !== '#/' + name) {
        try { history.replaceState(null, '', '#/' + name); } catch (e) { /* file:// 下可能异常 */ }
      }
      window.scrollTo(0, 0);
    },
    currentView: function () {
      var el = document.querySelector('.view.active');
      return el ? el.id.replace('view-', '') : null;
    },
    toast: function (msg, isErr) {
      var el = $('toast');
      el.textContent = msg;
      el.className = 'toast show' + (isErr ? ' err' : '');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { el.className = 'toast' + (isErr ? ' err' : ''); }, 1800);
    },
    /* 确认弹窗：站内风格（原生 confirm 样式与整站不一致），返回 Promise<boolean>
     * opts: { title, okLabel, cancelLabel, emote, img, danger } */
    confirm: function (msg, opts) {
      opts = opts || {};
      if (confirmOpen) return Promise.resolve(false); // 同一时间只允许一个确认框
      return new Promise(function (resolve) {
        var ov = $('confirmOverlay');
        var ok = $('confirmOkBtn');
        var cancel = $('confirmCancelBtn');
        confirmOpen = true;

        $('confirmTitle').textContent = opts.title || t('common.confirmTitle');
        $('confirmMsg').textContent = msg;
        $('confirmAvatar').src = opts.img || CONFIRM_AVATAR;
        $('confirmEmote').innerHTML = emoteHtml(opts.emote || '🤔');
        ok.textContent = opts.okLabel || t('common.confirm');
        ok.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
        cancel.textContent = opts.cancelLabel || t('common.cancel');

        var settle = function (result) {
          confirmOpen = false;
          ov.removeEventListener('click', onOverlay);
          document.removeEventListener('keydown', onKey);
          ok.removeEventListener('click', onOk);
          cancel.removeEventListener('click', onCancel);
          closeOverlay(ov);
          resolve(result);
        };
        var onOk = function () { settle(true); };
        var onCancel = function () { settle(false); };
        var onOverlay = function (e) { if (e.target === ov) settle(false); }; // 点遮罩 = 取消
        var onKey = function (e) {
          if (e.key !== 'Escape') return;
          e.stopPropagation(); // 拦在 document 上：同一次 Esc 不再触发下层弹窗的关闭
          settle(false);
        };

        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
        ov.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onKey);

        openOverlay(ov); // 焦点默认落在「取消」上，避免误触确认
      });
    },
    reduceMotion: reduceMotion,
    confetti: function () {
      if (reduceMotion()) return;
      var symbols = ['♥', '✿', '★', '✦'];
      var colors = ['#F2555A', '#FF8A8E', '#F5A623', '#FFC2CC'];
      for (var i = 0; i < 32; i++) {
        var el = document.createElement('div');
        el.className = 'confetti';
        el.textContent = symbols[Math.floor(Math.random() * symbols.length)];
        el.style.left = Math.random() * 100 + '%';
        el.style.color = colors[Math.floor(Math.random() * colors.length)];
        el.style.fontSize = (12 + Math.random() * 14) + 'px';
        el.style.animationDuration = (2.2 + Math.random() * 1.6) + 's';
        el.style.animationDelay = (Math.random() * .5) + 's';
        document.body.appendChild(el);
        setTimeout(function (n) { return function () { n.remove(); }; }(el), 4800);
      }
    },
    showResult: function (opts) {
      $('resultEmote').innerHTML = emoteHtml(opts.emote);
      $('resultTitle').textContent = opts.title;
      $('resultSub').textContent = opts.sub;
      var box = $('resultStats');
      box.innerHTML = '';
      opts.stats.forEach(function (s) {
        var d = document.createElement('div');
        d.className = 'stat ' + s.cls;
        d.innerHTML = '<div class="num">' + s.num + '</div><div class="lbl">' + s.lbl + '</div>';
        box.appendChild(d);
      });
      var main = $('resultMainBtn');
      main.textContent = opts.mainLabel;
      main.onclick = function () {
        closeOverlay($('resultOverlay'));
        opts.onMain();
      };
      openOverlay($('resultOverlay'));
      main.focus();
    },
    refreshHome: refreshHome
  };
  global.TMUI = TMUI;

  /* ---------- 首页刷新（错题入口状态 / 挑战进度） ---------- */
  function refreshHome() {
    var book = TMRecords.load(null, TMRecords.KEYS.wrongbook);
    var card = $('cardMistakes');
    card.disabled = book.length === 0;
    $('mistakesDesc').textContent = book.length === 0
      ? t('home.mistakes.emptyDesc')
      : t('home.mistakes.descN', { n: book.length });
    var lvl = TMGame.getChallengeLevel();
    $('challengeCta').textContent = lvl > 1
      ? t('home.challenge.ctaLevel', { level: lvl })
      : t('home.challenge.cta');

    // 云端模式：错题本以服务端为准，异步覆盖显示（DESIGN M1）
    var api = global.TMAPI;
    if (api && api.isPlayer() && api.state.currentProfileId) {
      api.getWrongbook().then(function (r) {
        if (!r.ok) return;
        var n = r.data.items.length;
        var cardEl = $('cardMistakes');
        cardEl.disabled = n === 0;
        $('mistakesDesc').textContent = n === 0
          ? t('home.mistakes.emptyDesc')
          : t('home.mistakes.descN', { n: n });
      });
    }
  }

  /* ---------- Practice 设置表单 ---------- */
  var DIFFS = ['times_tables_10', 'times_tables_12', 'two_by_one', 'two_by_two'];
  var COUNTS = [5, 10, 20];

  /* Learn 课程深链：/play/#/setup?amin=2&amax=5&bmin=2&bmax=5 预选课程对应的练习范围。
   * 范围都在 1–10 内，记录口径仍按 times_tables_10 上报，服务端白名单无需改动。 */
  var LESSON_DIFF = '__lesson__';
  var pendingRange = null;
  function parseLessonRange(query) {
    var qs = new URLSearchParams(query);
    function num(key, dflt) {
      var v = Number(qs.get(key));
      return Number.isInteger(v) && v >= 1 && v <= 99 ? v : dflt;
    }
    var a = [num('amin', 1), num('amax', 10)];
    var b = [num('bmin', 1), num('bmax', 10)];
    if (a[0] > a[1]) a = [a[1], a[0]];
    if (b[0] > b[1]) b = [b[1], b[0]];
    return { a: a, b: b };
  }
  function rangeLabel(r) {
    var f = function (p) { return p[0] === p[1] ? String(p[0]) : p[0] + '–' + p[1]; };
    return f(r.a) + ' × ' + f(r.b);
  }

  function renderSetup() {
    var dBox = $('diffOptions');
    dBox.innerHTML = '';
    if (settings.difficulty === LESSON_DIFF && !pendingRange) {
      settings.difficulty = 'times_tables_10'; // 会话里没有课程范围时回退到常规难度
    }
    if (pendingRange) {
      var lb = document.createElement('button');
      lb.type = 'button';
      lb.className = 'opt';
      lb.setAttribute('aria-pressed', settings.difficulty === LESSON_DIFF ? 'true' : 'false');
      lb.innerHTML = t('diff.lesson') + '<small>' + rangeLabel(pendingRange) + '</small>';
      lb.addEventListener('click', function () {
        settings.difficulty = LESSON_DIFF; saveSettings(); renderSetup();
      });
      dBox.appendChild(lb);
    }
    DIFFS.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.setAttribute('aria-pressed', settings.difficulty === d ? 'true' : 'false');
      b.innerHTML = t('diff.' + d) + '<small>' + t('diffdesc.' + d) + '</small>';
      b.addEventListener('click', function () {
        settings.difficulty = d; saveSettings(); renderSetup();
      });
      dBox.appendChild(b);
    });
    var cBox = $('countOptions');
    cBox.innerHTML = '';
    COUNTS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.setAttribute('aria-pressed', settings.count === c ? 'true' : 'false');
      b.textContent = t('setup.countN', { n: c });
      b.addEventListener('click', function () {
        settings.count = c; saveSettings(); renderSetup();
      });
      cBox.appendChild(b);
    });
    $('stopwatchToggle').checked = !!settings.stopwatch;
  }

  /* ---------- 统计视图 ---------- */
  function pct(x) { return x === null ? '—' : Math.round(x * 100) + '%'; }
  function fmtMs(ms) { return ms === null ? '—' : (ms / 1000).toFixed(1) + 's'; }

  function renderStats() {
    var list = TMRecords.load(null, TMRecords.KEYS.records);
    var by = TMRecords.summarize(list);
    var body = $('statsBody');
    body.innerHTML = '';

    var order = ['practice', 'challenge', 'mistakes', 'versus'];
    var names = {
      practice: 'stats.mode.practice', challenge: 'stats.mode.challenge',
      mistakes: 'stats.mode.mistakes', versus: 'stats.mode.versus'
    };
    var shown = 0;
    order.forEach(function (m) {
      var s = by[m];
      if (!s || s.rounds === 0) return;
      shown++;
      var div = document.createElement('div');
      div.className = 'stats-block';
      div.innerHTML =
        '<h3>' + t(names[m]) + '</h3>' +
        '<p class="stats-line">' +
        t('stats.rounds') + ': <b>' + s.rounds + '</b> · ' +
        t('stats.questions') + ': <b>' + s.questions + '</b><br>' +
        t('stats.firstAccuracy') + ': <b>' + pct(s.firstAccuracy) + '</b> · ' +
        t('stats.finalCompletion') + ': <b>' + pct(s.finalCompletion) + '</b> · ' +
        t('stats.avgActive') + ': <b>' + fmtMs(s.avgActiveMs) + '</b>' +
        '</p>';
      body.appendChild(div);
    });
    if (shown === 0) {
      var p = document.createElement('p');
      p.className = 'stats-line';
      p.textContent = t('stats.nodata');
      body.appendChild(p);
    }

    // 错题本
    var book = TMRecords.load(null, TMRecords.KEYS.wrongbook);
    var wb = document.createElement('div');
    wb.className = 'stats-block';
    var head = document.createElement('h3');
    head.textContent = t('stats.wrongbookTitle') + ' (' + book.length + ')';
    wb.appendChild(head);
    if (book.length === 0) {
      var pe = document.createElement('p');
      pe.className = 'stats-line';
      pe.textContent = t('stats.wrongbookEmpty');
      wb.appendChild(pe);
    } else {
      var listEl = document.createElement('div');
      listEl.className = 'wb-list';
      book.slice(0, 30).forEach(function (e) {
        var it = document.createElement('span');
        it.className = 'wb-item';
        it.innerHTML = e.a + ' × ' + e.b + '<span class="wb-n">×' + e.wrong_count + '</span>';
        listEl.appendChild(it);
      });
      wb.appendChild(listEl);
    }
    body.appendChild(wb);
  }

  /* ---------- 秘籍内容 ---------- */
  function renderTips() {
    var box = $('tipsBody');
    box.innerHTML = '';
    for (var i = 1; i <= 6; i++) {
      var d = document.createElement('div');
      d.className = 'g-step';
      d.innerHTML =
        '<h3><span class="no">' + i + '</span>' + t('tips.s' + i + '.title') + '</h3>' +
        '<p>' + t('tips.s' + i + '.body') + '</p>' +
        '<div class="eg">' + t('tips.s' + i + '.eg') + '</div>';
      box.appendChild(d);
    }
  }

  /* ---------- 设置弹窗 ---------- */
  function renderSettings() {
    var lang = TMI18N.lang();
    $('setLangEn').setAttribute('aria-pressed', lang === 'en' ? 'true' : 'false');
    $('setLangZh').setAttribute('aria-pressed', lang === 'zh' ? 'true' : 'false');
    var motionEl = $('motionToggle');
    motionEl.checked = settings.reduceMotion === null ? systemReducesMotion() : settings.reduceMotion;
    var recCount = TMRecords.load(null, TMRecords.KEYS.records).length;
    var bookCount = TMRecords.load(null, TMRecords.KEYS.wrongbook).length;
    $('dataRecordsInfo').textContent = t('settings.dataRecords', { n: recCount });
    $('dataWrongInfo').textContent = t('settings.dataWrong', { n: bookCount });
  }

  /* ---------- 语言切换 ---------- */
  /* 下拉菜单由 LANGS 生成，新增语言只改注册表一处 */
  function renderLangMenu() {
    var box = $('langDropdown');
    if (!box) return;
    box.innerHTML = '';
    LANGS.forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'lang-option';
      b.setAttribute('role', 'option');
      b.setAttribute('data-lang', l.code);
      b.textContent = l.label;
      b.addEventListener('click', function () {
        switchLang(l.code);
        closeLangMenu(true);
      });
      box.appendChild(b);
    });
  }

  function openLangMenu() {
    var dd = $('langDropdown');
    if (!dd) return;
    dd.hidden = false;
    $('langBtn').setAttribute('aria-expanded', 'true');
    var sel = dd.querySelector('.lang-option[aria-selected="true"]') || dd.querySelector('.lang-option');
    if (sel) sel.focus();
  }

  function closeLangMenu(returnFocus) {
    var dd = $('langDropdown');
    if (!dd || dd.hidden) return;
    dd.hidden = true;
    $('langBtn').setAttribute('aria-expanded', 'false');
    if (returnFocus) $('langBtn').focus();
  }

  function syncLangButtons() {
    var lang = TMI18N.lang();
    var current = LANGS.filter(function (l) { return l.code === lang; })[0] || LANGS[0];
    $('langCurrent').textContent = current.short;
    var options = $('langDropdown').querySelectorAll('.lang-option');
    for (var i = 0; i < options.length; i++) {
      var selected = options[i].getAttribute('data-lang') === lang;
      options[i].setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  }
  /* 底部链接跟随当前语言切换 /en/ 与 /zh/ 路径 */
  function syncFooterLinks() {
    var zh = TMI18N.lang() === 'zh';
    $('footHome').setAttribute('href', zh ? '/zh/' : '/');
    $('footPricing').setAttribute('href', zh ? '/zh/pricing/' : '/en/pricing/');
    $('btnWorksheets').setAttribute('href', zh ? '/zh/worksheets/' : '/en/worksheets/');
    $('btnBlog').setAttribute('href', zh ? '/zh/blog/' : '/en/blog/');
    $('footFaq').setAttribute('href', zh ? '/zh/faq/' : '/en/faq/');
    $('footAbout').setAttribute('href', zh ? '/zh/about/' : '/en/about/');
    $('footPrivacy').setAttribute('href', zh ? '/zh/privacy/' : '/en/privacy/');
    $('footTerms').setAttribute('href', zh ? '/zh/terms/' : '/en/terms/');
  }
  function switchLang(lang) {
    TMI18N.setLang(lang);
    syncLangButtons();
    syncFooterLinks();
    renderSetup();
    renderTips();
    refreshHome();
    if (document.querySelector('#view-stats.active')) renderStats();
    if (document.querySelector('#settingsOverlay.show')) renderSettings();
  }

  /* ---------- 初始化 ---------- */
  var toastTimer;
  document.addEventListener('DOMContentLoaded', function () {
    applyMotion();
    TMI18N.setLang(TMI18N.lang(), false); // 应用初始语言（不重复写入）
    renderLangMenu();
    syncLangButtons();
    syncFooterLinks();
    renderSetup();
    renderTips();
    refreshHome();

    // 背景漂浮装饰
    if (!reduceMotion()) {
      var box = $('particles');
      var symbols = ['♥', '✿', '❀', '✦'];
      var colors = ['#F2555A', '#FF8A8E', '#FFC2CC', '#F5A623'];
      for (var i = 0; i < 20; i++) {
        var s = document.createElement('div');
        s.className = 'particle';
        s.textContent = symbols[Math.floor(Math.random() * symbols.length)];
        s.style.color = colors[Math.floor(Math.random() * colors.length)];
        s.style.left = Math.random() * 100 + '%';
        s.style.fontSize = (11 + Math.random() * 12) + 'px';
        s.style.animationDuration = (10 + Math.random() * 12) + 's';
        s.style.animationDelay = (Math.random() * 14) + 's';
        box.appendChild(s);
      }
    }

    // 视图路由
    // 先留档初始 hash：下方 showView('home') 会把 hash 同步改写成 #/home，
    // 深链 /play/#/setup?amin=… 的参数必须在此前留存（Learn 课程 CTA）。
    var initialHash = location.hash;
    TMUI.showView('home');
    function routeHash(h) {
      var raw = ((h || location.hash) || '#/home').replace('#/', '') || 'home';
      var qi = raw.indexOf('?');
      var name = qi === -1 ? raw : raw.slice(0, qi);
      // Learn 课程深链：#/setup?amin=… 到达时解析范围并加入难度选项
      if (name === 'setup' && qi !== -1) {
        pendingRange = parseLessonRange(raw.slice(qi + 1));
        settings.difficulty = LESSON_DIFF; // 课程 CTA 落地即预选，直接开练
        saveSettings();
        renderSetup();
      }
      // 对战视图由 race.js 管理，避免 hash 回退把用户从对局里拽出来
      if (name === 'home' || name === 'setup' || name === 'stats' || name === 'versus') TMUI.showView(name);
    }
    global.addEventListener('hashchange', function () { routeHash(); });
    routeHash(initialHash); // 用留档的初始 hash 复核一次（直接打开深链时生效）

    // 首页卡片
    $('brandHome').addEventListener('click', function () {
      // 对战中先确认再离开（race.js 内部已有确认框）
      if (global.TMRace && global.TMRace.isActive()) { global.TMRace.exitToHome(); return; }
      // exitRound 内部已负责「有答案时先确认」，此处不再重复询问
      if (TMGame.isActive()) { TMGame.exitRound(); }
      else { TMUI.showView('home'); refreshHome(); }
    });
    $('cardPractice').addEventListener('click', function () { renderSetup(); TMUI.showView('setup'); });
    $('cardChallenge').addEventListener('click', function () { TMGame.startChallenge(); });
    $('cardMistakes').addEventListener('click', function () { TMGame.startMistakes(); });

    // Practice 表单
    $('stopwatchToggle').addEventListener('change', function (e) {
      settings.stopwatch = e.target.checked; saveSettings();
    });
    $('setupForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var cfg = { difficulty: settings.difficulty, count: settings.count, stopwatch: settings.stopwatch };
      if (settings.difficulty === LESSON_DIFF) {
        cfg.difficulty = 'times_tables_10'; // 记录口径：课程练习范围都在 1–10 内
        if (pendingRange) cfg.range = pendingRange;
      }
      TMGame.startPractice(cfg);
    });
    $('setupBack').addEventListener('click', function () { TMUI.showView('home'); });

    // 顶栏
    $('langBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      if ($('langDropdown').hidden) openLangMenu(); else closeLangMenu(true);
    });
    $('langBtn').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openLangMenu();
      } else if (e.key === 'Escape') {
        closeLangMenu(false);
      }
    });
    $('langDropdown').addEventListener('keydown', function (e) {
      var opts = Array.prototype.slice.call($('langDropdown').querySelectorAll('.lang-option'));
      var idx = opts.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeLangMenu(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); opts[(idx + 1) % opts.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(idx - 1 + opts.length) % opts.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); opts[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); opts[opts.length - 1].focus(); }
      else if (e.key === 'Tab') { closeLangMenu(false); }
    });
    // 点击菜单外部时收起
    document.addEventListener('click', function (e) {
      if (!$('langMenu').contains(e.target)) closeLangMenu(false);
    });
    $('btnTips').addEventListener('click', function () { openOverlay($('tipsOverlay')); });
    $('btnStats').addEventListener('click', function () { renderStats(); TMUI.showView('stats'); });
    $('btnSettings').addEventListener('click', function () { renderSettings(); openOverlay($('settingsOverlay')); });
    $('btnAccount').addEventListener('click', function () { location.href = '/account/'; });
    $('statsBack').addEventListener('click', function () { TMUI.showView('home'); refreshHome(); });

    // 登录态刷新：恢复会话、清空离线上报队列（按账号隔离，DESIGN 4.3）
    if (global.TMAPI && global.TMAPI.refresh) {
      global.TMAPI.refresh().then(function () {
        refreshHome();
        var btn = $('btnAccount');
        var st = global.TMAPI.state;
        if (st.child) {
          // 子女会话：按钮显示本人昵称
          btn.textContent = st.child.nickname;
          btn.setAttribute('aria-pressed', 'true');
        } else if (st.user) {
          // 家长会话：显示“账号”，避免与孩子的身份混淆
          btn.textContent = t('nav.account');
          btn.setAttribute('aria-pressed', 'true');
        }
      });
    }

    // 弹窗关闭（含 Esc 与遮罩点击）
    [['tipsOverlay', 'tipsCloseBtn'], ['settingsOverlay', 'settingsCloseBtn'], ['resultOverlay', null]].forEach(function (pair) {
      var ov = $(pair[0]);
      ov.addEventListener('click', function (e) { if (e.target === ov && pair[0] !== 'resultOverlay') closeOverlay(ov); });
      if (pair[1]) $(pair[1]).addEventListener('click', function () { closeOverlay(ov); });
    });
    global.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      ['tipsOverlay', 'settingsOverlay'].forEach(function (id) {
        var ov = $(id);
        if (ov.classList.contains('show')) closeOverlay(ov);
      });
    });

    // 设置项
    $('setLangEn').addEventListener('click', function () { switchLang('en'); renderSettings(); });
    $('setLangZh').addEventListener('click', function () { switchLang('zh'); renderSettings(); });
    $('motionToggle').addEventListener('change', function (e) {
      settings.reduceMotion = e.target.checked;
      saveSettings();
      applyMotion();
    });
    $('clearAllBtn').addEventListener('click', function () {
      TMUI.confirm(t('settings.clearConfirm'), { emote: '⚠️', danger: true, okLabel: t('common.delete') })
        .then(function (ok) {
          if (!ok) return;
          TMRecords.clearAll(null);
          try { localStorage.removeItem('tm_challenge_level'); } catch (e) { /* 忽略 */ }
          renderSettings();
          refreshHome();
          TMUI.toast(t('settings.cleared'), false);
        });
    });

    // 系统动画偏好变化时同步（用户未手动覆盖则跟随）
    if (global.matchMedia) {
      var mq = global.matchMedia('(prefers-reduced-motion: reduce)');
      var onChange = function () {
        if (settings.reduceMotion === null) applyMotion();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
