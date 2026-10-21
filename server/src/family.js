/* 家庭会员与子女账号（DESIGN §5、§6、§8）
 * - 一个家庭最多 2 位家长 + 2 名子女；
 * - 家长邮箱/Google 登录；子女由家长创建，用用户名 + 密码登录；
 * - 会员权益按家庭计算，家庭成员共享；
 * - 上线活动：每个新家庭赠送 3 个自然月的 Supporter。
 */
'use strict';

const bcrypt = require('bcryptjs');
const config = require('./config');
const U = require('./util');
const {
  SUPPORTER_FEATURES,
  listActiveEntitlements,
  activeFamilyFeatureKeys,
  hasFamilyEntitlement,
  grantFamilyEntitlement
} = require('./entitlements');

const MAX_PARENTS = 2;
const MAX_CHILDREN = 2;
const LAUNCH_PROMO_ID = 'launch-2026';
const LAUNCH_TRIAL_MONTHS = 3;

/* 子女用户名：3–20 位，首字符为字母/数字，其余可为 . _ -；全局唯一（不区分大小写）。
 * 不允许 @（避免与家长邮箱登录混淆），保留词防止冒充官方角色。 */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,19}$/;
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'parent', 'parents', 'teacher', 'support', 'help',
  'tangyuan', 'system', 'root', 'student', 'math', 'official'
]);

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidUsername(value) {
  const v = normalizeUsername(value);
  return USERNAME_RE.test(v) && !RESERVED_USERNAMES.has(v);
}

/* 自然月加法：1 月 31 日 + 3 个月 = 4 月 30 日（不溢出到 5 月） */
function addCalendarMonths(ts, months) {
  const d = new Date(ts);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.getTime();
}

