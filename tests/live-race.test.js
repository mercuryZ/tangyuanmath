'use strict';
/* Live Race 房间引擎单测（无网络：注入 now / rand / send / onMatchEnd）
 * 覆盖 DESIGN §13 的验收点：客户端拿不到答案、伪造 answer 无效、游客零落库、
 * 重连回归原座位、排名规则、限速、房间生命周期。
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const {
  RoomManager, rankPlayers, RECONNECT_WINDOW_MS, ROOM_IDLE_MS, ANSWER_RATE_PER_SEC,
  ROOM_CODE_WORDS, MAX_CODE_LENGTH
} = require('../server/src/live-race');

/* 测试脚手架：可推进的假时钟 + 消息记录 */
function harness() {
  let now = 1000000;
  const sent = [];
  const ended = [];
  const mgr = new RoomManager({
    now: () => now,
    autoTick: false,
    send: (connId, msg) => sent.push({ connId, msg }),
    onMatchEnd: m => ended.push(m)
  });
  const h = {
    mgr,
    sent,
    ended,
    now: () => now,
    advance: ms => { now += ms; },
    setNow: v => { now = v; },
    conn: id => { mgr.registerConn(id, { ip: '1.2.3.4' }); return id; },
    msgsTo: id => sent.filter(x => x.connId === id).map(x => x.msg),
    lastTo: id => { const a = sent.filter(x => x.connId === id); return a.length ? a[a.length - 1].msg : null; },
    lastOf: (id, type) => {
      const a = sent.filter(x => x.connId === id && x.msg.type === type);
      return a.length ? a[a.length - 1].msg : null;
    },
    /* 逐题作答：每答一题推进 300ms，避免撞上 4 次/秒的答案事件限速 */
    solveAll: (connId, room, stepMs) => {
      room.problems.forEach((q, i) => {
        mgr.handle(connId, { type: 'answer', position: i, value: q.a * q.b });
        h.advance(stepMs === undefined ? 300 : stepMs);
      });
    },
    clear: () => { sent.length = 0; }
  };
  return h;
}

function startTwoPlayer(h, settings) {
  const A = h.conn('cA'), B = h.conn('cB');
  const created = h.mgr.handle(A, { type: 'create_room', difficulty: 'two_by_two', count: 5 });
  const joined = h.mgr.handle(B, { type: 'join_room', code: created.code });
  h.mgr.handle(A, { type: 'start_game' });
  h.advance(3100);
  h.mgr.tick();
  return { A, B, code: created.code, tokenA: created.token, tokenB: joined.token };
}

test('创建房间：返回简单单词房间码、座位令牌，并广播 room_state', () => {
  const h = harness();
  const A = h.conn('cA');
  const r = h.mgr.handle(A, { type: 'create_room', difficulty: 'two_by_two', count: 10 });
  assert.ok(r.code, 'has code');
  assert.ok(ROOM_CODE_WORDS.includes(r.code), '房间码来自水果/动物/数字词表: ' + r.code);
  assert.ok(r.code.length <= MAX_CODE_LENGTH, '房间码不超过 5 个字符: ' + r.code);
  assert.strictEqual(r.seat, 0);
  assert.ok(r.token && r.token.length > 10);
  const joined = h.lastOf(A, 'joined');
  assert.strictEqual(joined.seat, 0);
  assert.strictEqual(joined.code, r.code);
  const state = h.msgsTo(A).filter(m => m.type === 'room_state').pop();
  assert.strictEqual(state.room.status, 'waiting');
  assert.strictEqual(state.room.players.length, 1);
  assert.strictEqual(state.room.players[0].seat, 0);
});

test('房间码词表：全大写、3–5 个字母、无重复', () => {
  assert.ok(ROOM_CODE_WORDS.length >= 50, '词表需覆盖同时在线的房间数量: ' + ROOM_CODE_WORDS.length);
  for (const w of ROOM_CODE_WORDS) assert.match(w, /^[A-Z]{3,5}$/, '非法词: ' + w);
  assert.strictEqual(new Set(ROOM_CODE_WORDS).size, ROOM_CODE_WORDS.length, '词表不得重复');
});

