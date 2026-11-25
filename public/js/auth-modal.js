/* Tangyuan Math — 全站悬浮登录框
 * 未登录访客点击页头「Sign in / 登录」或任何 /account/ 链接时，就地弹出登录框，
 * 不离开当前页面（参考 Analook 式悬浮登录）。登录成功后原地更新页头，不刷新页面。
 *
 * 设计约束：
 *  - 严格 CSP：零内联脚本、零内联样式，全部逻辑在外部文件里；
 *  - 静态页不加载 locales/*.js，所以本文件自带一份 EN/ZH 文案；
 *  - /account/ 完整页仍然保留：弹框底部给「更多账号设置」入口；
 *  - 已登录时完全让位：链接照旧直达家长中心。
 */
(function (global) {
  'use strict';

  var ACCOUNT_PATH = /^\/account\/?(?:\?|$)/;
  var MODES = ['login', 'register', 'student', 'forgot'];

  function byId(id) { return document.getElementById(id); }

  function lang() {
    try {
      var stored = global.localStorage.getItem('tm_lang');
      if (stored === 'zh' || stored === 'en') return stored;
    } catch (e) { /* 隐私模式：忽略 */ }
    return (document.documentElement.lang || 'en').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }

  var STR = {
    en: {
      brand: 'Tangyuan Math',
      sub: 'Sign in to sync your child’s progress across devices',
      tabLogin: 'Sign in',
      tabRegister: 'Sign up',
      email: 'Email',
      password: 'Password',
      username: 'Username',
      forgot: 'Forgot password?',
      loginBtn: 'Sign in',
      registerBtn: 'Create account',
      studentBtn: 'Sign in as student',
      sendResetBtn: 'Send reset link',
      or: 'or',
      google: 'Continue with Google',
      studentLink: 'Student sign-in',
      parentLink: 'Parent sign-in',
      pwdHint: 'At least 8 characters.',
      studentHint: 'Use the username and password a parent created for you.',
      terms: 'By continuing you agree to our Terms of Service and Privacy Policy.',
      more: 'More account options',
      close: 'Close',
      resetSent: 'If the email exists, a reset link is on its way.',
      registerSent: 'Account created. Check your inbox for the verification link, then sign in.',
      filled: 'Fill in both fields.',
      signedInLabel: 'Sign in'
    },
    zh: {
      brand: '汤圆数学',
      sub: '登录后，孩子的学习记录会在各设备间同步',
      tabLogin: '登录',
      tabRegister: '注册',
      email: '邮箱',
      password: '密码',
      username: '用户名',
      forgot: '忘记密码？',
      loginBtn: '登录',
      registerBtn: '创建账号',
      studentBtn: '学生登录',
      sendResetBtn: '发送重置链接',
      or: '或',
      google: '使用 Google 继续',
      studentLink: '学生登录',
      parentLink: '家长登录',
      pwdHint: '至少 8 位字符。',
      studentHint: '使用家长为你创建的用户名和密码。',
      terms: '继续即表示你同意我们的服务条款与隐私政策。',
      more: '更多账号设置',
      close: '关闭',
      resetSent: '如果该邮箱存在，重置链接已发出。',
      registerSent: '账号已创建，请查收验证邮件后再登录。',
      filled: '请填写完整。',
      signedInLabel: '登录'
    }
  };

  /* 服务端稳定错误码 → 文案（与 account.js 的映射保持一致的关键几条） */
  var ERR = {
    login_failed: ['Email or password is incorrect.', '邮箱或密码不正确。'],
    child_login_failed: ['Username or password is incorrect.', '用户名或密码不正确。'],
    email_taken: ['This email is already registered.', '该邮箱已注册。'],
    weak_password: ['Password must be at least 8 characters.', '密码至少 8 位。'],
    invalid_email: ['Please enter a valid email address.', '请输入有效的邮箱地址。'],
    rate_limited: ['Too many attempts — please wait a minute.', '尝试过于频繁，请稍等一分钟。'],
    invalid_input: ['Invalid email or password.', '邮箱或密码无效。'],
    invalid_username: ['Username must be 3–20 characters: letters, numbers, dots, dashes or underscores.', '用户名需 3–20 位，可用字母、数字、点、短横线或下划线。'],
    network_error: ['Network error — please try again.', '网络错误，请重试。'],
    bad_response: ['The server did not answer properly. Please try again.', '服务器响应异常，请重试。']
  };

  function t(key) {
    var pack = STR[lang()] || STR.en;
    return pack[key] !== undefined ? pack[key] : STR.en[key];
  }

  function errText(code) {
    var pair = ERR[code];
    if (!pair) return lang() === 'zh' ? '操作失败，请稍后重试。' : 'Something went wrong. Please try again.';
    return lang() === 'zh' ? pair[1] : pair[0];
  }

  function legalPaths() {
    var zh = lang() === 'zh';
    return { terms: zh ? '/zh/terms/' : '/en/terms/', privacy: zh ? '/zh/privacy/' : '/en/privacy/' };
  }

  /* 条款句里的两类链接：英文整句替换、中文整词替换 */
  function termsHtml() {
    var p = legalPaths();
    function link(href, text) {
      return '<a href="' + href + '" data-auth-modal="off">' + text + '</a>';
    }
    return t('terms')
      .replace('Terms of Service', link(p.terms, 'Terms of Service'))
      .replace('Privacy Policy', link(p.privacy, 'Privacy Policy'))
      .replace('服务条款', link(p.terms, '服务条款'))
      .replace('隐私政策', link(p.privacy, '隐私政策'));
  }

  var state = {
    built: false,
    open: false,
    mode: 'login',
    next: '',
    signedIn: false,
    meKnown: false,
    mePromise: null,
    google: false,
    busy: false,
    lastFocus: null,
    root: null
  };

  /* ---------- 会话状态：/api/me 只查一次 ---------- */
  function ensureMe() {
    if (state.meKnown) return Promise.resolve(state.signedIn);
    if (state.mePromise) return state.mePromise;
    state.mePromise = fetch('/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        var d = (json && json.ok && json.data) || {};
        state.signedIn = !!(d.user || d.child);
        state.google = !!(d.authMethods && d.authMethods.google);
      })
      .catch(function () { state.signedIn = false; })
      .then(function () {
        state.meKnown = true;
        state.mePromise = null;
        return state.signedIn;
      });
    return state.mePromise;
  }

  /* ---------- 小工具 ---------- */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'cls') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k]; // 仅用于本站内固定的 SVG 标记
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function input(id, type, name, placeholder, extra) {
    var attrs = {
      cls: 'tm-auth-input', id: id, type: type, name: name,
      placeholder: placeholder, 'aria-label': placeholder
    };
    Object.keys(extra || {}).forEach(function (k) { attrs[k] = extra[k]; });
    return el('input', attrs);
  }

  function googleIcon() {
    return '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">' +
      '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/>' +
      '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A8.997 8.997 0 0 0 9 18Z"/>' +
      '<path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/>' +
      '<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.42 0 9 0A8.997 8.997 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>';
  }

  function closeIcon() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5 13.5 13.5M13.5 2.5 2.5 13.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  }

  /* ---------- 构建 DOM（首次打开时） ---------- */
  function build() {
    if (state.built) return;
    state.built = true;

    var closeBtn = el('button', {
      cls: 'tm-auth-close', type: 'button', id: 'tmAuthClose', 'aria-label': t('close'), html: closeIcon()
    });

    var head = el('div', { cls: 'tm-auth-head' }, [
      el('img', { cls: 'tm-auth-logo', src: '/img/logo_small.png', alt: '', width: '52', height: '52' }),
      el('p', { cls: 'tm-auth-title', id: 'tmAuthBrand', text: t('brand') }),
      el('p', { cls: 'tm-auth-sub', id: 'tmAuthSub', text: t('sub') })
    ]);

    var tabLogin = el('button', { cls: 'tm-auth-tab', type: 'button', role: 'tab', 'data-mode': 'login', 'aria-selected': 'true', text: t('tabLogin') });
    var tabRegister = el('button', { cls: 'tm-auth-tab', type: 'button', role: 'tab', 'data-mode': 'register', 'aria-selected': 'false', text: t('tabRegister') });
    var tabs = el('div', { cls: 'tm-auth-tabs', id: 'tmAuthTabs', role: 'tablist' }, [tabLogin, tabRegister]);

    var emailInput = input('tmAuthEmail', 'email', 'email', t('email'), { autocomplete: 'email', required: 'required' });
    var passwordInput = input('tmAuthPassword', 'password', 'password', t('password'), {
      autocomplete: 'current-password', required: 'required', minlength: '8'
    });
    var forgotLink = el('button', { cls: 'tm-auth-link-btn', type: 'button', id: 'tmAuthForgotLink', text: t('forgot') });
    var pwdHint = el('p', { cls: 'tm-auth-hint', id: 'tmAuthPwdHint', text: t('pwdHint') });
    pwdHint.hidden = true;
    var loginSubmit = el('button', { cls: 'tm-auth-submit', type: 'submit', id: 'tmAuthSubmit', text: t('loginBtn') });
    var loginForm = el('form', { cls: 'tm-auth-form', id: 'tmAuthFormLogin', novalidate: 'novalidate' }, [
      el('div', { cls: 'tm-auth-field' }, [emailInput]),
      el('div', { cls: 'tm-auth-field' }, [passwordInput]),
      el('div', { cls: 'tm-auth-label-row' }, [forgotLink]),
      pwdHint,
      loginSubmit
    ]);

    var studentHint = el('p', { cls: 'tm-auth-hint', id: 'tmAuthStudentHint', text: t('studentHint') });
    var studentForm = el('form', { cls: 'tm-auth-form', id: 'tmAuthFormStudent', novalidate: 'novalidate', hidden: 'hidden' }, [
      studentHint,
      el('div', { cls: 'tm-auth-field' }, [input('tmAuthUsername', 'text', 'username', t('username'), { autocomplete: 'username', required: 'required' })]),
      el('div', { cls: 'tm-auth-field' }, [input('tmAuthStudentPassword', 'password', 'password', t('password'), { autocomplete: 'current-password', required: 'required' })]),
      el('button', { cls: 'tm-auth-submit', type: 'submit', id: 'tmAuthStudentSubmit', text: t('studentBtn') })
    ]);

    var forgotForm = el('form', { cls: 'tm-auth-form', id: 'tmAuthFormForgot', novalidate: 'novalidate', hidden: 'hidden' }, [
      el('div', { cls: 'tm-auth-field' }, [input('tmAuthForgotEmail', 'email', 'email', t('email'), { autocomplete: 'email', required: 'required' })]),
      el('button', { cls: 'tm-auth-submit', type: 'submit', id: 'tmAuthForgotSubmit', text: t('sendResetBtn') })
    ]);

    var msg = el('p', { cls: 'tm-auth-msg', id: 'tmAuthMsg', role: 'status', 'aria-live': 'polite' });
    msg.hidden = true;

    var divider = el('div', { cls: 'tm-auth-divider', id: 'tmAuthDivider' }, [el('span', { id: 'tmAuthOr', text: t('or') })]);
    var google = el('a', { cls: 'tm-auth-google', id: 'tmAuthGoogle', href: '/api/auth/google', html: googleIcon() });
    google.appendChild(el('span', { id: 'tmAuthGoogleLabel', text: t('google') }));
    google.hidden = true;

    var studentLink = el('button', { cls: 'tm-auth-link-btn', type: 'button', id: 'tmAuthStudentLink', text: t('studentLink') });
    var terms = el('p', { cls: 'tm-auth-note', id: 'tmAuthTerms', html: termsHtml() });
    var more = el('a', { cls: 'tm-auth-link-btn', id: 'tmAuthMore', href: '/account/', 'data-auth-modal': 'off', text: t('more') });

    var panel = el('div', {
      cls: 'tm-auth-panel', id: 'tmAuthPanel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tmAuthBrand'
    }, [
      closeBtn, head, tabs, loginForm, studentForm, forgotForm, msg, divider, google,
      studentLink,
      el('div', { cls: 'tm-auth-foot' }, [terms, more])
    ]);

    var overlay = el('div', { cls: 'tm-auth-overlay', id: 'tmAuthOverlay', hidden: 'hidden' }, [panel]);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    closeBtn.addEventListener('click', function () { close(); });

    tabs.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      setMode(btn.getAttribute('data-mode'));
      focusFirstField();
    });
    forgotLink.addEventListener('click', function () {
      var typed = byId('tmAuthEmail').value.trim();
      setMode('forgot');
      if (typed) byId('tmAuthForgotEmail').value = typed;
      byId('tmAuthForgotEmail').focus();
    });
    studentLink.addEventListener('click', function () {
      if (state.mode === 'student') { setMode('login'); byId('tmAuthEmail').focus(); }
      else { setMode('student'); byId('tmAuthUsername').focus(); }
    });

    loginForm.addEventListener('submit', onSubmitLogin);
    studentForm.addEventListener('submit', onSubmitStudent);
    forgotForm.addEventListener('submit', onSubmitForgot);
    panel.addEventListener('keydown', trapTab);

    document.body.appendChild(overlay);
    state.root = overlay;
  }

  function trapTab(e) {
    if (e.key !== 'Tab') return;
    var nodes = state.root.querySelectorAll('button, a[href], input');
    var list = Array.prototype.filter.call(nodes, function (node) {
      return !node.disabled && node.offsetParent !== null;
    });
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function focusFirstField() {
    var field = state.root.querySelector('.tm-auth-form:not([hidden]) input');
    if (field) field.focus();
  }

  /* ---------- 模式切换 ---------- */
  function setMode(mode) {
    if (MODES.indexOf(mode) === -1) mode = 'login';
    state.mode = mode;
    byId('tmAuthTabs').hidden = !(mode === 'login' || mode === 'register');
    byId('tmAuthFormLogin').hidden = !(mode === 'login' || mode === 'register');
    byId('tmAuthFormStudent').hidden = mode !== 'student';
    byId('tmAuthFormForgot').hidden = mode !== 'forgot';
    byId('tmAuthSubmit').textContent = mode === 'register' ? t('registerBtn') : t('loginBtn');
    byId('tmAuthPwdHint').hidden = mode !== 'register';
    byId('tmAuthPassword').setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
    byId('tmAuthStudentLink').textContent = mode === 'student' ? t('parentLink') : t('studentLink');
    Array.prototype.forEach.call(byId('tmAuthTabs').querySelectorAll('button[data-mode]'), function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-mode') === mode ? 'true' : 'false');
    });
    syncGoogle();
    hideMsg();
  }

  function syncGoogle() {
    var visible = state.google && (state.mode === 'login' || state.mode === 'register');
    byId('tmAuthGoogle').hidden = !visible;
    byId('tmAuthDivider').hidden = !visible;
    if (!visible) return;
    var next = state.next || (global.location.pathname + global.location.search);
    byId('tmAuthGoogle').href = '/api/auth/google' +
      (next && next !== '/account/' ? '?next=' + encodeURIComponent(next) : '');
  }

  /* ---------- 文案随语言重刷（play 页切语言会派发 tm:langchange） ---------- */
  function relabel() {
    if (!state.built) return;
    byId('tmAuthClose').setAttribute('aria-label', t('close'));
    byId('tmAuthBrand').textContent = t('brand');
    byId('tmAuthSub').textContent = t('sub');
    var tabs = byId('tmAuthTabs').querySelectorAll('button[data-mode]');
    if (tabs[0]) tabs[0].textContent = t('tabLogin');
    if (tabs[1]) tabs[1].textContent = t('tabRegister');
    setPlaceholder('tmAuthEmail', t('email'));
    setPlaceholder('tmAuthPassword', t('password'));
    setPlaceholder('tmAuthUsername', t('username'));
    setPlaceholder('tmAuthStudentPassword', t('password'));
    setPlaceholder('tmAuthForgotEmail', t('email'));
    byId('tmAuthForgotLink').textContent = t('forgot');
    byId('tmAuthPwdHint').textContent = t('pwdHint');
    byId('tmAuthStudentHint').textContent = t('studentHint');
    byId('tmAuthOr').textContent = t('or');
    byId('tmAuthGoogleLabel').textContent = t('google');
    byId('tmAuthStudentLink').textContent = state.mode === 'student' ? t('parentLink') : t('studentLink');
    byId('tmAuthMore').textContent = t('more');
    byId('tmAuthTerms').innerHTML = termsHtml();
    byId('tmAuthSubmit').textContent = state.mode === 'register' ? t('registerBtn') : t('loginBtn');
  }

  function setPlaceholder(id, text) {
    var node = byId(id);
    if (!node) return;
    node.placeholder = text;
    node.setAttribute('aria-label', text);
  }

  /* ---------- 消息 / 忙碌态 ---------- */
  function showMsg(text, isOk) {
    var msg = byId('tmAuthMsg');
    msg.textContent = text;
    msg.className = 'tm-auth-msg' + (isOk ? ' is-ok' : '');
    msg.hidden = false;
  }
  function hideMsg() {
    var msg = byId('tmAuthMsg');
    if (!msg) return;
    msg.hidden = true;
    msg.textContent = '';
  }
  function setBusy(busy) {
    state.busy = busy;
    Array.prototype.forEach.call(state.root.querySelectorAll('.tm-auth-submit'), function (b) {
      if (busy) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
      b.disabled = !!busy;
    });
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (json) {
        if (json && typeof json.ok === 'boolean') return json;
        return { ok: false, code: 'bad_response' };
      });
    }).catch(function () { return { ok: false, code: 'network_error' }; });
  }

  /* ---------- 提交 ---------- */
  function onSubmitLogin(e) {
    e.preventDefault();
    if (state.busy) return;
    var email = byId('tmAuthEmail').value.trim();
    var password = byId('tmAuthPassword').value;
    if (!email || !password) { showMsg(t('filled')); return; }
    var register = state.mode === 'register';
    if (register && password.length < 8) { showMsg(errText('weak_password')); return; }

    setBusy(true);
    hideMsg();

    if (!register) {
      post('/api/auth/login', { email: email, password: password }).then(function (r) {
        setBusy(false);
        if (!r.ok) { showMsg(errText(r.code)); return; }
        signedIn(r.data && r.data.user);
      });
      return;
    }

    post('/api/auth/register', { email: email, password: password, locale: lang(), timezone: guessTz() })
      .then(function (r) {
        if (!r.ok) return { stage: 'register', res: r };
        // 注册成功立刻登录：邮件发送是异步的，不让用户卡在「等验证信」上
        return post('/api/auth/login', { email: email, password: password })
          .then(function (lr) { return { stage: 'login', res: lr }; });
      })
      .then(function (out) {
        setBusy(false);
        if (out.stage === 'register' && !out.res.ok) { showMsg(errText(out.res.code)); return; }
        if (out.stage === 'register' && out.res.ok) { showMsg(t('registerSent'), true); return; }
        if (!out.res.ok) {
          // 账号建好了但自动登录失败（如限流）：提示去登录，不把错误当注册失败
          showMsg(t('registerSent'), true);
          setMode('login');
          return;
        }
        signedIn(out.res.data && out.res.data.user);
      });
  }

  function onSubmitStudent(e) {
    e.preventDefault();
    if (state.busy) return;
    var username = byId('tmAuthUsername').value.trim();
    var password = byId('tmAuthStudentPassword').value;
    if (!username || !password) { showMsg(t('filled')); return; }
    setBusy(true);
    hideMsg();
    post('/api/auth/child-login', { username: username, password: password }).then(function (r) {
      setBusy(false);
      if (!r.ok) { showMsg(errText(r.code)); return; }
      signedIn(null, r.data && r.data.child);
    });
  }

  function onSubmitForgot(e) {
    e.preventDefault();
    if (state.busy) return;
    var email = byId('tmAuthForgotEmail').value.trim();
    if (!email) { showMsg(t('filled')); return; }
    setBusy(true);
    hideMsg();
    post('/api/auth/forgot-password', { email: email }).then(function (r) {
      setBusy(false);
      if (!r.ok) { showMsg(errText(r.code)); return; }
      showMsg(t('resetSent'), true);
    });
  }

  function guessTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }

  function signedIn(user, child) {
    state.signedIn = true;
    state.meKnown = true;
    applyAuthLabels();
    document.dispatchEvent(new CustomEvent('tm:authchange', {
      detail: { user: user || null, child: child || null }
    }));
    if (global.TMAPI && global.TMAPI.refresh) global.TMAPI.refresh().catch(function () { /* 忽略 */ });
    var target = state.next;
    state.next = '';
    close(true);
    if (target) global.location.href = target;
  }

  /* ---------- 打开 / 关闭 ---------- */
  function open(opts) {
    build();
    opts = opts || {};
    state.lastFocus = document.activeElement;
    state.next = sanitizeNext(opts.next);
    setMode(opts.mode || 'login');
    clearSecrets();
    hideMsg();
    ensureMe().then(syncGoogle);

    var overlay = state.root;
    overlay.hidden = false;
    state.open = true;
    document.body.classList.add('tm-auth-lock');
    focusFirstField();
    if (document.activeElement === document.body || !overlay.contains(document.activeElement)) {
      byId('tmAuthClose').focus();
    }
  }

  function close(skipFocus) {
    if (!state.built) return;
    state.open = false;
    state.next = '';
    state.root.hidden = true;
    document.body.classList.remove('tm-auth-lock');
    if (!skipFocus && state.lastFocus && state.lastFocus.focus) {
      try { state.lastFocus.focus(); } catch (e) { /* 元素已移除 */ }
    }
    state.lastFocus = null;
  }

  function clearSecrets() {
    ['tmAuthPassword', 'tmAuthStudentPassword'].forEach(function (id) {
      var node = byId(id);
      if (node) node.value = '';
    });
  }

  function sanitizeNext(value) {
    if (typeof value !== 'string' || !value) return '';
    if (value.charAt(0) !== '/') return '';
    if (value.charAt(1) === '/' || value.charAt(1) === '\\') return ''; // 协议相对地址
    if (value.indexOf('/account') === 0) return '';                    // 已在登录页
    if (value.indexOf('/api/') === 0) return '';
    return value;
  }

  /* ---------- 页头：未登录时把「家长中心」显示成「登录」 ---------- */
  var ORIG_ATTR = 'data-tm-auth-orig';
  function accountNavLinks() {
    return document.querySelectorAll('.site-nav a[href^="/account/"], #btnAccount');
  }
  function applyAuthLabels() {
    Array.prototype.forEach.call(accountNavLinks(), function (a) {
      if (!a.hasAttribute(ORIG_ATTR)) a.setAttribute(ORIG_ATTR, a.textContent.trim());
      if (state.signedIn) {
        a.textContent = a.getAttribute(ORIG_ATTR);
        a.classList.remove('nav-auth-link');
        a.removeAttribute('aria-haspopup');
      } else {
        a.textContent = t('signedInLabel');
        a.classList.add('nav-auth-link');
        a.setAttribute('aria-haspopup', 'dialog');
      }
    });
  }

  function setSignedIn(value) {
    state.signedIn = !!value;
    state.meKnown = true;
    applyAuthLabels();
  }

  /* ---------- 点击拦截：未登录时 /account/ 链接改为弹框 ---------- */
  function shouldHandle(a) {
    if (!a || a.getAttribute('data-auth-modal') === 'off') return false;
    var href = a.getAttribute('href') || '';
    if (!ACCOUNT_PATH.test(href)) return false;
    // 邮件里的令牌页必须真的打开 /account/ 处理
    if (/[?&]token=/.test(href)) return false;
    if (/[?&]mode=(verify|reset)\b/.test(href)) return false;
    return true;
  }

  function parseHref(href) {
    var out = { mode: 'login', next: '' };
    var q = href.indexOf('?');
    if (q === -1) return out;
    var params = new URLSearchParams(href.slice(q + 1));
    var mode = params.get('mode');
    if (MODES.indexOf(mode) !== -1) out.mode = mode;
    out.next = sanitizeNext(params.get('next'));
    return out;
  }

  function handleClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!shouldHandle(a)) return;
    var href = a.getAttribute('href');
    e.preventDefault();
    var opts = parseHref(href);
    ensureMe().then(function (signedInNow) {
      if (signedInNow) { global.location.href = href; return; }
      open(opts);
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', function (e) {
      if (state.open && e.key === 'Escape') { e.preventDefault(); close(); }
    });
    document.addEventListener('tm:langchange', function () {
      relabel();
      applyAuthLabels();
    });
    ensureMe().then(applyAuthLabels);
  }

  global.TMAuthModal = {
    open: open,
    close: close,
    isSignedIn: function () { return state.signedIn; },
    setSignedIn: setSignedIn,
    refresh: function () { state.meKnown = false; return ensureMe().then(applyAuthLabels); },
    /* play 应用用：未登录时打开弹框并返回 true，调用方据此跳过跳转 */
    openIfSignedOut: function () {
      if (state.signedIn) return false;
      open({ mode: 'login' });
      ensureMe().then(function (signedInNow) {
        if (signedInNow) { close(true); global.location.href = '/account/'; }
      });
      return true;
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
