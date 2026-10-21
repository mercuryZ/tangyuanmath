'use strict';
/* M2 首期测试：PDF 练习卷（DESIGN §9）
 * - 越权：匿名 401、无权益 403（M2 验收「非会员不能生成付费 PDF」）；
 * - 参数边界与默认值（count 5–100、枚举、locale 决定默认纸张）；
 * - 响应头（PDF 信封例外：Content-Type/Disposition/no-store）；
 * - 答案页独立、中文字体字形覆盖、过期/撤销权益、限流；
 * - 生成器单测：题数守恒、答案正确、因子范围、去重。 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { initDb } = require('../server/src/db');
const { createApp } = require('../server/src/index');
const { renderWorksheetPdf, generateQuestions, normalizeParams, DIFFICULTY_KEYS, ZH_STRINGS } = require('../server/src/pdf');
const { grantFamilyEntitlement, revokeFamilySource, activeFamilyFeatureKeys } = require('../server/src/entitlements');

let base, jar, csrfToken, mailCapture, serverRef, dbRef;

function resetJar() { jar = new Map(); csrfToken = null; }

function cookieHeaderValue() {
  if (!jar || jar.size === 0) return undefined;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(method, urlPath) {
  const headers = { origin: base };
  if (cookieHeaderValue()) headers.cookie = cookieHeaderValue();
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(base + urlPath, { method, headers, redirect: 'manual' });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* PDF 等二进制 */ }
  return { status: res.status, json, buf, headers: res.headers };
}

async function createUser(email, password) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password })
  });
  assert.strictEqual(res.status, 200, 'register ' + email);
}

async function loginAs(email, password) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password })
  });
  assert.strictEqual(res.status, 200, 'login ' + email);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function userId(email) {
  return dbRef.prepare('SELECT id FROM users WHERE email_normalized = ?').get(email).id;
}

function familyId(email) {
  return dbRef.prepare('SELECT family_id FROM users WHERE email_normalized = ?').get(email).family_id;
}

