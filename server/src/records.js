/* 练习记录 / 统计 / 错题本（DESIGN §2.4、§6、§7）
 * 服务端权威口径：
 *  - 客户端只上报每题 {a, b, firstAnswer, finalAnswer, activeMs}；
 *    正确与否、blank、passed 全部由服务端计算（不接受客户端 correct 声明）；
 *  - 首次错误进错题本：同答案不重复累计、不同答案 +1、a×b 规范化合并（2.4）；
 *  - 幂等：attempts(profile_id, client_event_id) 唯一，重复上报返回 duplicate；
 *  - 导入有界批量，逐条返回 inserted/duplicate/invalid；
 *  - 统计分模式与难度分组，打卡按家长账号时区的自然日（4.2 / 7.3）。
 */
'use strict';

const express = require('express');
const { ok, fail, csrfProtect, rateLimit } = require('./middleware');
const { loadOwnProfile } = require('./profiles');
const U = require('./util');

const MODES = ['practice', 'challenge', 'mistakes', 'versus'];
const DIFFS = ['times_tables_10', 'times_tables_12', 'two_by_one', 'two_by_two', 'mixed'];
const MAX_QUESTIONS = 20;
const IMPORT_BATCH_MAX = 50;

/* ---------- 校验：一条记录载荷 ---------- */
function validateRecordPayload(body) {
  if (!body || typeof body !== 'object') return { err: 'invalid_body' };
  if (!U.isValidEventId(body.clientEventId)) return { err: 'invalid_event_id' };
  if (!MODES.includes(body.mode)) return { err: 'invalid_mode' };
  if (!DIFFS.includes(body.difficulty)) return { err: 'invalid_difficulty' };
  if (body.level !== undefined && body.level !== null && !U.intIn(body.level, 1, 10)) return { err: 'invalid_level' };
  if (body.usedTimeS !== undefined && body.usedTimeS !== null && !U.intIn(body.usedTimeS, 0, 3600)) return { err: 'invalid_used_time' };
  if (body.createdAt !== undefined && body.createdAt !== null &&
      (!U.intIn(body.createdAt, Date.now() - 366 * 24 * 3600 * 1000, Date.now() + 24 * 3600 * 1000))) {
    return { err: 'invalid_created_at' };
  }
  const pq = body.perQuestion;
  if (!Array.isArray(pq) || pq.length < 1 || pq.length > MAX_QUESTIONS) return { err: 'invalid_question_count' };
  for (const q of pq) {
    if (!q || typeof q !== 'object') return { err: 'invalid_question' };
    if (!U.intIn(q.a, 1, 99) || !U.intIn(q.b, 1, 99)) return { err: 'invalid_factor' };
    if (q.firstAnswer !== null && q.firstAnswer !== undefined && !U.intIn(q.firstAnswer, -1, 100000)) return { err: 'invalid_answer' };
    if (q.finalAnswer !== null && q.finalAnswer !== undefined && !U.intIn(q.finalAnswer, -1, 100000)) return { err: 'invalid_answer' };
    if (q.activeMs !== null && q.activeMs !== undefined && !U.intIn(q.activeMs, 0, 600000)) return { err: 'invalid_active_ms' };
  }
  return { body };
}

/* ---------- 服务端判分（权威） ---------- */
function gradeServerSide(pq) {
  return pq.map(q => {
    const first = q.firstAnswer === undefined ? null : q.firstAnswer;
    const final = q.finalAnswer === undefined ? null : q.finalAnswer;
    const answer = q.a * q.b;
    return {
      a: q.a, b: q.b,
      first_answer: first,
      final_answer: final,
      first_correct: first === null ? null : (first === answer),
      final_correct: final !== null && final === answer,
      active_ms: q.activeMs === undefined ? null : q.activeMs
    };
  });
}

function normKey(a, b) { return a <= b ? [a, b] : [b, a]; }

/* 首次错误 → 错题本（规范化合并；同答案不累计，不同答案 +1） */
function applyFirstWrong(db, profileId, graded, level, now) {
  for (const g of graded) {
    if (g.first_answer === null || g.first_correct) continue;
    const [na, nb] = normKey(g.a, g.b);
    const row = db.prepare('SELECT * FROM wrong_questions WHERE profile_id = ? AND a = ? AND b = ?')
      .get(profileId, na, nb);
    if (!row) {
      db.prepare(
        'INSERT INTO wrong_questions (profile_id, a, b, user_answer, wrong_count, level, last_wrong_at) VALUES (?,?,?,?,1,?,?)'
      ).run(profileId, na, nb, g.first_answer, level || null, now);
    } else if (row.user_answer !== g.first_answer) {
      db.prepare('UPDATE wrong_questions SET user_answer = ?, wrong_count = wrong_count + 1, level = ?, last_wrong_at = ? WHERE id = ?')
        .run(g.first_answer, level || null, now, row.id);
    } else {
      db.prepare('UPDATE wrong_questions SET last_wrong_at = ? WHERE id = ?').run(now, row.id);
    }
  }
}

