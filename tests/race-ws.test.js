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
const { revokeFamilySource } = require('../server/src/entitlements');

function familyIdFor(email) {
  return db.prepare('SELECT family_id FROM users WHERE email_normalized = ?').get(email).family_id;
}

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

async function csrfFor(session) {
  const csrfRes = await fetch(httpBase + '/api/csrf', { headers: { cookie: session } });
  const csrfCookie = csrfRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const csrf = csrfRes.headers.getSetCookie()
    .map(c => /tm_csrf=([^;]+)/.exec(c)).filter(Boolean)[0][1];
  return { csrf, cookie: session + '; ' + csrfCookie };
}

async function createProfile(session, nickname, credentials) {
  const { csrf, cookie } = await csrfFor(session);
  const body = Object.assign({ nickname }, credentials || {});
  const r = await fetch(httpBase + '/api/profiles', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: httpBase,
      cookie,
      'x-csrf-token': csrf
    },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  assert.ok(j.ok, 'profile created: ' + JSON.stringify(j));
  return j.data.profile.id;
}

/* 家长创建子女账号 → 子女用用户名密码登录，拿到 tm_session */
async function newChild(email, username) {
  const { session } = await newSession(email);
  const pid = await createProfile(session, 'Kid ' + username, {
    username, password: 'child-pass-123'
  });
  const login = await fetch(httpBase + '/api/auth/child-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: httpBase },
    body: JSON.stringify({ username, password: 'child-pass-123' })
  });
  assert.strictEqual(login.status, 200, 'child login');
  const childSession = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return { parentSession: session, childSession, pid };
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
  assert.strictEqual(hello.canRace, false);
  await c.close();
});

test('WS：家长直接参赛不绑定档案；子女会话强制绑定本人档案', async () => {
  const { parentSession, childSession, pid } = await newChild('race1@example.com', 'kidone');

  // 家长会话：即使带 profileId 也不绑定（家长直接参赛，不写儿童档案）
  const parent = connect({ cookie: parentSession, origin: httpBase, query: '?profileId=' + pid });
  await parent.open();
  const helloParent = await parent.wait('hello');
  assert.strictEqual(helloParent.loggedIn, true);
  assert.strictEqual(helloParent.role, 'parent');
  assert.strictEqual(helloParent.profileId, null, '家长不绑定儿童档案');
  assert.strictEqual(helloParent.canRace, true);
  await parent.close();

  // 子女会话：绑定本人档案
  const child = connect({ cookie: childSession, origin: httpBase, query: '?profileId=99999' });
  await child.open();
  const helloChild = await child.wait('hello');
  assert.strictEqual(helloChild.loggedIn, true);
  assert.strictEqual(helloChild.role, 'child');
  assert.strictEqual(helloChild.profileId, pid, '子女强制绑定本人档案');
  assert.strictEqual(helloChild.canRace, true);
  await child.close();

  // 另一个账号的家长尝试伪造 profileId：仍然不绑定
  const other = await newSession('race2@example.com');
  const stolen = connect({ cookie: other.session, origin: httpBase, query: '?profileId=' + pid });
  await stolen.open();
  const hello2 = await stolen.wait('hello');
  assert.strictEqual(hello2.profileId, null, '跨账号档案不会被绑定');
  await stolen.close();
});

test('WS：非法 JSON 直接断开连接', async () => {
  const c = connect({ origin: httpBase });
  await c.open();
  c.ws.send('{not json');
  const code = await new Promise(resolve => c.ws.once('close', code => resolve(code)));
  assert.strictEqual(code, 1003);
});

