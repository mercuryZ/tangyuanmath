/* 儿童档案（DESIGN §5.1、§7.1）
 * - 首发一个档案：超限返回 profile_limit（界面另有说明）；
 * - 所有对象级资源验证归属（不能仅验证已登录）：跨账号一律 404，不泄露存在性；
 * - 档案只有昵称 + 预设头像键，无真实姓名/生日等。
 */
'use strict';

const express = require('express');
const { ok, fail, csrfProtect } = require('./middleware');
const U = require('./util');

const MAX_PROFILES = 1; // 首发（DESIGN 5.1）

function profileRow(db, id) {
  return db.prepare(
    'SELECT id, nickname, avatar_key AS avatarKey, created_at AS createdAt FROM child_profiles WHERE id = ?'
  ).get(id);
}

/* 归属校验用（含 user_id，不对外返回） */
function profileRowInternal(db, id) {
  return db.prepare('SELECT id, user_id FROM child_profiles WHERE id = ?').get(id);
}

/* 归属校验中间件：req.profile 或 404 */
function loadOwnProfile(db) {
  return (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 404, 'profile_not_found', 'Profile not found.');
    const p = profileRowInternal(db, id);
    if (!p || p.user_id !== req.user.id) return fail(res, 404, 'profile_not_found', 'Profile not found.');
    req.profile = { id: p.id };
    next();
  };
}

function buildProfilesRouter(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const list = db.prepare(
      'SELECT id, nickname, avatar_key AS avatarKey, created_at AS createdAt FROM child_profiles WHERE user_id = ? ORDER BY id'
    ).all(req.user.id);
    ok(res, { profiles: list, max: MAX_PROFILES });
  });

  r.post('/', csrfProtect, (req, res) => {
    const { nickname, avatarKey } = req.body || {};
    const nick = U.cleanNickname(nickname);
    if (!nick) return fail(res, 400, 'invalid_nickname', 'Nickname must be 1–20 characters.');
    const av = avatarKey && U.AVATAR_KEYS.includes(avatarKey) ? avatarKey : 'tangyuan';
    const existing = db.prepare('SELECT COUNT(*) AS c FROM child_profiles WHERE user_id = ?').get(req.user.id);
    if (existing.c >= MAX_PROFILES) {
      return fail(res, 409, 'profile_limit', 'One child profile for now — more profiles will come later.');
    }
    const info = db.prepare(
      'INSERT INTO child_profiles (user_id, nickname, avatar_key, created_at) VALUES (?,?,?,?)'
    ).run(req.user.id, nick, av, Date.now());
    ok(res, { profile: profileRow(db, info.lastInsertRowid) });
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

  r.delete('/:id', csrfProtect, loadOwnProfile(db), (req, res) => {
    // 级联删除 attempts / attempt_questions / wrong_questions（外键 ON DELETE CASCADE）
    db.prepare('DELETE FROM child_profiles WHERE id = ?').run(req.profile.id);
    ok(res, { deleted: true });
  });

  return r;
}

module.exports = { buildProfilesRouter, loadOwnProfile, profileRow, MAX_PROFILES };
