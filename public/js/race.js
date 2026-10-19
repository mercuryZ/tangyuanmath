/* Tangyuan Math — Live Race 客户端（M1.5，DESIGN §13）
 * 关键约束：
 *  - 题目与判定都在服务端：本文件只上报 {position, value}，从不持有答案；
 *  - 断线重连：sessionStorage 记住 {code, token}，刷新或闪断后回归原座位；
 *  - 儿童安全：无自由文本、无聊天；显示名与头像全部由服务端生成；
 *  - 无障碍：复用键盘 Enter 流；prefers-reduced-motion / 手动减少动画时关闭跳动。
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'tm_race_seat';
  var RECONNECT_DELAYS = [0, 800, 1600, 3200, 5000];

  function t(key, vars) { return global.TMI18N.t(key, vars); }
  function $(id) { return document.getElementById(id); }

  var state = null; // { ws, code, seat, token, room, problems, deadline, serverSkew, per, timerId, reconnectAttempt, closed }
  var settings = { difficulty: 'two_by_two', count: 10 };
  var DIFFS = ['times_tables_10', 'times_tables_12', 'two_by_one', 'two_by_two'];
  var COUNTS = [5, 10, 20];

  /* ---------- 座位记忆（重连用） ---------- */
  function saveSeat(code, token, seat) {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ code: code, token: token, seat: seat })); } catch (e) { /* 忽略 */ }
  }
  function readSeat() {
    try { return JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; }
  }
  function clearSeat() {
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* 忽略 */ }
  }

  /* ---------- WebSocket ---------- */
  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var pid = global.TMAPI && global.TMAPI.state ? global.TMAPI.state.currentProfileId : null;
    return proto + '//' + location.host + '/api/race/ws' + (pid ? '?profileId=' + encodeURIComponent(pid) : '');
  }

  function connect(onReady) {
    var ws;
    try { ws = new WebSocket(wsUrl()); }
    catch (e) { onError('network_error'); return null; }
    state = state || {};
    state.ws = ws;

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(msg);
    };
    ws.onclose = function () {
      if (!state || state.closed) return;
      // 非主动关闭：尝试自动重连（重连窗口 30 秒，DESIGN 13.2）
      scheduleReconnect();
    };
    ws.onerror = function () { /* onclose 统一处理 */ };
    ws.onopen = function () {
      state.reconnectAttempt = 0;
      if (onReady) onReady();
    };
    return ws;
  }

  function scheduleReconnect() {
    if (!state || state.closed) return;
    var seat = readSeat();
    if (!seat || !seat.token) { showError('disconnected'); return; }
    var attempt = state.reconnectAttempt || 0;
    if (attempt >= RECONNECT_DELAYS.length) { showError('disconnected'); return; }
    state.reconnectAttempt = attempt + 1;
    setTimeout(function () {
      if (!state || state.closed) return;
      connect(function () {
        send({ type: 'join_room', code: seat.code, resumeToken: seat.token });
      });
    }, RECONNECT_DELAYS[attempt]);
  }

  function send(msg) {
    if (state && state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /* ---------- 消息分发 ---------- */
  function handle(msg) {
    switch (msg.type) {
      case 'hello': break;
      case 'joined': onJoined(msg); break;
      case 'room_state': onRoomState(msg.room); break;
      case 'countdown': showCountdown(msg.seconds); break;
      case 'game_start': onGameStart(msg); break;
      case 'judge': onJudge(msg); break;
      case 'submitted': onSubmitted(msg); break;
      case 'peer_progress': onPeerProgress(msg); break;
      case 'game_over': onGameOver(msg); break;
      case 'error': onServerError(msg.code); break;
      default: break;
    }
  }

  function onServerError(code) {
    var map = {
      room_not_found: 'race.err.roomNotFound',
      room_full: 'race.err.roomFull',
      already_started: 'race.err.alreadyStarted',
      need_players: 'race.err.needPlayers',
      host_only: 'race.err.hostOnly',
      rate_limited: 'race.err.rateLimited',
      invalid_resume: 'race.err.resumeFailed',
      already_in_room: 'race.err.alreadyInRoom'
    };
    global.TMUI.toast(t(map[code] || 'race.err.generic'), true);
    if (code === 'room_not_found' || code === 'invalid_resume') {
      clearSeat();
      global.TMUI.showView('versus');
    }
  }

  function onJoined(msg) {
    state.code = msg.code;
    state.seat = msg.seat;
    state.token = msg.token;
    saveSeat(msg.code, msg.token, msg.seat);
    if (msg.room) renderRoom(msg.room);
    global.TMUI.showView('lobby');
    if (msg.resumed && msg.room && msg.room.status === 'waiting') {
      global.TMUI.toast(t('race.reconnected'), false);
    }
  }

  function onRoomState(room) {
    if (!state) return;
    state.room = room;
    // 只要还在房间里，就把座位令牌存下来：刷新 / 闪断后能回归（DESIGN 13.2）
    if (state.token) saveSeat(state.code, state.token, state.seat);
    if (room.status === 'waiting') {
      renderRoom(room);
      if (global.TMUI.currentView() !== 'lobby') global.TMUI.showView('lobby');
    } else if (room.status === 'over') {
      renderRoom(room);
    } else {
      renderPeers(room);
    }
  }

  /* ---------- 大厅 ---------- */
  function renderLobbyOptions() {
    var dBox = $('raceDiffOptions');
    dBox.innerHTML = '';
    DIFFS.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.setAttribute('aria-pressed', settings.difficulty === d ? 'true' : 'false');
      b.innerHTML = t('diff.' + d) + '<small>' + t('diffdesc.' + d) + '</small>';
      b.addEventListener('click', function () {
        settings.difficulty = d;
        renderLobbyOptions();
      });
      dBox.appendChild(b);
    });
    var cBox = $('raceCountOptions');
    cBox.innerHTML = '';
    COUNTS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.setAttribute('aria-pressed', settings.count === c ? 'true' : 'false');
      b.textContent = t('setup.countN', { n: c });
      b.addEventListener('click', function () {
        settings.count = c;
        renderLobbyOptions();
      });
      cBox.appendChild(b);
    });
  }

  /* ---------- 等待室 ---------- */
  function renderRoom(room) {
    $('lobbyCode').textContent = room.code;
    var box = $('lobbySeats');
    box.innerHTML = '';
    room.players.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'seat' + (p.seat === state.seat ? ' self' : '') + (p.connected ? '' : ' offline');
      var tags = [];
      if (p.seat === room.hostSeat) tags.push('<span class="seat-tag host">' + t('lobby.host') + '</span>');
      if (p.seat === state.seat) tags.push('<span class="seat-tag">' + t('lobby.you') + '</span>');
      if (!p.connected) tags.push('<span class="seat-tag">' + t('lobby.offline') + '</span>');
      d.innerHTML =
        '<span class="seat-avatar" aria-hidden="true">' + p.avatar + '</span>' +
        '<span class="seat-name"></span>' +
        tags.join(' ');
      d.querySelector('.seat-name').textContent = p.name; // 系统生成名，仍用 textContent 防注入
      box.appendChild(d);
    });
    // 空座位提示
    for (var i = room.players.length; i < 4; i++) {
      var e = document.createElement('div');
      e.className = 'seat seat-empty';
      e.textContent = t('lobby.emptySeat');
      box.appendChild(e);
    }

    var isHost = room.hostSeat === state.seat;
    var startBtn = $('raceStartBtn');
    startBtn.hidden = !isHost;
    startBtn.disabled = room.players.filter(function (p) { return p.connected; }).length < 2;
    $('lobbySettings').textContent = t('lobby.settings', {
      diff: t('diff.' + room.settings.difficulty),
      n: room.settings.count,
      s: room.settings.duration
    });
  }

  function copyInvite() {
    var url = location.origin + '/play/?room=' + state.code;
    var text = t('lobby.inviteText', { code: state.code, url: url });
    var done = function () { global.TMUI.toast(t('lobby.copied'), false); };
    if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done) {
    // 旧浏览器/非安全上下文：用临时 textarea + execCommand
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (ok) done(); else global.TMUI.toast(t('lobby.copyFailed'), true);
  }

  /* ---------- 倒计时 ---------- */
  function showCountdown(seconds) {
    global.TMUI.showView('race');
    var grid = $('raceGrid');
    if (grid) grid.innerHTML = '';
    $('racePeers').innerHTML = '';
    $('raceDesc').textContent = t('race.getReady');
    $('raceScoreDesc').textContent = '';
    var badge = $('raceBadge');
    if (badge) badge.textContent = String(seconds);
    $('raceTimer').textContent = String(seconds);
  }

  /* ---------- 对局 ---------- */
  function onGameStart(msg) {
    if (!state) return;
    state.problems = msg.problems;
    state.per = msg.problems.map(function () { return { answer: null, correct: false }; });
    state.deadline = msg.deadline;
    state.submitted = !!msg.submitted; // 重连时可能已交卷
    // 用服务端时间校准本地时钟，避免设备时间不准导致倒计时偏差
    state.serverSkew = (msg.serverNow || Date.now()) - Date.now();
    (msg.solvedPositions || []).forEach(function (i) {
      if (state.per[i]) { state.per[i].correct = true; }
    });

    global.TMUI.showView('race');
    var badge = $('raceBadge');
    if (badge) badge.textContent = t('race.badge');
    $('raceDesc').textContent = t('race.desc', { n: msg.count });
    $('raceScoreDesc').textContent = '';
    renderGrid();
    renderPeers(state.room);
    updateProgress();
    startClock();
    resetSubmitUi();
    if (state.submitted) {
      markSubmittedBoard();
      lockBoard();
      var btn0 = $('raceSubmitBtn');
      if (btn0) { btn0.disabled = true; btn0.textContent = t('race.submitted'); }
      var hint0 = $('raceSubmitHint');
      if (hint0) hint0.textContent = t('race.submitted');
      var solvedN = state.per.filter(function (p) { return p.correct; }).length;
      $('raceScoreDesc').textContent = t('race.submittedScore', { solved: solvedN, total: msg.count });
    }
    var firstOpen = $('raceGrid').querySelector('input:not([disabled])');
    if (firstOpen) setTimeout(function () { firstOpen.focus(); }, 60);
  }

  /* 每局开始时恢复提交按钮与提示文案 */
  function resetSubmitUi() {
    var btn = $('raceSubmitBtn');
    if (btn) { btn.disabled = false; btn.textContent = t('race.submit'); }
    var hint = $('raceSubmitHint');
    if (hint) hint.textContent = t('race.submitHint');
  }

  function renderGrid() {
    var grid = $('raceGrid');
    grid.innerHTML = '';
    state.problems.forEach(function (q, i) {
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
      // 必须在入 DOM 之后再标记：markCard 通过选择器找卡片（重连时恢复已答对的题）
      if (state.per[i].correct) markCard(i, 'correct');
    });
  }

  function markCard(i, kind) {
    var card = $('raceGrid').querySelector('.card[data-idx="' + i + '"]');
    if (!card) return;
    var check = card.querySelector('.check');
    var inp = card.querySelector('input');
    card.classList.remove('done', 'wrong');
    check.textContent = '';
    if (kind === 'correct') {
      card.classList.add('done');
      check.textContent = '✓';
      inp.disabled = true;
    } else if (kind === 'wrong') {
      card.classList.add('wrong');
      check.textContent = '✗';
    }
  }

  /* 逐题上报：只发 position 与 value，正确性由服务端判定 */
  function submitAnswer(i) {
    var card = $('raceGrid').querySelector('.card[data-idx="' + i + '"]');
    if (!card) return;
    var inp = card.querySelector('input');
    if (!inp || inp.disabled) return;
    var raw = inp.value.trim();
    if (raw === '') return;
    var v = Number(raw);
    if (!isFinite(v)) return;
    send({ type: 'answer', position: i, value: Math.round(v) });
  }

  function onJudge(msg) {
    if (!state || !state.per[msg.position]) return;
    if (msg.correct) {
      state.per[msg.position].correct = true;
      markCard(msg.position, 'correct');
      focusNextOpen();
    } else {
      markCard(msg.position, 'wrong');
      var card = $('raceGrid').querySelector('.card[data-idx="' + msg.position + '"]');
      if (card) {
        var inp = card.querySelector('input');
        if (inp) { inp.select(); }
      }
    }
    updateProgress();
  }

  function focusNextOpen() {
    var inputs = Array.prototype.slice.call($('raceGrid').querySelectorAll('input'));
    var cur = document.activeElement;
    var idx = inputs.indexOf(cur);
    for (var i = 0; i < inputs.length; i++) {
      var j = (idx + 1 + i) % inputs.length;
      if (!inputs[j].disabled) { inputs[j].focus(); return; }
    }
  }

  function updateProgress() {
    if (!state || !state.per) return;
    var solved = state.per.filter(function (p) { return p.correct; }).length;
    var total = state.problems.length;
    var pct = Math.round(solved / total * 100);
    var fill = $('raceProgressFill');
    var role = $('raceProgressRole');
    if (fill) fill.style.width = pct + '%';
    if (role) role.setAttribute('aria-valuenow', String(pct));
    var scoreDesc = $('raceScoreDesc');
    if (scoreDesc) scoreDesc.textContent = t('race.solved', { solved: solved, total: total });
  }

  function onPeerProgress(msg) {
    if (!state || !state.room) return;
    var p = state.room.players.filter(function (x) { return x.seat === msg.seat; })[0];
    if (p) {
      p.solved = msg.solved;
      p.finished = msg.finished;
    }
    renderPeers(state.room);
  }

  function renderPeers(room) {
    if (!room || !room.players) return;
    var box = $('racePeers');
    if (!box) return;
    var total = room.settings ? room.settings.count : (state.problems ? state.problems.length : 10);
    box.innerHTML = '';
    room.players.slice().sort(function (a, b) { return a.seat - b.seat; }).forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'peer' +
        (p.seat === state.seat ? ' self' : '') +
        (p.finished ? ' done' : '') +
        (p.connected === false ? ' offline' : '');
      var pct = Math.round((p.solved || 0) / total * 100);
      d.innerHTML =
        '<span class="peer-avatar" aria-hidden="true">' + p.avatar + '</span>' +
        '<div><div class="peer-name"></div>' +
        '<div class="peer-bar"><div class="peer-fill" style="width:' + pct + '%"></div></div></div>' +
        '<span class="peer-solved">' + (p.solved || 0) + '/' + total + '</span>';
      d.querySelector('.peer-name').textContent = p.name;
      box.appendChild(d);
    });
  }

  /* ---------- 时钟：服务端截止时刻驱动，标签页隐藏不延长 ---------- */
  function startClock() {
    stopClock();
    tickClock();
    state.timerId = setInterval(tickClock, 250);
  }
  function stopClock() {
    if (state && state.timerId) clearInterval(state.timerId);
    if (state) state.timerId = null;
  }
  function tickClock() {
    if (!state || !state.deadline) return;
    var left = Math.max(0, Math.ceil((state.deadline - (Date.now() + state.serverSkew)) / 1000));
    var el = $('raceTimer');
    if (el) {
      el.textContent = left;
      el.classList.toggle('warn', left <= 15 && left > 0);
    }
    if (left === 0) stopClock();
  }

  /* ---------- 交卷 ----------
   * 把当前整张卷子一次性发给服务端：已答对（锁定）的题跳过，
   * 其余取输入框当前值。服务端判定后返回 submitted，此后本方棋盘锁定。 */
  function collectAnswers() {
    var answers = [];
    if (!state || !state.problems) return answers;
    state.problems.forEach(function (q, i) {
      if (state.per[i] && state.per[i].correct) return; // 已答对，无需重发
      var card = $('raceGrid').querySelector('.card[data-idx="' + i + '"]');
      if (!card) return;
      var inp = card.querySelector('input');
      if (!inp || inp.disabled) return;
      var raw = inp.value.trim();
      if (raw === '') return; // 空题不占答案，按未答处理
      var v = Number(raw);
      if (!isFinite(v)) return;
      answers.push({ position: i, value: Math.round(v) });
    });
    return answers;
  }

  function submitSheet() {
    if (!state || state.submitted) return;
    if (!send({ type: 'submit', answers: collectAnswers() })) {
      showError('disconnected');
      return;
    }
  }

  /* 服务端确认交卷：逐题打 ✓/✗，锁定棋盘并提示等待 */
  function onSubmitted(msg) {
    if (!state) return;
    state.submitted = true;
    // 服务端返回本张卷子的逐题判定，写回本地进度
    (msg.results || []).forEach(function (r) {
      if (r && state.per[r.position] && r.correct) state.per[r.position].correct = true;
    });
    markSubmittedBoard();
    lockBoard();
    var btn = $('raceSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = t('race.submitted'); }
    var hint = $('raceSubmitHint');
    if (hint) hint.textContent = t('race.waitingOthers', { n: msg.waitingFor || 0 });
    $('raceScoreDesc').textContent = t('race.submittedScore', {
      solved: msg.solved, total: msg.total
    });
    if (!msg.solved && msg.solved !== 0) { /* 兼容缺省 */ }
  }

  /* 交卷后逐题标记：答对 ✓，答错或未答 ✗（与服务端计分口径一致）。
   * 重连恢复已交卷的棋局时也走这里：solvedPositions 之外的一律视为未答对。 */
  function markSubmittedBoard() {
    if (!state || !state.problems) return;
    state.problems.forEach(function (q, i) {
      var ok = !!(state.per[i] && state.per[i].correct);
      markCard(i, ok ? 'correct' : 'wrong');
    });
  }

  function lockBoard() {
    var inputs = $('raceGrid').querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) inputs[i].disabled = true;
  }

  /* ---------- 结算 ---------- */
  function onGameOver(msg) {
    if (!state) return;
    stopClock();
    clearSeat();
    var ranking = msg.ranking || [];
    var total = msg.total || (state.problems ? state.problems.length : 0);
    var me = ranking.filter(function (r) { return r.seat === state.seat; })[0];
    var box = $('raceRanking');
    box.innerHTML = '';
    ranking.forEach(function (r) {
      var d = document.createElement('div');
      d.className = 'rank-row' + (r.rank === 1 ? ' win' : '');
      var medal = r.rank === 1 ? '🏆' : '#' + r.rank;
      d.innerHTML =
        '<span class="rank-no" aria-hidden="true">' + medal + '</span>' +
        '<span class="rank-avatar" aria-hidden="true">' + r.avatar + '</span>' +
        '<span class="rank-name"></span>' +
        '<span class="rank-meta">' + r.solved + '/' + total + ' · ' + Math.round(r.usedMs / 1000) + 's' +
        (r.submitted === false ? ' · ' + t('race.notSubmitted') : '') + '</span>';
      d.querySelector('.rank-name').textContent = r.name;
      box.appendChild(d);
    });
    $('raceResultTitle').textContent = me && me.rank === 1 ? t('race.win') : t('race.done');
    $('raceResultSub').textContent = me
      ? t('race.yourRank', { rank: me.rank, solved: me.solved, total: total })
      : t('race.doneSub');
    if (me && me.rank === 1 && !global.TMUI.reduceMotion()) global.TMUI.confetti();
    // Rematch 仅房主可见
    var isHost = state.room && state.room.hostSeat === state.seat;
    $('raceRematchBtn').hidden = !isHost;
    openRaceResult();
    // 有登录档案时，对局成绩已由服务端落库；这里只刷新一次首页统计入口
    if (global.TMAPI && global.TMAPI.refresh) global.TMAPI.refresh().then(function () { global.TMUI.refreshHome(); });
  }

  function openRaceResult() {
    var ov = $('raceResultOverlay');
    ov.classList.add('show');
    $('raceRematchBtn').focus();
  }
  function closeRaceResult() {
    $('raceResultOverlay').classList.remove('show');
  }

  /* ---------- 错误展示 ---------- */
  function showError(key) {
    global.TMUI.toast(t('race.err.' + key), true);
  }
  function onError(key) { showError(key); }

  /* ---------- 对外 API ---------- */
  var TMRace = {
    enter: function (opts) {
      opts = opts || {};
      // 已经连上就只切视图，避免重复开一条 WebSocket
      if (state && state.ws && state.ws.readyState === 1) {
        renderLobbyOptions();
        global.TMUI.showView('versus');
        return true;
      }
      state = { reconnectAttempt: 0, closed: false };
      renderLobbyOptions();
      global.TMUI.showView('versus');
      connect(function () {
        // 邀请链接 ?room=CODE：连上后自动加入
        var code = opts.code;
        if (!code) {
          var q = new URLSearchParams(location.search);
          code = (q.get('room') || '').toUpperCase();
        }
        if (code) {
          $('raceJoinCode').value = code;
          send({ type: 'join_room', code: code });
        } else {
          // 刷新后仍在房间：尝试用记忆的座位令牌回归
          var seat = readSeat();
          if (seat && seat.token) send({ type: 'join_room', code: seat.code, resumeToken: seat.token });
        }
      });
      return true;
    },
    create: function () {
      if (!send({ type: 'create_room', difficulty: settings.difficulty, count: settings.count })) {
        showError('disconnected');
      }
    },
    join: function (rawCode) {
      // 房间码是 3–5 个字母的简单单词（水果 / 动物 / 数字），大小写不敏感
      var code = String(rawCode || '').trim().toUpperCase();
      if (!/^[A-Z]{3,5}$/.test(code)) {
        global.TMUI.toast(t('race.err.badCode'), true);
        return;
      }
      send({ type: 'join_room', code: code });
    },
    start: function () { send({ type: 'start_game' }); },
    rematch: function () {
      closeRaceResult();
      send({ type: 'rematch' });
      global.TMUI.showView('lobby');
    },
    backToLobby: function () {
      closeRaceResult();
      global.TMUI.showView('versus');
      send({ type: 'leave' });
      clearSeat();
    },
    leave: function () {
      send({ type: 'leave' });
      clearSeat();
      stopClock();
      closeRaceResult();
      state = state || {};
      state.closed = true;
      if (state.ws) { try { state.ws.close(); } catch (e) { /* 忽略 */ } }
      state = null;
      global.TMUI.showView('home');
    },
    exitToHome: function () {
      global.TMUI.confirm(t('race.confirmLeave')).then(function (ok) {
        if (ok) TMRace.leave();
      });
    },
    isActive: function () { return !!(state && state.ws); }
  };

  /* ---------- 事件绑定 ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    /* 邀请链接 /play/?room=CODE：直接进大厅并自动加入 */
    var invited = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    if (/^[A-Z]{3,5}$/.test(invited)) {
      TMRace.enter({ code: invited });
    } else {
      /* 刷新 / 闪断后自动回归原座位（30 秒重连窗口内）。
       * 座位令牌只存在 sessionStorage：关掉标签页即失效，不构成长期凭据。 */
      var seat = readSeat();
      if (seat && seat.token) {
        state = { reconnectAttempt: 0, closed: false };
        connect(function () {
          send({ type: 'join_room', code: seat.code, resumeToken: seat.token });
        });
      }
    }

    $('cardVersus').addEventListener('click', function () { TMRace.enter(); });
    $('versusBack').addEventListener('click', function () {
      if (state && state.ws) { send({ type: 'leave' }); clearSeat(); state.closed = true; try { state.ws.close(); } catch (e) {} state = null; }
      global.TMUI.showView('home');
      global.TMUI.refreshHome();
    });
    $('raceCreateBtn').addEventListener('click', function () { TMRace.create(); });
    $('raceJoinBtn').addEventListener('click', function () { TMRace.join($('raceJoinCode').value); });
    $('raceJoinCode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); TMRace.join($('raceJoinCode').value); }
    });
    $('raceCopyBtn').addEventListener('click', copyInvite);
    $('raceStartBtn').addEventListener('click', function () { TMRace.start(); });
    $('lobbyLeaveBtn').addEventListener('click', function () { TMRace.leave(); });
    $('raceExitBtn').addEventListener('click', function () { TMRace.exitToHome(); });
    $('raceSubmitBtn').addEventListener('click', function () { submitSheet(); });
    $('raceRematchBtn').addEventListener('click', function () { TMRace.rematch(); });
    $('raceLobbyBtn').addEventListener('click', function () { TMRace.backToLobby(); });

    var grid = $('raceGrid');
    grid.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !state || !state.problems) return;
      if (!e.target.matches('input')) return;
      e.preventDefault();
      var i = Number(e.target.dataset.i);
      submitAnswer(i);
    });
    grid.addEventListener('input', function (e) {
      if (!state || !state.problems) return;
      if (!e.target.matches('input')) return;
      // 边输边报会浪费限速额度：只在长度达到答案可能的最小位数后自动提交由 Enter 负责，
      // 这里仅在用户清空时移除 ✗ 标记，避免误以为已判定
      var card = e.target.closest('.card');
      if (card && e.target.value.trim() === '') card.classList.remove('wrong');
    });
  });

  global.TMRace = TMRace;
})(typeof window !== 'undefined' ? window : globalThis);