test('WS：游客与无会员家长被会员门禁拒绝，且零落库', async () => {
  const counts = () => ({
    matches: db.prepare('SELECT count(*) c FROM matches').get().c,
    attempts: db.prepare('SELECT count(*) c FROM attempts').get().c,
    players: db.prepare('SELECT count(*) c FROM match_players').get().c
  });
  const before = counts();

  // 游客：可以连上大厅，但不能创建/加入
  const guest = connect({ origin: httpBase });
  await guest.open();
  const helloGuest = await guest.wait('hello');
  assert.strictEqual(helloGuest.loggedIn, false);
  assert.strictEqual(helloGuest.canRace, false);
  assert.strictEqual(helloGuest.membershipRequired, true);
  guest.send({ type: 'create_room', difficulty: 'two_by_two', count: 5 });
  assert.strictEqual((await guest.wait('error')).code, 'login_required');
  await guest.close();

  // 已登录但没有会员（撤销上线赠送）
  const { session } = await newSession('nomember@example.com');
  revokeFamilySource(db, familyIdFor('nomember@example.com'), 'promo');
  const parent = connect({ cookie: session, origin: httpBase });
  await parent.open();
  const helloParent = await parent.wait('hello');
  assert.strictEqual(helloParent.loggedIn, true);
  assert.strictEqual(helloParent.canRace, false);
  parent.send({ type: 'create_room', difficulty: 'two_by_two', count: 5 });
  assert.strictEqual((await parent.wait('error')).code, 'membership_required');
  await parent.close();

  assert.deepStrictEqual(counts(), before, '被拒绝的请求不得写入任何表');
});

test('WS：子女对局落库；家长直接参赛不落库', async () => {
  const { parentSession, childSession, pid } = await newChild('race3@example.com', 'kidthree');
  const other = await newSession('race4@example.com');

  const a = connect({ cookie: childSession, origin: httpBase });
  const b = connect({ cookie: other.session, origin: httpBase });
  await a.open(); await b.open();
  await a.wait('hello'); await b.wait('hello');

  a.send({ type: 'create_room', difficulty: 'times_tables_10', count: 5 });
  const joined = await a.wait('joined');
  b.send({ type: 'join_room', code: joined.code });
  await b.wait('joined');
  a.send({ type: 'start_game' });
  const gs = await a.wait('game_start', null, 6000);
  const gsB = await b.wait('game_start', null, 6000);

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
  a.send({ type: 'submit', answers: [] });
  b.send({ type: 'submit', answers: [] });
  await a.wait('submitted');
  const over = await a.wait('game_over', null, 10000);
  assert.strictEqual(over.ranking[0].solved, 5);

  // 只有子女座位落库；家长没有档案
  const mp = db.prepare('SELECT * FROM match_players WHERE profile_id = ?').all(pid);
  assert.strictEqual(mp.length, 1, '子女座位落库');
  assert.strictEqual(mp[0].rank, 1);
  const att = db.prepare("SELECT * FROM attempts WHERE profile_id = ? AND mode = 'versus'").all(pid);
  assert.strictEqual(att.length, 1);
  const totalPlayers = db.prepare('SELECT COUNT(*) c FROM match_players').get().c;
  assert.strictEqual(totalPlayers, 1, '家长座位不写儿童档案');

  // 家长中心私密战绩（家长会话可读本家庭子女）
  const r = await fetch(httpBase + '/api/profiles/' + pid + '/versus', {
    headers: { cookie: parentSession }
  });
  const j = await r.json();
  assert.ok(j.ok);
  assert.strictEqual(j.data.matches, 1);
  assert.strictEqual(j.data.wins, 1);

  // 跨账号读取该战绩 → 404（对象级归属校验）
  const r2 = await fetch(httpBase + '/api/profiles/' + pid + '/versus', {
    headers: { cookie: other.session }
  });
  assert.strictEqual(r2.status, 404);

  await a.close(); await b.close();
});

test('WS：断线后带座位令牌重连，回归原座位并保留进度', async () => {
  const aS = (await newSession('race5@example.com')).session;
  const bS = (await newSession('race6@example.com')).session;
  const a = connect({ cookie: aS, origin: httpBase });
  const b = connect({ cookie: bS, origin: httpBase });
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

  // 新连接带令牌回归（续连不重新检查会员状态）
  const b2 = connect({ cookie: bS, origin: httpBase });
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
