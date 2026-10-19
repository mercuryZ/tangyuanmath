/* Tangyuan Math — 家长中心逻辑（M1）
 * 登录/注册/忘记密码/重置/邮箱验证 + 档案 + 云统计 + 云错题 + 游客导入 + 导出/删号。
 * 错误提示：服务端返回稳定 code（DESIGN 4.1），此处映射常用提示，兜底显示 code。
 */
(function (global) {
  'use strict';

  function t(key, vars) { return global.TMI18N.t(key, vars); }
  function $(id) { return document.getElementById(id); }

  var ERR_MAP = {
    login_failed: { en: 'Email or password is incorrect.', zh: '邮箱或密码不正确。' },
    email_taken: { en: 'This email is already registered.', zh: '该邮箱已注册。' },
    weak_password: { en: 'Password must be at least 8 characters.', zh: '密码至少 8 位。' },
    invalid_email: { en: 'Please enter a valid email address.', zh: '请输入有效的邮箱地址。' },
    rate_limited: { en: 'Too many attempts — please wait a minute.', zh: '尝试过于频繁，请稍等一分钟。' },
    profile_limit: { en: 'One child profile for now.', zh: '目前支持一个儿童档案。' },
    invalid_nickname: { en: 'Nickname must be 1–20 characters.', zh: '昵称需 1–20 个字符。' },
    network_error: { en: 'Network error — is the server running?', zh: '网络错误——服务器是否在运行？' },
    email_unverified_exists: {
      en: 'This email already has a password account that is not verified yet. Sign in with the password first, verify the email, then Google sign-in will connect automatically.',
      zh: '该邮箱已用密码注册但尚未完成邮箱验证。请先用密码登录并验证邮箱，之后 Google 登录会自动关联。'
    },
    google_not_configured: {
      en: 'Google sign-in is not configured on this server yet.',
      zh: '此服务器尚未配置 Google 登录。'
    },
    google_error: { en: 'Google sign-in was cancelled or failed. Please try again.', zh: 'Google 登录已取消或失败，请重试。' },
    google_invalid: { en: 'Invalid Google sign-in response.', zh: 'Google 登录响应无效。' },
    invalid_state: { en: 'Sign-in session expired — please try again.', zh: '登录会话已过期，请重试。' },
    exchange_failed: { en: 'Could not reach Google. Please try again.', zh: '无法连接 Google，请重试。' },
    google_email_unverified: { en: 'Google reports this email as not verified.', zh: 'Google 显示该邮箱未验证。' }
  };
  function errMsg(r) {
    if (r && r.code && ERR_MAP[r.code]) return ERR_MAP[r.code][TMI18N.lang()] || ERR_MAP[r.code].en;
    return t('acct.errorPrefix', { code: (r && r.code) || 'unknown' });
  }

  var AVATARS = [
    { key: 'tangyuan', emoji: '🍡' }, { key: 'star', emoji: '⭐️' }, { key: 'heart', emoji: '❤️' },
    { key: 'flower', emoji: '🌸' }, { key: 'moon', emoji: '🌙' }, { key: 'sun', emoji: '☀️' }
  ];
  var selectedAvatar = 'tangyuan';

  var toastTimer;
  function toast(msg, isErr) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast' + (isErr ? ' err' : ''); }, 2600);
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    var el = $('view-' + name);
    if (el) el.classList.add('active');
  }

  /* ---------- 认证表单（tab 切换） ---------- */
  var authMode = 'login'; // login | register | forgot | reset
  function setAuthMode(mode) {
    authMode = mode;
    ['tabLogin', 'tabRegister', 'tabForgot'].forEach(function (id, i) {
      $(id).setAttribute('aria-selected', ['login', 'register', 'forgot'][i] === mode ? 'true' : 'false');
    });
    $('passwordField').hidden = mode === 'forgot';
    $('pwdHint').hidden = mode !== 'register';
    $('authSubmit').textContent = t({
      login: 'acct.loginBtn', register: 'acct.registerBtn', forgot: 'acct.sendResetBtn', reset: 'acct.resetBtn'
    }[mode]);
    $('authPassword').setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
    $('formMsg').textContent = '';
  }

  async function submitAuth(e) {
    e.preventDefault();
    var email = $('authEmail').value.trim();
    var pw = $('authPassword').value;
    var r;
    if (authMode === 'login') r = await global.TMAPI.login(email, pw);
    else if (authMode === 'register') r = await global.TMAPI.register(email, pw, TMI18N.lang(), guessTz());
    else if (authMode === 'forgot') r = await global.TMAPI.forgotPassword(email);
    if (!r.ok) { $('formMsg').textContent = errMsg(r); return; }
    if (authMode === 'login') { await renderMain(); return; }
    $('formMsg').textContent = t(authMode === 'register' ? 'acct.registerHint' : 'acct.forgotHint');
    $('authEmail').value = ''; $('authPassword').value = '';
  }

  function guessTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }

  /* ---------- 已登录主视图 ---------- */
  async function renderMain() {
    var st = await global.TMAPI.refresh();
    if (!st.user) { showView('auth'); setAuthMode('login'); return; }
    showView('main');

    $('meEmail').textContent = st.user.email;
    var v = $('meVerified');
    v.textContent = t(st.user.emailVerified ? 'acct.verified' : 'acct.unverified');
    v.className = 'badge-ok' + (st.user.emailVerified ? '' : ' off');
    var sup = $('meSupporter'); // Supporter 徽章（M2）：entitlements 含 pdf_worksheet 即显示
    var ents = st.entitlements || [];
    sup.hidden = ents.indexOf('pdf_worksheet') === -1;
    sup.href = global.TMI18N && global.TMI18N.lang() === 'zh' ? '/zh/worksheets/' : '/en/worksheets/';

    renderTzSelect(st.user.timezone);
    renderProfile(st);
    renderStats();
    renderWrongbook();
    renderImport();
  }

  function renderTzSelect(current) {
    var sel = $('tzSelect');
    var zones = [];
    try { zones = Intl.supportedValuesOf('timeZone') || []; } catch (e) { zones = []; }
    if (!zones.length) zones = ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
    if (zones.indexOf(current) === -1) zones.unshift(current);
    sel.innerHTML = '';
    zones.forEach(function (z) {
      var o = document.createElement('option');
      o.value = z; o.textContent = z;
      if (z === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = async function () {
      var r = await global.TMAPI.updateMe({ timezone: sel.value });
      if (r.ok) toast('OK'); else toast(errMsg(r), true);
    };
  }

  function renderProfile(st) {
    var p = st.profiles && st.profiles[0];
    $('profileNickname').value = p ? p.nickname : '';
    selectedAvatar = p ? p.avatarKey : 'tangyuan';
    renderAvatarOptions();
    $('profileSubmit').textContent = t(p ? 'acct.saveProfile' : 'acct.createProfile');
    $('deleteProfileBtn').hidden = !p;
    $('importGroup').hidden = !p;
  }

  function renderAvatarOptions() {
    var box = $('avatarOptions');
    box.innerHTML = '';
    AVATARS.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatar-opt';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', a.key === selectedAvatar ? 'true' : 'false');
      b.setAttribute('aria-label', a.key);
      b.textContent = a.emoji;
      b.addEventListener('click', function () { selectedAvatar = a.key; renderAvatarOptions(); });
      box.appendChild(b);
    });
  }

  async function submitProfile(e) {
    e.preventDefault();
    var nick = $('profileNickname').value.trim();
    var st = global.TMAPI.state;
    var existing = st.profiles && st.profiles[0];
    var r = existing
      ? await global.TMAPI.updateProfile(existing.id, { nickname: nick, avatarKey: selectedAvatar })
      : await global.TMAPI.createProfile(nick, selectedAvatar);
    if (!r.ok) { toast(errMsg(r), true); return; }
    toast('OK');
    renderMain();
  }

  function pct(x) { return x === null ? '—' : Math.round(x * 100) + '%'; }
  function fmtMs(ms) { return ms === null ? '—' : (ms / 1000).toFixed(1) + 's'; }

  async function renderStats() {
    var box = $('statsBody');
    box.innerHTML = '<p class="hint">' + t('acct.loading') + '</p>';
    var r = await global.TMAPI.getStats();
    if (!r.ok) { box.innerHTML = '<p class="hint">' + errMsg(r) + '</p>'; return; }
    var d = r.data;
    if (!d.groups.length) { box.innerHTML = '<p class="hint">' + t('acct.statsNodata') + '</p>'; }
    else {
      var html = '<p class="stats-line"><b>' + t('acct.streak') + ': ' + d.streakDays + ' ' + t('acct.days') +
        '</b> · ' + t('acct.activeDays') + ': ' + d.activeDays + '</p>';
      d.groups.forEach(function (g) {
        html += '<p class="stats-line">' + t('stats.mode.' + g.mode) + ' · ' + g.difficulty +
          ' — ' + t('stats.rounds') + ': <b>' + g.rounds + '</b>, ' +
          t('stats.firstAccuracy') + ': <b>' + pct(g.firstAccuracy) + '</b>, ' +
          t('stats.finalCompletion') + ': <b>' + pct(g.finalCompletion) + '</b>, ' +
          t('stats.avgActive') + ': <b>' + fmtMs(g.avgActiveMs) + '</b></p>';
      });
      box.innerHTML = html;
    }
    renderVersusStats(box);
  }

  /* 对战战绩（DESIGN 13.1：私密，只显示给本人，不公开排行榜） */
  async function renderVersusStats(box) {
    var pid = global.TMAPI.state.currentProfileId;
    if (!pid) return;
    var r = await global.TMAPI.call('GET', '/api/profiles/' + pid + '/versus');
    if (!r.ok) return;
    var d = r.data;
    var p = document.createElement('p');
    p.className = 'stats-line';
    p.innerHTML = '<b>' + t('stats.mode.versus') + '</b> — ' +
      t('acct.versusWins') + ': <b>' + d.wins + '</b>, ' +
      t('acct.versusLosses') + ': <b>' + d.losses + '</b>, ' +
      t('stats.rounds') + ': <b>' + d.matches + '</b>';
    box.appendChild(p);
    if (!d.matches) {
      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = t('acct.versusHint');
      box.appendChild(hint);
    }
  }

  async function renderWrongbook() {
    var box = $('wrongbookBody');
    box.innerHTML = '<p class="hint">' + t('acct.loading') + '</p>';
    var r = await global.TMAPI.getWrongbook();
    if (!r.ok) { box.innerHTML = '<p class="hint">' + errMsg(r) + '</p>'; return; }
    var items = r.data.items;
    if (!items.length) {
      box.innerHTML = '<p class="hint">' + t('acct.wrongbookEmpty') + '</p><p class="hint">' + t('acct.wrongbookHint') + '</p>';
      return;
    }
    box.innerHTML = '';
    var list = document.createElement('div');
    list.className = 'wb-list';
    items.forEach(function (w) {
      var it = document.createElement('span');
      it.className = 'wb-item';
      it.innerHTML = w.a + ' × ' + w.b + '<span class="wb-n">×' + w.wrongCount + '</span>' +
        ' <button class="wb-remove" type="button" data-id="' + w.id + '" aria-label="' + t('acct.remove') + '">✕</button>';
      list.appendChild(it);
    });
    box.appendChild(list);
    list.addEventListener('click', async function (e) {
      var btn = e.target.closest('.wb-remove');
      if (!btn) return;
      var r2 = await global.TMAPI.call('DELETE', '/api/profiles/' + global.TMAPI.state.currentProfileId + '/wrongbook/' + btn.dataset.id);
      if (r2.ok) renderWrongbook();
      else toast(errMsg(r2), true);
    });
  }

  function renderImport() {
    var local = global.TMRecords.load(null, global.TMRecords.KEYS.records);
    var group = $('importGroup');
    if (!global.TMAPI.state.currentProfileId || local.length === 0) { group.hidden = true; return; }
    group.hidden = false;
    $('importDesc').textContent = t('acct.importDesc', { n: local.length });
  }

  async function doImport() {
    var local = global.TMRecords.load(null, global.TMRecords.KEYS.records);
    if (!local.length) return;
    $('importBtn').disabled = true;
    var r = await global.TMAPI.importLocalRecords(local);
    $('importBtn').disabled = false;
    if (!r.ok) { $('importResult').textContent = errMsg(r); return; }
    var ok = 0, dup = 0, bad = 0;
    r.data.results.forEach(function (x) {
      if (x.result === 'inserted') ok++;
      else if (x.result === 'duplicate') dup++;
      else bad++;
    });
    $('importResult').textContent = t('acct.importDone', { ok: ok, dup: dup, bad: bad });
    renderStats();
  }

  /* ---------- 初始化 ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    TMI18N.setLang(TMI18N.lang(), false);
    ['langEn', 'langZh'].forEach(function (id) {
      $(id).addEventListener('click', function () {
        TMI18N.setLang(id === 'langEn' ? 'en' : 'zh');
        location.reload(); // 整页重渲染，保证所有文案切换
      });
    });
    $('tabLogin').addEventListener('click', function () { setAuthMode('login'); });
    $('tabRegister').addEventListener('click', function () { setAuthMode('register'); });
    $('tabForgot').addEventListener('click', function () { setAuthMode('forgot'); });
    $('authForm').addEventListener('submit', submitAuth);
    $('profileForm').addEventListener('submit', submitProfile);
    $('logoutBtn').addEventListener('click', async function () { await global.TMAPI.logout(); location.reload(); });
    $('logoutAllBtn').addEventListener('click', async function () { await global.TMAPI.logoutAll(); location.reload(); });
    $('deleteProfileBtn').addEventListener('click', async function () {
      var st = global.TMAPI.state;
      var p = st.profiles && st.profiles[0];
      if (!p || !confirm(t('acct.deleteProfileConfirm'))) return;
      var r = await global.TMAPI.deleteProfile(p.id);
      if (r.ok) renderMain(); else toast(errMsg(r), true);
    });
    $('importBtn').addEventListener('click', doImport);
    $('deleteAccountBtn').addEventListener('click', async function () {
      if (!confirm(t('acct.deleteConfirm'))) return;
      var r = await global.TMAPI.deleteAccount();
      if (r.ok) { alert(t('acct.deleted')); location.reload(); }
      else toast(errMsg(r), true);
    });

    /* 邮箱验证 / 密码重置：?token=…&mode=verify|reset */
    var q = new URLSearchParams(location.search);
    var token = q.get('token');
    var mode = q.get('mode') || 'verify';

    /* Google 登录按钮：仅当服务端已配置时显示（?authError= 回跳时也显示，便于重试） */
    global.TMAPI.call('GET', '/api/me').then(function (r) {
      var enabled = r.ok && r.data && r.data.authMethods && r.data.authMethods.google;
      document.getElementById('googleRow').hidden = !(enabled || q.get('authError'));
    });

    /* Google 登录失败回跳：?authError=<code> */
    if (q.get('authError')) {
      showView('auth');
      setAuthMode('login');
      $('formMsg').textContent = errMsg({ code: q.get('authError') });
    }

    if (token && mode === 'verify') {
      showView('token');
      global.TMAPI.verifyEmail(token).then(function (r) {
        $('tokenMsg').textContent = t(r.ok ? 'acct.verifySuccess' : 'acct.verifyFail');
        if (!r.ok) $('tokenMsg').textContent += ' (' + errMsg(r) + ')';
      });
    } else if (token && mode === 'reset') {
      showView('token');
      $('tokenTitle').textContent = t('acct.tabForgot');
      $('tokenMsg').textContent = t('acct.pwdHint');
      $('resetFormWrap').hidden = false;
      $('resetForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var r = await global.TMAPI.resetPassword(token, $('resetPassword').value);
        if (r.ok) {
          $('resetFormWrap').hidden = true;
          $('tokenMsg').textContent = t('acct.resetSuccess');
          setTimeout(function () { location.href = '/account/'; }, 1500);
        } else {
          $('tokenMsg').textContent = errMsg(r);
        }
      });
    } else {
      renderMain();
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
