'use strict';
/* 家庭会员 / 子女账号 / 上线赠送（DESIGN §5、§6、§8）
 * 覆盖：注册赠送、共同家长邮箱邀请、席位上限、子女用户名登录与越权、
 *       邀请合并保护、账号删除时的家庭归属、赠送到期。 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { initDb } = require('../server/src/db');
const { createApp } = require('../server/src/index');
const { addCalendarMonths } = require('../server/src/family');
const {
  SUPPORTER_FEATURES, grantFamilyEntitlement, revokeFamilySource
} = require('../server/src/entitlements');
const { resolveGoogleUser } = require('../server/src/auth');

let base, db, server, dbFile, mailCapture;

let ipSeq = 0;
class Client {
  constructor(ip) {
    this.ip = ip || ('10.0.0.' + (++ipSeq));
    this.cookies = new Map();
    this.csrfToken = null;
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
  }
  async csrf() {
    const r = await this.fetch('GET', '/api/csrf');
    this.csrfToken = this.cookies.get('tm_csrf') || null;
    return r;
  }
  async fetch(method, p, body) {
    const headers = { origin: base, 'x-forwarded-for': this.ip };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    if (this.csrfToken && method !== 'GET') headers['x-csrf-token'] = this.csrfToken;
    const res = await fetch(base + p, {
      method, headers, redirect: 'manual',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '') this.cookies.delete(k); else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = text; }
    return { status: res.status, json };
  }
}

function lastMail(subjectPart) {
  const list = mailCapture.filter(m => m.subject.includes(subjectPart));
  return list[list.length - 1];
}
function tokenFromMail(mail) {
  return /token=([A-Za-z0-9_-]+)/.exec(mail.text)[1];
}

async function newAccount(email, password) {
  password = password || 'family-pass-123';
  const c = new Client();
  await c.csrf();
  let r = await c.fetch('POST', '/api/auth/register', { email, password });
  assert.strictEqual(r.status, 200, 'register ' + email + ': ' + JSON.stringify(r.json));
  const verifyToken = tokenFromMail(lastMail('verify'));
  r = await c.fetch('POST', '/api/auth/verify-email', { token: verifyToken });
  assert.strictEqual(r.status, 200, 'verify ' + email);
  r = await c.fetch('POST', '/api/auth/login', { email, password });
  assert.strictEqual(r.status, 200, 'login ' + email);
  await c.csrf();
  return c;
}

async function childLogin(username, password) {
  const c = new Client();
  const r = await c.fetch('POST', '/api/auth/child-login', { username, password });
  if (r.status === 200) await c.csrf();
  return { client: c, status: r.status, json: r.json };
}

function familyOf(email) {
  return db.prepare('SELECT family_id, family_role FROM users WHERE email_normalized = ?').get(email);
}
function familyCount() {
  return db.prepare('SELECT COUNT(*) c FROM families').get().c;
}

/* 测试辅助：新注册不再赠送会员，需要会员的用例显式授予。
 * 用 grant 来源，避免与 order/promo 语义混淆。 */
function grantMembership(familyId, expiresAt) {
  for (const featureKey of SUPPORTER_FEATURES) {
    grantFamilyEntitlement(db, {
      familyId, featureKey, sourceType: 'grant', sourceId: 'test-membership',
      startsAt: Date.now() - 1000, expiresAt: expiresAt === undefined ? null : expiresAt
    });
  }
}

test.before(async () => {
  dbFile = path.join(os.tmpdir(), 'tm-family-test-' + Date.now() + '.db');
  db = initDb(dbFile);
  mailCapture = [];
  const app = createApp(db, { mailCapture });
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  db.close();
  fs.rmSync(dbFile, { force: true });
  fs.rmSync(dbFile + '-wal', { force: true });
  fs.rmSync(dbFile + '-shm', { force: true });
});

test('自然月加法：1 月 31 日 + 3 个月 = 4 月 30 日', () => {
  const jan31 = Date.UTC(2027, 0, 31, 12);
  assert.strictEqual(new Date(addCalendarMonths(jan31, 3)).toISOString().slice(0, 10), '2027-04-30');
  const dec31 = Date.UTC(2026, 11, 31, 12);
  assert.strictEqual(new Date(addCalendarMonths(dec31, 2)).toISOString().slice(0, 10), '2027-02-28');
});