/* ---------- 写入一条（事务 + 幂等） ---------- */
function insertRecord(db, profileId, payload) {
  const graded = gradeServerSide(payload.perQuestion);
  const passed = graded.length > 0 && graded.every(g => g.final_correct);
  const createdAt = payload.createdAt || Date.now();
  const now = Date.now();

  const insert = db.transaction(() => {
    const info = db.prepare(
      `INSERT OR IGNORE INTO attempts
         (profile_id, client_event_id, mode, difficulty, level, passed, used_time_s, active_time_ms, created_at, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(profileId, payload.clientEventId, payload.mode, payload.difficulty,
      payload.level || null, passed ? 1 : 0,
      payload.usedTimeS ?? null,
      graded.reduce((s, g) => s + (g.active_ms || 0), 0) || null,
      createdAt, now);
    if (info.changes === 0) return { duplicate: true };

    const attemptId = info.lastInsertRowid;
    const insQ = db.prepare(
      `INSERT INTO attempt_questions
         (attempt_id, position, a, b, first_answer, final_answer, first_correct, final_correct, active_time_ms)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    graded.forEach((g, i) => insQ.run(attemptId, i, g.a, g.b, g.first_answer, g.final_answer,
      g.first_correct === null ? null : (g.first_correct ? 1 : 0), g.final_correct ? 1 : 0, g.active_ms));
    applyFirstWrong(db, profileId, graded, payload.level, createdAt);
    return { duplicate: false, attemptId, passed };
  });
  return insert();
}

/* ---------- 时区打卡（DESIGN 4.2 / 7.3） ---------- */
function dateInTz(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms)); // YYYY-MM-DD
}

function computeStreak(datesSet, timeZone) {
  if (datesSet.size === 0) return 0;
  const today = dateInTz(Date.now(), timeZone);
  const yesterday = dateInTz(Date.now() - 24 * 3600 * 1000, timeZone);
  if (!datesSet.has(today) && !datesSet.has(yesterday)) return 0;
  let streak = 0;
  let cursor = datesSet.has(today) ? Date.now() : Date.now() - 24 * 3600 * 1000;
  for (;;) {
    const d = dateInTz(cursor, timeZone);
    if (!datesSet.has(d)) break;
    streak++;
    cursor -= 24 * 3600 * 1000;
  }
  return streak;
}

/* 错题重练上报的共用实现：correct 减一到零移出；答错 +1；批内规范化去重 */
function applyReview(db, profileId, items) {
  const seen = new Set();
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const it of items) {
      if (!it || !U.intIn(it.a, 1, 99) || !U.intIn(it.b, 1, 99) || typeof it.correct !== 'boolean') continue;
      const [na, nb] = normKey(it.a, it.b);
      const key = na + 'x' + nb;
      if (seen.has(key)) continue; // 每题每轮最多一次（DESIGN 2.4）
      seen.add(key);
      const row = db.prepare('SELECT * FROM wrong_questions WHERE profile_id = ? AND a = ? AND b = ?')
        .get(profileId, na, nb);
      if (it.correct) {
        if (row) {
          if (row.wrong_count <= 1) db.prepare('DELETE FROM wrong_questions WHERE id = ?').run(row.id);
          else db.prepare('UPDATE wrong_questions SET wrong_count = wrong_count - 1 WHERE id = ?').run(row.id);
        }
      } else {
        const ua = it.userAnswer !== undefined && U.intIn(it.userAnswer, -1, 100000) ? it.userAnswer : null;
        if (!row) {
          db.prepare('INSERT INTO wrong_questions (profile_id, a, b, user_answer, wrong_count, last_wrong_at) VALUES (?,?,?,?,1,?)')
            .run(profileId, na, nb, ua, now);
        } else if (row.user_answer !== ua) {
          db.prepare('UPDATE wrong_questions SET user_answer = ?, wrong_count = wrong_count + 1, last_wrong_at = ? WHERE id = ?')
            .run(ua, now, row.id);
        } else {
          db.prepare('UPDATE wrong_questions SET last_wrong_at = ? WHERE id = ?').run(now, row.id);
        }
      }
    }
  });
  tx();
  return seen.size;
}

