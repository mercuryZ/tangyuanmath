/* 中间件：安全头 / 限流 / CSRF / 会话鉴权 / 统一响应（DESIGN 5.2、10.2）
 * CSRF 策略：双提交 Cookie（tm_csrf 可读 Cookie + X-CSRF-Token 头一致）
 *           + 修改类请求 Origin/Referer 同源校验。SameSite=Lax 只是其中一层。
 */
'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db'); // 仅类型引用，实际 db 实例经 req.app.locals
const { hashToken } = require('./util');

/* ---------- 统一 JSON 响应 ---------- */
function ok(res, data) { res.json({ ok: true, data }); }
function fail(res, status, code, msg) { res.status(status).json({ ok: false, code, msg }); }

/* ---------- 安全响应头 + 严格 CSP（DESIGN 10.2） ----------
 * Live Race 需要 WebSocket：connect-src 除 'self' 外只放行「本请求的同源 ws/wss」，
 * 不用 `ws:` / `wss:` 通配——那等于允许脚本连任意主机。 */
function securityHeaders(req, res, next) {
  const host = String(req.headers.host || '');
  const wsHost = /^[A-Za-z0-9.:[\]-]+$/.test(host) ? host : '';
  const connectSrc = wsHost
    ? `'self' ws://${wsHost} wss://${wsHost}`
    : "'self'";
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      `connect-src ${connectSrc}; font-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'`,
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

/* ---------- 会话鉴权：Cookie tm_session → 哈希查表 ----------
 * 会话二选一：家长（user_id）或子女（child_profile_id）。
 * 家长与子女共用同一个 HttpOnly Cookie；/api/race/ws 也复用 resolveSession。 */
function sessionCookieName() { return 'tm_session'; }

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, child_profile_id, expires_at, created_at) VALUES (?,?,NULL,?,?)')
    .run(hashToken(token), userId, now + config.sessionTtlMs, now);
  return token;
}

function createChildSession(db, childProfileId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, child_profile_id, expires_at, created_at) VALUES (?,NULL,?,?,?)')
    .run(hashToken(token), childProfileId, now + config.sessionTtlMs, now);
  return token;
}

/* 解析会话令牌，返回家长或子女身份；无效/过期返回 null。 */
function resolveSession(db, token) {
  if (!token || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const row = db.prepare(
    `SELECT s.token_hash, s.expires_at,
            u.id AS user_id, u.email_normalized, u.email_verified_at,
            u.locale, u.timezone, u.created_at, u.family_id AS user_family_id, u.family_role,
            c.id AS child_id, c.family_id AS child_family_id, c.nickname, c.avatar_key, c.username
     FROM sessions s
     LEFT JOIN users u ON u.id = s.user_id
     LEFT JOIN child_profiles c ON c.id = s.child_profile_id
     WHERE s.token_hash = ?`
  ).get(hashToken(token));
  if (!row || row.expires_at <= Date.now()) return null;
  if (row.user_id) {
    return {
      kind: 'parent',
      tokenHash: row.token_hash,
      familyId: row.user_family_id,
      user: {
        id: row.user_id,
        email: row.email_normalized,
        emailVerified: !!row.email_verified_at,
        locale: row.locale,
        timezone: row.timezone,
        createdAt: row.created_at,
        familyId: row.user_family_id,
        familyRole: row.family_role
      }
    };
  }
  if (row.child_id) {
    // 子女没有自己的时区，统计沿用家庭 owner（或第一位家长）的时区
    const tzRow = db.prepare(
      `SELECT timezone FROM users WHERE family_id = ?
       ORDER BY CASE family_role WHEN 'owner' THEN 0 ELSE 1 END, id LIMIT 1`
    ).get(row.child_family_id);
    return {
      kind: 'child',
      tokenHash: row.token_hash,
      familyId: row.child_family_id,
      child: {
        id: row.child_id,
        nickname: row.nickname,
        avatarKey: row.avatar_key,
        username: row.username,
        familyId: row.child_family_id,
        timezone: tzRow ? tzRow.timezone : 'UTC'
      }
    };
  }
  return null;
}

function attachIdentity(db) {
  return function (req, res, next) {
    req.user = null;
    req.child = null;
    req.familyId = null;
    req.sessionKind = null;
    req.timezone = 'UTC';
    const token = req.cookies ? req.cookies[sessionCookieName()] : null;
    const ident = resolveSession(db, token);
    if (ident) {
      req.sessionKind = ident.kind;
      req.familyId = ident.familyId;
      req.sessionTokenHash = ident.tokenHash;
      if (ident.kind === 'parent') {
        req.user = ident.user;
        req.timezone = ident.user.timezone;
      } else {
        req.child = ident.child;
        req.timezone = ident.child.timezone;
      }
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.child) return fail(res, 403, 'parent_only', 'This page is for parent accounts.');
  return fail(res, 401, 'not_logged_in', 'Please sign in first.');
}

function requireParentOwner(req, res, next) {
  if (!req.user) return fail(res, 401, 'not_logged_in', 'Please sign in first.');
  if (req.user.familyRole !== 'owner') return fail(res, 403, 'owner_only', 'Only the family owner can do that.');
  next();
}

/* 管理后台：身份来自 TM_ADMIN_EMAILS 环境变量（config.adminEmails），不在库里存角色 */
function requireAdmin(req, res, next) {
  if (!req.user) return fail(res, 401, 'not_logged_in', 'Please sign in first.');
  if (!config.adminEmails.has(String(req.user.email || '').toLowerCase())) {
    return fail(res, 403, 'admin_required', 'Admin access is required.');
  }
  next();
}

function requireChild(req, res, next) {
  if (!req.child) return fail(res, 401, 'not_logged_in', 'Please sign in first.');
  next();
}

/* 游戏数据接口：家长或子女均可，具体档案归属由 loadOwnProfile 校验 */
function requirePlayer(req, res, next) {
  if (!req.user && !req.child) return fail(res, 401, 'not_logged_in', 'Please sign in first.');
  next();
}

function parseCookieHeader(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

module.exports = {
  ok, fail,
  securityHeaders, rateLimit,
  issueCsrfCookie, csrfProtect,
  sessionCookieName, createSession, createChildSession, resolveSession,
  attachIdentity, requireAuth, requireParentOwner, requireAdmin, requireChild, requirePlayer,
  parseCookieHeader
};