test('注册：创建家庭，不再赠送免费会员', async () => {
  const before = familyCount();
  const c = await newAccount('fam1@example.com');
  assert.strictEqual(familyCount(), before + 1);

  const me = await c.fetch('GET', '/api/me');
  assert.ok(me.json.ok);
  const d = me.json.data;
  assert.strictEqual(d.user.familyRole, 'owner');
  assert.deepStrictEqual(d.family.seats, { parents: 1, maxParents: 2, children: 0, maxChildren: 2 });
  assert.deepStrictEqual(d.entitlements, []);
  assert.strictEqual(d.membership.active, false);
  assert.strictEqual(d.membership.plan, null);

  const rows = db.prepare(
    'SELECT feature_key FROM entitlements WHERE family_id = ?'
  ).all(d.family.id);
  assert.deepStrictEqual(rows, [], '注册不应写入任何权益（包括旧 promo）');
});

test('Google 全新账号：创建家庭，不赠送免费会员', () => {
  const before = familyCount();
  const resolved = resolveGoogleUser(db, {
    sub: 'google-new-1', email: 'google-new@example.com', locale: 'en'
  });
  assert.ok(resolved.user && resolved.user.id);
  assert.ok(resolved.user.family_id);
  assert.strictEqual(familyCount(), before + 1);
  const keys = db.prepare(
    'SELECT feature_key FROM entitlements WHERE family_id = ? ORDER BY feature_key'
  ).all(resolved.user.family_id).map(r => r.feature_key);
  assert.deepStrictEqual(keys, []);
});