test('房间码大小写不敏感；不存在的码返回 room_not_found', () => {
  const h = harness();
  const A = h.conn('cA');
  const r = h.mgr.handle(A, { type: 'create_room', count: 5 });
  const B = h.conn('cB');
  const lower = h.mgr.handle(B, { type: 'join_room', code: r.code.toLowerCase() });
  assert.ok(lower.room, '小写房间码也能加入');
  const C = h.conn('cC');
  const miss = h.mgr.handle(C, { type: 'join_room', code: 'ZZZZZ' });
  assert.strictEqual(miss.error, 'room_not_found');
});

test('game_start 下发的题目只有 {a,b}，绝不含 answer（防作弊核心）', () => {
  const h = harness();
  const { A, B } = startTwoPlayer(h);
  for (const id of [A, B]) {
    const gs = h.msgsTo(id).filter(m => m.type === 'game_start').pop();
    assert.ok(gs, '收到 game_start');
    assert.strictEqual(gs.problems.length, 5);
    gs.problems.forEach(p => {
      assert.deepStrictEqual(Object.keys(p).sort(), ['a', 'b'], '题目字段只有 a/b：' + JSON.stringify(p));
      assert.strictEqual(p.answer, undefined);
    });
    assert.ok(gs.deadline > gs.startedAt, '截止时刻由服务器给出');
  }
  // 两名玩家拿到的是同一套题
  const pa = h.msgsTo(A).filter(m => m.type === 'game_start').pop().problems;
  const pb = h.msgsTo(B).filter(m => m.type === 'game_start').pop().problems;
  assert.deepStrictEqual(pa, pb);
});

test('伪造 answer：客户端无法声明 correct，只能报 {position,value}，判定由服务端完成', () => {
  const h = harness();
  const { A, B } = startTwoPlayer(h);
  const room = h.mgr.rooms.get(h.mgr.byConn.get(A).code);
  const q = room.problems[0];
  const correct = q.a * q.b;

  // 谎报 correct:true 但答案错误 → 服务端仍判错
  h.mgr.handle(A, { type: 'answer', position: 0, value: correct + 1, correct: true });
  let judge = h.lastOf(A, 'judge');
  assert.strictEqual(judge.correct, false, '服务端不采信客户端的 correct 声明');
  assert.strictEqual(judge.solved, 0);

  // 答对才推进进度
  h.advance(300);
  h.mgr.handle(A, { type: 'answer', position: 0, value: correct });
  judge = h.lastOf(A, 'judge');
  assert.strictEqual(judge.correct, true);
  assert.strictEqual(judge.solved, 1);
});

test('交卷：一次性判定整张卷子，返回逐题结果供棋盘打 ✓/✗', () => {
  const h = harness();
  const { A } = startTwoPlayer(h);
  const room = h.mgr.rooms.get(h.mgr.byConn.get(A).code);
  const q0 = room.problems[0], q1 = room.problems[1], q2 = room.problems[2];
  // 第 0 题此前已逐题答对
  h.mgr.handle(A, { type: 'answer', position: 0, value: q0.a * q0.b });
  h.advance(300);

  // 交卷时补报第 1 题（对）与第 2 题（错），第 3/4 题未答
  const r = h.mgr.handle(A, { type: 'submit', answers: [
    { position: 1, value: q1.a * q1.b },
    { position: 2, value: q2.a * q2.b + 1 }
  ] });
  assert.deepStrictEqual(r, { ok: true });

  const sub = h.lastOf(A, 'submitted');
  assert.strictEqual(sub.solved, 2, '逐题答对 + 交卷判定合并计数');
  assert.strictEqual(sub.total, 5);
  assert.strictEqual(sub.waitingFor, 1, '只统计其他未交卷玩家');
  assert.deepStrictEqual(sub.results, [
    { position: 1, correct: true },
    { position: 2, correct: false }
  ], '逐题结果只含本次交卷判定的题，足够客户端标记整张棋盘');

  // 交卷后不再接受作答，也不能重复交卷
  assert.strictEqual(h.mgr.handle(A, { type: 'answer', position: 3, value: 0 }).error, 'finished');
  assert.strictEqual(h.mgr.handle(A, { type: 'submit', answers: [] }).error, 'already_submitted');
});

