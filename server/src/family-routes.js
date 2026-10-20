/* 家庭 API：家庭概览、共同家长邮箱邀请（DESIGN §5、§8）
 * - 只有 owner 能邀请另一位家长；每个家庭最多 2 位家长；
 * - 邀请令牌只存哈希，7 天过期；
 * - 接受邀请时要求邮箱已验证、邀请邮箱与当前账号一致；
 * - 邀请对象注册时自动创建的家庭若为空（无其他家长、无子女、无付费权益），
 *   在加入时合并并删除，避免出现两个家庭/两份赠送。 */
'use strict';

const express = require('express');
const config = require('./config');
const {
  ok, fail, csrfProtect, rateLimit, requireParentOwner
} = require('./middleware');
const U = require('./util');
const mailer = require('./mailer');
const family = require('./family');

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const INVITE_COOKIE = 'tm_invite';

function inviteList(db, familyId) {
  return db.prepare(
    `SELECT id, email_normalized AS email, expires_at AS expiresAt, created_at AS createdAt
     FROM family_invites
     WHERE family_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
     ORDER BY id`
  ).all(familyId);
}

/* GET /api/family/invite/landing?token=…（无需登录）
 * 把令牌放进 HttpOnly Cookie 后跳回家长中心，确保 Google OAuth 重定向后仍可接受。 */