function ensureFamilyForUser(db, userId, now) {
  const user = db.prepare('SELECT id, family_id FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  if (user.family_id) return user.family_id;
  const familyId = db.prepare('INSERT INTO families (created_at, is_personal) VALUES (?,1)')
    .run(now === undefined ? Date.now() : now).lastInsertRowid;
  db.prepare("UPDATE users SET family_id = ?, family_role = 'owner' WHERE id = ?").run(familyId, userId);
  return familyId;
}

/* 上线赠送：每个家庭一次，幂等；已撤销过的家庭不再补发。 */
function grantLaunchTrial(db, familyId, now) {
  const t = now === undefined ? Date.now() : now;
  const existing = db.prepare(
    "SELECT 1 FROM entitlements WHERE family_id = ? AND source_type = 'promo' AND source_id = ? LIMIT 1"
  ).get(familyId, LAUNCH_PROMO_ID);
  if (existing) return 0;
  const expiresAt = addCalendarMonths(t, LAUNCH_TRIAL_MONTHS);
  let granted = 0;
  const tx = db.transaction(() => {
    for (const featureKey of SUPPORTER_FEATURES) {
      granted += grantFamilyEntitlement(db, {
        familyId, featureKey, sourceType: 'promo', sourceId: LAUNCH_PROMO_ID,
        startsAt: t, expiresAt
      });
    }
  });
  tx();
  return granted;
}

/* 注册 / 新建 Google 账号时调用：同一事务内建家庭并发赠送 */
function initFamilyForNewUser(db, userId, now) {
  const t = now === undefined ? Date.now() : now;
  const tx = db.transaction(() => {
    const familyId = ensureFamilyForUser(db, userId, t);
    grantLaunchTrial(db, familyId, t);
    return familyId;
  });
  return tx();
}

function hasActiveMembership(db, familyId, now) {
  return hasFamilyEntitlement(db, familyId, 'live_race', now);
}

/* 会员摘要：用于家长中心与 /api/me。
 * 取剩余时间最长的一条有效权益作为展示来源（永久 > 到期晚的）。 */
function membershipSummary(db, familyId, now) {
  const t = now === undefined ? Date.now() : now;
  /* 只展示仍然有效的订阅；已过期但尚未收到 canceled 事件的订单不再显示续费入口。 */
  const subscription = db.prepare(
    `SELECT order_no AS orderNo, sku, status,
            current_period_end AS currentPeriodEnd
     FROM orders
     WHERE family_id = ? AND sku <> 'supporter_lifetime'
       AND status IN ('paid','canceling','past_due')
       AND (current_period_end IS NULL OR current_period_end > ?)
     ORDER BY CASE status
                WHEN 'paid' THEN 0 WHEN 'canceling' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
              created_at DESC
     LIMIT 1`
  ).get(familyId, t) || null;
  const hasOrders = !!db.prepare(
    `SELECT 1 FROM orders
     WHERE family_id = ? AND status NOT IN ('pending','failed','expired') LIMIT 1`
  ).get(familyId);
  const rows = listActiveEntitlements(db, familyId, now);
  if (!rows.length) {
    return { active: false, plan: null, sourceType: null, expiresAt: null, subscription, hasOrders };
  }
  const priority = { order: 4, redeem: 3, grant: 2, promo: 1 };
  rows.sort((a, b) => {
    const ae = a.expires_at === null ? Infinity : a.expires_at;
    const be = b.expires_at === null ? Infinity : b.expires_at;
    if (ae !== be) return be - ae;
    return (priority[b.source_type] || 0) - (priority[a.source_type] || 0);
  });
  const best = rows[0];
  return {
    active: true,
    plan: best.source_type === 'promo' ? 'launch_trial' : best.source_type,
    sourceType: best.source_type,
    expiresAt: best.expires_at,
    subscription,
    hasOrders
  };
}

function familyParentCount(db, familyId) {
  return db.prepare('SELECT COUNT(*) AS c FROM users WHERE family_id = ?').get(familyId).c;
}

function familyChildCount(db, familyId) {
  return db.prepare('SELECT COUNT(*) AS c FROM child_profiles WHERE family_id = ?').get(familyId).c;
}

/* 家长看到的家庭信息（含两位家长与子女；不含密码哈希） */
function familySummary(db, familyId) {
  const parents = db.prepare(
    `SELECT id, email_normalized AS email, family_role AS role,
            email_verified_at AS emailVerified, created_at AS createdAt
     FROM users WHERE family_id = ?
     ORDER BY CASE family_role WHEN 'owner' THEN 0 ELSE 1 END, id`
  ).all(familyId);
  const children = db.prepare(
    `SELECT id, nickname, avatar_key AS avatarKey, username,
            CASE WHEN password_hash IS NOT NULL AND password_hash <> '' THEN 1 ELSE 0 END AS hasLogin,
            created_at AS createdAt
     FROM child_profiles WHERE family_id = ? ORDER BY id`
  ).all(familyId);
  return {
    id: familyId,
    parents,
    children: children.map(c => ({ ...c, hasLogin: !!c.hasLogin })),
    seats: {
      parents: parents.length,
      maxParents: MAX_PARENTS,
      children: children.length,
      maxChildren: MAX_CHILDREN
    }
  };
}

/* 子女公开资料：绝不包含 password_hash / username_normalized */
function publicChild(row) {
  return {
    id: row.id,
    nickname: row.nickname,
    avatarKey: row.avatar_key === undefined ? row.avatarKey : row.avatar_key,
    username: row.username || null,
    hasLogin: !!(row.password_hash || row.hasLogin),
    createdAt: row.created_at === undefined ? row.createdAt : row.created_at
  };
}

function findChildByUsername(db, username) {
  const normalized = normalizeUsername(username);
  if (!isValidUsername(normalized)) return null;
  return db.prepare(
    `SELECT id, family_id, nickname, avatar_key, username, password_hash, created_at
     FROM child_profiles WHERE username_normalized = ?`
  ).get(normalized) || null;
}

function isUniqueViolation(err) {
  return !!(err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(err.message || '')));
}

