/* 认证：家长账号（DESIGN §5、§7.1）
 * - 注册：邮箱+密码，发验证令牌（不自动登录）；
 * - 登录：成功即轮换会话（新令牌）；失败统一响应防枚举；
 * - 忘记密码：无论账号是否存在都返回一致结果；
 * - 重置：一次性令牌，成功后撤销该账号全部旧会话；
 * - 登出：当前设备；logout-all：全部会话撤销。
 * 邮箱未验证允许登录（M1 策略），/api/me 如实返回 emailVerified。
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

const config = require('./config');
const { ok, fail, rateLimit, sessionCookieName, createSession, issueCsrfCookie, csrfProtect } = require('./middleware');
const U = require('./util');
const mailer = require('./mailer');

function setSessionCookie(req, res, token) {
  res.cookie(sessionCookieName(), token, {
    httpOnly: true, // 不进 localStorage / JS（DESIGN 5.2）
    sameSite: 'lax',
    secure: req.secure || config.isProd,
    path: '/',
    maxAge: config.sessionTtlMs
  });
}

function clearSessionCookie(res) {
  res.clearCookie(sessionCookieName(), { path: '/' });
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    emailVerified: !!u.emailVerified,
    locale: u.locale,
    timezone: u.timezone,
    createdAt: u.createdAt
  };
}

/* 颁发一次性令牌并按 transport 发信；返回 {token, url} 便于测试 */
function issueOneTimeToken(db, userId, purpose, email, capture) {
  const token = U.randomToken(32);
  const now = Date.now();
  db.prepare('INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(U.hashToken(token), userId, purpose, now + config.tokenTtlMs, now);
  const pathMap = { verify_email: '/account/verify-email', reset_password: '/account/reset' };
  const url = config.publicBaseUrl + pathMap[purpose] + '?token=' + encodeURIComponent(token);
  if (purpose === 'verify_email') mailer.sendVerificationEmail(email, url, capture);
  else mailer.sendResetEmail(email, url, capture);
  return { token, url };
}

/* ---------- Google 登录（OAuth 2.0 授权码重定向流程，DESIGN 5.1） ----------
 * 我们的页面零第三方脚本（严格 CSP 不变）：浏览器仅在 Google 站点上完成授权。
 * 账号关联规则（防「预注册劫持」）：
 *   1) 已绑定 google_id → 直接登录；
 *   2) 同邮箱且本地账号已通过邮箱验证 → 自动关联（Google 邮箱已验证，双向确权）；
 *   3) 同邮箱但本地账号未验证 → 拒绝，要求先密码登录并完成邮箱验证；
 *   4) 全新邮箱 → 直接建号，标记已验证，password_hash 存空串（密码登录自然失效）。 */
function googleEnabled() {
  return !!(config.googleClientId && config.googleClientSecret);
}

/* 核心：按 Google 档案解析/创建用户。供集成测试直接调用。 */
function resolveGoogleUser(db, profile, now) {
  now = now || Date.now();
  const email = U.normalizeEmail(profile.email);
  const byGoogle = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.sub);
  if (byGoogle) return { user: byGoogle };

  const byEmail = db.prepare('SELECT * FROM users WHERE email_normalized = ?').get(email);
  if (byEmail) {
    if (!byEmail.email_verified_at) return { error: 'email_unverified_exists' };
    db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(profile.sub, byEmail.id);
    return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(byEmail.id) };
  }
  const info = db.prepare(
    `INSERT INTO users (email_normalized, password_hash, email_verified_at, locale, timezone, created_at, google_id)
     VALUES (?,?,?,?,?,?,?)`
  ).run(email, '', now, profile.locale === 'zh' ? 'zh' : 'en', 'UTC', now, profile.sub);
  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) };
}

function oauthRedirectUri(req) {
  // 从请求推导（trust proxy 已开启），须与 Google Console 登记的回调地址完全一致
  return req.protocol + '://' + req.get('host') + '/api/auth/google/callback';
}

