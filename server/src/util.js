/* 工具：令牌、校验、脱敏（DESIGN 10.2） */
'use strict';

const crypto = require('node:crypto');

/* 密码学安全随机令牌（DESIGN 10.2：会话/重置令牌用密码学安全随机数） */
function randomToken(bytes) {
  return crypto.randomBytes(bytes || 32).toString('base64url');
}

/* 服务端只存令牌哈希（DESIGN 5.2） */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* 时区校验：用 Intl 实际构造验证 IANA 时区 */
function isValidTimezone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,10}$/;
function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(normalizeEmail(email));
}

function isValidPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
}

/* 昵称：1–20 字符，去首尾空白 */
function cleanNickname(s) {
  if (typeof s !== 'string') return null;
  const v = s.trim();
  if (v.length === 0 || v.length > 20) return null;
  // 不允许控制字符
  if (/[\u0000-\u001f]/.test(v)) return null;
  return v;
}

/* client_event_id：1–64 位安全字符（字母数字-_） */
function isValidEventId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/* 整数边界校验 */
function intIn(v, min, max) {
  if (typeof v !== 'number' || !Number.isInteger(v)) return false;
  return v >= min && v <= max;
}

/* 预设头像键（儿童档案不用自由图片，DESIGN 5.1） */
const AVATAR_KEYS = ['tangyuan', 'star', 'heart', 'flower', 'moon', 'sun'];

/* 日志脱敏：过滤邮箱、令牌、Cookie（DESIGN 10.2） */
function redact(obj) {
  const seen = new Set();
  return JSON.parse(JSON.stringify(obj, (k, v) => {
    if (typeof v === 'string') {
      if (k === 'email' || k === 'username') return v.replace(/^(.).*(@.*)?$/, '$1***$2');
      if (/token|cookie|password|secret/i.test(k)) return '[redacted]';
    }
    return v;
  }), (k, v) => v);
}

module.exports = {
  randomToken, hashToken,
  isValidTimezone, normalizeEmail, isValidEmail, isValidPassword,
  cleanNickname, isValidEventId, intIn, AVATAR_KEYS, redact
};
