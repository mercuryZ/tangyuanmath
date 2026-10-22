/* Tangyuan Math — 家长中心逻辑（M1 / 家庭会员）
 * 家长：登录/注册/忘记密码/重置/邮箱验证 + 会员 + 家庭邀请 + 子女账号 + 云端数据。
 * 子女：用户名 + 密码登录，登录后只显示简化视图。
 * 错误提示：服务端返回稳定 code（DESIGN 4.1），此处映射常用提示，兜底显示 code。
 */
(function (global) {
  'use strict';

  function t(key, vars) { return global.TMI18N.t(key, vars); }
  function $(id) { return document.getElementById(id); }

  var ERR_MAP = {
    login_failed: { en: 'Email or password is incorrect.', zh: '邮箱或密码不正确。' },
    child_login_failed: { en: 'Username or password is incorrect.', zh: '用户名或密码不正确。' },
    email_taken: { en: 'This email is already registered.', zh: '该邮箱已注册。' },
    weak_password: { en: 'Password must be at least 8 characters.', zh: '密码至少 8 位。' },
    invalid_email: { en: 'Please enter a valid email address.', zh: '请输入有效的邮箱地址。' },
    rate_limited: { en: 'Too many attempts — please wait a minute.', zh: '尝试过于频繁，请稍等一分钟。' },
    profile_limit: { en: 'A family can have up to 2 child accounts.', zh: '一个家庭最多 2 个子女账号。' },
    invalid_nickname: { en: 'Nickname must be 1–20 characters.', zh: '昵称需 1–20 个字符。' },
    invalid_username: {
      en: 'Username must be 3–20 characters: letters, numbers, dots, dashes or underscores.',
      zh: '用户名需 3–20 位，可用字母、数字、点、短横线或下划线。'
    },
    username_taken: { en: 'That username is already taken.', zh: '该用户名已被使用。' },
    username_required: { en: 'Enter a username before setting a password.', zh: '设置密码前请先填写用户名。' },
    membership_required: {
      en: 'This needs an active Supporter membership.',
      zh: '这需要有效的支持者会员。'
    },
    family_full: { en: 'This family already has 2 parents.', zh: '这个家庭已经有 2 位家长了。' },
    already_in_family: {
      en: 'Your account already belongs to a family with children or paid access.',
      zh: '你的账号已属于一个有子女或付费权益的家庭。'
    },
    already_member: { en: 'This person is already in your family.', zh: '对方已经在这个家庭里了。' },
    invite_email_mismatch: {
      en: 'This invitation was sent to a different email address.',
      zh: '这个邀请是发给另一个邮箱的。'
    },
    invite_expired: { en: 'This invitation has expired.', zh: '邀请已过期。' },
    invalid_invite: { en: 'This invitation is invalid or has expired.', zh: '邀请无效或已过期。' },
    invite_invalid: { en: 'This invitation is invalid or has expired.', zh: '邀请无效或已过期。' },
    email_unverified: {
      en: 'Verify your email first — we sent a link when you registered.',
      zh: '请先完成邮箱验证——注册时我们已发送验证链接。'
    },
    owner_only: { en: 'Only the family owner can do that.', zh: '只有家庭创建者可以执行此操作。' },
    parent_only: { en: 'This page is for parent accounts.', zh: '此页面仅供家长账号使用。' },
    invalid_avatar: { en: 'Unknown avatar.', zh: '未知头像。' },
    nothing_to_update: { en: 'Nothing to update.', zh: '没有需要修改的内容。' },
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
  var googleEnabled = false;
  var inviteAttempted = false;
  var initialAuthMode = 'login'; // ?mode=register|student|login

  function avatarEmoji(key) {
    for (var i = 0; i < AVATARS.length; i++) if (AVATARS[i].key === key) return AVATARS[i].emoji;
    return AVATARS[0].emoji;
  }

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

  function fmtDate(ts) {
    try {
      return new Intl.DateTimeFormat(TMI18N.lang() === 'zh' ? 'zh-CN' : 'en-US',
        { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ts));
    } catch (e) { return new Date(ts).toISOString().slice(0, 10); }
  }
  function pricingUrl() { return TMI18N.lang() === 'zh' ? '/zh/pricing/' : '/en/pricing/'; }
  function worksheetsUrl() { return TMI18N.lang() === 'zh' ? '/zh/worksheets/' : '/en/worksheets/'; }

  /* ---------- 认证表单（tab 切换） ---------- */
  var authMode = 'login'; // login | register | forgot | student
  function setAuthMode(mode) {
    authMode = mode;
    var modes = ['login', 'register', 'student', 'forgot'];
    ['tabLogin', 'tabRegister', 'tabStudent', 'tabForgot'].forEach(function (id, i) {
      $(id).setAttribute('aria-selected', modes[i] === mode ? 'true' : 'false');
    });
    var isStudent = mode === 'student';
    $('authForm').hidden = isStudent;
    $('studentForm').hidden = !isStudent;
    $('registerOffer').hidden = mode !== 'register';
    $('googleRow').hidden = isStudent || !googleEnabled;
    if (!isStudent) {
      $('passwordField').hidden = mode === 'forgot';
      $('pwdHint').hidden = mode !== 'register';
      $('authSubmit').textContent = t({
        login: 'acct.loginBtn', register: 'acct.registerBtn', forgot: 'acct.sendResetBtn', reset: 'acct.resetBtn'
      }[mode]);
      $('authPassword').setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
      $('formMsg').textContent = '';
    } else {
      $('studentMsg').textContent = '';
    }
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

  async function submitStudent(e) {
    e.preventDefault();
    var r = await global.TMAPI.childLogin($('studentUsername').value.trim(), $('studentPassword').value);
    if (!r.ok) { $('studentMsg').textContent = errMsg(r); return; }
    location.href = '/play/';
  }

  function guessTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }

  /* ---------- 邀请 / 登录后跳转 ---------- */
  function setInviteFlag() {
    try { sessionStorage.setItem('tm_invite_pending', '1'); } catch (e) { /* 忽略 */ }
  }
  function hasInviteFlag() {
    try { return sessionStorage.getItem('tm_invite_pending') === '1'; } catch (e) { return false; }
  }
  function clearInviteFlag() {
    try { sessionStorage.removeItem('tm_invite_pending'); } catch (e) { /* 忽略 */ }
  }

  /* 登录后接受邀请（令牌在 HttpOnly Cookie 里，客户端无需读取） */
  async function maybeAcceptInvite() {
    if (!hasInviteFlag() || inviteAttempted) return false;
    inviteAttempted = true;
    var token = null;
    try { token = sessionStorage.getItem('tm_invite_token'); } catch (e) { /* 忽略 */ }
    var r = await global.TMAPI.acceptInvite(token);
    if (r.ok) {
      clearInviteFlag();
      try { sessionStorage.removeItem('tm_invite_token'); } catch (e) { /* 忽略 */ }
      toast(t('acct.inviteJoined'), false);
      return true;
    }
    if (r.code === 'email_unverified') {
      toast(errMsg(r), true);
      return false;
    }
    clearInviteFlag();
    if (r.code !== 'invalid_invite' && r.code !== 'invite_invalid') toast(errMsg(r), true);
    return false;
  }

  function maybeRedirectNext() {
    var next = null;
    try { next = localStorage.getItem('tm_next'); } catch (e) { /* 忽略 */ }
    if (!next || next.charAt(0) !== '/' || next.indexOf('/account') === 0) return false;
    try { localStorage.removeItem('tm_next'); } catch (e) { /* 忽略 */ }
    location.href = next;
    return true;
  }

  /* ---------- 已登录主视图 ---------- */
  async function renderMain() {
    var st = await global.TMAPI.refresh();

    if (st.child) { renderChildView(st); return; }
    if (!st.user) { showView('auth'); setAuthMode(initialAuthMode); return; }

    if (hasInviteFlag()) {
      var joined = await maybeAcceptInvite();
      if (joined) st = global.TMAPI.state;
    }
    if (maybeRedirectNext()) return;

    showView('main');
    $('meEmail').textContent = st.user.email;
    var v = $('meVerified');
    v.textContent = t(st.user.emailVerified ? 'acct.verified' : 'acct.unverified');
    v.className = 'badge-ok' + (st.user.emailVerified ? '' : ' off');

    var sup = $('meSupporter');
    sup.hidden = !(st.membership && st.membership.active);
    sup.href = worksheetsUrl();

    $('adminLink').hidden = !st.user.isAdmin; // TM_ADMIN_EMAILS 内的家长才显示管理入口

    renderMembership(st);
    renderFamily(st);
    renderChildren(st);
    renderTzSelect(st.user.timezone);
    renderStats();
    renderWrongbook();
    renderImport();
  }

  function renderChildView(st) {
    showView('child');
    $('childTitle').textContent = t('acct.childSignedIn', { name: st.child.nickname });
    $('childSub').textContent = t('acct.childSub');
  }

  function renderMembership(st) {
    var m = st.membership || { active: false };
    var status = $('membershipStatus');
    var hint = $('membershipHint');
    if (!m.active) {
      status.textContent = t('acct.membershipNone');
      hint.textContent = t('acct.membershipHintNone');
    } else if (m.expiresAt === null) {
      status.textContent = t('acct.membershipLifetime');
      hint.textContent = t('acct.membershipHintActive');
    } else {
      status.textContent = t('acct.membershipActive', { date: fmtDate(m.expiresAt) });
      hint.textContent = t('acct.membershipHintActive');
    }
    renderSubscription(m.subscription);
    renderBillingPortal(m);
    $('membershipLink').href = pricingUrl();
  }

  /* Waffo 客户门户：取消订阅、更新支付方式、查看账单、提交退款申请。
   * 链接是 bearer token，服务端每次点击即时签发，前端只负责在用户手势中打开新标签页。 */
  function renderBillingPortal(m) {
    var btn = $('billingPortalBtn');
    btn.hidden = !(m && m.hasOrders);
    btn.onclick = async function () {
      // 同步打开空白标签页，避免异步请求后弹窗被拦截
      var win = window.open('', '_blank');
      btn.disabled = true;
      var r = await global.TMAPI.call('POST', '/api/orders/portal');
      btn.disabled = false;
      if (!r.ok) {
        if (win) win.close();
        toast(errMsg(r), true);
        return;
      }
      if (!win) { toast(t('acct.portalPopupBlocked'), true); return; }
      win.opener = null;
      win.location.href = r.data.portalUrl;
    };
  }

  /* 订阅续费状态与取消入口（Waffo Pancake；取消后本周期仍可用） */
  function renderSubscription(sub) {
    var line = $('subscriptionStatus');
    var btn = $('cancelRenewalBtn');
    line.hidden = true;
    btn.hidden = true;
    btn.onclick = null;
    if (!sub) return;

    if (sub.status === 'canceling') {
      line.textContent = sub.currentPeriodEnd
        ? t('acct.subscriptionCanceling', { date: fmtDate(sub.currentPeriodEnd) })
        : t('acct.subscriptionCancelingNoDate');
      line.hidden = false;
      return;
    }
    if (sub.status === 'past_due') {
      line.textContent = t('acct.subscriptionPastDue');
      line.hidden = false;
    } else if (sub.currentPeriodEnd) {
      line.textContent = t('acct.subscriptionRenews', { date: fmtDate(sub.currentPeriodEnd) });
      line.hidden = false;
    }
    if ((sub.status === 'paid' || sub.status === 'past_due') && sub.orderNo) {
      btn.hidden = false;
      btn.onclick = async function () {
        if (!confirm(t('acct.cancelRenewalConfirm'))) return;
        btn.disabled = true;
        var r = await global.TMAPI.call('POST', '/api/orders/' + encodeURIComponent(sub.orderNo) + '/cancel');
        btn.disabled = false;
        if (!r.ok) { toast(errMsg(r), true); return; }
        toast(t('acct.cancelRenewalDone'), false);
        await renderMain();
      };
    }
  }

  /* 支付成功返回页：只轮询本店订单状态，不依据 URL 直接开通权益 */
  function watchCheckoutOrder(orderNo) {
    var started = Date.now();
    var timer = setInterval(async function () {
      if (Date.now() - started > 10 * 60 * 1000) { clearInterval(timer); return; }
      var r = await global.TMAPI.call('GET', '/api/orders/' + encodeURIComponent(orderNo));
      if (r.ok && r.data && ['paid', 'canceling', 'past_due'].indexOf(r.data.status) !== -1) {
        clearInterval(timer);
        toast(t('acct.checkoutSuccess'), false);
        await global.TMAPI.refresh();
        if (!global.TMAPI.state.child) renderMain();
      }
    }, 3000);
  }

  function parentRow(p) {
    var row = document.createElement('div');
    row.className = 's-row';
    var email = document.createElement('span');
    email.textContent = p.email;
    var badge = document.createElement('span');
    badge.className = 'badge-ok';
    badge.textContent = t(p.role === 'owner' ? 'acct.parentOwner' : 'acct.parentCoparent');
    row.appendChild(email);
    row.appendChild(badge);
    return row;
  }

  function renderFamily(st) {
    var fam = st.family || { seats: {} };
    var seats = fam.seats || {};
    $('familySeats').textContent = t('acct.familySeats', {
      parents: seats.parents || 0, maxParents: seats.maxParents || 2,
      children: seats.children || 0, maxChildren: seats.maxChildren || 2
    });

    var parentsBox = $('familyParents');
    parentsBox.innerHTML = '';
    (fam.parents || []).forEach(function (p) { parentsBox.appendChild(parentRow(p)); });

    var canInvite = st.user.familyRole === 'owner' && seats.parents < 2 &&
      st.membership && st.membership.active && st.user.emailVerified;
    $('inviteWrap').hidden = !canInvite;

    global.TMAPI.getFamily().then(function (r) {
      if (!r.ok) return;
      renderInvites(r.data.invites || []);
    });
  }

  function renderInvites(invites) {
    var box = $('inviteList');
    var wrap = $('invitesWrap');
    box.innerHTML = '';
    if (!invites.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    invites.forEach(function (inv) {
      var row = document.createElement('div');
      row.className = 's-row';
      var label = document.createElement('span');
      label.textContent = t('acct.invitePending') + ': ' + inv.email + ' · ' + fmtDate(inv.expiresAt);
      row.appendChild(label);
      if (global.TMAPI.state.user && global.TMAPI.state.user.familyRole === 'owner') {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 's-btn danger';
        btn.textContent = t('acct.revokeInvite');
        btn.addEventListener('click', async function () {
          var r = await global.TMAPI.revokeInvite(inv.id);
          if (r.ok) renderMain(); else toast(errMsg(r), true);
        });
        row.appendChild(btn);
      }
      box.appendChild(row);
    });
  }

  async function submitInvite(e) {
    e.preventDefault();
    var email = $('inviteEmail').value.trim();
    var r = await global.TMAPI.inviteParent(email);
    if (!r.ok) { $('inviteMsg').textContent = errMsg(r); return; }
    $('inviteMsg').textContent = t('acct.inviteSent');
    $('inviteEmail').value = '';
    renderMain();
  }

  /* ---------- 优惠码兑换 ---------- */
  var REDEEM_ERRORS = {
    code_not_found: 'acct.redeemCodeNotFound',
    code_used: 'acct.redeemCodeUsed',
    code_expired: 'acct.redeemCodeExpired'
  };
  async function submitRedeem(e) {
    e.preventDefault();
    var msg = $('redeemMsg');
    msg.textContent = '';
    var code = $('redeemCode').value.trim();
    if (!code) return;
    var r = await global.TMAPI.call('POST', '/api/redeem', { code: code });
    if (!r.ok) { msg.textContent = REDEEM_ERRORS[r.code] ? t(REDEEM_ERRORS[r.code]) : errMsg(r); return; }
    msg.textContent = t('acct.redeemOk');
    $('redeemCode').value = '';
    toast(t('acct.redeemOk'));
    renderMain();
  }

  /* ---------- 子女账号 ---------- */
  function renderChildren(st) {
    var list = $('childrenList');
    list.innerHTML = '';
    var profiles = st.profiles || [];
    profiles.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 's-row child-row';

      var info = document.createElement('span');
      var name = document.createElement('b');
      name.textContent = avatarEmoji(p.avatarKey) + ' ' + p.nickname;
      info.appendChild(name);
      var meta = document.createElement('small');
      meta.className = 'hint';
      meta.textContent = p.hasLogin
        ? t('acct.childHasLogin') + ': ' + p.username
        : t('acct.childNoLogin');
      info.appendChild(meta);

      var actions = document.createElement('span');
      var edit = document.createElement('button');
      edit.type = 'button'; edit.className = 's-btn'; edit.textContent = t('acct.childEdit');
      edit.addEventListener('click', function () { openChildForm(p); });
      var view = document.createElement('button');
      view.type = 'button'; view.className = 's-btn'; view.textContent = t('acct.childViewData');
      view.addEventListener('click', function () {
        global.TMAPI.selectProfile(p.id);
        renderStats(); renderWrongbook(); renderImport();
        updateStatsChild(p);
      });
      var del = document.createElement('button');
      del.type = 'button'; del.className = 's-btn danger'; del.textContent = t('acct.childDelete');
      del.addEventListener('click', async function () {
        if (!confirm(t('acct.childDeleteConfirm'))) return;
        var r = await global.TMAPI.deleteProfile(p.id);
        if (r.ok) renderMain(); else toast(errMsg(r), true);
      });
      actions.appendChild(edit); actions.appendChild(view); actions.appendChild(del);

      card.appendChild(info); card.appendChild(actions);
      list.appendChild(card);
    });

    var seats = (st.family && st.family.seats) || {};
    var atLimit = (seats.children || 0) >= (seats.maxChildren || 2);
    var canAdd = !atLimit && st.membership && st.membership.active && st.user.emailVerified;
    $('addChildBtn').disabled = !canAdd;
    $('addChildBtn').textContent = atLimit ? t('acct.childLimit')
      : (!st.user.emailVerified ? t('acct.childVerifyFirst')
        : (!(st.membership && st.membership.active) ? t('acct.childAddingLocked') : t('acct.childAdd')));

    var selected = profiles.find(function (p) { return p.id === st.currentProfileId; }) || profiles[0];
    updateStatsChild(selected);
    $('childForm').hidden = true;
  }

  function updateStatsChild(profile) {
    $('statsChild').textContent = profile
      ? t('acct.selectedChild') + ': ' + profile.nickname
      : '';
  }

  function renderAvatarOptions() {
    var box = $('childAvatarOptions');
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

  function openChildForm(profile) {
    $('childId').value = profile ? profile.id : '';
    $('childNickname').value = profile ? profile.nickname : '';
    $('childUsername').value = profile ? (profile.username || '') : '';
    $('childPassword').value = '';
    selectedAvatar = profile ? profile.avatarKey : 'tangyuan';
    renderAvatarOptions();
    $('childSubmit').textContent = t(profile ? 'acct.childSave' : 'acct.childAdd');
    $('childMsg').textContent = '';
    $('childForm').hidden = false;
    $('childNickname').focus();
  }

  async function submitChild(e) {
    e.preventDefault();
    var id = $('childId').value;
    var nick = $('childNickname').value.trim();
    var username = $('childUsername').value.trim();
    var password = $('childPassword').value;
    var msg = $('childMsg');

    if (username && password.length < 8) { msg.textContent = t('acct.pwdHint'); return; }
    if (password && !username) { msg.textContent = errMsg({ code: 'username_required' }); return; }

    var r;
    if (!id) {
      r = await global.TMAPI.createProfile(nick, selectedAvatar, username, password);
    } else {
      var current = (global.TMAPI.state.profiles || []).find(function (p) { return String(p.id) === String(id); });
      var usernameChanged = !!username && (!current || current.username !== username);
      if (usernameChanged && !password) { msg.textContent = t('acct.childPasswordHint'); return; }
      r = await global.TMAPI.updateProfile(id, { nickname: nick, avatarKey: selectedAvatar });
      if (r.ok && (usernameChanged || password)) {
        r = await global.TMAPI.setChildCredentials(id, username || (current && current.username), password);
      }
    }
    if (!r.ok) { msg.textContent = errMsg(r); return; }
    toast('OK');
    renderMain();
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

  function pct(x) { return x === null ? '—' : Math.round(x * 100) + '%'; }
  function fmtMs(ms) { return ms === null ? '—' : (ms / 1000).toFixed(1) + 's'; }

  async function renderStats() {
    var box = $('statsBody');
    if (!global.TMAPI.state.currentProfileId) {
      box.innerHTML = '<p class="hint">' + t('acct.profileEmpty') + '</p>';
      return;
    }
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
    if (!global.TMAPI.state.currentProfileId) { box.innerHTML = ''; return; }
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
        location.reload();
      });
    });
    $('tabLogin').addEventListener('click', function () { setAuthMode('login'); });
    $('tabRegister').addEventListener('click', function () { setAuthMode('register'); });
    $('tabStudent').addEventListener('click', function () { setAuthMode('student'); });
    $('tabForgot').addEventListener('click', function () { setAuthMode('forgot'); });
    $('authForm').addEventListener('submit', submitAuth);
    $('studentForm').addEventListener('submit', submitStudent);
    $('inviteForm').addEventListener('submit', submitInvite);
    $('redeemForm').addEventListener('submit', submitRedeem);
    $('childForm').addEventListener('submit', submitChild);
    $('addChildBtn').addEventListener('click', function () { openChildForm(null); });
    $('childCancel').addEventListener('click', function () { $('childForm').hidden = true; });
    $('logoutBtn').addEventListener('click', async function () { await global.TMAPI.logout(); location.reload(); });
    $('logoutAllBtn').addEventListener('click', async function () { await global.TMAPI.logoutAll(); location.reload(); });
    $('childLogoutBtn').addEventListener('click', async function () { await global.TMAPI.logout(); location.href = '/play/'; });
    $('childPasswordForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var r = await global.TMAPI.childPassword($('childCurrentPw').value, $('childNewPw').value);
      $('childPwMsg').textContent = r.ok ? t('acct.passwordUpdated') : errMsg(r);
      if (r.ok) { $('childCurrentPw').value = ''; $('childNewPw').value = ''; }
    });
    $('importBtn').addEventListener('click', doImport);
    $('deleteAccountBtn').addEventListener('click', async function () {
      if (!confirm(t('acct.deleteConfirm'))) return;
      var r = await global.TMAPI.deleteAccount();
      if (r.ok) { alert(t('acct.deleted')); location.reload(); }
      else toast(errMsg(r), true);
    });

    var q = new URLSearchParams(location.search);
    var token = q.get('token');
    var mode = q.get('mode') || 'verify';
    if (!token && (mode === 'register' || mode === 'student' || mode === 'login')) {
      initialAuthMode = mode;
    }

    /* 邀请标记：/api/family/invite/landing 会带 ?invite=1 跳回；
     * Google OAuth 回跳也保留该参数。 */
    if (q.get('invite') === '1') setInviteFlag();
    if (q.get('invite_token')) {
      setInviteFlag();
      try { sessionStorage.setItem('tm_invite_token', q.get('invite_token')); } catch (e) { /* 忽略 */ }
    }
    /* 登录后回到原来的游戏页（对战邀请 / 会员门禁） */
    var next = q.get('next');
    if (next && next.charAt(0) === '/' && next.indexOf('/account') !== 0) {
      try { localStorage.setItem('tm_next', next); } catch (e) { /* 忽略 */ }
    }

    /* Waffo 结账成功返回页：等待 webhook 确认后刷新会员状态 */
    if (q.get('checkout') === 'success' && q.get('order')) {
      watchCheckoutOrder(q.get('order'));
    }

    global.TMAPI.call('GET', '/api/me').then(function (r) {
      googleEnabled = !!(r.ok && r.data && r.data.authMethods && r.data.authMethods.google);
      var isStudent = authMode === 'student';
      $('googleRow').hidden = isStudent || !(googleEnabled || q.get('authError'));
    });

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
      // 邀请可能来自另一个标签页（如邮箱里点开验证链接）：Cookie 仍在，登录后自动接受
      global.TMAPI.call('GET', '/api/family/invite/pending').then(function (r) {
        if (r.ok && r.data && r.data.pending) setInviteFlag();
      }).then(function () {
        renderMain();
      }, function () {
        renderMain();
      });
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