function buildAuthRouter(db) {
  const r = express.Router();

  /* CSRF 令牌签发（GET，登录前后皆可调用） */
  r.get('/csrf', (req, res) => {
    ok(res, { csrfToken: issueCsrfCookie(req, res) });
  });

  /* 注册 */
  r.post('/register',
    rateLimit({ windowMs: 60000, max: 10, name: 'register' }),
    (req, res) => {
      const { email, password, locale, timezone } = req.body || {};
      if (!U.isValidEmail(email)) return fail(res, 400, 'invalid_email', 'Please enter a valid email address.');
      if (!U.isValidPassword(password)) return fail(res, 400, 'weak_password', 'Password must be at least 8 characters.');
      const tz = timezone && U.isValidTimezone(timezone) ? timezone : 'UTC';
      const loc = locale === 'zh' ? 'zh' : 'en';

      const exists = db.prepare('SELECT id FROM users WHERE email_normalized = ?').get(U.normalizeEmail(email));
      if (exists) return fail(res, 409, 'email_taken', 'This email is already registered.');

      const hash = bcrypt.hashSync(password, config.bcryptRounds);
      const now = Date.now();
      const info = db.prepare(
        'INSERT INTO users (email_normalized, password_hash, email_verified_at, locale, timezone, created_at) VALUES (?,?,NULL,?,?,?)'
      ).run(U.normalizeEmail(email), hash, loc, tz, now);

      issueOneTimeToken(db, info.lastInsertRowid, 'verify_email', U.normalizeEmail(email), req.app.locals.mailCapture);
      ok(res, { sent: true });
    });

  /* 邮箱验证 */
  r.post('/verify-email',
    rateLimit({ windowMs: 60000, max: 20, name: 'verify-email' }),
    (req, res) => {
      const { token } = req.body || {};
      if (!token || typeof token !== 'string') return fail(res, 400, 'invalid_token', 'Missing token.');
      const row = db.prepare(
        "SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = 'verify_email'"
      ).get(U.hashToken(token));
      if (!row || row.used_at || row.expires_at < Date.now()) {
        return fail(res, 400, 'invalid_token', 'This link is invalid or has expired.');
      }
      db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ?').run(Date.now(), row.id);
      db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(Date.now(), row.user_id);
      ok(res, { verified: true });
    });

  /* 登录（成功轮换会话） */
  r.post('/login',
    rateLimit({ windowMs: 60000, max: 10, name: 'login' }),
    (req, res) => {
      const { email, password } = req.body || {};
      if (!U.isValidEmail(email) || typeof password !== 'string') {
        return fail(res, 400, 'invalid_input', 'Invalid email or password.');
      }
      const row = db.prepare('SELECT * FROM users WHERE email_normalized = ?').get(U.normalizeEmail(email));
      const okPass = row && bcrypt.compareSync(password, row.password_hash);
      if (!row || !okPass) return fail(res, 401, 'login_failed', 'Email or password is incorrect.');
      const token = createSession(db, row.id);
      setSessionCookie(req, res, token);
      ok(res, { user: publicUser({
        id: row.id, email: row.email_normalized, emailVerified: !!row.email_verified_at,
        locale: row.locale, timezone: row.timezone, createdAt: row.created_at
      }) });
    });

  /* 登出（当前设备） */
  r.post('/logout', csrfProtect, (req, res) => {
    if (req.sessionTokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionTokenHash);
    clearSessionCookie(res);
    ok(res, { loggedOut: true });
  });

  /* 全部会话撤销 */
  r.post('/logout-all', csrfProtect, (req, res) => {
    if (!req.user) return fail(res, 401, 'not_logged_in', 'Please sign in first.');
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
    clearSessionCookie(res);
    ok(res, { revokedAll: true });
  });

  /* 忘记密码：统一响应，不泄露账号是否存在（DESIGN 7.1） */
  r.post('/forgot-password',
    rateLimit({ windowMs: 60000, max: 10, name: 'forgot' }),
    (req, res) => {
      const { email } = req.body || {};
      if (U.isValidEmail(email)) {
        const row = db.prepare('SELECT id FROM users WHERE email_normalized = ?').get(U.normalizeEmail(email));
        if (row) {
          // 旧的同用途未用令牌作废，避免多个有效链接
          db.prepare("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'reset_password' AND used_at IS NULL")
            .run(Date.now(), row.id);
          issueOneTimeToken(db, row.id, 'reset_password', U.normalizeEmail(email), req.app.locals.mailCapture);
        }
      }
      ok(res, { sent: true }); // 无论是否存在都一致
    });

  /* 重置密码（一次性令牌 → 撤销全部旧会话） */
  r.post('/reset-password',
    rateLimit({ windowMs: 60000, max: 10, name: 'reset' }),
    (req, res) => {
      const { token, password } = req.body || {};
      if (!token || typeof token !== 'string') return fail(res, 400, 'invalid_token', 'Missing token.');
      if (!U.isValidPassword(password)) return fail(res, 400, 'weak_password', 'Password must be at least 8 characters.');
      const row = db.prepare(
        "SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = 'reset_password'"
      ).get(U.hashToken(token));
      if (!row || row.used_at || row.expires_at < Date.now()) {
        return fail(res, 400, 'invalid_token', 'This link is invalid or has expired.');
      }
      const hash = bcrypt.hashSync(password, config.bcryptRounds);
      const tx = db.transaction(() => {
        db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ?').run(Date.now(), row.id);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
      });
      tx();
      ok(res, { reset: true });
    });

  /* ---------- Google 登录两个端点 ---------- */
  r.get('/google',
    rateLimit({ windowMs: 60000, max: 30, name: 'google-start' }),
    function (req, res) {
      if (!googleEnabled()) return res.redirect('/account/?authError=google_not_configured');
      const state = U.randomToken(24);
      res.cookie('tm_oauth_state', state, {
        httpOnly: true, sameSite: 'lax',
        secure: req.secure || config.isProd,
        maxAge: 10 * 60 * 1000, path: '/api/auth/google'
      });
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: config.googleClientId,
        redirect_uri: oauthRedirectUri(req),
        response_type: 'code',
        scope: 'openid email', // 最小化：只要验证过的邮箱与用户 ID
        state: state,
        access_type: 'online',
        prompt: 'select_account'
      }).toString();
      res.redirect(302, url);
    });

  r.get('/google/callback',
    rateLimit({ windowMs: 60000, max: 30, name: 'google-callback' }),
    async function (req, res) {
      const failRedirect = function (code) { return res.redirect('/account/?authError=' + encodeURIComponent(code)); };
      const code = req.query.code, state = req.query.state, qErr = req.query.error;
      if (qErr) return failRedirect('google_error');
      if (!code || !state || typeof code !== 'string' || typeof state !== 'string') return failRedirect('google_invalid');

      // state 双向校验（OAuth CSRF 防护，先于配置检查），用完即清
      const cookieState = req.cookies ? req.cookies.tm_oauth_state : null;
      res.clearCookie('tm_oauth_state', { path: '/api/auth/google' });
      if (!cookieState || cookieState !== state) return failRedirect('invalid_state');

      if (!googleEnabled()) return failRedirect('google_not_configured');

      // 授权码换令牌（服务端到服务端，TLS 直连，id_token 无需再验签）
      let tokens = null;
      try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: code,
            client_id: config.googleClientId,
            client_secret: config.googleClientSecret,
            redirect_uri: oauthRedirectUri(req),
            grant_type: 'authorization_code'
          })
        });
        tokens = await resp.json();
      } catch (e) {
        return failRedirect('exchange_failed');
      }
      if (!tokens || !tokens.id_token) return failRedirect('exchange_failed');

      let payload;
      try {
        payload = JSON.parse(Buffer.from(String(tokens.id_token).split('.')[1], 'base64url').toString('utf8'));
      } catch (e) {
        return failRedirect('exchange_failed');
      }
      if (!payload.sub || !payload.email || payload.email_verified !== true) {
        return failRedirect('google_email_unverified');
      }

      const localeCookie = req.cookies ? req.cookies.tm_lang : null;
      const resolved = resolveGoogleUser(db, {
        sub: payload.sub, email: payload.email, locale: localeCookie === 'zh' ? 'zh' : 'en'
      });
      if (resolved.error) return failRedirect(resolved.error);

      const token = createSession(db, resolved.user.id);
      setSessionCookie(req, res, token);
      issueCsrfCookie(req, res); // 回到 /account/ 后立即可调用修改类接口
      res.redirect('/account/');
    });

  return r;
}