test('peer_progress 只广播座位号与答对数，不含用户/档案标识', () => {
  const h = harness();
  const { A, B } = startTwoPlayer(h);
  const room = h.mgr.rooms.get(h.mgr.byConn.get(A).code);
  h.mgr.handle(A, { type: 'answer', position: 0, value: room.problems[0].a * room.problems[0].b });
  const peer = h.msgsTo(B).filter(m => m.type === 'peer_progress').pop();
  assert.ok(peer, '对手收到进度');
  assert.deepStrictEqual(Object.keys(peer).sort(), ['finished', 'seat', 'solved', 'type']);
  assert.strictEqual(peer.seat, 0);
});

test('越界 position / 非法 value 被拒；未开局时 answer 被拒', () => {
  const h = harness();
  const A = h.conn('cA'), B = h.conn('cB');
  const r = h.mgr.handle(A, { type: 'create_room', count: 5 });
  h.mgr.handle(B, { type: 'join_room', code: r.code });
  // 还没开始
  assert.strictEqual(h.mgr.handle(A, { type: 'answer', position: 0, value: 1 }).error, 'not_running');
  h.mgr.handle(A, { type: 'start_game' });
  h.advance(3100); h.mgr.tick();
  assert.strictEqual(h.mgr.handle(A, { type: 'answer', position: 99, value: 1 }).error, 'invalid_position');
  assert.strictEqual(h.mgr.handle(A, { type: 'answer', position: -1, value: 1 }).error, 'invalid_position');
  assert.strictEqual(h.mgr.handle(A, { type: 'answer', position: 0, value: 'x' }).error, 'invalid_value');
  assert.strictEqual(h.mgr.handle(A, { type: 'answer', position: 0, value: 1.5 }).error, 'invalid_value');
});

test('答案事件限速：同一秒内超过阈值的事件被丢弃', () => {
  const h = harness();
  const { A } = startTwoPlayer(h);
  const room = h.mgr.rooms.get(h.mgr.byConn.get(A).code);
  // 时间不推进：全部落在同一个 1 秒窗口
  const results = [];
  for (let i = 0; i < ANSWER_RATE_PER_SEC + 3; i++) {
    results.push(h.mgr.handle(A, { type: 'answer', position: 0, value: 1 }));
  }
  const limited = results.filter(r => r && r.error === 'rate_limited').length;
  assert.strictEqual(limited, 3, '超出部分应被限速：' + JSON.stringify(results.map(r => r && (r.error || 'ok'))));
});

test('排名：先全部答对者胜；超时则答对多者胜；再平局比最后一题更早答对', () => {
  const room = {
    startedAt: 1000,
    players: [
      { seat: 0, name: 'A', avatar: '🍡', correctPositions: new Set([0, 1]), finishedAt: null, lastCorrectAt: 9000, disconnectedAt: null },
      { seat: 1, name: 'B', avatar: '⭐', correctPositions: new Set([0, 1, 2]), finishedAt: null, lastCorrectAt: 9500, disconnectedAt: null },
      { seat: 2, name: 'C', avatar: '❤️', correctPositions: new Set([0, 1, 2]), finishedAt: null, lastCorrectAt: 8000, disconnectedAt: null }
    ]
  };
  const ranked = rankPlayers(room, 20000);
  assert.deepStrictEqual(ranked.map(r => r.seat), [2, 1, 0], '答对多者优先，平手时更早答对者靠前');

  // 完成者永远排在未完成者之前
  room.players[2].finishedAt = 12000;
  const ranked2 = rankPlayers(room, 20000);
  assert.strictEqual(ranked2[0].seat, 2);
  assert.strictEqual(ranked2[0].usedMs, 12000 - 1000);
});

test('全员交卷即结束：广播 game_over 并触发一次落库回调', () => {
  const h = harness();
  const { A, B } = startTwoPlayer(h);
  const room = h.mgr.rooms.get(h.mgr.byConn.get(A).code);
  h.solveAll(A, room);
  h.mgr.handle(A, { type: 'submit', answers: [] });
  assert.strictEqual(h.ended.length, 0, '还有人没交卷，不结束');
  h.solveAll(B, room);
  h.mgr.handle(B, { type: 'submit', answers: [] });
  assert.strictEqual(room.status, 'over');
  assert.strictEqual(h.ended.length, 1, '只落库一次');
  const over = h.msgsTo(B).filter(m => m.type === 'game_over').pop();
  assert.strictEqual(over.ranking.length, 2);
  assert.strictEqual(over.ranking[0].rank, 1);
  assert.ok(over.ranking.every(r => r.usedMs >= 0));
});

