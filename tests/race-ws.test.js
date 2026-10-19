'use strict';
/* Live Race WebSocket 集成测试：真实 HTTP 升级 + 真实会话 Cookie
 * 覆盖：路径隔离、跨站 Origin 拒绝、握手鉴权（档案归属）、消息协议、
 *       端到端对局、游客零落库、登录档案落库、断线重连。
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('../server/node_modules/ws');

const { initDb } = require('../server/src/db');
const { createApp, attachLiveRace } = require('../server/src/index');

let base, httpBase, db, server, race, dbFile, mailCapture;

/* 极简 Cookie 会话：注册 → 验证 → 登录，拿到 tm_session */
async function newSession(email) {
  const reg = await fetch(httpBase + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: httpBase },
    body: JSON.stringify({ email, password: 'race-pass-123' })
  });
  assert.strictEqual(reg.status, 200);
  const token = mailCapture[mailCapture.length - 1].text.match(/token=([A-Za-z0-9_-]+)/)[1];
  await fetch(httpBase + '/api/auth/verify-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: httpBase },
    body: JSON.stringify({ token })
  });
  const login = await fetch(httpBase + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: httpBase },
    body: JSON.stringify({ email, password: 'race-pass-123' })
  });
  const setCookies = login.headers.getSetCookie();
  const session = setCookies.map(c => c.split(';')[0]).join('; ');
  return { session, setCookies };
}

async function createProfile(session, nickname) {
  // 需要 CSRF 双提交
  const csrfRes = await fetch(httpBase + '/api/csrf', { headers: { cookie: session } });
  const csrfCookie = csrfRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const csrf = csrfRes.headers.getSetCookie()
    .map(c => /tm_csrf=([^;]+)/.exec(c)).filter(Boolean)[0][1];
  const r = await fetch(httpBase + '/api/profiles', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: httpBase,
      cookie: session + '; ' + csrfCookie,
      'x-csrf-token': csrf
    },
    body: JSON.stringify({ nickname })
  });
  const j = await r.json();
  assert.ok(j.ok, 'profile created: ' + JSON.stringify(j));
  return j.data.profile.id;
}

/* 打开一条 WS，收集所有消息 */
function connect(opts) {
  opts = opts || {};
  const url = base + '/api/race/ws' + (opts.query || '');
  const headers = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = opts.origin;
  const ws = new WebSocket(url, { headers });
  const msgs = [];
  const waiters = [];
  ws.on('message', raw => {
    const m = JSON.parse(String(raw));
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { waiters.splice(i, 1)[0].resolve(m); }
    }
  });
  const api = {
    ws, msgs,
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (req, res) => reject(new Error('HTTP ' + res.statusCode)));
    }),
    send: msg => ws.send(JSON.stringify(msg)),
    /* 等待某类消息（可带谓词），超时后报出已收到的类型便于排查 */
    wait: (type, pred, timeoutMs) => new Promise((resolve, reject) => {
      const hit = msgs.find(m => m.type === type && (!pred || pred(m)));
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(
        'timeout waiting ' + type + '; got: ' + msgs.map(m => m.type).join(',')
      )), timeoutMs || 3000);
      waiters.push({ pred: m => m.type === type && (!pred || pred(m)), resolve: m => { clearTimeout(t); resolve(m); } });
    }),
    close: () => new Promise(r => { ws.once('close', r); ws.close(); })
  };
  return api;
}

test.before(async () => {
  dbFile = path.join(os.tmpdir(), 'tm-race-ws-' + Date.now() + '.db');
  db = initDb(dbFile);
  mailCapture = [];
  const app = createApp(db, { mailCapture });
  server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  httpBase = 'http://127.0.0.1:' + server.address().port;
  base = 'ws://127.0.0.1:' + server.address().port;
  // 测试进程内所有连接都来自 127.0.0.1，放宽每 IP 并发座位上限
  race = attachLiveRace(server, db, { maxSeatsPerIp: 100 });
});

test.after(async () => {
  if (race) race.close();
  await new Promise(r => server.close(r));
  db.close();
  fs.rmSync(dbFile, { force: true });
  fs.rmSync(dbFile + '-wal', { force: true });
  fs.rmSync(dbFile + '-shm', { force: true });
});

test('WS：其它路径的升级请求被拒绝（404），不会悬着连接', async () => {
  const bad = new WebSocket(base + '/api/race/other');
  const result = await new Promise(resolve => {
    bad.on('error', e => resolve('error'));
    bad.on('open', () => resolve('open'));
    setTimeout(() => resolve('timeout'), 2000);
  });
  assert.strictEqual(result, 'error', '未知 upgrade 路径应立即失败，实际: ' + result);
});

