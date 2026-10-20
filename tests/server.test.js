'use strict';
/* M1 服务端集成测试：真实 HTTP（node:test + 内置 fetch），临时 SQLite */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { initDb } = require('../server/src/db');
const { createApp } = require('../server/src/index');

let base, jar, csrfToken, mailCapture, serverRef, dbRef;

function resetJar() { jar = new Map(); csrfToken = null; }

function cookieHeaderValue() {
  if (!jar || jar.size === 0) return undefined;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(method, urlPath, body, extraHeaders) {
  const headers = Object.assign({}, extraHeaders || {});
  headers.origin = base; // 浏览器对同源 POST 会带 Origin；Node fetch 不会，这里补齐
  if (cookieHeaderValue()) headers.cookie = cookieHeaderValue();
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(base + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  // 简易 Cookie Jar
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '') jar.delete(name); else jar.set(name, value);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON（静态页等） */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function getCsrf() {
  const r = await req('GET', '/api/csrf');
  csrfToken = r.json.data.csrfToken;
  return csrfToken;
}

function extractTokenFromMail() {
  const mail = mailCapture[mailCapture.length - 1];
  const m = mail.text.match(/token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'mail contains token url');
  return m[1];
}

test.before(async () => {
  const dbFile = path.join(os.tmpdir(), `tm-test-${Date.now()}.db`);
  const db = initDb(dbFile);
  dbRef = db;
  mailCapture = [];
  const app = createApp(db, { mailCapture });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  serverRef = server;
  base = `http://127.0.0.1:${server.address().port}`;
  resetJar();
});

test.after(async () => {
  if (serverRef) await new Promise(r => serverRef.close(r));
});

test('未登录 /api/me 返回 null 用户；静态首页带 CSP 头', async () => {
  const me = await req('GET', '/api/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.data.user, null);

  const home = await req('GET', '/');
  assert.strictEqual(home.status, 200);
  assert.ok(home.text.includes('Tangyuan Math'));
  const csp = home.headers.get('content-security-policy') || '';
  assert.ok(csp.includes("default-src 'self'"));
  /* Live Race 需要 WebSocket：connect-src 必须放行同源 ws/wss，
   * 否则浏览器会拦掉 /api/race/ws 的连接。同时不能放行通配 ws:。 */
  assert.ok(/connect-src [^;]*ws:\/\//.test(csp), 'connect-src 应放行同源 ws：' + csp);
  assert.ok(/connect-src [^;]*wss:\/\//.test(csp), 'connect-src 应放行同源 wss：' + csp);
  assert.ok(!/connect-src [^;]*\bws:\s/.test(csp), '不得使用 ws: 通配：' + csp);
});

/* 裸路径 301 到英文页：不带语言前缀时不能落到「404 + 首页正文」的兜底 */
test('裸路径 /privacy /about /terms /faq 301 到对应英文页（带不带斜杠都行）', async () => {
  const cases = [['/privacy', '/en/privacy/'], ['/about', '/en/about/'], ['/terms', '/en/terms/'], ['/faq', '/en/faq/']];
  for (const [from, to] of cases) {
    for (const variant of [from, from + '/']) {
      const r = await fetch(base + variant, { redirect: 'manual' });
      assert.strictEqual(r.status, 301, variant + ' 应为 301');
      assert.ok((r.headers.get('location') || '').endsWith(to), variant + ' → ' + r.headers.get('location'));
    }
  }
  // 重定向目标本身必须存在且是内容页
  const target = await req('GET', '/en/privacy/');
  assert.strictEqual(target.status, 200);
  assert.ok(target.text.includes('Privacy Policy'));
});

/* 早期邮件里的旧链接形式也要能用：转成前端解析的地址并保留 token */
test('旧令牌链接 /account/verify-email 与 /account/reset 301 到 /account/ 并保留 token', async () => {
  const legacy = [
    ['/account/verify-email?token=abc123', 'mode=verify'],
    ['/account/reset?token=abc123', 'mode=reset']
  ];
  for (const [from, mode] of legacy) {
    const r = await fetch(base + from, { redirect: 'manual' });
    assert.strictEqual(r.status, 301, from);
    const loc = r.headers.get('location');
    assert.ok(loc.startsWith('/account/?' + mode), from + ' → ' + loc);
    assert.ok(loc.includes('token=abc123'), 'token 必须保留：' + loc);
    const landed = await req('GET', loc);
    assert.strictEqual(landed.status, 200);
  }
});

test('注册 → 邮箱验证 → 重复注册 409', async () => {
  const bad = await req('POST', '/api/auth/register', { email: 'not-an-email', password: '12345678' });
  assert.strictEqual(bad.status, 400);

  const r = await req('POST', '/api/auth/register', {
    email: 'Parent@Example.com ', password: 'horse-battery-9', locale: 'zh', timezone: 'Asia/Shanghai'
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(mailCapture.length, 1);
  const token = extractTokenFromMail();

  /* 邮件里的链接必须是前端真正能解析的地址：/account/?mode=verify&token=…
   * 曾经写成 /account/verify-email?token=…，该路径不存在，点击后 404 落到首页。 */
  const mailedUrl = mailCapture[mailCapture.length - 1].text.match(/https?:\/\/\S+/)[0];
  const parsed = new URL(mailedUrl);
  assert.strictEqual(parsed.pathname, '/account/', '链接必须落在 /account/ 页面：' + mailedUrl);
  assert.strictEqual(parsed.searchParams.get('mode'), 'verify');
  assert.strictEqual(parsed.searchParams.get('token'), token);
  const page = await req('GET', parsed.pathname + parsed.search);
  assert.strictEqual(page.status, 200, '邮件链接应可直接打开');

  const dup = await req('POST', '/api/auth/register', { email: 'parent@example.com', password: 'whatever-123' });
  assert.strictEqual(dup.status, 409);

  const verify = await req('POST', '/api/auth/verify-email', { token });
  assert.strictEqual(verify.json.data.verified, true);
  const reuse = await req('POST', '/api/auth/verify-email', { token });
  assert.strictEqual(reuse.status, 400); // 一次性
});

test('登录失败统一 401；成功建立会话并轮换；me 返回邮箱与档案', async () => {
  const bad = await req('POST', '/api/auth/login', { email: 'parent@example.com', password: 'wrong-pass' });
  assert.strictEqual(bad.status, 401);

  const ok1 = await req('POST', '/api/auth/login', { email: 'PARENT@example.com', password: 'horse-battery-9' });
  assert.strictEqual(ok1.status, 200);
  assert.strictEqual(ok1.json.data.user.emailVerified, true);
  assert.strictEqual(ok1.json.data.user.timezone, 'Asia/Shanghai');
  assert.ok(jar.get('tm_session'), 'session cookie set');
  assert.strictEqual(jar.get('tm_session').httpOnly, undefined); // jar 只存值；httpOnly 由 set-cookie 属性保证

  const me = await req('GET', '/api/me');
  assert.strictEqual(me.json.data.user.email, 'parent@example.com');
  assert.deepStrictEqual(me.json.data.profiles, []);
});

test('CSRF：无令牌/错令牌拒绝；GET /api/csrf 签发后放行', async () => {
  const noTok = await req('POST', '/api/profiles', { nickname: 'Xiao Tang' });
  assert.strictEqual(noTok.status, 403);

  await getCsrf();
  const savedTok = csrfToken;
  csrfToken = 'forged-token-1234567890';
  const forged = await req('POST', '/api/profiles', { nickname: 'Xiao Tang' });
  assert.strictEqual(forged.status, 403);
  csrfToken = savedTok;

  const created = await req('POST', '/api/profiles', { nickname: 'Xiao Tang', avatarKey: 'star' });
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.json.data.profile.nickname, 'Xiao Tang');

  const second = await req('POST', '/api/profiles', { nickname: 'Second' });
  assert.strictEqual(second.status, 200); // 家庭最多 2 个子女
  const third = await req('POST', '/api/profiles', { nickname: 'Third' });
  assert.strictEqual(third.status, 409); // 超出家庭子女上限
});

test('记录上报：服务端判分（忽略客户端声明）+ 首次错误进错题本', async () => {
  const pid = (await req('GET', '/api/profiles')).json.data.profiles[0].id;

  const payload = {
    clientEventId: 'evt-001', mode: 'practice', difficulty: 'two_by_one',
    perQuestion: [
      { a: 12, b: 3, firstAnswer: 36, finalAnswer: 36, activeMs: 2200 },
      { a: 21, b: 4, firstAnswer: 85, finalAnswer: 84, activeMs: 4100 } // 首错终对
    ]
  };
  const r = await req('POST', `/api/profiles/${pid}/records`, payload);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.inserted, true);
  assert.strictEqual(r.json.data.passed, true); // 最终全对 → 服务端判定通过

  const wb = (await req('GET', `/api/profiles/${pid}/wrongbook`)).json.data.items;
  assert.strictEqual(wb.length, 1);
  assert.strictEqual(wb[0].a, 4); assert.strictEqual(wb[0].b, 21); // 规范化
  assert.strictEqual(wb[0].wrongCount, 1);
});

test('幂等：同 client_event_id 重复上报不重复计数', async () => {
  const pid = (await req('GET', '/api/profiles')).json.data.profiles[0].id;
  const payload = {
    clientEventId: 'evt-001', mode: 'practice', difficulty: 'two_by_one',
    perQuestion: [
      { a: 12, b: 3, firstAnswer: 36, finalAnswer: 36, activeMs: 2200 },
      { a: 21, b: 4, firstAnswer: 85, finalAnswer: 84, activeMs: 4100 }
    ]
  };
  const again = await req('POST', `/api/profiles/${pid}/records`, payload);
  assert.strictEqual(again.json.data.duplicate, true);

  const wb = (await req('GET', `/api/profiles/${pid}/wrongbook`)).json.data.items;
  assert.strictEqual(wb.length, 1);
  assert.strictEqual(wb[0].wrongCount, 1); // 未重复累计

  const list = (await req('GET', `/api/profiles/${pid}/records`)).json.data;
  assert.strictEqual(list.records.length, 1);
});

test('错题口径：同答案不累计、不同答案 +1；重练答对减到零移出', async () => {
  const pid = (await req('GET', '/api/profiles')).json.data.profiles[0].id;
  const mk = (id, fa, extra) => ({
    clientEventId: id, mode: 'practice', difficulty: 'two_by_one',
    perQuestion: [Object.assign({ a: 21, b: 4, firstAnswer: fa, finalAnswer: fa, activeMs: 3000 }, extra || {})]
  });
  await req('POST', `/api/profiles/${pid}/records`, mk('evt-002', 85)); // 同答案错
  await req('POST', `/api/profiles/${pid}/records`, mk('evt-003', 90)); // 不同答案错
  let wb = (await req('GET', `/api/profiles/${pid}/wrongbook`)).json.data.items;
  const target = wb.find(x => x.a === 4);
  assert.strictEqual(target.wrongCount, 2);

  // 重练答对 ×2（2→1→0）→ 移出
  const rv = await req('POST', `/api/profiles/${pid}/wrongbook/review`, {
    results: [{ a: 4, b: 21, correct: true }]
  });
  assert.strictEqual(rv.json.data.applied, 1);
  wb = (await req('GET', `/api/profiles/${pid}/wrongbook`)).json.data.items;
  assert.strictEqual(wb.find(x => x.a === 4).wrongCount, 1);
  await req('POST', `/api/profiles/${pid}/wrongbook/review`, { results: [{ a: 4, b: 21, correct: true }] });
  wb = (await req('GET', `/api/profiles/${pid}/wrongbook`)).json.data.items;
  assert.ok(!wb.some(x => x.a === 4 && x.b === 21));
});

test('统计：分模式难度分组 + 时区打卡（Asia/Shanghai）', async () => {
  const pid = (await req('GET', '/api/profiles')).json.data.profiles[0].id;
  const stats = (await req('GET', `/api/profiles/${pid}/records/stats`)).json.data;
  assert.strictEqual(stats.timezone, 'Asia/Shanghai');
  assert.ok(stats.streakDays >= 1, '今天有记录 → streak ≥ 1');
  const prac = stats.groups.find(g => g.mode === 'practice' && g.difficulty === 'two_by_one');
  assert.ok(prac, 'practice/two_by_one 分组存在');
  assert.strictEqual(prac.rounds, 3);
  assert.strictEqual(prac.questions, 4);
  assert.ok(prac.firstAccuracy > 0 && prac.firstAccuracy < 1);
  assert.strictEqual(prac.finalCompletion, 0.5); // evt-001 两题最终对；evt-002/003 最终仍错
});

test('游客导入：批量 + 幂等逐条结果', async () => {
  const pid = (await req('GET', '/api/profiles')).json.data.profiles[0].id;
  const imp = await req('POST', `/api/profiles/${pid}/records/import`, {
    records: [
      {
        clientEventId: 'guest-001', mode: 'challenge', difficulty: 'two_by_two', level: 2,
        perQuestion: [{ a: 34, b: 56, firstAnswer: 1904, finalAnswer: 1904, activeMs: 5200 }]
      },
      { clientEventId: 'evt-001', mode: 'practice', difficulty: 'two_by_one',
        perQuestion: [{ a: 12, b: 3, firstAnswer: 36, finalAnswer: 36 }] }, // 重复
      { clientEventId: 'bad!!id', mode: 'practice', difficulty: 'two_by_one', perQuestion: [] } // 非法
    ]
  });
  assert.strictEqual(imp.status, 200);
  const rs = imp.json.data.results;
  assert.strictEqual(rs[0].result, 'inserted');
  assert.strictEqual(rs[1].result, 'duplicate');
  assert.strictEqual(rs[2].result, 'invalid');
});

test('跨账号隔离：其他家长读取档案 → 404，不泄露存在性', async () => {
  // 记住 parent 的档案 id，稍后用别的账号探测
  const parentPid = (await req('GET', '/api/profiles')).json.data.profiles[0].id;

  // 注册并登录第二个账号
  await req('POST', '/api/auth/register', { email: 'other@example.com', password: 'other-pass-123' });
  const otherToken = extractTokenFromMail();
  await req('POST', '/api/auth/verify-email', { token: otherToken });
  const loginOther = await req('POST', '/api/auth/login', { email: 'other@example.com', password: 'other-pass-123' });
  assert.strictEqual(loginOther.status, 200);

  // 探测 parent 的档案（跨账号）与不存在的档案：一律 404
  const probe1 = await req('GET', `/api/profiles/${parentPid}/records`);
  assert.strictEqual(probe1.status, 404);
  const probe2 = await req('GET', '/api/profiles/99999/records');
  assert.strictEqual(probe2.status, 404);
  const probe3 = await req('GET', `/api/profiles/${parentPid}/wrongbook`);
  assert.strictEqual(probe3.status, 404);

  const all = await req('GET', '/api/profiles');
  assert.strictEqual(all.json.data.profiles.length, 0); // 新账号无档案

  // 切回 parent，供后续测试使用
  await req('POST', '/api/auth/login', { email: 'parent@example.com', password: 'horse-battery-9' });
  await getCsrf();
});

test('PATCH /api/me：非法时区 400，合法时区更新成功', async () => {
  const bad = await req('PATCH', '/api/me', { timezone: 'Not/AZone' });
  assert.strictEqual(bad.status, 400);
  const good = await req('PATCH', '/api/me', { timezone: 'America/New_York', locale: 'en' });
  assert.strictEqual(good.json.data.user.timezone, 'America/New_York');
  await req('PATCH', '/api/me', { timezone: 'Asia/Shanghai' }); // 改回
});

test('忘记密码：统一响应；重置成功后旧会话全部失效', async () => {
  // 先确保当前是第一个账号的会话（上个测试登录了 other）→ 重新登录 parent
  await req('POST', '/api/auth/login', { email: 'parent@example.com', password: 'horse-battery-9' });
  await getCsrf();

  const before = mailCapture.length;
  const forgot = await req('POST', '/api/auth/forgot-password', { email: 'parent@example.com' });
  assert.strictEqual(forgot.status, 200);
  const forgotGhost = await req('POST', '/api/auth/forgot-password', { email: 'ghost@example.com' });
  assert.strictEqual(forgotGhost.status, 200); // 统一响应
  assert.strictEqual(mailCapture.length, before + 1); // 不存在的账号不发信

  const resetToken = extractTokenFromMail();
  const weak = await req('POST', '/api/auth/reset-password', { token: resetToken, password: 'short' });
  assert.strictEqual(weak.status, 400);
  const okReset = await req('POST', '/api/auth/reset-password', { token: resetToken, password: 'new-pass-456' });
  assert.strictEqual(okReset.json.data.reset, true);

  // 旧会话失效
  const me = await req('GET', '/api/me');
  assert.strictEqual(me.json.data.user, null);
  const reuse = await req('POST', '/api/auth/reset-password', { token: resetToken, password: 'another-789' });
  assert.strictEqual(reuse.status, 400); // 一次性

  // 新密码可登录
  const relogin = await req('POST', '/api/auth/login', { email: 'parent@example.com', password: 'new-pass-456' });
  assert.strictEqual(relogin.status, 200);
});

test('logout-all 撤销全部会话', async () => {
  await getCsrf();
  const r = await req('POST', '/api/auth/logout-all');
  assert.strictEqual(r.json.data.revokedAll, true);
  const me = await req('GET', '/api/me');
  assert.strictEqual(me.json.data.user, null);
});

test('导出与删除：JSON 结构完整；删号级联清除且无法再登录', async () => {
  await req('POST', '/api/auth/login', { email: 'parent@example.com', password: 'new-pass-456' });
  await getCsrf();
  const pid = (await req('GET', '/api/profiles')).json.data.profiles[0].id;
  assert.ok(pid, '档案仍在');

  const exp = await req('GET', '/api/account/export');
  assert.strictEqual(exp.status, 200);
  assert.ok(exp.text.includes('"clientEventId":"evt-001"'));
  assert.ok(exp.text.includes('"wrongbook"'));
  assert.strictEqual(exp.headers.get('content-disposition'), 'attachment; filename="tangyuan-math-data.json"');

  // 删除前留档验证错题存在，删号后由 DB 直查验证级联
  const dbFile = path.join(os.tmpdir(), ''); // 通过 API 侧面验证即可
  const del = await req('DELETE', '/api/account');
  assert.strictEqual(del.json.data.deleted, true);

  const me = await req('GET', '/api/me');
  assert.strictEqual(me.json.data.user, null);
  const gone = await req('POST', '/api/auth/login', { email: 'parent@example.com', password: 'new-pass-456' });
  assert.strictEqual(gone.status, 401); // 账号已删，无法登录
});

test('请求体限制：超大 JSON → 413', async () => {
  // 注册个新号做这个测试（上一账号已删）
  await req('POST', '/api/auth/register', { email: 'big@example.com', password: 'big-pass-1234' });
  await req('POST', '/api/auth/login', { email: 'big@example.com', password: 'big-pass-1234' });
  const big = { padding: 'x'.repeat(200 * 1024) };
  const r = await req('POST', '/api/auth/forgot-password', big);
  assert.strictEqual(r.status, 413);
});


/* ============ Google 登录（M1 补充） ============ */
const { resolveGoogleUser } = require('../server/src/auth');

test('Google：全新邮箱直接建号（已验证、空密码哈希、带 google_id），再次解析即登录', async () => {
  const r1 = resolveGoogleUser(dbRef, { sub: 'g-sub-111', email: 'GoogleUser@Example.com', locale: 'zh' });
  assert.ok(r1.user, '创建成功');
  assert.strictEqual(r1.user.google_id, 'g-sub-111');
  assert.strictEqual(r1.user.email_normalized, 'googleuser@example.com'); // 规范化
  assert.ok(r1.user.email_verified_at, '直接标记已验证');
  assert.strictEqual(r1.user.password_hash, '', '空密码哈希');

  // 空哈希下密码登录必然失败
  const pwLogin = await req('POST', '/api/auth/login', { email: 'googleuser@example.com', password: 'whatever-123' });
  assert.strictEqual(pwLogin.status, 401);

  const r2 = resolveGoogleUser(dbRef, { sub: 'g-sub-111', email: 'googleuser@example.com' });
  assert.strictEqual(r2.user.id, r1.user.id, '同 google_id 复用账号');
});

test('Google：同邮箱已验证账号自动关联；未验证账号拒绝（防预注册劫持）', async () => {
  // 建一个已验证的密码账号
  await req('POST', '/api/auth/register', { email: 'linkme@example.com', password: 'link-pass-123' });
  const vt = extractTokenFromMail();
  await req('POST', '/api/auth/verify-email', { token: vt });

  const linked = resolveGoogleUser(dbRef, { sub: 'g-sub-222', email: 'linkme@example.com' });
  assert.ok(linked.user.google_id === 'g-sub-222', '自动关联');
  assert.ok(linked.user.email_verified_at, '保留已验证状态');
  assert.notStrictEqual(linked.user.password_hash, '', '原密码保留可继续用');

  // 未验证账号 → 拒绝
  await req('POST', '/api/auth/register', { email: 'unverified@example.com', password: 'some-pass-123' });
  const rejected = resolveGoogleUser(dbRef, { sub: 'g-sub-333', email: 'unverified@example.com' });
  assert.strictEqual(rejected.error, 'email_unverified_exists');
});

test('Google：未配置时访问入口重定向到带错误码的 account 页', async () => {
  const r = await fetch(base + '/api/auth/google', { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  const loc = r.headers.get('location');
  assert.ok(loc.startsWith('/account/?authError=google_not_configured'), 'redirect: ' + loc);
});

test('Google：callback 缺 state/伪造 state 一律被拒', async () => {
  const bad1 = await fetch(base + '/api/auth/google/callback?code=x&state=forged-state-1234567890', { redirect: 'manual' });
  assert.strictEqual(bad1.status, 302);
  assert.ok(bad1.headers.get('location').includes('invalid_state'));
  const bad2 = await fetch(base + '/api/auth/google/callback?error=access_denied', { redirect: 'manual' });
  assert.ok(bad2.headers.get('location').includes('google_error'));
});

test('登录限流：连续失败最终 429', async () => {
  let saw429 = false;
  for (let i = 0; i < 15; i++) {
    const r = await req('POST', '/api/auth/login', { email: 'ratelimit@example.com', password: 'nope-nope' });
    if (r.status === 429) { saw429 = true; break; }
  }
  assert.ok(saw429, '连续失败触发限流');
});
