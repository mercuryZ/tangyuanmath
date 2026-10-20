/* Tangyuan Math — 回合引擎（Practice / Challenge / Mistakes）
 * 关键口径（DESIGN.md）：
 *  - 7.2 每题「活动答题时间」：输入框获得焦点开始、失焦累计；页面隐藏时暂停；
 *    未作答题耗时为 null；无焦点阅读时间不归给任何题。
 *  - 7.2 Challenge 倒计时用绝对截止时刻计算，标签页隐藏不延长截止。
 *  - 2.4 首次/最终答案按「每题」记录：某题第一次非空提交即为其首次答案；
 *    错题本只记首次错误；当场修正不抵消；重练的对账在对局结束时一次应用。
 *  - 7.1 判分在本地完成（M0 无服务端），数据结构与服务端权威版一致。
 */
(function (global) {
  'use strict';

  var TOTAL_LEVELS = 10;
  var LEVEL_TIME = function (lvl) { return Math.round(120 - (lvl - 1) * (100 / (TOTAL_LEVELS - 1))); };

  var state = null;

  function t(key, vars) { return global.TMI18N.t(key, vars); }

  /* ---------- 每题活动计时 ---------- */
  function timerStart(per) { if (per.timer.start === null) per.timer.start = performance.now(); }
  function timerAccum(per) {
    if (per.timer.start !== null) {
      per.timer.acc += performance.now() - per.timer.start;
      per.timer.start = null;
    }
  }
  function activeMs(per) {
    var extra = per.timer.start !== null ? performance.now() - per.timer.start : 0;
    return Math.round(per.timer.acc + extra);
  }
  document.addEventListener('visibilitychange', function () {
    if (!state) return;
    if (document.hidden) {
      state.per.forEach(timerAccum); // 页面隐藏：暂停所有计时（DESIGN 7.2）
    } else {
      var el = document.activeElement;
      if (el && el.dataset && el.dataset.i !== undefined) timerStart(state.per[Number(el.dataset.i)]);
    }
  });

  /* ---------- DOM ---------- */
  function $(id) { return document.getElementById(id); }
  var grid = null, checkBtn, tryAgainBtn, exitBtn,
      timerBox, stopwatchBox, progressFill, progressRole, roundBadge, roundDesc, scoreDesc;

  function dom() {
    if (grid) return;
    grid = $('grid'); checkBtn = $('checkBtn');
    tryAgainBtn = $('tryAgainBtn'); exitBtn = $('exitBtn');
    timerBox = $('timerBox'); stopwatchBox = $('stopwatchBox');
    progressFill = $('progressFill'); progressRole = $('progressRole');
    roundBadge = $('roundBadge'); roundDesc = $('roundDesc'); scoreDesc = $('scoreDesc');
  }

  /* ---------- 错题本读写 ---------- */
  function loadBook() { return TMRecords.load(null, TMRecords.KEYS.wrongbook); }
  function saveBook(book) { TMRecords.save(null, TMRecords.KEYS.wrongbook, book); }

  /* 云端模式：登录且有档案时，错题本与记录以服务端为准（DESIGN M1）
   * - 首次错误：由服务端在记录上报时入库，跳过本地写；
   * - 重练对账：POST /wrongbook/review；
   * - 游客：完全本地。 */
  function cloudActive() {
    return !!(global.TMAPI && global.TMAPI.state &&
      (global.TMAPI.state.user || global.TMAPI.state.child) &&
      global.TMAPI.state.currentProfileId);
  }

  /* ---------- 回合构建 ---------- */
  function newState(cfg) {
    return {
      mode: cfg.mode, difficulty: cfg.difficulty, count: cfg.questions.length,
      level: cfg.level || null, questions: cfg.questions,
      per: cfg.questions.map(function (q) {
        return {
          a: q.a, b: q.b,
          first_answer: null, first_correct: null,
          final_answer: null, final_correct: null,
          timer: { acc: 0, start: null }, reviewApplied: false
        };
      }),
      ended: false,
      deadline: 0, timerId: null,
      stopwatchOn: !!cfg.stopwatch, swStart: 0, swId: null,
      reviewSet: {}, saved: false
    };
  }

  function renderRound() {
    dom();
    grid.innerHTML = '';
    state.questions.forEach(function (q, i) {
      var card = document.createElement('div');
      card.className = 'card';
      card.dataset.idx = i;
      var label = t('a11y.question', { n: i + 1, a: q.a, b: q.b });
      card.innerHTML =
        '<span class="idx" aria-hidden="true">' + (i + 1) + '</span>' +
        '<span class="question">' + q.a + ' <span class="op" aria-hidden="true">×</span> ' + q.b +
        '<span class="eq" aria-hidden="true">=</span></span>' +
        '<input type="number" inputmode="numeric" data-i="' + i + '" aria-label="' + label + '">' +
        '<span class="check" data-check="' + i + '" aria-hidden="true"></span>';
      grid.appendChild(card);
    });

    if (state.mode === 'challenge') {
      roundBadge.textContent = t('round.level', { n: state.level });
      roundDesc.textContent = t('round.challengeDesc', { s: LEVEL_TIME(state.level), n: state.count });
      timerBox.hidden = false; stopwatchBox.hidden = true;
      startCountdown();
    } else {
      roundBadge.textContent = state.mode === 'mistakes' ? t('round.badge.mistakes') : t('round.badge.practice');
      roundDesc.textContent = t('round.practiceDesc', { n: state.count });
      timerBox.hidden = true; stopwatchBox.hidden = !state.stopwatchOn;
      if (state.stopwatchOn) startStopwatch();
    }

    checkBtn.hidden = false;
    tryAgainBtn.hidden = state.mode === 'challenge';
    updateProgress();
    var first = grid.querySelector('input');
    if (first) setTimeout(function () { first.focus(); }, 60);
  }

  /* ---------- 倒计时：绝对截止时刻（DESIGN 7.2） ---------- */
  function startCountdown() {
    clearInterval(state.timerId);
    state.deadline = Date.now() + LEVEL_TIME(state.level) * 1000;
    timerBox.classList.remove('warn');
    renderCountdown();
    state.timerId = setInterval(function () {
      renderCountdown();
      if (Date.now() >= state.deadline) { clearInterval(state.timerId); onTimeout(); }
    }, 250);
  }
  function renderCountdown() {
    var left = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    timerBox.textContent = left;
    timerBox.classList.toggle('warn', left <= 20 && left > 0);
  }
  function startStopwatch() {
    clearInterval(state.swId);
    state.swStart = Date.now();
    state.swId = setInterval(function () {
      var s = Math.floor((Date.now() - state.swStart) / 1000);
      stopwatchBox.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }, 500);
  }

  function inputs() { return Array.prototype.slice.call(grid.querySelectorAll('input')); }
  function updateProgress() {
    var filled = inputs().filter(function (inp) { return inp.value.trim() !== ''; }).length;
    var pct = Math.round(filled / state.count * 100);
    progressFill.style.width = pct + '%';
    progressRole.setAttribute('aria-valuenow', String(pct));
    scoreDesc.textContent = t('round.filled', { filled: filled, count: state.count });
  }

  function markCard(i, kind) {
    var card = grid.querySelector('.card[data-idx="' + i + '"]');
    var check = card.querySelector('.check');
    var inp = card.querySelector('input');
    var base = t('a11y.question', { n: i + 1, a: state.questions[i].a, b: state.questions[i].b });
    card.classList.remove('done', 'wrong');
    check.textContent = '';
    if (kind === 'correct') {
      card.classList.add('done'); check.textContent = '✓';
      inp.disabled = true;
      inp.setAttribute('aria-label', base + ' — ' + t('a11y.correct'));
    } else if (kind === 'wrong') {
      card.classList.add('wrong'); check.textContent = '✗';
      inp.setAttribute('aria-label', base + ' — ' + t('a11y.wrong'));
    } else {
      check.textContent = '?';
      inp.setAttribute('aria-label', base + ' — ' + t('a11y.blank'));
    }
  }

  /* ---------- 判分（本地权威数据结构，与服务端口径一致） ---------- */
  function grade() {
    var allFinal = true;
    for (var i = 0; i < state.count; i++) {
      var q = state.questions[i], p = state.per[i];
      var inp = grid.querySelector('input[data-i="' + i + '"]');
      var v = inp.value.trim();
      if (v !== '') {
        var val = Number(v);
        var correct = val === q.answer;
        if (p.first_answer === null) { // 该题首次提交（DESIGN 2.4）
          p.first_answer = val;
          p.first_correct = correct;
          if (!correct && state.mode !== 'mistakes' && !cloudActive()) {
            // 首次错误进错题本（重练走 review 规则）；云端模式下由服务端在记录上报时入库
            saveBook(TMWrongBook.recordFirstWrong(loadBook(), q.a, q.b, val));
          }
        }
        p.final_answer = val;
        p.final_correct = correct;
        if (!correct) allFinal = false;
      } else {
        p.final_answer = null; // 当前为空 = 未完成
        p.final_correct = false;
        allFinal = false;
      }
    }
    return { allFinal: allFinal };
  }

  /* 重练对账：对局结束时按「最终结果」一次应用（每题每轮最多一次） */
  function applyReview() {
    if (state.mode !== 'mistakes') return;
    if (cloudActive()) {
      var results = [];
      var seen = {};
      state.per.forEach(function (p) {
        if (p.reviewApplied || p.final_answer === null) return;
        var k = Math.min(p.a, p.b) + 'x' + Math.max(p.a, p.b);
        if (seen[k]) return;
        seen[k] = true;
        results.push({ a: p.a, b: p.b, correct: !!p.final_correct, userAnswer: p.final_answer });
        p.reviewApplied = true;
      });
      if (results.length) global.TMAPI.reviewWrong(results); // 服务端按同样规则对账
      return;
    }
    var book = loadBook();
    state.per.forEach(function (p) {
      if (p.reviewApplied || p.final_answer === null) return; // blank 不处理
      if (p.final_correct) book = TMWrongBook.reviewCorrect(book, p.a, p.b);
      else book = TMWrongBook.reviewWrong(book, p.a, p.b, p.final_answer, state.reviewSet);
      p.reviewApplied = true;
    });
    saveBook(book);
  }

  function snapshotPer() {
    return state.per.map(function (p) {
      timerAccum(p);
      var answered = p.first_answer !== null || p.final_answer !== null;
      return {
        a: p.a, b: p.b,
        first_answer: p.first_answer, first_correct: p.first_correct === true,
        final_answer: p.final_answer, final_correct: p.final_correct === true,
        active_ms: answered || p.timer.acc > 0 ? activeMs(p) : null
      };
    });
  }

  function usedTimeSeconds() {
    if (state.mode === 'challenge') {
      var left = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
      return LEVEL_TIME(state.level) - left;
    }
    if (state.stopwatchOn && state.swStart) return Math.round((Date.now() - state.swStart) / 1000);
    return null;
  }

  function saveRecord(passed) {
    if (state.saved) return;
    var any = state.per.some(function (p) { return p.first_answer !== null; });
    if (!any) return; // 从未提交过答案：不保存，避免污染统计
    var meta = { mode: state.mode, difficulty: state.difficulty, passed: !!passed };
    if (state.mode === 'challenge') meta.level = state.level;
    var usedS = usedTimeSeconds();
    if (usedS !== null) meta.usedTimeS = usedS;
    var rec = TMRecords.buildRecord(meta, snapshotPer());
    TMRecords.append(null, rec); // 本地始终保留一份（离线备份 / 游客导入源）
    state.saved = true;
    if (global.TMAPI && global.TMAPI.onRecord) global.TMAPI.onRecord(rec); // 云端：入队上报
  }

  /* ---------- Check Answers ---------- */
  function checkAnswers() {
    if (!state || state.ended) return;
    var filled = inputs().filter(function (inp) { return inp.value.trim() !== ''; }).length;
    if (filled === 0) { global.TMUI.toast(t('toast.fillFirst'), true); return; }
    if (filled < state.count) { global.TMUI.toast(t('toast.remain', { n: state.count - filled }), true); return; }

    var res = grade();

    var wrongs = 0;
    for (var i = 0; i < state.count; i++) {
      var p = state.per[i];
      if (p.final_answer === null) markCard(i, 'blank');
      else if (p.final_correct) markCard(i, 'correct');
      else { markCard(i, 'wrong'); wrongs++; }
    }
    updateProgress();

    if (res.allFinal) { finishRound(true); return; }
    global.TMUI.toast(t('toast.errors', { n: wrongs }), true);
    var firstWrongInput = grid.querySelector('.card.wrong input');
    if (firstWrongInput) setTimeout(function () { firstWrongInput.focus(); }, 50);
  }

  /* ---------- 回合结束 ---------- */
  function stopClocks() {
    if (state.timerId) clearInterval(state.timerId);
    if (state.swId) clearInterval(state.swId);
    state.timerId = null; state.swId = null;
  }

  function lockBoard() {
    inputs().forEach(function (inp) {
      if (inp.value.trim() === '') inp.placeholder = state.questions[Number(inp.dataset.i)].answer;
      inp.disabled = true;
    });
    checkBtn.hidden = true;
  }

  function resultStats() {
    var firstCorrect = 0, finalCorrect = 0, blanks = 0;
    state.per.forEach(function (p) {
      if (p.first_answer === null) blanks++;
      else if (p.first_correct) firstCorrect++;
      if (p.final_correct) finalCorrect++;
    });
    var stats = [
      { cls: 'g', num: firstCorrect + '/' + state.count, lbl: t('result.firstTry') },
      { cls: 'g', num: finalCorrect + '/' + state.count, lbl: t('result.final') },
      { cls: 'b', num: blanks, lbl: t('result.blank') }
    ];
    var usedS = usedTimeSeconds();
    if (usedS !== null) stats.push({ cls: 't', num: usedS + 's', lbl: t('result.time') });
    return stats;
  }

  /* 通过（全部答对）结算 */
  function finishRound() {
    state.ended = true;
    applyReview();
    stopClocks();
    lockBoard();
    saveRecord(true);
    if (!global.TMUI.reduceMotion()) global.TMUI.confetti();

    var titleKey, subKey;
    var isFinalLevel = state.mode === 'challenge' && state.level === TOTAL_LEVELS;
    if (state.mode === 'mistakes') { titleKey = 'result.mistakesClear'; subKey = 'result.mistakesClearSub'; }
    else if (state.mode === 'challenge') {
      titleKey = isFinalLevel ? 'result.allLevels' : 'result.levelComplete';
      subKey = isFinalLevel ? 'result.allLevelsSub' : 'result.nextSub';
    } else { titleKey = 'result.allCorrect'; subKey = 'result.allCorrectSub'; }

    if (state.mode === 'challenge') {
      var next = state.level + 1;
      setChallengeLevel(next > TOTAL_LEVELS ? 1 : next);
    }
    var mainAction = mainActionFor(true);
    global.TMUI.showResult({
      emote: isFinalLevel ? '🏆' : '🎉',
      title: t(titleKey),
      sub: t(subKey, { n: state.mode === 'challenge' ? getChallengeLevel() : '' }),
      stats: resultStats(),
      mainLabel: mainAction.label,
      onMain: mainAction.fn
    });
  }

  /* 挑战超时：自动判分结算 */
  function onTimeout() {
    if (!state || state.ended) return;
    grade();
    var allRight = state.per.every(function (p) { return p.final_correct === true; });
    if (allRight) { finishRound(); return; }
    state.ended = true;
    stopClocks();
    lockBoard();
    saveRecord(false);
    var wrongs = state.per.filter(function (p) { return p.final_answer !== null && !p.final_correct; }).length;
    var blanks = state.per.filter(function (p) { return p.final_answer === null; }).length;
    var mainAction = mainActionFor(false);
    global.TMUI.showResult({
      emote: '⏰',
      title: t('result.timeup'),
      sub: t('result.timeupSub', { wrong: wrongs, blank: blanks }),
      stats: resultStats(),
      mainLabel: mainAction.label,
      onMain: mainAction.fn
    });
  }

  function mainActionFor(won) {
    if (state.mode === 'challenge') {
      if (won) {
        var final = state.level === TOTAL_LEVELS;
        return {
          label: final ? t('result.playAgain') : t('round.nextLevel'),
          fn: function () { TMGame.startChallenge(getChallengeLevel()); }
        };
      }
      var lvl = state.level;
      return { label: t('round.retryLevel'), fn: function () { TMGame.startChallenge(lvl); } };
    }
    var cfg = { difficulty: state.difficulty, count: state.count, stopwatch: state.stopwatchOn };
    return { label: t('round.tryAgain'), fn: function () { TMGame.startPractice(cfg); } };
  }

  /* 退出 / Try Again：保存最终快照 */
  function settleAndSave() {
    if (state.ended) return;
    grade();
    applyReview();
    saveRecord(false);
  }
  function exitRound() {
    if (!state) { global.TMUI.showView('home'); return; }
    var hasAnswers = !state.ended && inputs().some(function (i) { return i.value.trim() !== ''; });
    if (!hasAnswers) { finishExit(); return; } // 没填答案就直接退出，不必确认
    // 半途离开：用困惑的汤圆，比默认头像更贴合「你确定要走吗」
    global.TMUI.confirm(t('round.confirmExit'), { img: '../img/confused.png' }).then(function (ok) {
      if (ok && state) finishExit(); // 等待期间状态可能已被清空
    });
  }
  function finishExit() {
    settleAndSave();
    stopClocks();
    state = null;
    global.TMUI.showView('home');
    global.TMUI.refreshHome();
  }
  function tryAgain() {
    if (!state) return;
    var mode = state.mode;
    var cfg = { difficulty: state.difficulty, count: state.count, stopwatch: state.stopwatchOn };
    settleAndSave();
    stopClocks();
    if (mode === 'mistakes') TMGame.startMistakes();
    else TMGame.startPractice(cfg);
  }

  /* ---------- 挑战关卡进度（本地记忆） ---------- */
  var LEVEL_KEY = 'tm_challenge_level';
  function getChallengeLevel() {
    try { var v = Number(global.localStorage.getItem(LEVEL_KEY)); return (v >= 1 && v <= TOTAL_LEVELS) ? v : 1; }
    catch (e) { return 1; }
  }
  function setChallengeLevel(l) {
    try { global.localStorage.setItem(LEVEL_KEY, String(l)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 对外 API ---------- */
  var TMGame = {
    LEVEL_TIME: LEVEL_TIME,
    TOTAL_LEVELS: TOTAL_LEVELS,
    getChallengeLevel: getChallengeLevel,

    startPractice: function (cfg) {
      state = newState({
        mode: 'practice', difficulty: cfg.difficulty,
        questions: TMQuestions.generateSet(cfg.difficulty, cfg.count),
        stopwatch: cfg.stopwatch
      });
      global.TMUI.showView('round');
      renderRound();
    },

    startChallenge: function (level) {
      level = level || getChallengeLevel();
      state = newState({
        mode: 'challenge', difficulty: 'two_by_two',
        questions: TMQuestions.generateSet('two_by_two', 10),
        level: level
      });
      global.TMUI.showView('round');
      renderRound();
    },

    startMistakes: function () {
      var done = function (book) {
        if (!book.length) { global.TMUI.toast(t('mistakes.emptyToast'), false); return false; }
        var count = Math.min(10, Math.max(5, book.length));
        var qs = [];
        for (var i = 0; i < count; i++) {
          var e = book[i % book.length];
          qs.push({ a: e.a, b: e.b, answer: e.a * e.b });
        }
        state = newState({ mode: 'mistakes', difficulty: 'mixed', questions: qs });
        global.TMUI.showView('round');
        renderRound();
        return true;
      };
      if (cloudActive()) {
        global.TMAPI.getWrongbook().then(function (r) {
          done(r.ok ? r.data.items : []);
        });
        return true; // 异步加载中
      }
      return done(loadBook());
    },

    exitRound: exitRound,
    tryAgain: tryAgain,
    isActive: function () { return !!state; },
    mode: function () { return state ? state.mode : null; }
  };

  /* ---------- 输入事件（委托） ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    dom();
    var progressDebounce = null;
    grid.addEventListener('input', function (e) {
      if (!e.target.matches('input')) return;
      clearTimeout(progressDebounce);
      progressDebounce = setTimeout(updateProgress, 80);
    });
    grid.addEventListener('focusin', function (e) {
      if (!state || !e.target.matches('input')) return;
      timerStart(state.per[Number(e.target.dataset.i)]);
    });
    grid.addEventListener('focusout', function (e) {
      if (!state || !e.target.matches('input')) return;
      timerAccum(state.per[Number(e.target.dataset.i)]);
    });
    grid.addEventListener('keydown', function (e) { // 回车跳题；最后一题回车 = 交卷
      if (e.key !== 'Enter' || !state || state.ended) return;
      var list = inputs();
      var idx = list.indexOf(e.target);
      if (idx === -1) return;
      var rest = list.slice(idx + 1).filter(function (inp) { return !inp.disabled; });
      if (rest.length) { rest[0].focus(); return; }
      checkBtn.click();
    });
    checkBtn.addEventListener('click', checkAnswers);
    exitBtn.addEventListener('click', exitRound);
    tryAgainBtn.addEventListener('click', tryAgain);
  });

  global.TMGame = TMGame;
})(typeof window !== 'undefined' ? window : globalThis);