/* ---------- /api/profiles/:id/records ---------- */
function buildRecordsRouter(db) {
  const r = express.Router({ mergeParams: true }); // 继承挂载路径的 :id
  r.use(loadOwnProfile(db));

  r.post('/',
    rateLimit({ windowMs: 60000, max: 60, keyFn: q => q.user && q.user.id, name: 'records' }),
    csrfProtect, (req, res) => {
      const v = validateRecordPayload(req.body);
      if (v.err) return fail(res, 400, v.err, 'Invalid record payload.');
      const result = insertRecord(db, req.profile.id, v.body);
      ok(res, { inserted: !result.duplicate, duplicate: result.duplicate, passed: !!result.passed });
    });

  r.post('/import',
    rateLimit({ windowMs: 60000, max: 5, keyFn: q => q.user && q.user.id, name: 'import' }),
    csrfProtect, (req, res) => {
      const items = req.body && req.body.records;
      if (!Array.isArray(items) || items.length < 1 || items.length > IMPORT_BATCH_MAX) {
        return fail(res, 400, 'invalid_batch', `Import accepts 1–${IMPORT_BATCH_MAX} records per call.`);
      }
      const results = items.map(item => {
        const v = validateRecordPayload(item);
        if (v.err) return { clientEventId: (item && item.clientEventId) || null, result: 'invalid', reason: v.err };
        const r = insertRecord(db, req.profile.id, v.body);
        return { clientEventId: v.body.clientEventId, result: r.duplicate ? 'duplicate' : 'inserted' };
      });
      ok(res, { results });
    });

  r.get('/', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const cursor = req.query.cursor !== undefined && Number(req.query.cursor) > 0
      ? Number(req.query.cursor) : Number.MAX_SAFE_INTEGER;
    const mode = MODES.includes(req.query.mode) ? req.query.mode : null;
    const rows = db.prepare(
      `SELECT id, client_event_id, mode, difficulty, level, passed, used_time_s, active_time_ms, created_at
       FROM attempts WHERE profile_id = ? AND id < ? ${mode ? 'AND mode = ?' : ''}
       ORDER BY id DESC LIMIT ?`
    ).all(...[req.profile.id, cursor, ...(mode ? [mode] : []), limit + 1]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    ok(res, {
      records: page.map(x => ({
        id: x.id, clientEventId: x.client_event_id, mode: x.mode, difficulty: x.difficulty,
        level: x.level, passed: !!x.passed, usedTimeS: x.used_time_s, activeTimeMs: x.active_time_ms,
        createdAt: x.created_at
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null
    });
  });

  r.get('/stats', (req, res) => {
    const byGroup = db.prepare(
      `SELECT a.mode, a.difficulty,
              COUNT(DISTINCT a.id) AS rounds,
              COUNT(q.id) AS questions,
              SUM(CASE WHEN q.first_correct = 1 THEN 1 ELSE 0 END) AS firstCorrect,
              SUM(CASE WHEN q.first_correct IS NOT NULL THEN 1 ELSE 0 END) AS firstAnswered,
              SUM(CASE WHEN q.final_correct = 1 THEN 1 ELSE 0 END) AS finalCorrect,
              SUM(CASE WHEN q.active_time_ms IS NOT NULL THEN q.active_time_ms ELSE 0 END) AS activeTotal,
              SUM(CASE WHEN q.active_time_ms IS NOT NULL THEN 1 ELSE 0 END) AS activeCount
       FROM attempts a JOIN attempt_questions q ON q.attempt_id = a.id
       WHERE a.profile_id = ?
       GROUP BY a.mode, a.difficulty`
    ).all(req.profile.id);

    const groups = byGroup.map(g => ({
      mode: g.mode, difficulty: g.difficulty, rounds: g.rounds, questions: g.questions,
      firstAccuracy: g.firstAnswered ? +(g.firstCorrect / g.firstAnswered).toFixed(4) : null,
      finalCompletion: g.questions ? +(g.finalCorrect / g.questions).toFixed(4) : null,
      avgActiveMs: g.activeCount ? Math.round(g.activeTotal / g.activeCount) : null
    }));

    const dates = new Set(db.prepare('SELECT created_at FROM attempts WHERE profile_id = ?')
      .all(req.profile.id).map(x => dateInTz(x.created_at, req.timezone)));
    ok(res, {
      groups,
      streakDays: computeStreak(dates, req.timezone),
      activeDays: dates.size,
      timezone: req.timezone
    });
  });

  return r;
}

/* ---------- /api/profiles/:id/wrongbook ---------- */
function buildWrongbookRouter(db) {
  const r = express.Router({ mergeParams: true }); // 继承挂载路径的 :id
  r.use(loadOwnProfile(db));

  r.get('/', (req, res) => {
    const rows = db.prepare(
      `SELECT id, a, b, user_answer AS userAnswer, wrong_count AS wrongCount, level, last_wrong_at AS lastWrongAt
       FROM wrong_questions WHERE profile_id = ?
       ORDER BY wrong_count DESC, last_wrong_at DESC LIMIT 200`
    ).all(req.profile.id);
    ok(res, { items: rows });
  });

  r.post('/review', csrfProtect, (req, res) => {
    const items = req.body && req.body.results;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_QUESTIONS) {
      return fail(res, 400, 'invalid_batch', 'Review accepts 1–20 results.');
    }
    ok(res, { applied: applyReview(db, req.profile.id, items) });
  });

  r.delete('/:qid', csrfProtect, (req, res) => {
    const qid = Number(req.params.qid);
    if (!Number.isInteger(qid)) return fail(res, 400, 'invalid_id', 'Invalid id.');
    db.prepare('DELETE FROM wrong_questions WHERE id = ? AND profile_id = ?').run(qid, req.profile.id);
    ok(res, { deleted: true });
  });

  return r;
}

module.exports = {
  buildRecordsRouter, buildWrongbookRouter,
  validateRecordPayload, gradeServerSide, insertRecord, applyReview,
  dateInTz, computeStreak,
  MODES, DIFFS, MAX_QUESTIONS, IMPORT_BATCH_MAX
};