/* GET /api/me：语言、时区、档案与权益（M1 无付费权益 → 空 entitlements） */
function meHandler(db) {
  return (req, res) => {
    if (!req.user) return ok(res, { user: null, authMethods: { google: googleEnabled() } });
    const profiles = db.prepare(
      'SELECT id, nickname, avatar_key AS avatarKey, created_at AS createdAt FROM child_profiles WHERE user_id = ? ORDER BY id'
    ).all(req.user.id);
    ok(res, {
      user: publicUser(req.user),
      profiles,
      entitlements: [], // M2 起由 orders/entitlements 提供
      authMethods: { google: googleEnabled() }
    });
  };
}

/* PATCH /api/me：locale / timezone（家长可改，DESIGN 4.2） */
function updateMeHandler(db) {
  return [csrfProtect, (req, res) => {
    const { locale, timezone } = req.body || {};
    const sets = [];
    const args = [];
    if (locale !== undefined) {
      if (locale !== 'en' && locale !== 'zh') return fail(res, 400, 'invalid_locale', 'locale must be en or zh.');
      sets.push('locale = ?'); args.push(locale);
    }
    if (timezone !== undefined) {
      if (!U.isValidTimezone(timezone)) return fail(res, 400, 'invalid_timezone', 'Unknown timezone.');
      sets.push('timezone = ?'); args.push(timezone);
    }
    if (!sets.length) return fail(res, 400, 'nothing_to_update', 'Nothing to update.');
    args.push(req.user.id);
    db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?').run(...args);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    ok(res, { user: publicUser({
      id: row.id, email: row.email_normalized, emailVerified: !!row.email_verified_at,
      locale: row.locale, timezone: row.timezone, createdAt: row.created_at
    }) });
  }];
}

module.exports = {
  buildAuthRouter, meHandler, updateMeHandler,
  issueOneTimeToken, setSessionCookie, clearSessionCookie, publicUser,
  resolveGoogleUser, googleEnabled
};
