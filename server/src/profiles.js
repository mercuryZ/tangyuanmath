/* 儿童档案 / 子女账号（DESIGN §5.1、§7.1）
 * - 每个家庭最多 2 个子女；新增座位需要有效会员；
 * - 子女由家长创建，可设置用户名 + 密码供子女独立登录；
 * - 所有对象级资源按家庭校验归属（家长）或本人（子女会话）；跨家庭一律 404；
 * - 档案只有昵称 + 预设头像键，无真实姓名/生日等。 */
'use strict';

const express = require('express');
const { ok, fail, csrfProtect } = require('./middleware');
const U = require('./util');
const family = require('./family');

const MAX_PROFILES = family.MAX_CHILDREN;

function profileRow(db, id) {
  const p = db.prepare(
    `SELECT id, nickname, avatar_key AS avatarKey, username,
            CASE WHEN password_hash IS NOT NULL AND password_hash <> '' THEN 1 ELSE 0 END AS hasLogin,
            created_at AS createdAt
     FROM child_profiles WHERE id = ?`
  ).get(id);
  if (!p) return p;
  p.hasLogin = !!p.hasLogin;
  return p;
}

/* 归属校验用（含 user_id / family_id，不对外返回） */
function profileRowInternal(db, id) {
  return db.prepare('SELECT id, user_id, family_id FROM child_profiles WHERE id = ?').get(id);
}

/* 归属校验中间件：家长可访问本家庭任意子女，子女会话只能访问自己；否则 404 */
function loadOwnProfile(db) {
  return (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 404, 'profile_not_found', 'Profile not found.');
    const p = profileRowInternal(db, id);
    if (!p) return fail(res, 404, 'profile_not_found', 'Profile not found.');

    if (req.child) {
      if (p.id !== req.child.id) return fail(res, 404, 'profile_not_found', 'Profile not found.');
    } else if (req.user) {
      const sameFamily = p.family_id !== null && p.family_id === req.user.familyId;
      const legacyOwn = p.family_id === null && p.user_id === req.user.id;
      if (!sameFamily && !legacyOwn) return fail(res, 404, 'profile_not_found', 'Profile not found.');
    } else {
      return fail(res, 401, 'not_logged_in', 'Please sign in first.');
    }
    req.profile = { id: p.id };
    next();
  };
}

function buildProfilesRouter(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const list = db.prepare(
      `SELECT id, nickname, avatar_key AS avatarKey, username,
              CASE WHEN password_hash IS NOT NULL AND password_hash <> '' THEN 1 ELSE 0 END AS hasLogin,
              created_at AS createdAt
       FROM child_profiles WHERE family_id = ? ORDER BY id`
    ).all(req.user.familyId).map(p => ({ ...p, hasLogin: !!p.hasLogin }));
    const parentCount = family.familyParentCount(db, req.user.familyId);
    ok(res, {
      profiles: list,
      max: MAX_PROFILES,
      seats: {
        parents: parentCount, maxParents: family.MAX_PARENTS,
        children: list.length, maxChildren: MAX_PROFILES
      }
    });
  });

  r.post('/', csrfProtect, (req, res) => {
    const { nickname, avatarKey, username, password } = req.body || {};
    if (!req.user.emailVerified) {
      return fail(res, 403, 'email_unverified', 'Verify your email before adding a child account.');
    }
    // 新增座位属于会员权益；已有子女仍可在会员到期后继续使用
    if (!family.hasActiveMembership(db, req.user.familyId)) {
      return fail(res, 403, 'membership_required', 'Adding a child requires an active Supporter membership.');
    }
    if (family.familyChildCount(db, req.user.familyId) >= MAX_PROFILES) {
      return fail(res, 409, 'profile_limit', 'A family can have up to 2 child accounts.');
    }
    const created = family.createChild(db, {
      familyId: req.user.familyId,
      creatorUserId: req.user.id,
      nickname,
      avatarKey,
      username,
      password
    });
    if (created.error) {
      const status = created.error === 'username_taken' ? 409 : 400;
      const msg = created.error === 'username_taken'
        ? 'That username is already taken.'
        : created.error === 'weak_password'
          ? 'Password must be at least 8 characters.'
          : created.error === 'invalid_username'
            ? 'Username must be 3–20 characters using letters, numbers, dots, dashes or underscores.'
            : 'Please check the child details.';
      return fail(res, status, created.error, msg);
    }
    ok(res, { profile: profileRow(db, created.profile.id) });
  });

  r.patch('/:id', csrfProtect, loadOwnProfile(db), (req, res) => {
    const { nickname, avatarKey } = req.body || {};
    const sets = []; const args = [];
    if (nickname !== undefined) {
      const nick = U.cleanNickname(nickname);
      if (!nick) return fail(res, 400, 'invalid_nickname', 'Nickname must be 1–20 characters.');
      sets.push('nickname = ?'); args.push(nick);
    }
    if (avatarKey !== undefined) {
      if (!U.AVATAR_KEYS.includes(avatarKey)) return fail(res, 400, 'invalid_avatar', 'Unknown avatar.');
      sets.push('avatar_key = ?'); args.push(avatarKey);
    }
    if (!sets.length) return fail(res, 400, 'nothing_to_update', 'Nothing to update.');
    args.push(req.profile.id);
    db.prepare('UPDATE child_profiles SET ' + sets.join(', ') + ' WHERE id = ?').run(...args);
    ok(res, { profile: profileRow(db, req.profile.id) });
  });

  /* 家长设置 / 重置子女登录用户名与密码 */
  r.put('/:id/credentials', csrfProtect, loadOwnProfile(db), (req, res) => {
    const { username, password } = req.body || {};
    const result = family.setChildCredentials(db, req.profile.id, { username, password });
    if (result.error) {
      const status = result.error === 'username_taken' ? 409 : 400;
      const msg = result.error === 'username_taken'
        ? 'That username is already taken.'
        : result.error === 'weak_password'
          ? 'Password must be at least 8 characters.'
          : 'Username must be 3–20 characters using letters, numbers, dots, dashes or underscores.';
      return fail(res, status, result.error, msg);
    }
    ok(res, { profile: profileRow(db, req.profile.id) });
  });

  r.delete('/:id', csrfProtect, loadOwnProfile(db), (req, res) => {
    // 级联删除 attempts / attempt_questions / wrong_questions / sessions（外键 ON DELETE CASCADE）
    db.prepare('DELETE FROM child_profiles WHERE id = ?').run(req.profile.id);
    ok(res, { deleted: true });
  });

  return r;
}

module.exports = { buildProfilesRouter, loadOwnProfile, profileRow, MAX_PROFILES };