test('共同家长：邮箱邀请 → 接受 → 合并空家庭，共享会员；席位与令牌保护', async () => {
  const owner = await newAccount('fam2-owner@example.com');
  const ownerFam = familyOf('fam2-owner@example.com').family_id;
  grantMembership(ownerFam); // 邀请另一位家长需要有效会员
  const before = familyCount();

  let r = await owner.fetch('POST', '/api/family/invite', { email: 'fam2-coparent@example.com' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const inviteToken = tokenFromMail(lastMail('family'));

  const coparent = await newAccount('fam2-coparent@example.com');
  // 邀请对象注册时会自动建一个空家庭
  assert.strictEqual(familyCount(), before + 1);
  // 走真实落地页：把令牌放进 HttpOnly Cookie，再不带 body 接受（Google 回跳也走这条路）
  r = await coparent.fetch('GET', '/api/family/invite/landing?token=' + encodeURIComponent(inviteToken));
  assert.strictEqual(r.status, 302);
  assert.strictEqual(coparent.cookies.get('tm_invite'), inviteToken);
  r = await coparent.fetch('GET', '/api/family/invite/pending');
  assert.strictEqual(r.json.data.pending, true);
  r = await coparent.fetch('POST', '/api/family/invite/accept', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(coparent.cookies.get('tm_invite'), undefined, '接受后清除邀请 Cookie');
  assert.strictEqual(familyCount(), before, '空家庭被合并删除');

  const me = await coparent.fetch('GET', '/api/me');
  assert.strictEqual(me.json.data.user.familyId, ownerFam);
  assert.strictEqual(me.json.data.user.familyRole, 'coparent');
  assert.strictEqual(me.json.data.family.seats.parents, 2);
  assert.deepStrictEqual(me.json.data.entitlements, ['celebration_image', 'live_race', 'pdf_worksheet']);

  // 令牌不能重复使用
  r = await coparent.fetch('POST', '/api/family/invite/accept', { token: inviteToken });
  assert.strictEqual(r.status, 400);

  // 已有 2 位家长：不能再邀请
  r = await owner.fetch('POST', '/api/family/invite', { email: 'third@example.com' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'family_full');

  // 共同家长不是 owner：不能邀请
  r = await coparent.fetch('POST', '/api/family/invite', { email: 'third@example.com' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.code, 'owner_only');
});

test('邀请：邮箱不匹配、过期、已有子女的家庭不能合并', async () => {
  const owner = await newAccount('fam3-owner@example.com');
  grantMembership(familyOf('fam3-owner@example.com').family_id);
  let r = await owner.fetch('POST', '/api/family/invite', { email: 'fam3-invitee@example.com' });
  assert.strictEqual(r.status, 200);
  const token = tokenFromMail(lastMail('family'));

  const wrong = await newAccount('fam3-wrong@example.com');
  r = await wrong.fetch('POST', '/api/family/invite/accept', { token });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.code, 'invite_email_mismatch');

  const invitee = await newAccount('fam3-invitee@example.com');
  grantMembership(familyOf('fam3-invitee@example.com').family_id);
  // 邀请对象先创建了子女 → 家庭不再可合并
  r = await invitee.fetch('POST', '/api/profiles', { nickname: 'Kid', username: 'fam3kid', password: 'child-pass-123' });
  assert.strictEqual(r.status, 200);
  r = await invitee.fetch('POST', '/api/family/invite/accept', { token });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'already_in_family');

  // 过期令牌
  db.prepare('UPDATE family_invites SET expires_at = ? WHERE token_hash = ?')
    .run(Date.now() - 1000, require('../server/src/util').hashToken(token));
  r = await invitee.fetch('POST', '/api/family/invite/accept', { token });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.code, 'invite_expired');
});

test('子女账号：创建 2 个、用户名登录、越权拦截、密码重置撤销旧会话', async () => {
  const parent = await newAccount('fam4-parent@example.com');
  grantMembership(familyOf('fam4-parent@example.com').family_id);
  let r = await parent.fetch('POST', '/api/profiles', {
    nickname: 'Kid One', username: 'fam4kid1', password: 'child-pass-123'
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const childId = r.json.data.profile.id;
  r = await parent.fetch('POST', '/api/profiles', {
    nickname: 'Kid Two', username: 'fam4kid2', password: 'child-pass-123'
  });
  assert.strictEqual(r.status, 200);
  r = await parent.fetch('POST', '/api/profiles', {
    nickname: 'Kid Three', username: 'fam4kid3', password: 'child-pass-123'
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'profile_limit');

  const bad = await childLogin('fam4kid1', 'wrong-password');
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(bad.json.code, 'child_login_failed');

  const child = await childLogin('fam4kid1', 'child-pass-123');
  assert.strictEqual(child.status, 200);
  const me = await child.client.fetch('GET', '/api/me');
  assert.strictEqual(me.json.data.user, null);
  assert.strictEqual(me.json.data.child.id, childId);
  assert.strictEqual(me.json.data.child.username, 'fam4kid1');
  assert.deepStrictEqual(me.json.data.entitlements, ['celebration_image', 'live_race', 'pdf_worksheet']);

  // 子女只能读自己的游戏数据
  r = await child.client.fetch('GET', '/api/profiles/' + childId + '/records/stats');
  assert.strictEqual(r.status, 200);
  r = await child.client.fetch('GET', '/api/profiles/999999/records/stats');
  assert.strictEqual(r.status, 404);

  // 家长专属接口
  r = await child.client.fetch('GET', '/api/account/export');
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.code, 'parent_only');
  r = await child.client.fetch('POST', '/api/profiles', { nickname: 'Nope' });
  assert.strictEqual(r.status, 403);

  // 家长重置密码：旧子女会话被撤销
  r = await parent.fetch('PUT', '/api/profiles/' + childId + '/credentials', {
    username: 'fam4kid1', password: 'new-child-pass-123'
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  r = await child.client.fetch('GET', '/api/me');
  assert.strictEqual(r.json.data.user, null);
  assert.strictEqual(r.json.data.child, undefined);

  const relogin = await childLogin('fam4kid1', 'new-child-pass-123');
  assert.strictEqual(relogin.status, 200);

  // 全局唯一用户名
  const other = await newAccount('fam4-other@example.com');
  grantMembership(familyOf('fam4-other@example.com').family_id);
  r = await other.fetch('POST', '/api/profiles', {
    nickname: 'Copy', username: 'fam4kid1', password: 'child-pass-123'
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'username_taken');

  // 非法 / 保留用户名
  for (const username of ['ab', 'has space', 'admin', 'a@b']) {
    r = await other.fetch('POST', '/api/profiles', { nickname: 'X', username, password: 'child-pass-123' });
    assert.strictEqual(r.status, 400, username);
    assert.strictEqual(r.json.code, 'invalid_username', username);
  }
});

test('未验证邮箱：不能创建子女或邀请另一位家长', async () => {
  const c = new Client();
  await c.csrf();
  let r = await c.fetch('POST', '/api/auth/register', { email: 'unverified@example.com', password: 'unverified-pass' });
  assert.strictEqual(r.status, 200);
  r = await c.fetch('POST', '/api/auth/login', { email: 'unverified@example.com', password: 'unverified-pass' });
  assert.strictEqual(r.status, 200);
  await c.csrf();

  r = await c.fetch('POST', '/api/profiles', { nickname: 'Kid', username: 'unverifiedkid', password: 'child-pass-123' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.code, 'email_unverified');
  r = await c.fetch('POST', '/api/family/invite', { email: 'invitee@example.com' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.code, 'email_unverified');
});

test('会员到期：不能新增子女，PDF 与联机对战权益失效', async () => {
  const parent = await newAccount('fam5-parent@example.com');
  const fam = familyOf('fam5-parent@example.com').family_id;
  grantMembership(fam);
  revokeFamilySource(db, fam, 'grant');

  let r = await parent.fetch('POST', '/api/profiles', { nickname: 'After Expiry', username: 'fam5kid', password: 'child-pass-123' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.code, 'membership_required');

  r = await parent.fetch('GET', '/api/pdf/worksheet?count=5&locale=en');
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.code, 'supporter_required');

  const me = await parent.fetch('GET', '/api/me');
  assert.strictEqual(me.json.data.membership.active, false);
  assert.deepStrictEqual(me.json.data.entitlements, []);
});

test('owner 删除：家长身份转交共同家长，子女不被 creator 级联删除', async () => {
  const owner = await newAccount('fam7-owner@example.com');
  const fam = familyOf('fam7-owner@example.com').family_id;
  grantMembership(fam);
  let r = await owner.fetch('POST', '/api/profiles', { nickname: 'Owner Kid', username: 'fam7kid', password: 'child-pass-123' });
  assert.strictEqual(r.status, 200);
  const childId = r.json.data.profile.id;
  r = await owner.fetch('POST', '/api/family/invite', { email: 'fam7-coparent@example.com' });
  assert.strictEqual(r.status, 200);
  const token = tokenFromMail(lastMail('family'));
  const coparent = await newAccount('fam7-coparent@example.com');
  r = await coparent.fetch('POST', '/api/family/invite/accept', { token });
  assert.strictEqual(r.status, 200);

  r = await owner.fetch('DELETE', '/api/account');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const me = await coparent.fetch('GET', '/api/me');
  assert.strictEqual(me.json.data.user.familyId, fam, '家庭保留');
  assert.strictEqual(me.json.data.user.familyRole, 'owner', '共同家长接任 owner');
  assert.strictEqual(me.json.data.family.children.length, 1, 'owner 创建的子女保留');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM child_profiles WHERE id = ?').get(childId).c, 1);
});

test('账号删除：共同家长离开时家庭与子女保留；最后一位家长删除整个家庭', async () => {
  const owner = await newAccount('fam6-owner@example.com');
  const fam = familyOf('fam6-owner@example.com').family_id;
  grantMembership(fam);
  let r = await owner.fetch('POST', '/api/family/invite', { email: 'fam6-coparent@example.com' });
  assert.strictEqual(r.status, 200);
  const token = tokenFromMail(lastMail('family'));
  const coparent = await newAccount('fam6-coparent@example.com');
  r = await coparent.fetch('POST', '/api/family/invite/accept', { token });
  assert.strictEqual(r.status, 200);
  r = await coparent.fetch('POST', '/api/profiles', { nickname: 'Shared Kid', username: 'fam6kid', password: 'child-pass-123' });
  assert.strictEqual(r.status, 200);
  const childId = r.json.data.profile.id;

  // 共同家长删除账号：家庭、子女、owner 都保留
  r = await coparent.fetch('DELETE', '/api/account');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM users WHERE email_normalized = ?').get('fam6-owner@example.com').c, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM child_profiles WHERE id = ?').get(childId).c, 1);
  assert.strictEqual(db.prepare('SELECT family_id FROM users WHERE email_normalized = ?').get('fam6-owner@example.com').family_id, fam);

  // 最后一位家长删除：家庭、子女、权益全部清除
  r = await owner.fetch('DELETE', '/api/account');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM families WHERE id = ?').get(fam).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM child_profiles WHERE id = ?').get(childId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM entitlements WHERE family_id = ?').get(fam).c, 0);
});