function familyInviteLandingHandler(db) {
  return (req, res) => {
    const token = req.query.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(token)) {
      return res.redirect('/account/?authError=invite_invalid');
    }
    const row = db.prepare(
      `SELECT id FROM family_invites
       WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
    ).get(U.hashToken(token), Date.now());
    if (!row) return res.redirect('/account/?authError=invite_invalid');
    res.cookie(INVITE_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || config.isProd,
      maxAge: INVITE_TTL_MS,
      path: '/'
    });
    res.redirect('/account/?invite=1');
  };
}

/* GET /api/family/invite/pending（无需登录）
 * 只告诉前端「浏览器里是否有一个待接受的邀请 Cookie」，不暴露令牌本身。
 * 用于验证邮件在新标签页打开后，仍然能自动完成邀请。 */
function familyInvitePendingHandler(req, res) {
  res.json({ ok: true, data: { pending: !!(req.cookies && req.cookies[INVITE_COOKIE]) } });
}

function buildFamilyRouter(db) {
  const r = express.Router();

  /* 家庭概览（家长） */
  r.get('/', (req, res) => {
    ok(res, {
      family: family.familySummary(db, req.user.familyId),
      membership: family.membershipSummary(db, req.user.familyId),
      invites: inviteList(db, req.user.familyId)
    });
  });

  /* 邀请另一位家长（仅 owner） */
  r.post('/invite',
    rateLimit({
      windowMs: 60 * 60 * 1000, max: 5, name: 'family-invite',
      keyFn: req => 'u:' + (req.user ? req.user.id : req.ip)
    }),
    csrfProtect,
    requireParentOwner,
    (req, res) => {
      const email = U.normalizeEmail(req.body && req.body.email);
      if (!U.isValidEmail(email)) return fail(res, 400, 'invalid_email', 'Please enter a valid email address.');
      if (!req.user.emailVerified) {
        return fail(res, 403, 'email_unverified', 'Verify your own email before inviting another parent.');
      }
      if (!family.hasActiveMembership(db, req.user.familyId)) {
        return fail(res, 403, 'membership_required', 'Inviting another parent requires an active Supporter membership.');
      }
      if (family.familyParentCount(db, req.user.familyId) >= family.MAX_PARENTS) {
        return fail(res, 409, 'family_full', 'This family already has 2 parents.');
      }
      if (email === req.user.email) {
        return fail(res, 400, 'invalid_invite_email', 'You cannot invite your own email address.');
      }
      const existing = db.prepare('SELECT id, family_id FROM users WHERE email_normalized = ?').get(email);
      if (existing && existing.family_id === req.user.familyId) {
        return fail(res, 409, 'already_member', 'This person is already in your family.');
      }
      if (existing) {
        // 对方已有家庭：只有「空家庭」才能合并；提前拒绝，避免发出一封注定失败的邀请
        const merge = family.checkMergeableFamily(db, existing.family_id, existing.id);
        if (merge.error) {
          return fail(res, 409, 'already_in_family',
            'This person already belongs to a family with children or paid access.');
        }
      }

      const token = U.randomToken(32);
      const now = Date.now();
      const expiresAt = now + INVITE_TTL_MS;
      const tx = db.transaction(() => {
        // 同一邮箱只保留一个待接受邀请
        db.prepare(
          `UPDATE family_invites SET revoked_at = ?
           WHERE family_id = ? AND email_normalized = ?
             AND accepted_at IS NULL AND revoked_at IS NULL`
        ).run(now, req.user.familyId, email);
        db.prepare(
          `INSERT INTO family_invites
             (family_id, email_normalized, token_hash, invited_by, expires_at, created_at)
           VALUES (?,?,?,?,?,?)`
        ).run(req.user.familyId, email, U.hashToken(token), req.user.id, expiresAt, now);
      });
      tx();

      const url = config.publicBaseUrl + '/api/family/invite/landing?token=' + encodeURIComponent(token);
      mailer.sendFamilyInviteEmail(email, url, req.user.email, req.app.locals.mailCapture);
      ok(res, { sent: true, expiresAt });
    });

  /* 接受邀请（登录家长 + CSRF + 已验证邮箱） */
  r.post('/invite/accept', csrfProtect, (req, res) => {
    const clearInvite = () => res.clearCookie(INVITE_COOKIE, { path: '/' });
    let token = req.body && req.body.token;
    if (!token && req.cookies) token = req.cookies[INVITE_COOKIE];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(token)) {
      clearInvite();
      return fail(res, 400, 'invalid_invite', 'This invitation is invalid or has expired.');
    }
    if (!req.user.emailVerified) {
      // 保留 Cookie：验证邮箱后可以重试
      return fail(res, 403, 'email_unverified', 'Verify your email before joining a family.');
    }
    const invite = db.prepare('SELECT * FROM family_invites WHERE token_hash = ?').get(U.hashToken(token));
    if (!invite || invite.accepted_at || invite.revoked_at) {
      clearInvite();
      return fail(res, 400, 'invalid_invite', 'This invitation is invalid or has expired.');
    }
    if (invite.expires_at <= Date.now()) {
      clearInvite();
      return fail(res, 400, 'invite_expired', 'This invitation has expired.');
    }
    if (invite.email_normalized !== req.user.email) {
      clearInvite();
      return fail(res, 403, 'invite_email_mismatch', 'This invitation was sent to a different email address.');
    }

    const now = Date.now();
    const tx = db.transaction(() => {
      const fresh = db.prepare('SELECT * FROM family_invites WHERE id = ?').get(invite.id);
      if (!fresh || fresh.accepted_at || fresh.revoked_at) return { error: 'invalid_invite' };
      if (req.user.familyId !== fresh.family_id) {
        if (family.familyParentCount(db, fresh.family_id) >= family.MAX_PARENTS) {
          return { error: 'family_full' };
        }
        const merge = family.checkMergeableFamily(db, req.user.familyId, req.user.id);
        if (merge.error) return { error: merge.error };
      }
      // 先「认领」邀请，避免同一令牌被并发接受
      const claim = db.prepare(
        `UPDATE family_invites SET accepted_at = ?, accepted_by = ?
         WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`
      ).run(now, req.user.id, fresh.id);
      if (claim.changes !== 1) return { error: 'invalid_invite' };

      if (req.user.familyId !== fresh.family_id) {
        db.prepare("UPDATE users SET family_id = ?, family_role = 'coparent' WHERE id = ?")
          .run(fresh.family_id, req.user.id);
        db.prepare('DELETE FROM families WHERE id = ?').run(req.user.familyId);
      }
      return { ok: true, familyId: fresh.family_id };
    });

    const result = tx();
    if (result.error) {
      clearInvite();
      const status = result.error === 'family_full' ? 409
        : result.error === 'already_in_family' ? 409 : 400;
      const msg = result.error === 'family_full' ? 'This family already has 2 parents.'
        : result.error === 'already_in_family'
          ? 'Your account already belongs to a family with children or paid access.'
          : 'This invitation is invalid or has expired.';
      return fail(res, status, result.error, msg);
    }
    res.clearCookie(INVITE_COOKIE, { path: '/' });
    ok(res, {
      joined: true,
      family: family.familySummary(db, result.familyId),
      membership: family.membershipSummary(db, result.familyId)
    });
  });

  /* 撤销待接受邀请（仅 owner） */
  r.delete('/invite/:id', csrfProtect, requireParentOwner, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 404, 'invite_not_found', 'Invitation not found.');
    const info = db.prepare(
      `UPDATE family_invites SET revoked_at = ?
       WHERE id = ? AND family_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`
    ).run(Date.now(), id, req.user.familyId);
    if (!info.changes) return fail(res, 404, 'invite_not_found', 'Invitation not found.');
    ok(res, { revoked: true });
  });

  return r;
}

module.exports = {
  buildFamilyRouter, familyInviteLandingHandler, familyInvitePendingHandler, INVITE_COOKIE
};