test('超时结束：答对多者排名靠前，reason=timeout', () => {
  const h = harness();
  const { A, B } = startTwoPlayer(h);
  const room = h.mgr.rooms.get(h.mgr.byConn.get(A).code);
  h.mgr.handle(B, { type: 'answer', position: 0, value: room.problems[0].a * room.problems[0].b });
  h.advance(room.settings.duration * 1000 + 10);
  h.mgr.tick();
  assert.strictEqual(room.status, 'over');
  const over = h.msgsTo(A).filter(m => m.type === 'game_over').pop();
  assert.strictEqual(over.reason, 'timeout');
  assert.strictEqual(over.ranking[0].seat, 1, '答对 1 题的 B 排第一');
});

test('重连：座位令牌命中即回归原座位，并补发题目与本人进度', () => {
  const h = harness();
  const A = h.conn('cA'), B = h.conn('cB');
  const created = h.mgr.handle(A, { type: 'create_room', count: 5 });
  const joined = h.mgr.handle(B, { type: 'join_room', code: created.code });
  h.mgr.handle(A, { type: 'start_game' });
  h.advance(3100); h.mgr.tick();
  const room = h.mgr.rooms.get(created.code);
  h.mgr.handle(B, { type: 'answer', position: 0, value: room.problems[0].a * room.problems[0].b });

  // B 掉线
  h.mgr.unregisterConn(B);
  assert.ok(room.players[1].disconnectedAt, '标记掉线');
  h.advance(5000);

  // 换一个新连接，带令牌回归
  const B2 = h.conn('cB2');
  const resumed = h.mgr.handle(B2, { type: 'join_room', code: created.code, resumeToken: joined.token });
  assert.strictEqual(resumed.seat, 1, '回到原座位');
  assert.strictEqual(resumed.resumed, true);
  assert.strictEqual(room.players[1].disconnectedAt, null);
  const gs = h.msgsTo(B2).filter(m => m.type === 'game_start').pop();
  assert.ok(gs, '重连补发对局快照');
  assert.strictEqual(gs.resumed, true);
  assert.deepStrictEqual(gs.solvedPositions, [0], '本人进度保留');
  assert.ok(gs.deadline === room.deadline, '截止时刻不变（掉线不暂停比赛）');
});

test('错误的重连令牌被拒；重连窗口过后等待室座位被移除', () => {
  const h = harness();
  const A = h.conn('cA'), B = h.conn('cB');
  const created = h.mgr.handle(A, { type: 'create_room', count: 5 });
  h.mgr.handle(B, { type: 'join_room', code: created.code });
  const bad = h.mgr.handle(h.conn('cX'), { type: 'join_room', code: created.code, resumeToken: 'forged' });
  assert.strictEqual(bad.error, 'invalid_resume');

  h.mgr.unregisterConn(B);
  h.advance(RECONNECT_WINDOW_MS + 1000);
  h.mgr.tick();
  const room = h.mgr.rooms.get(created.code);
  assert.strictEqual(room.players.length, 1, '超时未回 → 座位释放');
});

test('房主离开 → 房主移交给剩余玩家；全员离开 → 房间销毁', () => {
  const h = harness();
  const A = h.conn('cA'), B = h.conn('cB');
  const created = h.mgr.handle(A, { type: 'create_room', count: 5 });
  h.mgr.handle(B, { type: 'join_room', code: created.code });
  const room = h.mgr.rooms.get(created.code);
  h.mgr.handle(A, { type: 'leave' });
  assert.strictEqual(room.hostSeat, 1, '房主移交给 B');
  h.mgr.handle(B, { type: 'leave' });
  assert.strictEqual(h.mgr.rooms.has(created.code), false, '空房间销毁');
});

test('闲置房间在 ROOM_IDLE_MS 后被回收', () => {
  const h = harness();
  const A = h.conn('cA');
  const created = h.mgr.handle(A, { type: 'create_room', count: 5 });
  h.advance(ROOM_IDLE_MS + 1000);
  h.mgr.tick();
  assert.strictEqual(h.mgr.rooms.has(created.code), false);
});