/* 创建子女（可同时设置登录用户名与密码）。
 * 返回 { profile } 或 { error }。座位与会员检查由调用方先做。 */
function createChild(db, { familyId, creatorUserId, nickname, avatarKey, username, password, now }) {
  const nick = U.cleanNickname(nickname);
  if (!nick) return { error: 'invalid_nickname' };
  const av = avatarKey && U.AVATAR_KEYS.includes(avatarKey) ? avatarKey : 'tangyuan';

  let uname = null;
  let hash = null;
  if (username !== undefined && username !== null && username !== '') {
    uname = normalizeUsername(username);
    if (!isValidUsername(uname)) return { error: 'invalid_username' };
    if (!U.isValidPassword(password)) return { error: 'weak_password' };
    hash = bcrypt.hashSync(password, config.bcryptRounds);
  } else if (password !== undefined && password !== null && password !== '') {
    return { error: 'username_required' };
  }

  try {
    const info = db.prepare(
      `INSERT INTO child_profiles
         (user_id, family_id, nickname, avatar_key, username, username_normalized, password_hash, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(creatorUserId, familyId, nick, av, uname, uname, hash, now === undefined ? Date.now() : now);
    return { profile: db.prepare(
      `SELECT id, nickname, avatar_key, username, password_hash, created_at
       FROM child_profiles WHERE id = ?`
    ).get(info.lastInsertRowid) };
  } catch (e) {
    if (isUniqueViolation(e)) return { error: 'username_taken' };
    throw e;
  }
}

/* 家长设置/重置子女用户名与密码。成功后撤销该子女的全部会话。 */
function setChildCredentials(db, profileId, { username, password }) {
  const uname = normalizeUsername(username);
  if (!isValidUsername(uname)) return { error: 'invalid_username' };
  if (!U.isValidPassword(password)) return { error: 'weak_password' };
  const hash = bcrypt.hashSync(password, config.bcryptRounds);
  try {
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE child_profiles
         SET username = ?, username_normalized = ?, password_hash = ?
         WHERE id = ?`
      ).run(uname, uname, hash, profileId);
      db.prepare('DELETE FROM sessions WHERE child_profile_id = ?').run(profileId);
    });
    tx();
    return { ok: true };
  } catch (e) {
    if (isUniqueViolation(e)) return { error: 'username_taken' };
    throw e;
  }
}

/* 允许在邀请加入时被合并的家庭：注册时自动创建、无其他家长、无子女、无付费权益。
 * 返回 { family, error }。 */
function checkMergeableFamily(db, familyId, userId) {
  const family = db.prepare('SELECT id, is_personal FROM families WHERE id = ?').get(familyId);
  if (!family) return { error: 'family_not_found' };
  if (!family.is_personal) return { error: 'already_in_family' };
  const otherParents = db.prepare(
    'SELECT COUNT(*) AS c FROM users WHERE family_id = ? AND id <> ?'
  ).get(familyId, userId).c;
  if (otherParents > 0) return { error: 'already_in_family' };
  const children = familyChildCount(db, familyId);
  if (children > 0) return { error: 'already_in_family' };
  const paid = db.prepare(
    `SELECT COUNT(*) AS c FROM entitlements
     WHERE family_id = ? AND source_type <> 'promo' AND revoked_at IS NULL`
  ).get(familyId).c;
  if (paid > 0) return { error: 'already_in_family' };
  return { family };
}

module.exports = {
  MAX_PARENTS, MAX_CHILDREN, LAUNCH_PROMO_ID, LAUNCH_TRIAL_MONTHS,
  normalizeUsername, isValidUsername, addCalendarMonths,
  ensureFamilyForUser, grantLaunchTrial, initFamilyForNewUser,
  hasActiveMembership, membershipSummary,
  familyParentCount, familyChildCount, familySummary,
  publicChild, findChildByUsername, createChild, setChildCredentials,
  checkMergeableFamily,
  activeFamilyFeatureKeys, hasFamilyEntitlement
};
