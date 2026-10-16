/* 账号数据：导出 / 删除（DESIGN §7.1、§6）
 * - 导出：JSON 附件，包含账号、档案、练习记录（含逐题）、错题本；
 * - 删除：事务内级联清除（sessions/auth_tokens → profiles → attempts/questions/wrongbook → users），
 *   M1 无订单数据；日志只记脱敏摘要（DESIGN 10.2）。
 */
'use strict';

const express = require('express');
const { ok, csrfProtect } = require('./middleware');
const { clearSessionCookie } = require('./auth');

function buildAccountRouter(db) {
  const r = express.Router();

  /* 导出学习数据 */
  r.get('/export', (req, res) => {
    const uid = req.user.id;
    const profiles = db.prepare('SELECT id, nickname, avatar_key, created_at FROM child_profiles WHERE user_id = ?').all(uid);
    const out = {
      exportedAt: new Date().toISOString(),
      user: {
        email: req.user.email,
        emailVerified: req.user.emailVerified,
        locale: req.user.locale,
        timezone: req.user.timezone,
        createdAt: req.user.createdAt
      },
      profiles: [],
      wrongbook: []
    };
    const selAtt = db.prepare(
      `SELECT id, client_event_id, mode, difficulty, level, passed, used_time_s, active_time_ms, created_at, received_at
       FROM attempts WHERE profile_id = ? ORDER BY id`);
    const selQ = db.prepare(
      `SELECT position, a, b, first_answer, final_answer, first_correct, final_correct, active_time_ms
       FROM attempt_questions WHERE attempt_id = ? ORDER BY position`);
    for (const p of profiles) {
      const attempts = selAtt.all(p.id).map(a => ({
        id: a.id, clientEventId: a.client_event_id, mode: a.mode, difficulty: a.difficulty,
        level: a.level, passed: !!a.passed, usedTimeS: a.used_time_s, activeTimeMs: a.active_time_ms,
        createdAt: a.created_at, receivedAt: a.received_at,
        questions: selQ.all(a.id).map(q => ({
          position: q.position, a: q.a, b: q.b,
          firstAnswer: q.first_answer, finalAnswer: q.final_answer,
          firstCorrect: q.first_correct === null ? null : !!q.first_correct,
          finalCorrect: !!q.final_correct, activeMs: q.active_time_ms
        }))
      }));
      out.profiles.push({ id: p.id, nickname: p.nickname, avatarKey: p.avatar_key, createdAt: p.created_at, attempts });
      out.wrongbook.push(...db.prepare(
        'SELECT profile_id, a, b, user_answer, wrong_count, last_wrong_at FROM wrong_questions WHERE profile_id = ?'
      ).all(p.id).map(w => ({
        profileId: w.profile_id, a: w.a, b: w.b, userAnswer: w.user_answer,
        wrongCount: w.wrong_count, lastWrongAt: w.last_wrong_at
      })));
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tangyuan-math-data.json"');
    // 导出响应不进入公共缓存（DESIGN 9）
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, data: out });
  });

  /* 删除账号（全部学习数据级联清除） */
  r.delete('/', csrfProtect, (req, res) => {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
      db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(req.user.id);
      db.prepare('DELETE FROM child_profiles WHERE user_id = ?').run(req.user.id); // 级联 attempts 等
      db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    });
    tx();
    clearSessionCookie(res);
    // 日志脱敏：不记邮箱，只记内部 ID（DESIGN 10.2）
    console.log(`[account] deleted user id=${req.user.id}`);
    ok(res, { deleted: true });
  });

  return r;
}

module.exports = { buildAccountRouter };