test('人数与状态限制：单人不能开局；满员拒绝；已开局不能加入', () => {
  const h = harness();
  const A = h.conn('cA');
  const created = h.mgr.handle(A, { type: 'create_room', count: 5 });
  assert.strictEqual(h.mgr.handle(A, { type: 'start_game' }).error, 'need_players', '至少两人');

  const conns = ['c1', 'c2', 'c3'].map(c => h.conn(c));
  conns.forEach(c => h.mgr.handle(c, { type: 'join_room', code: created.code }));
  const fifth = h.conn('c5');
  assert.strictEqual(h.mgr.handle(fifth, { type: 'join_room', code: created.code }).error, 'room_full');

  h.mgr.handle(A, { type: 'start_game' });
  const late = h.conn('cLate');
  assert.strictEqual(h.mgr.handle(late, { type: 'join_room', code: created.code }).error, 'already_started');
});

test('非房主不能开局；rematch 只有房主能发起，且重置进度', () => {
  const h = harness();
  const { A, B } = startTwoPlayer(h);
  const room = h.mgr.rooms.get(h.mgr.byConn.get(A).code);
  assert.strictEqual(h.mgr.handle(B, { type: 'rematch' }).error, 'not_over');
  h.solveAll(A, room);
  h.mgr.handle(A, { type: 'submit', answers: [] });
  h.solveAll(B, room);
  h.mgr.handle(B, { type: 'submit', answers: [] });
  assert.strictEqual(room.status, 'over');
  assert.strictEqual(h.mgr.handle(B, { type: 'rematch' }).error, 'host_only');
  h.mgr.handle(A, { type: 'rematch' });
  assert.strictEqual(room.status, 'waiting');
  assert.strictEqual(room.resultSent, false);
  assert.strictEqual(room.players[0].correctPositions.size, 0);
});

test('落库载荷：游客座位 profileId 为空，登录座位带 profileId 与逐题作答', () => {
  const h = harness();
  // A 是游客；B 是登录档案
  h.mgr.registerConn('cA', { ip: '1.1.1.1', userId: null, profileId: null });
  h.mgr.registerConn('cB', { ip: '2.2.2.2', userId: 7, profileId: 42 });
  const created = h.mgr.handle('cA', { type: 'create_room', count: 5 });
  h.mgr.handle('cB', { type: 'join_room', code: created.code });
  h.mgr.handle('cA', { type: 'start_game' });
  h.advance(3100); h.mgr.tick();
  const room = h.mgr.rooms.get(created.code);
  h.solveAll('cB', room);
  h.mgr.handle('cA', { type: 'answer', position: 0, value: 999 });
  // 游客没答完：比赛不会因「全员答对」结束，推进到截止时刻触发超时结算
  h.advance(room.settings.duration * 1000);
  h.mgr.tick();

  assert.strictEqual(h.ended.length, 1);
  const match = h.ended[0];
  const guest = match.players.find(p => p.seat === 0);
  const user = match.players.find(p => p.seat === 1);
  assert.strictEqual(guest.profileId, null, '游客座位没有 profileId → 落库时被跳过');
  assert.strictEqual(user.profileId, 42);
  assert.strictEqual(user.solved, 5);
  assert.strictEqual(user.rank, 1);
  assert.strictEqual(user.perQuestion.length, 5);
  assert.ok(user.perQuestion.every(q => q.finalAnswer !== null));
  // 落库载荷不含答案字段
  assert.ok(user.perQuestion.every(q => q.answer === undefined));
});

test('房间状态里不含任何用户 ID / 邮箱 / 档案昵称', () => {
  const h = harness();
  h.mgr.registerConn('cA', { ip: '1.1.1.1', userId: 7, profileId: 42 });
  const r = h.mgr.handle('cA', { type: 'create_room', count: 5 });
  const state = h.msgsTo('cA').filter(m => m.type === 'room_state').pop().room;
  const json = JSON.stringify(state);
  assert.ok(!/userId|profileId|email|@/.test(json), '状态里没有身份信息: ' + json);
  assert.deepStrictEqual(Object.keys(state.players[0]).sort(), ['avatar', 'connected', 'finished', 'name', 'seat', 'solved']);
});