test.before(async () => {
  const dbFile = path.join(os.tmpdir(), `tm-pdf-test-${Date.now()}.db`);
  dbRef = initDb(dbFile);
  mailCapture = [];
  const app = createApp(dbRef, { mailCapture });
  serverRef = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${serverRef.address().port}`;
  resetJar();
  /* 建两个账号：supporter@example.com（有权益）、plain@example.com（无权益） */
  await createUser('supporter@example.com', 'supporter-pass-1');
  await createUser('plain@example.com', 'plain-pass-123');
  // 新注册不再赠送会员：supporter 显式授予全部权益，plain 保持无权益
  for (const featureKey of ['pdf_worksheet', 'celebration_image', 'live_race']) {
    grantFamilyEntitlement(dbRef, {
      familyId: familyId('supporter@example.com'), userId: userId('supporter@example.com'),
      featureKey, sourceType: 'grant'
    });
  }
});

test.after(async () => {
  if (serverRef) await new Promise(r => serverRef.close(r));
});

/* ---------- 生成器单测 ---------- */

test('生成器：题数守恒、答案正确、因子在范围内、按规范化键去重', () => {
  const RANGES = {
    times_tables_10: { a: [1, 10], b: [1, 10] },
    times_tables_12: { a: [1, 12], b: [1, 12] },
    two_by_one: { a: [10, 99], b: [2, 9] },
    two_by_two: { a: [10, 99], b: [10, 99] }
  };
  for (const key of DIFFICULTY_KEYS) {
    const [min, max] = [5, 100];
    for (const count of [min, 20, max]) {
      const qs = generateQuestions(key, count);
      assert.strictEqual(qs.length, count, `${key} x${count} 题数守恒`);
      const seen = new Set();
      for (const q of qs) {
        assert.strictEqual(q.answer, q.a * q.b, '答案 = a×b');
        assert.ok(q.a >= RANGES[key].a[0] && q.a <= RANGES[key].a[1], `${key} a 越界: ${q.a}`);
        assert.ok(q.b >= RANGES[key].b[0] && q.b <= RANGES[key].b[1], `${key} b 越界: ${q.b}`);
        const k = q.a <= q.b ? `${q.a}x${q.b}` : `${q.b}x${q.a}`;
        seen.add(k);
      }
      if (key === 'two_by_two') assert.strictEqual(seen.size, count, 'two_by_two 空间足够时应全部去重');
    }
  }
});

test('生成器：可注入 rng（确定性）', () => {
  const seq = [0.001, 0.999, 0.5, 0.5];
  const qs = generateQuestions('times_tables_10', 2, () => seq.shift());
  assert.deepStrictEqual(qs.map(q => [q.a, q.b]), [[1, 10], [6, 6]]);
});

/* ---------- 参数校验 ---------- */

test('normalizeParams：默认值随 locale（en→letter，zh→a4）+ 越界拒绝', () => {
  assert.deepStrictEqual(normalizeParams({ userLocale: 'en' }),
    { count: 20, difficulty: 'times_tables_10', paper: 'letter', answers: 0, locale: 'en' });
  assert.deepStrictEqual(normalizeParams({ userLocale: 'zh' }),
    { count: 20, difficulty: 'times_tables_10', paper: 'a4', answers: 0, locale: 'zh' });
  assert.deepStrictEqual(normalizeParams({ userLocale: 'zh', paper: 'letter', answers: '1', count: '50', difficulty: 'two_by_two' }),
    { count: 50, difficulty: 'two_by_two', paper: 'letter', answers: 1, locale: 'zh' });

  for (const bad of [{ count: 4 }, { count: 101 }, { count: 'abc' }, { count: '20.5' }]) {
    assert.throws(() => normalizeParams({ ...bad, locale: 'en' }), e => e.code === 'invalid_count');
  }
  for (const bad of [{ difficulty: 'near_100' }, { difficulty: '' }]) {
    assert.throws(() => normalizeParams({ ...bad, locale: 'en' }), e => e.code === 'invalid_difficulty');
  }
  for (const bad of [{ paper: 'a5' }, { answers: '2' }, { locale: 'fr' }]) {
    assert.throws(() => normalizeParams({ ...bad }), e => /^invalid_/.test(e.code));
  }
});

/* ---------- 中文字体字形覆盖（防止文案改动后子集缺字） ---------- */

test('中文子集字体覆盖渲染文案的全部字符', async () => {
  const fontkit = require('../server/node_modules/@pdf-lib/fontkit');
  const fontBytes = fs.readFileSync(path.resolve(__dirname, '../server/fonts/NotoSansSC-Subset.ttf'));
  const font = fontkit.create(new Uint8Array(fontBytes));
  const covered = new Set(font.characterSet);
  const text = Object.values(ZH_STRINGS).flatMap(v =>
    typeof v === 'function' ? [v(3, 4), v(11, 20)] : (typeof v === 'object' ? Object.values(v) : [v])
  ).join('') + '0123456789×=·—（）第页共';
  for (const ch of new Set(text)) {
    if (ch === ' ') continue;
    assert.ok(covered.has(ch.codePointAt(0)), `字体缺少字符「${ch}」(U+${ch.codePointAt(0).toString(16)})`);
  }
});

/* ---------- 纯渲染：纸张尺寸与答案页 ---------- */

test('renderWorksheetPdf：en=Letter 宽 612、zh=A4 宽 595.28；answers=1 追加答案页', async () => {
  const { PDFDocument } = require('../server/node_modules/pdf-lib');
  {
    const out = await renderWorksheetPdf({ locale: 'en', count: 20, difficulty: 'two_by_two', answers: 0 });
    const doc = await PDFDocument.load(out.bytes);
    assert.strictEqual(doc.getPageCount(), 1, '20 题一页');
    const p = doc.getPage(0).getSize();
    assert.ok(Math.abs(p.width - 612) < 0.5 && Math.abs(p.height - 792) < 0.5, 'US Letter');
  }
  {
    const out = await renderWorksheetPdf({ locale: 'zh', count: 20, difficulty: 'two_by_two', answers: 1 });
    const doc = await PDFDocument.load(out.bytes);
    assert.strictEqual(doc.getPageCount(), 2, '题目页 + 答案页');
    const p = doc.getPage(0).getSize();
    assert.ok(Math.abs(p.width - 595.28) < 0.5, 'A4');
    assert.ok(Buffer.from(out.bytes.slice(0, 5)).toString() === '%PDF-');
  }
  {
    const out = await renderWorksheetPdf({ locale: 'en', count: 100, difficulty: 'times_tables_12', answers: 1 });
    const doc = await PDFDocument.load(out.bytes);
    assert.ok(doc.getPageCount() >= 5, '100 题跨页 + 答案页');
    assert.ok(out.bytes.length < 300 * 1024, 'PDF 体积应保持在几十 KB 量级');
  }
});

/* ---------- HTTP：门禁与响应 ---------- */

test('匿名 401；登录但无权益 403 supporter_required（M2 验收）', async () => {
  resetJar();
  const anon = await req('GET', '/api/pdf/worksheet?count=20&difficulty=two_by_two&paper=letter&locale=en');
  assert.strictEqual(anon.status, 401);
  assert.strictEqual(anon.json.code, 'not_logged_in');

  await loginAs('plain@example.com', 'plain-pass-123');
  const no = await req('GET', '/api/pdf/worksheet?count=20&difficulty=two_by_two&paper=letter&locale=en');
  assert.strictEqual(no.status, 403);
  assert.strictEqual(no.json.code, 'supporter_required');
});

test('有权益：200 + PDF 字节 + 正确响应头（信封例外）', async () => {
  await loginAs('supporter@example.com', 'supporter-pass-1');
  const r = await req('GET', '/api/pdf/worksheet?count=20&difficulty=two_by_two&paper=letter&answers=1&locale=en');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.buf.slice(0, 5).toString(), '%PDF-');
  assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
  assert.ok(/filename="tangyuan-multiplication-two_by_two-20-letter-answers\.pdf"/.test(r.headers.get('content-disposition') || ''));
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
});

test('参数越界：count=101 / 非法枚举 → 400', async () => {
  for (const qs of ['count=101', 'count=4', 'difficulty=near_100', 'paper=a5', 'answers=2', 'locale=fr']) {
    const r = await req('GET', '/api/pdf/worksheet?' + qs);
    assert.strictEqual(r.status, 400, qs);
    assert.ok(/^invalid_/.test(r.json.code), qs);
  }
});

test('/api/me 返回去重后的有效权益键', async () => {
  const me = await req('GET', '/api/me');
  assert.deepStrictEqual(me.json.data.entitlements, ['celebration_image', 'live_race', 'pdf_worksheet']);
});

test('过期权益与已撤销权益都不能生成', async () => {
  await createUser('expired@example.com', 'expired-pass-12');
  grantFamilyEntitlement(dbRef, {
    familyId: familyId('expired@example.com'), userId: userId('expired@example.com'),
    featureKey: 'pdf_worksheet',
    sourceType: 'grant', startsAt: Date.now() - 7200 * 1000, ttlMs: 3600 * 1000
  });
  await loginAs('expired@example.com', 'expired-pass-12');
  let r = await req('GET', '/api/pdf/worksheet?locale=en');
  assert.strictEqual(r.status, 403);

  await createUser('revoked@example.com', 'revoked-pass-1');
  grantFamilyEntitlement(dbRef, {
    familyId: familyId('revoked@example.com'), userId: userId('revoked@example.com'),
    featureKey: 'pdf_worksheet', sourceType: 'grant'
  });
  revokeFamilySource(dbRef, familyId('revoked@example.com'), 'grant');
  await loginAs('revoked@example.com', 'revoked-pass-1');
  r = await req('GET', '/api/pdf/worksheet?locale=en');
  assert.strictEqual(r.status, 403);
  assert.deepStrictEqual(activeFamilyFeatureKeys(dbRef, familyId('revoked@example.com')), []);
});

test('限流：同一账号 10 分钟内第 21 次 → 429（独立用户桶不受影响）', async () => {
  /* 前面用例已为 supporter 消耗少量配额；先切到全新账号精确计数 */
  await createUser('burst@example.com', 'burst-pass-123');
  grantFamilyEntitlement(dbRef, {
    familyId: familyId('burst@example.com'), userId: userId('burst@example.com'),
    featureKey: 'pdf_worksheet', sourceType: 'grant'
  });
  await loginAs('burst@example.com', 'burst-pass-123');
  let last;
  for (let i = 0; i < 21; i++) {
    last = await req('GET', '/api/pdf/worksheet?count=5&locale=en');
  }
  assert.strictEqual(last.status, 429, '第 21 次应被限流');
  assert.strictEqual(last.json.code, 'rate_limited');
  /* 其他账号不受影响（按用户分桶） */
  await loginAs('supporter@example.com', 'supporter-pass-1');
  const other = await req('GET', '/api/pdf/worksheet?count=5&locale=en');
  assert.strictEqual(other.status, 200);
});