test('WS：跨站 Origin 的握手被拒（WebSocket 不受 CORS 限制，必须显式校验）', async () => {
  const c = connect({ origin: 'https://evil.example' });
  const err = await c.open().then(() => null, e => e);
  assert.ok(err, '跨站 Origin 应握手失败');
});

test('WS：匿名游客可以连接并收到 hello', async () => {
  const c = connect({ origin: httpBase });
  await c.open();
  const hello = await c.wait('hello');
  assert.strictEqual(hello.loggedIn, false);
  assert.strictEqual(hello.profileId, null);
  await c.close();
});

test('WS：登录会话 + 归属档案在握手时被识别；伪造他人 profileId 降级为游客', async () => {
  const { session } = await newSession('race1@example.com');
  const pid = await createProfile(session, 'Kid One');

  const mine = connect({ cookie: session, origin: httpBase, query: '?profileId=' + pid });
  await mine.open();
  const hello = await mine.wait('hello');
  assert.strictEqual(hello.loggedIn, true);
  assert.strictEqual(hello.profileId, pid, '归属校验通过');
  await mine.close();

  // 另一个账号尝试用这个 profileId
  const other = await newSession('race2@example.com');
  const stolen = connect({ cookie: other.session, origin: httpBase, query: '?profileId=' + pid });
  await stolen.open();
  const hello2 = await stolen.wait('hello');
  assert.strictEqual(hello2.loggedIn, true);
  assert.strictEqual(hello2.profileId, null, '跨账号档案一律降级为游客');
  await stolen.close();
});

test('WS：非法 JSON 直接断开连接', async () => {
  const c = connect({ origin: httpBase });
  await c.open();
  c.ws.send('{not json');
  const code = await new Promise(resolve => c.ws.once('close', code => resolve(code)));
  assert.strictEqual(code, 1003);
});

test('WS：端到端对局——两名游客跑完一局，游客全程零落库', async () => {
  const before = {
    matches: db.prepare('SELECT count(*) c FROM matches').get().c,
    attempts: db.prepare('SELECT count(*) c FROM attempts').get().c,
    players: db.prepare('SELECT count(*) c FROM match_players').get().c
  };

  const a = connect({ origin: httpBase });
  const b = connect({ origin: httpBase });
  await a.open(); await b.open();
  await a.wait('hello'); await b.wait('hello');

  a.send({ type: 'create_room', difficulty: 'two_by_two', count: 5 });
  const joinedA = await a.wait('joined');
  assert.ok(joinedA.code);

  b.send({ type: 'join_room', code: joinedA.code });
  const joinedB = await b.wait('joined');
  assert.notStrictEqual(joinedB.seat, joinedA.seat);

  // 等待室里两人都能看到对方
  const state = await a.wait('room_state', m => m.room.players.length === 2);
  assert.strictEqual(state.room.status, 'waiting');

  a.send({ type: 'start_game' });
  const countdown = await a.wait('countdown');
  assert.ok(countdown.seconds > 0);
  const gsA = await a.wait('game_start', null, 6000);
  const gsB = await b.wait('game_start', null, 6000);
  assert.deepStrictEqual(gsA.problems, gsB.problems, '同题');
  assert.ok(gsA.problems.every(p => p.answer === undefined), '题目不含答案');

  // 双方都答完（游客也作答，用来验证「游客即便参赛也不落库」）
  const solve = (c, gs) => new Promise(resolve => {
    let i = 0;
    const tick = () => {
      if (i >= gs.problems.length) return resolve();
      const p = gs.problems[i];
      c.send({ type: 'answer', position: i, value: p.a * p.b });
      i++;
      setTimeout(tick, 300);
    };
    tick();
  });
  await Promise.all([solve(a, gsA), solve(b, gsB)]);

  const over = await a.wait('game_over', null, 6000);
  assert.strictEqual(over.ranking.length, 2);
  assert.strictEqual(over.ranking[0].rank, 1);
  assert.ok(over.ranking.every(r => r.solved === 5));

  // 游客零落库
  const after = {
    matches: db.prepare('SELECT count(*) c FROM matches').get().c,
    attempts: db.prepare('SELECT count(*) c FROM attempts').get().c,
    players: db.prepare('SELECT count(*) c FROM match_players').get().c
  };
  assert.deepStrictEqual(after, before, '游客对局不得写入任何表');

  await a.close(); await b.close();
});

