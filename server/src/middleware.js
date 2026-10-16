/* 中间件：安全头 / 限流 / CSRF / 会话鉴权 / 统一响应（DESIGN 5.2、10.2）
 * CSRF 策略：双提交 Cookie（tm_csrf 可读 Cookie + X-CSRF-Token 头一致）
 *           + 修改类请求 Origin/Referer 同源校验。SameSite=Lax 只是其中一层。
 */
'use strict';

const crypto = require('node:crypto');
const db = require('./db'); // 仅类型引用，实际 db 实例经 req.app.locals
const { hashToken } = require('./util');

/* ---------- 统一 JSON 响应 ---------- */
function ok(res, data) { res.json({ ok: true, data }); }
function fail(res, status, code, msg) { res.status(status).json({ ok: false, code, msg }); }

/* ---------- 安全响应头 + 严格 CSP（DESIGN 10.2） ---------- */
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  next();
}

/* ---------- 简单内存限流（单实例部署足够；粒度：IP / 账号） ---------- */
function rateLimit(opts) {
  const { windowMs, max, keyFn, name } = opts;
  const buckets = new Map();
  setInterval(() => { // 定期清理过期桶
    const now = Date.now();
    for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  }, Math.max(windowMs, 60000)).unref();
  return function limit(req, res, next) {
    const key = (keyFn ? keyFn(req) : req.ip) + '|' + name;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count++;
    if (b.count > max) return fail(res, 429, 'rate_limited', 'Too many requests. Please slow down.');
    next();
  };
}

/* ---------- CSRF ---------- */
function issueCsrfCookie(req, res) {
  const token = crypto.randomBytes(24).toString('base64url');
  res.cookie('tm_csrf', token, {
    httpOnly: false, // 双提交：前端需要读取
    sameSite: 'lax',
    secure: req.secure || process.env.NODE_ENV === 'production',
    path: '/'
  });
  return token;
}

function csrfProtect(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const cookieTok = req.cookies ? req.cookies.tm_csrf : null;
  const headerTok = req.get('x-csrf-token');
  if (!cookieTok || !headerTok || cookieTok !== headerTok ||
      !/^[A-Za-z0-9_-]{10,}$/.test(cookieTok)) {
    return fail(res, 403, 'csrf_failed', 'Missing or invalid CSRF token.');
  }
  // Origin / Referer 同源校验
  const origin = req.get('origin') || req.get('referer');
  if (!origin) return fail(res, 403, 'csrf_origin', 'Missing Origin header.');
  let host;
  try { host = new URL(origin).host; } catch (e) { return fail(res, 403, 'csrf_origin', 'Invalid Origin.'); }
  if (host !== req.get('host')) return fail(res, 403, 'csrf_origin', 'Cross-origin request rejected.');
  next();
}

/* ---------- 会话鉴权：Cookie tm_session → 哈希查表 ---------- */
function sessionCookieName() { return 'tm_session'; }

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)')
    .run(hashToken(token), userId, now + 7 * 24 * 3600 * 1000, now);
  return token;
}

function attachUser(db) {
  return function (req, res, next) {
    req.user = null;
    const token = req.cookies ? req.cookies[sessionCookieName()] : null;
    if (token && /^[A-Za-z0-9_-]{20,}$/.test(token)) {
      const row = db.prepare(
        `SELECT s.token_hash, s.expires_at, u.id, u.email_normalized, u.email_verified_at,
                u.locale, u.timezone, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      ).get(hashToken(token));
      if (row && row.expires_at > Date.now()) {
        req.user = {
          id: row.id,
          email: row.email_normalized,
          emailVerified: !!row.email_verified_at,
          locale: row.locale,
          timezone: row.timezone,
          createdAt: row.created_at
        };
        req.sessionTokenHash = row.token_hash;
      }
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return fail(res, 401, 'not_logged_in', 'Please sign in first.');
  next();
}

module.exports = {
  ok, fail,
  securityHeaders, rateLimit,
  issueCsrfCookie, csrfProtect,
  sessionCookieName, createSession, attachUser, requireAuth
};
