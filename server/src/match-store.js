/* Live Race 对局落库（M1.5，DESIGN §13.3、§6）
 * - 只有登录档案的座位落库；游客座位全程留在内存（游客对局零落库）；
 * - 逐题数据写进 attempts(mode='versus') + attempt_questions，
 *   因此速度统计与错题本自动涵盖对战数据，且与 Practice/Challenge 分开统计（7.3）；
 * - 首次错误进错题本沿用 records.insertRecord 的服务端判分与 2.4 口径；
 * - 幂等：attempt 的 client_event_id 由 matchId+seat 决定，重复调用不会重复计数。
 */
'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { ok } = require('./middleware');
const { loadOwnProfile } = require('./profiles');
const { insertRecord } = require('./records');

/* 把一次对局写入数据库。返回 { matchId, seats: [...] }
 * 幂等键取「房间码 + 开局时刻 + 座位」：同一场对局即使被重复持久化
 * （例如结算回调被触发两次），也不会重复写 attempt 或重复累计错题。 */
function persistMatch(db, match) {
  const stableEventId = seat =>
    ('vs' + crypto.createHash('sha1')
      .update(match.roomCode + ':' + match.startedAt + ':' + seat)
      .digest('hex')).slice(0, 64);

  const tx = db.transaction(() => {
    /* 先筛出真正要落库的座位：游客（profileId 为空）或档案已删除的一律跳过。
     * 如果一场对局里没有任何登录档案，就完全不留痕（DESIGN 13.0：游客对局零落库）——
     * 连 matches 主体也不建，否则会留下「某场对战存在过」的空行。 */
    const persistable = [];
    for (const p of match.players) {
      if (!p.profileId) continue;
      const owned = db.prepare('SELECT id FROM child_profiles WHERE id = ?').get(p.profileId);
      if (owned) persistable.push(p);
    }
    if (!persistable.length) return { matchId: null, seats: [] };

    /* 同一场对局（房间码 + 开局时刻相同）只建一条 matches 记录：
     * 结算回调被重复触发时复用已有行，而不是写第二场对局。 */
    const existing = db.prepare(
      'SELECT id FROM matches WHERE room_code = ? AND started_at = ?'
    ).get(match.roomCode, match.startedAt);
    let matchId;
    if (existing) {
      matchId = existing.id;
    } else {
      const info = db.prepare(
        'INSERT INTO matches (room_code, mode, difficulty, count, started_at, ended_at) VALUES (?,?,?,?,?,?)'
      ).run(match.roomCode, 'versus', match.difficulty, match.count, match.startedAt, match.endedAt);
      matchId = info.lastInsertRowid;
    }

    const seats = [];
    for (const p of persistable) {
      db.prepare(
        `INSERT OR IGNORE INTO match_players
           (match_id, profile_id, seat, display_name, solved, used_ms, rank, disconnected)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(matchId, p.profileId, p.seat, p.displayName, p.solved,
        p.usedMs === null || p.usedMs === undefined ? null : p.usedMs,
        p.rank, p.disconnected ? 1 : 0);

      // 逐题记录：与练习共用同一套服务端判分（客户端从未上报正确性）
      const payload = {
        clientEventId: stableEventId(p.seat),
        mode: 'versus',
        difficulty: match.difficulty,
        usedTimeS: p.usedMs === null || p.usedMs === undefined ? undefined : Math.round(p.usedMs / 1000),
        createdAt: match.endedAt,
        perQuestion: p.perQuestion.map(q => ({
          a: q.a, b: q.b,
          firstAnswer: q.firstAnswer, finalAnswer: q.finalAnswer, activeMs: q.activeMs
        }))
      };
      // 一题都没答就不写 attempt，避免污染统计（与练习侧 saveRecord 一致）
      const any = payload.perQuestion.some(q => q.firstAnswer !== null || q.finalAnswer !== null);
      if (any) insertRecord(db, p.profileId, payload);
      seats.push({ seat: p.seat, profileId: p.profileId, rank: p.rank });
    }
    return { matchId, seats };
  });
  return tx();
}

/* 家长中心私密战绩（DESIGN 13.1：不公开、只给本人看） */
function matchSummaryForProfile(db, profileId) {
  const rows = db.prepare(
    `SELECT rank, solved, used_ms FROM match_players
     WHERE profile_id = ? ORDER BY id DESC LIMIT 50`
  ).all(profileId);
  let wins = 0, losses = 0;
  for (const r of rows) {
    if (r.rank === 1) wins++;
    else if (r.rank !== null) losses++;
  }
  return { matches: rows.length, wins, losses, recent: rows };
}

/* GET /api/profiles/:id/versus —— 只返回本人档案的对战战绩 */
function buildVersusRouter(db) {
  const r = express.Router({ mergeParams: true });
  r.use(loadOwnProfile(db));
  r.get('/', (req, res) => {
    const s = matchSummaryForProfile(db, req.profile.id);
    ok(res, {
      matches: s.matches,
      wins: s.wins,
      losses: s.losses,
      recent: s.recent.map(x => ({ rank: x.rank, solved: x.solved, usedMs: x.used_ms }))
    });
  });
  return r;
}

module.exports = { persistMatch, matchSummaryForProfile, buildVersusRouter };
