'use strict';
/* 管理后台 + 优惠码：鉴权、会员查询/详情、手动授予/撤销、码生成（明文仅一次）、
 * 四档时长兑换、重用/过期/限流/CSRF。管理员身份通过直接改 config.adminEmails 注入。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDb } = require('../server/src/db');
const { createApp } = require('../server/src/index');
const mw = require('../server/src/middleware');
const config = require('../server/src/config');
const redeem = require('../server/src/redeem');
const { initFamilyForNewUser, addCalendarMonths, membershipSummary } = require('../server/src/family');
const { listActiveEntitlements } = require('../server/src/entitlements');

const ADMIN_EMAIL = 'admin@example.com';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-admin-'));
  const db = initDb(path.join(dir, 'app.db'));
  const now = Date.now();
  const mk = (email) => {
    const userId = Number(db.prepare(
      'INSERT INTO users (email_normalized, password_hash, email_verified_at, locale, created_at) VALUES (?,?,?,?,?)'
    ).run(email, 'hash', now, 'en', now).lastInsertRowid);
    const familyId = initFamilyForNewUser(db, userId);
    return { userId, familyId };
  };
  return {
    dir, db, mk,
    cleanup() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

async function startServer(db) {
  const app = createApp(db);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(r => server.close(r)) };
}

async function getCsrf(base, token) {
  const res = await fetch(base + '/api/csrf', { headers: { cookie: 'tm_session=' + token } });
  const json = await res.json();
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const m = /tm_csrf=([^;]+)/.exec(cookies.join(';'));
  return { token: json.data.csrfToken, cookie: 'tm_csrf=' + (m ? m[1] : '') };
}

async function api(base, token, csrf, method, p, body) {
  const headers = { origin: base, cookie: 'tm_session=' + token + '; ' + csrf.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf.token;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  return { status: res.status, json, data: json && json.data };
}

const DAY = 24 * 3600 * 1000;

test.before(() => { config.adminEmails.add(ADMIN_EMAIL); });
test.after(() => { config.adminEmails.delete(ADMIN_EMAIL); });

test('管理鉴权：非管理员 403；匿名兑换 401；/api/me 带 isAdmin', async () => {
  const f = fixture();
  const ctx = await startServer(f.db);
  try {
    const admin = f.mk(ADMIN_EMAIL);
    const plain = f.mk('plain@example.com');

    const adminToken = mw.createSession(f.db, admin.userId);
    const plainToken = mw.createSession(f.db, plain.userId);
    const adminCsrf = await getCsrf(ctx.base, adminToken);
    const plainCsrf = await getCsrf(ctx.base, plainToken);

    let r = await api(ctx.base, plainToken, plainCsrf, 'GET', '/api/admin/members?q=plain@');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.code, 'admin_required');

    const anon = await fetch(ctx.base + '/api/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ctx.base },
      body: JSON.stringify({ code: 'TANGYUAN-AAAAA-AAAAA' })
    });
    assert.strictEqual(anon.status, 401);

    const me = await (await fetch(ctx.base + '/api/me', { headers: { cookie: 'tm_session=' + adminToken } })).json();
    assert.strictEqual(me.data.user.isAdmin, true);
    const mePlain = await (await fetch(ctx.base + '/api/me', { headers: { cookie: 'tm_session=' + plainToken } })).json();
    assert.strictEqual(mePlain.data.user.isAdmin, false);

    // 管理员可以查询
    r = await api(ctx.base, adminToken, adminCsrf, 'GET', '/api/admin/members?q=plain@');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.families.length >= 1);

    // 不带 q：列出最近注册的家庭（浏览全部用户）+ 总数
    const all = await api(ctx.base, adminToken, adminCsrf, 'GET', '/api/admin/members');
    assert.strictEqual(all.status, 200);
    assert.ok(all.data.families.length >= 2);
    assert.ok(all.data.totalFamilies >= 2 && all.data.totalParents >= 2);
    // 单字符仍拒绝
    const short = await api(ctx.base, adminToken, adminCsrf, 'GET', '/api/admin/members?q=p');
    assert.strictEqual(short.status, 400);
  } finally {
    await ctx.close();
    f.cleanup();
  }
});

test('会员搜索与详情：家长邮箱、权益行、订单列表', async () => {
  const f = fixture();
  const ctx = await startServer(f.db);
  try {
    const admin = f.mk(ADMIN_EMAIL);
    const target = f.mk('target@example.com');
    const token = mw.createSession(f.db, admin.userId);
    const csrf = await getCsrf(ctx.base, token);

    const r = await api(ctx.base, token, csrf, 'GET', '/api/admin/members?q=target@');
    assert.strictEqual(r.status, 200);
    const fam = r.data.families.find(x => x.familyId === target.familyId);
    assert.ok(fam, '搜索结果包含目标家庭');
    assert.ok(fam.parents.some(p => p.email === 'target@example.com'));

    const d = await api(ctx.base, token, csrf, 'GET', '/api/admin/members/' + target.familyId);
    assert.strictEqual(d.status, 200);
    assert.ok(Array.isArray(d.data.entitlements));
    assert.ok(Array.isArray(d.data.orders));
    assert.ok(d.data.family && Array.isArray(d.data.family.parents));

    const nf = await api(ctx.base, token, csrf, 'GET', '/api/admin/members/999999');
    assert.strictEqual(nf.status, 404);
  } finally {
    await ctx.close();
    f.cleanup();
  }
});

test('手动授予与撤销（管理 API）', async () => {
  const f = fixture();
  const ctx = await startServer(f.db);
  try {
    const admin = f.mk(ADMIN_EMAIL);
    const target = f.mk('grantme@example.com');
    const token = mw.createSession(f.db, admin.userId);
    const csrf = await getCsrf(ctx.base, token);

    let r = await api(ctx.base, token, csrf, 'POST', '/api/admin/grant', { email: 'grantme@example.com', sku: 'supporter_monthly' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(membershipSummary(f.db, target.familyId).active, true);

    r = await api(ctx.base, token, csrf, 'POST', '/api/admin/revoke', { familyId: target.familyId, sourceType: 'grant' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.revoked >= 3);
    assert.strictEqual(membershipSummary(f.db, target.familyId).active, false);

    r = await api(ctx.base, token, csrf, 'POST', '/api/admin/grant', { email: 'nobody@example.com', sku: 'supporter_monthly' });
    assert.strictEqual(r.status, 404);
    r = await api(ctx.base, token, csrf, 'POST', '/api/admin/grant', { email: 'grantme@example.com', sku: 'nope' });
    assert.strictEqual(r.status, 400);
  } finally {
    await ctx.close();
    f.cleanup();
  }
});

test('优惠码：批量生成（明文仅一次）、列表无明文、禁用未用码', async () => {
  const f = fixture();
  const ctx = await startServer(f.db);
  try {
    const admin = f.mk(ADMIN_EMAIL);
    const token = mw.createSession(f.db, admin.userId);
    const csrf = await getCsrf(ctx.base, token);

    let r = await api(ctx.base, token, csrf, 'POST', '/api/admin/codes', { sku: 'supporter_monthly', count: 5, note: 'unit-test' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.codes.length, 5);
    for (const c of r.data.codes) {
      assert.ok(/^TM-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/.test(c), '码格式: ' + c);
      assert.ok(c.length <= 15, '激活码不超过 15 位: ' + c);
    }

    const list = await api(ctx.base, token, csrf, 'GET', '/api/admin/codes');
    assert.strictEqual(list.data.codes.length, 5);
    for (const c of list.data.codes) {
      assert.ok(c.hashPrefix && c.hashPrefix.length === 8);
      assert.ok(!('code' in c) && !('codeHash' in c), '列表不含明文或哈希全文');
    }

    // 列表按创建时间倒序：list[0] 是最后创建的码，与 r.data.codes[4] 是同一行
    const one = list.data.codes[0];
    const newestCode = r.data.codes[4];
    const rv = await api(ctx.base, token, csrf, 'POST', '/api/admin/codes/' + one.id + '/revoke');
    assert.strictEqual(rv.status, 200);
    // 禁用后不可兑换
    const target = f.mk('disabled@example.com');
    const t2 = mw.createSession(f.db, target.userId);
    const c2 = await getCsrf(ctx.base, t2);
    const rd = await api(ctx.base, t2, c2, 'POST', '/api/redeem', { code: newestCode });
    assert.strictEqual(rd.status, 400);
    assert.strictEqual(rd.json.code, 'code_expired');

    r = await api(ctx.base, token, csrf, 'POST', '/api/admin/codes', { sku: 'supporter_monthly', count: 0 });
    assert.strictEqual(r.status, 400);
    r = await api(ctx.base, token, csrf, 'POST', '/api/admin/codes', { sku: 'nope', count: 1 });
    assert.strictEqual(r.status, 400);
  } finally {
    await ctx.close();
    f.cleanup();
  }
});

test('兑换时长：四档 SKU 与自然月语义一致（领域层）', () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-10-31T12:00:00Z'); // 月末边界：+1 自然月 = 11-30
    for (const [sku, expect] of [
      ['supporter_trial7', now + 3 * DAY],
      ['supporter_monthly', addCalendarMonths(now, 1)],
      ['supporter_yearly', addCalendarMonths(now, 12)],
      ['supporter_lifetime', null]
    ]) {
      const u = f.mk('dur-' + sku + '@example.com');
      const created = redeem.createCodes(f.db, { sku, count: 1, adminUserId: u.userId, now });
      const out = redeem.redeemCode(f.db, { code: created.codes[0], familyId: u.familyId, userId: u.userId, now });
      assert.strictEqual(out.expiresAt, expect, sku);
      const rows = listActiveEntitlements(f.db, u.familyId, now + 1000);
      assert.strictEqual(rows.length, 3);
      for (const row of rows) {
        assert.strictEqual(row.source_type, 'redeem');
        assert.strictEqual(row.expires_at, expect);
      }
      assert.strictEqual(membershipSummary(f.db, u.familyId, now + 1000).active, true);
    }
  } finally {
    f.cleanup();
  }
});

test('兑换 API：成功开通、重用/错码/过期、CSRF 必须、限流 429', async () => {
  const f = fixture();
  const ctx = await startServer(f.db);
  try {
    const admin = f.mk(ADMIN_EMAIL);
    const parent = f.mk('redeemer@example.com');
    const token = mw.createSession(f.db, parent.userId);
    const csrf = await getCsrf(ctx.base, token);
    const adminToken = mw.createSession(f.db, admin.userId);
    const adminCsrf = await getCsrf(ctx.base, adminToken);

    const created = await api(ctx.base, adminToken, adminCsrf, 'POST', '/api/admin/codes',
      { sku: 'supporter_yearly', count: 1 });
    const code = created.data.codes[0];

    let r = await api(ctx.base, token, csrf, 'POST', '/api/redeem', { code });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.membership.active, true);
    assert.strictEqual(listActiveEntitlements(f.db, parent.familyId).length, 3);

    r = await api(ctx.base, token, csrf, 'POST', '/api/redeem', { code });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.code, 'code_used');

    r = await api(ctx.base, token, csrf, 'POST', '/api/redeem', { code: 'TANGYUAN-ZZZZZ-ZZZZZ' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.code, 'code_not_found');

    // 过期码：直接改库把一个未用码的截止时间改成过去
    const exp = await api(ctx.base, adminToken, adminCsrf, 'POST', '/api/admin/codes',
      { sku: 'supporter_trial7', count: 1, expiresInDays: 30 });
    f.db.prepare('UPDATE redeem_codes SET expires_at = ? WHERE code_hash = ?')
      .run(Date.now() - 1000, require('../server/src/util').hashToken(exp.data.codes[0]));
    r = await api(ctx.base, token, csrf, 'POST', '/api/redeem', { code: exp.data.codes[0] });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.code, 'code_expired');

    // CSRF：不带头的 POST 被拒
    const noCsrf = await fetch(ctx.base + '/api/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ctx.base, cookie: 'tm_session=' + token + '; ' + csrf.cookie },
      body: JSON.stringify({ code: 'TANGYUAN-AAAAA-AAAAA' })
    });
    assert.strictEqual(noCsrf.status, 403);

    // 限流：全新账号连打 11 次（全部错码也计数）→ 第 11 次 429
    const burst = f.mk('burst@example.com');
    const bt = mw.createSession(f.db, burst.userId);
    const bc = await getCsrf(ctx.base, bt);
    let last;
    for (let i = 0; i < 11; i++) {
      last = await api(ctx.base, bt, bc, 'POST', '/api/redeem', { code: 'TANGYUAN-AAAAA-AAAA' + i });
    }
    assert.strictEqual(last.status, 429);
    assert.strictEqual(last.json.code, 'rate_limited');
  } finally {
    await ctx.close();
    f.cleanup();
  }
});
