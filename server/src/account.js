/* 账号数据：导出 / 删除（DESIGN §7.1、§6）
 * - 导出：JSON 附件，包含账号、家庭、家庭内子女档案、练习记录（含逐题）、错题本；
 * - 删除：家长账号删除只影响本人；若还有其他家长，家庭、子女与会员权益保留；
 *   最后一位家长删除时整个家庭一起删除（级联子女数据与家庭权益）。
 * - 日志只记脱敏摘要（DESIGN 10.2）。
 */
'use strict';

const express = require('express');
const { ok, csrfProtect } = require('./middleware');
const { clearSessionCookie } = require('./auth');

function buildAccountRouter(db) {
  const r = express.Router();

  /* 导出学习数据（家庭维度；不含密码哈希） */
  r.get('/export', (req, res) => {
    const familyId = req.user.familyId;
    const profiles = db.prepare(
      'SELECT id, nickname, avatar_key, username, created_at FROM child_profiles WHERE family_id = ? ORDER BY id'
    ).all(familyId);
    const out = {
      exportedAt: new Date().toISOString(),
      user: {
        email: req.user.email,
        emailVerified: req.user.emailVerified,
        locale: req.user.locale,
        timezone: req.user.timezone,
        createdAt: req.user.createdAt,
        familyRole: req.user.familyRole
      },
      family: {
        id: familyId,
        parents: db.prepare(
          'SELECT email_normalized AS email, family_role AS role FROM users WHERE family_id = ? ORDER BY id'
        ).all(familyId)
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
      out.profiles.push({
        id: p.id, nickname: p.nickname, avatarKey: p.avatar_key,
        username: p.username || null, createdAt: p.created_at,
        attempts,
        // 对战记录（DESIGN 13.3）：家长导出时也应能看到子女的对局成绩
        versus: db.prepare(
          `SELECT mp.seat, mp.display_name, mp.solved, mp.used_ms, mp.rank, mp.disconnected,
                  m.room_code, m.difficulty, m.count, m.started_at, m.ended_at
           FROM match_players mp JOIN matches m ON m.id = mp.match_id
           WHERE mp.profile_id = ? ORDER BY mp.id`
        ).all(p.id).map(v => ({
          roomCode: v.room_code, difficulty: v.difficulty, count: v.count,
          startedAt: v.started_at, endedAt: v.ended_at,
          seat: v.seat, displayName: v.display_name, solved: v.solved,
          usedMs: v.used_ms, rank: v.rank, disconnected: !!v.disconnected
        }))
      });
      out.wrongbook.push(...db.prepare(
        'SELECT profile_id, a, b, user_answer, wrong_count, last_wrong_at FROM wrong_questions WHERE profile_id = ?'
      ).all(p.id).map(w => ({
        profileId: w.profile_id, a: w.a, b: w.b, userAnswer: w.user_answer,
        wrongCount: w.wrong_count, lastWrongAt: w.last_wrong_at
      })));
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tangyuan-math-data.json"');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, data: out });
  });

  /* 删除账号：有其他家长时只移除本人，最后一位家长删除整个家庭 */
  r.delete('/', csrfProtect, (req, res) => {
    const familyId = req.user.familyId;
    const tx = db.transaction(() => {
      const otherParents = familyId
        ? db.prepare('SELECT id FROM users WHERE family_id = ? AND id <> ? ORDER BY id').all(familyId, req.user.id)
        : [];

      if (otherParents.length) {
        const heirId = otherParents[0].id;
        // 转交 owner（如果离开的是 owner），并把其创建的子女交给留任家长，
        // 否则 child_profiles.user_id 的级联删除会带走家庭共有子女。
        if (req.user.familyRole === 'owner') {
          // 先降级即将删除的 owner，再提升继承人：部分唯一索引不允许同一家庭同时有两个 owner
          db.prepare("UPDATE users SET family_role = 'coparent' WHERE id = ?").run(req.user.id);
          db.prepare("UPDATE users SET family_role = 'owner' WHERE id = ?").run(heirId);
        }
        db.prepare('UPDATE child_profiles SET user_id = ? WHERE user_id = ?').run(heirId, req.user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
        db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(req.user.id);
        db.prepare('DELETE FROM family_invites WHERE invited_by = ? AND accepted_at IS NULL').run(req.user.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
      } else {
        // 最后一位家长：整个家庭一起删除；权益/邀请随 families 级联
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
        db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(req.user.id);
        if (familyId) {
          db.prepare('DELETE FROM child_profiles WHERE family_id = ?').run(familyId); // 级联练习/错题/对战/子会话
          db.prepare('DELETE FROM families WHERE id = ?').run(familyId);
        } else {
          db.prepare('DELETE FROM child_profiles WHERE user_id = ?').run(req.user.id);
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
      }

      /* 删除子女后，matches 主体可能变成没有参与者的空对局；
       * 它不属于任何账号（DESIGN 6），一并清掉。 */
      db.prepare('DELETE FROM matches WHERE id NOT IN (SELECT match_id FROM match_players)').run();
    });
    tx();
    clearSessionCookie(res);
    console.log(`[account] deleted user id=${req.user.id}`);
    ok(res, { deleted: true });
  });

  return r;
}

module.exports = { buildAccountRouter };