test('WS：登录档案参战会落库，且能通过 /api/profiles/:id/versus 读到私密战绩', async () => {
  const { session } = await newSession('race3@example.com');
  const pid = await createProfile(session, 'Kid Three');

  const a = connect({ cookie: session, origin: httpBase, query: '?profileId=' + pid });
  const b = connect({ origin: httpBase });
  await a.open(); await b.open();
  await a.wait('hello'); await b.wait('hello');

  a.send({ type: 'create_room', difficulty: 'times_tables_10', count: 5 });
  const joined = await a.wait('joined');
  b.send({ type: 'join_room', code: joined.code });
  await b.wait('joined');
  a.send({ type: 'start_game' });
  const gs = await a.wait('game_start', null, 6000);
  const gsB = await b.wait('game_start', null, 6000);

  // 两人都答完：游客也参赛，用来验证「只有登录座位落库」
  const solve = (c, problems) => new Promise(resolve => {
    let i = 0;
    const tick = () => {
      if (i >= problems.length) return resolve();
      const p = problems[i];
      c.send({ type: 'answer', position: i, value: p.a * p.b });
      i++;
      setTimeout(tick, 300);
    };
    tick();
  });
  await Promise.all([solve(a, gs.problems), solve(b, gsB.problems)]);
  const over = await a.wait('game_over', null, 10000);
  assert.strictEqual(over.ranking[0].solved, 5);

  // 落库
  const mp = db.prepare('SELECT * FROM match_players WHERE profile_id = ?').all(pid);
  assert.strictEqual(mp.length, 1, '只有登录座位落库');
  assert.strictEqual(mp[0].rank, 1);
  const att = db.prepare("SELECT * FROM attempts WHERE profile_id = ? AND mode = 'versus'").all(pid);
  assert.strictEqual(att.length, 1);

  // 家长中心私密战绩
  const r = await fetch(httpBase + '/api/profiles/' + pid + '/versus', {
    headers: { cookie: session }
  });
  const j = await r.json();
  assert.ok(j.ok);
  assert.strictEqual(j.data.matches, 1);
  assert.strictEqual(j.data.wins, 1);

  // 跨账号读取该战绩 → 404（对象级归属校验）
  const other = await newSession('race4@example.com');
  const r2 = await fetch(httpBase + '/api/profiles/' + pid + '/versus', {
    headers: { cookie: other.session }
  });
  assert.strictEqual(r2.status, 404);

  await a.close(); await b.close();
});

test('WS：断线后带座位令牌重连，回归原座位并保留进度', async () => {
  const a = connect({ origin: httpBase });
  const b = connect({ origin: httpBase });
  await a.open(); await b.open();
  await a.wait('hello'); await b.wait('hello');

  a.send({ type: 'create_room', difficulty: 'two_by_two', count: 5 });
  const ja = await a.wait('joined');
  b.send({ type: 'join_room', code: ja.code });
  const jb = await b.wait('joined');
  a.send({ type: 'start_game' });
  const gs = await a.wait('game_start', null, 6000);
  await b.wait('game_start', null, 6000);

  // b 答对第一题
  b.send({ type: 'answer', position: 0, value: gs.problems[0].a * gs.problems[0].b });
  await b.wait('judge', m => m.correct === true);

  // b 断线
  await b.close();
  await new Promise(r => setTimeout(r, 300));

  // 新连接带令牌回归
  const b2 = connect({ origin: httpBase });
  await b2.open();
  await b2.wait('hello');
  b2.send({ type: 'join_room', code: ja.code, resumeToken: jb.token });
  const rejoined = await b2.wait('joined');
  assert.strictEqual(rejoined.seat, jb.seat, '回到原座位');
  assert.strictEqual(rejoined.resumed, true);
  const snapshot = await b2.wait('game_start');
  assert.strictEqual(snapshot.resumed, true);
  assert.deepStrictEqual(snapshot.solvedPositions, [0], '进度保留');

  await a.close(); await b2.close();
});

test('WS：错误消息类型返回 error，不崩溃连接', async () => {
  const c = connect({ origin: httpBase });
  await c.open();
  await c.wait('hello');
  c.send({ type: 'bogus_type' });
  const err = await c.wait('error');
  assert.ok(err.code);
  // 连接仍可用
  c.send({ type: 'ping' });
  await c.wait('pong');
  await c.close();
});