test('persistMatch：游客座位零落库；登录座位写入 matches/match_players/attempts', () => {
  const { initDb } = require('../server/src/db');
  const { persistMatch } = require('../server/src/match-store');
  const dbFile = path.join(os.tmpdir(), 'tm-race-' + Date.now() + '.db');
  const db = initDb(dbFile);
  const now = Date.now();
  const u = db.prepare('INSERT INTO users (email_normalized,password_hash,created_at) VALUES (?,?,?)').run('r@example.com', 'x', now);
  const p = db.prepare('INSERT INTO child_profiles (user_id,nickname,created_at) VALUES (?,?,?)').run(u.lastInsertRowid, 'Kid', now);
  const profileId = p.lastInsertRowid;

  const match = {
    roomCode: 'ABCDE', difficulty: 'two_by_two', count: 2,
    startedAt: now, endedAt: now + 5000, reason: 'all_finished',
    players: [
      { seat: 0, profileId: null, displayName: 'Mochi', solved: 1, usedMs: 4000, rank: 2, disconnected: false,
        perQuestion: [{ a: 12, b: 12, firstAnswer: 144, finalAnswer: 144, activeMs: null }] },
      { seat: 1, profileId, displayName: 'Pudding', solved: 2, usedMs: 5000, rank: 1, disconnected: false,
        perQuestion: [
          { a: 12, b: 12, firstAnswer: 100, finalAnswer: 144, activeMs: null },
          { a: 13, b: 13, firstAnswer: 169, finalAnswer: 169, activeMs: null }
        ] }
    ]
  };
  const res = persistMatch(db, match);
  assert.strictEqual(res.seats.length, 1, '只有登录座位落库');
  assert.strictEqual(db.prepare('SELECT count(*) c FROM matches').get().c, 1);
  const mp = db.prepare('SELECT * FROM match_players').all();
  assert.strictEqual(mp.length, 1);
  assert.strictEqual(mp[0].profile_id, profileId);
  assert.strictEqual(mp[0].rank, 1);
  const att = db.prepare("SELECT * FROM attempts WHERE mode = 'versus'").all();
  assert.strictEqual(att.length, 1);
  const qs = db.prepare('SELECT * FROM attempt_questions WHERE attempt_id = ? ORDER BY position').all(att[0].id);
  assert.strictEqual(qs.length, 2);
  assert.strictEqual(qs[0].first_correct, 0, '首次答错');
  assert.strictEqual(qs[0].final_correct, 1, '最终答对');
  // 首次错误进错题本（2.4 口径）
  const wb = db.prepare('SELECT * FROM wrong_questions WHERE profile_id = ?').all(profileId);
  assert.strictEqual(wb.length, 1, '12×12 进错题本');

  // 幂等：同一 match 重复落库不会重复计数
  persistMatch(db, match);
  assert.strictEqual(db.prepare("SELECT count(*) c FROM attempts WHERE mode='versus'").get().c, 1, 'client_event_id 幂等');

  // 删除账号 → 对局记录级联清除，且不留空 matches
  const { matchSummaryForProfile } = require('../server/src/match-store');
  assert.strictEqual(matchSummaryForProfile(db, profileId).wins, 1);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.lastInsertRowid);
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(u.lastInsertRowid);
  db.prepare('DELETE FROM child_profiles WHERE user_id = ?').run(u.lastInsertRowid);
  db.prepare('DELETE FROM matches WHERE id NOT IN (SELECT match_id FROM match_players)').run();
  db.prepare('DELETE FROM users WHERE id = ?').run(u.lastInsertRowid);
  assert.strictEqual(db.prepare('SELECT count(*) c FROM match_players').get().c, 0);
  assert.strictEqual(db.prepare('SELECT count(*) c FROM matches').get().c, 0);
  assert.strictEqual(db.prepare('SELECT count(*) c FROM attempts').get().c, 0);
  assert.deepStrictEqual(db.pragma('foreign_key_check'), []);

  db.close();
  fs.rmSync(dbFile, { force: true });
  fs.rmSync(dbFile + '-wal', { force: true });
  fs.rmSync(dbFile + '-shm', { force: true });
});
