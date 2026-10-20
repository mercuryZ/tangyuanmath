'use strict';
/* Waffo Pancake 支付：订单、webhook 幂等、权益开通/撤销、订阅取消、路由鉴权 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDb } = require('../server/src/db');
const { createApp } = require('../server/src/index');
const mw = require('../server/src/middleware');
const config = require('../server/src/config');
const orderStore = require('../server/src/order-store');
const { initFamilyForNewUser } = require('../server/src/family');
const { revokeFamilySource } = require('../server/src/entitlements');
const waffo = require('../server/src/waffo');

const STORE = config.waffoStoreId || 'STO_test';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-waffo-'));
  const db = initDb(path.join(dir, 'app.db'));
  const now = Date.now();
  const userId = Number(db.prepare(
    'INSERT INTO users (email_normalized, password_hash, email_verified_at, locale, created_at) VALUES (?,?,?,?,?)'
  ).run('parent-' + now + '@example.com', 'hash', now, 'en', now).lastInsertRowid);
  const familyId = initFamilyForNewUser(db, userId);
  // 清掉上线赠送，测试只看 order 来源
  revokeFamilySource(db, familyId, 'promo', 'launch-2026');
  return {
    dir, db, userId, familyId,
    cleanup() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

let eventSeq = 0;
function makeEvent(type, orderNo, sku, extra) {
  eventSeq++;
  return {
    id: 'evt_' + eventSeq,
    timestamp: new Date().toISOString(),
    eventType: type,
    eventId: 'BIZ_' + eventSeq,
    storeId: STORE,
    storeName: 'Tangyuan Math',
    mode: 'test',
    data: Object.assign({
      orderId: 'ORD_' + eventSeq,
      buyerEmail: 'parent@example.com',
      currency: 'USD',
      orderMetadata: { orderNo: orderNo, sku: sku, familyId: '1' },
      orderMerchantExternalId: orderNo
    }, extra || {})
  };
}

function orderEntitlements(db, familyId) {
  return db.prepare(
    "SELECT feature_key, expires_at, revoked_at FROM entitlements WHERE family_id = ? AND source_type = 'order' ORDER BY feature_key"
  ).all(familyId);
}

function process(db, event) {
  return orderStore.processWaffoEvent(db, event, { storeId: STORE, environment: 'test' });
}

test('order.completed：一次性付款开通永久权益，重复事件不重复开通', () => {
  const f = fixture();
  try {
    const order = orderStore.createPendingOrder(f.db, {
      familyId: f.familyId, userId: f.userId, sku: 'supporter_lifetime', mode: 'test'
    });
    const event = makeEvent('order.completed', order.order_no, order.sku, {
      listPrice: { total: '149.00', subtotal: '149.00', taxAmount: '0' },
      chargedAmount: '149.00'
    });

    assert.strictEqual(process(f.db, event).status, 'processed');
    const paid = orderStore.getOrderByNo(f.db, order.order_no);
    assert.strictEqual(paid.status, 'paid');
    assert.strictEqual(paid.provider_order_id, event.data.orderId);

    let rows = orderEntitlements(f.db, f.familyId);
    assert.strictEqual(rows.length, 3);
    assert.ok(rows.every(r => r.expires_at === null && r.revoked_at === null));

    assert.strictEqual(process(f.db, event).status, 'duplicate');
    rows = orderEntitlements(f.db, f.familyId);
    assert.strictEqual(rows.length, 3);
  } finally {
    f.cleanup();
  }
});

test('subscription.activated / renewed：按 currentPeriodEnd 开通并延长', () => {
  const f = fixture();
  try {
    const order = orderStore.createPendingOrder(f.db, {
      familyId: f.familyId, userId: f.userId, sku: 'supporter_monthly', mode: 'test'
    });
    const first = makeEvent('subscription.activated', order.order_no, order.sku,
      { currentPeriodEnd: '2026-11-20', billingPeriod: 'monthly' });
    assert.strictEqual(process(f.db, first).status, 'processed');

    let rows = orderEntitlements(f.db, f.familyId);
    assert.strictEqual(rows.length, 3);
    assert.ok(rows.every(r => r.expires_at === Date.parse('2026-11-20')));

    // 续费事件把到期时间延后
    const renewed = makeEvent('subscription.renewed', order.order_no, order.sku,
      { currentPeriodEnd: '2026-12-20', billingPeriod: 'monthly' });
    process(f.db, renewed);
    rows = orderEntitlements(f.db, f.familyId);
    assert.ok(rows.every(r => r.expires_at === Date.parse('2026-12-20')));

    // 乱序到达的 payment_succeeded（无周期信息）不能把期限改短
    const payment = makeEvent('subscription.payment_succeeded', order.order_no, order.sku,
      { chargedAmount: '4.99' });
    process(f.db, payment);
    rows = orderEntitlements(f.db, f.familyId);
    assert.ok(rows.every(r => r.expires_at === Date.parse('2026-12-20')));
  } finally {
    f.cleanup();
  }
});

test('取消订阅：canceling 保留权益，canceled 撤销；延迟支付事件不能复活', () => {
  const f = fixture();
  try {
    const order = orderStore.createPendingOrder(f.db, {
      familyId: f.familyId, userId: f.userId, sku: 'supporter_yearly', mode: 'test'
    });
    const activated = makeEvent('subscription.activated', order.order_no, order.sku,
      { currentPeriodEnd: '2027-10-20' });
    process(f.db, activated);

    // 订阅状态事件可能不带 metadata：用 data.orderId 兜底匹配订单
    const canceling = makeEvent('subscription.canceling', order.order_no, order.sku,
      { currentPeriodEnd: '2027-10-20' });
    delete canceling.data.orderMetadata;
    delete canceling.data.orderMerchantExternalId;
    canceling.data.orderId = activated.data.orderId;
    process(f.db, canceling);

    assert.strictEqual(orderStore.getOrderByNo(f.db, order.order_no).status, 'canceling');
    let rows = orderEntitlements(f.db, f.familyId);
    assert.ok(rows.every(r => r.revoked_at === null));

    process(f.db, makeEvent('subscription.canceled', order.order_no, order.sku,
      { currentPeriodEnd: '2027-10-20' }));
    assert.strictEqual(orderStore.getOrderByNo(f.db, order.order_no).status, 'canceled');
    rows = orderEntitlements(f.db, f.familyId);
    assert.ok(rows.every(r => r.revoked_at !== null));

    // 延迟到达的续费事件不能重新开通
    process(f.db, makeEvent('subscription.renewed', order.order_no, order.sku,
      { currentPeriodEnd: '2027-11-20' }));
    rows = orderEntitlements(f.db, f.familyId);
    assert.ok(rows.every(r => r.revoked_at !== null));
  } finally {
    f.cleanup();
  }
});

test('refund.succeeded：只撤销该订单来源的权益', () => {
  const f = fixture();
  try {
    const order = orderStore.createPendingOrder(f.db, {
      familyId: f.familyId, userId: f.userId, sku: 'supporter_lifetime', mode: 'test'
    });
    // 另一条 grant 来源（例如客服补偿）不应被退款影响
    f.db.prepare(
      `INSERT INTO entitlements (family_id, user_id, feature_key, source_type, source_id, starts_at, expires_at)
       VALUES (?,?, 'live_race', 'grant', 'support-1', ?, NULL)`
    ).run(f.familyId, f.userId, Date.now());

    process(f.db, makeEvent('order.completed', order.order_no, order.sku,
      { listPrice: { subtotal: '149.00', total: '149.00', taxAmount: '0' } }));
    const refunded = process(f.db, makeEvent('refund.succeeded', order.order_no, order.sku,
      { refundedAmount: '149.00' }));

    assert.strictEqual(refunded.status, 'processed');
    assert.strictEqual(orderStore.getOrderByNo(f.db, order.order_no).status, 'refunded');
    const orderRows = orderEntitlements(f.db, f.familyId);
    assert.ok(orderRows.every(r => r.revoked_at !== null));
    const grant = f.db.prepare(
      "SELECT revoked_at FROM entitlements WHERE family_id = ? AND source_type = 'grant' AND source_id = 'support-1'"
    ).get(f.familyId);
    assert.strictEqual(grant.revoked_at, null);
  } finally {
    f.cleanup();
  }
});

test('订阅事件无 metadata 时用 merchantProvidedBuyerIdentity 兜底匹配订单', () => {
  const f = fixture();
  try {
    const order = orderStore.createPendingOrder(f.db, {
      familyId: f.familyId, userId: f.userId, sku: 'supporter_monthly', mode: 'test'
    });
    const event = makeEvent('subscription.activated', 'TM-NOT-IN-METADATA', order.sku, {
      merchantProvidedBuyerIdentity: 'family:' + f.familyId,
      orderId: 'ORD_fallback_1',
      currentPeriodEnd: '2026-12-01'
    });
    delete event.data.orderMetadata;
    delete event.data.orderMerchantExternalId;

    const r = process(f.db, event);
    assert.strictEqual(r.status, 'processed');
    assert.strictEqual(r.orderNo, order.order_no);
    assert.strictEqual(orderStore.getOrderByNo(f.db, order.order_no).provider_order_id, 'ORD_fallback_1');
    assert.strictEqual(orderEntitlements(f.db, f.familyId).length, 3);
  } finally {
    f.cleanup();
  }
});

test('webhook 校验：店铺、环境、币种、SKU、金额不符时一律不开通', () => {
  const f = fixture();
  try {
    const order = orderStore.createPendingOrder(f.db, {
      familyId: f.familyId, userId: f.userId, sku: 'supporter_lifetime', mode: 'test'
    });
    const base = () => makeEvent('order.completed', order.order_no, order.sku,
      { listPrice: { subtotal: '149.00', total: '149.00', taxAmount: '0' } });

    const wrongStore = base(); wrongStore.storeId = 'STO_other';
    const wrongMode = base(); wrongMode.mode = 'prod';
    const wrongCurrency = base(); wrongCurrency.data.currency = 'EUR';
    const wrongSku = base(); wrongSku.data.orderMetadata.sku = 'supporter_monthly';
    const wrongAmount = base(); wrongAmount.data.chargedAmount = '1.00';
    const unknown = makeEvent('order.completed', 'TM-NOPE', 'supporter_lifetime');
    const unhandled = makeEvent('dispute.opened', order.order_no, order.sku);

    for (const ev of [wrongStore, wrongMode, wrongCurrency, wrongSku, wrongAmount, unknown, unhandled]) {
      const r = process(f.db, ev);
      assert.strictEqual(r.status, 'ignored', ev.eventType + ' -> ' + r.reason);
    }
    assert.strictEqual(orderEntitlements(f.db, f.familyId).length, 0);
    assert.strictEqual(orderStore.getOrderByNo(f.db, order.order_no).status, 'pending');
  } finally {
    f.cleanup();
  }
});

/* ---------- HTTP 路由 ---------- */

function fakePayments() {
  const calls = { checkout: [], cancel: [] };
  return {
    calls,
    isCheckoutConfigured: () => true,
    createCheckout: async (order, opts) => {
      calls.checkout.push({ order, opts });
      return {
        checkoutUrl: 'https://checkout.test/' + order.order_no,
        sessionId: 'CS_' + order.order_no,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString()
      };
    },
    verifyWebhook: (raw, signature) => {
      if (signature !== 'good') {
        const err = new Error('bad signature');
        err.code = 'invalid_signature';
        throw err;
      }
      return JSON.parse(raw);
    },
    cancelSubscription: async orderId => {
      calls.cancel.push(orderId);
      return { orderId, status: 'canceling' };
    }
  };
}

async function startServer(db, payments) {
  const app = createApp(db, { payments });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { server, base, close: () => new Promise(r => server.close(r)) };
}

async function getCsrf(base, token) {
  const res = await fetch(base + '/api/csrf', {
    headers: { cookie: 'tm_session=' + token }
  });
  const json = await res.json();
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const m = /tm_csrf=([^;]+)/.exec(cookies.join(';'));
  return { token: json.data.csrfToken, cookie: 'tm_csrf=' + (m ? m[1] : '') };
}

async function api(base, token, csrf, method, p, body) {
  const headers = {
    origin: base,
    cookie: 'tm_session=' + token + '; ' + csrf.cookie
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf.token;
  const res = await fetch(base + p, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

test('POST /api/orders：鉴权、SKU 校验、pending 订单与托管结账 URL', async () => {
  const f = fixture();
  const payments = fakePayments();
  const ctx = await startServer(f.db, payments);
  try {
    const token = mw.createSession(f.db, f.userId);
    let csrf = await getCsrf(ctx.base, token);

    let r = await api(ctx.base, token, csrf, 'POST', '/api/orders', { sku: 'nope' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.code, 'invalid_sku');

    r = await api(ctx.base, token, csrf, 'POST', '/api/orders', { sku: 'supporter_monthly' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.data.orderNo.startsWith('TM-'));
    assert.ok(r.json.data.checkoutUrl.startsWith('https://checkout.test/'));
    assert.strictEqual(payments.calls.checkout.length, 1);

    const row = orderStore.getOrderByNo(f.db, r.json.data.orderNo);
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.provider_checkout_id, 'CS_' + row.order_no);

    // 未登录
    const anon = await fetch(ctx.base + '/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'supporter_monthly' })
    });
    assert.strictEqual(anon.status, 401);
  } finally {
    await ctx.close();
    f.cleanup();
  }
});

test('未配置私钥时下单返回 503（页面回退邮件联系）', async () => {
  const f = fixture();
  const savedKey = config.waffoPrivateKey;
  config.waffoPrivateKey = '';
  const ctx = await startServer(f.db); // 使用真实 Waffo 模块
  try {
    const token = mw.createSession(f.db, f.userId);
    const csrf = await getCsrf(ctx.base, token);
    const r = await api(ctx.base, token, csrf, 'POST', '/api/orders', { sku: 'supporter_monthly' });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.code, 'payments_not_configured');
  } finally {
    config.waffoPrivateKey = savedKey;
    await ctx.close();
    f.cleanup();
  }
});

test('有效订阅拒绝重复购买，过期后可以重新订阅', async () => {
  const f = fixture();
  const payments = fakePayments();
  const ctx = await startServer(f.db, payments);
  try {
    const token = mw.createSession(f.db, f.userId);
    const csrf = await getCsrf(ctx.base, token);
    const existing = orderStore.createPendingOrder(f.db, {
      familyId: f.familyId, userId: f.userId, sku: 'supporter_monthly', mode: 'test'
    });
    f.db.prepare("UPDATE orders SET status='paid', current_period_end=? WHERE id=?")
      .run(Date.now() + 30 * 24 * 3600 * 1000, existing.id);

    let r = await api(ctx.base, token, csrf, 'POST', '/api/orders', { sku: 'supporter_monthly' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'already_subscribed');

    f.db.prepare('UPDATE orders SET current_period_end=? WHERE id=?')
      .run(Date.now() - 1000, existing.id);
    r = await api(ctx.base, token, csrf, 'POST', '/api/orders', { sku: 'supporter_monthly' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.data.checkoutUrl);
  } finally {
    await ctx.close();
    f.cleanup();
  }
});

test('订单查询跨家庭 404；订阅取消调用 Waffo 并更新状态', async () => {
  const f = fixture();
  const payments = fakePayments();
  const ctx = await startServer(f.db, payments);
  try {
    const order = orderStore.createPendingOrder(f.db, {
      familyId: f.familyId, userId: f.userId, sku: 'supporter_monthly', mode: 'test'
    });
    f.db.prepare("UPDATE orders SET status='paid', provider_order_id='ORD_sub_1' WHERE id = ?").run(order.id);

    const token = mw.createSession(f.db, f.userId);
    const csrf = await getCsrf(ctx.base, token);

    let r = await api(ctx.base, token, csrf, 'GET', '/api/orders/' + order.order_no);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.cancelable, true);

    // 另一个家庭看不到
    const otherUser = Number(f.db.prepare(
      'INSERT INTO users (email_normalized, password_hash, email_verified_at, created_at) VALUES (?,?,?,?)'
    ).run('other@example.com', 'hash', Date.now(), Date.now()).lastInsertRowid);
    initFamilyForNewUser(f.db, otherUser);
    const otherToken = mw.createSession(f.db, otherUser);
    const otherCsrf = await getCsrf(ctx.base, otherToken);
    r = await api(ctx.base, otherToken, otherCsrf, 'GET', '/api/orders/' + order.order_no);
    assert.strictEqual(r.status, 404);

    r = await api(ctx.base, token, csrf, 'POST', '/api/orders/' + order.order_no + '/cancel');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.status, 'canceling');
    assert.deepStrictEqual(payments.calls.cancel, ['ORD_sub_1']);
    assert.strictEqual(orderStore.getOrderByNo(f.db, order.order_no).status, 'canceling');
  } finally {
    await ctx.close();
    f.cleanup();
  }
});

test('子女会话不能创建订单', async () => {
  const f = fixture();
  const payments = fakePayments();
  const ctx = await startServer(f.db, payments);
  try {
    const childId = Number(f.db.prepare(
      'INSERT INTO child_profiles (user_id, family_id, nickname, created_at) VALUES (?,?,?,?)'
    ).run(f.userId, f.familyId, 'Kid', Date.now()).lastInsertRowid);
    const token = mw.createChildSession(f.db, childId);
    const csrf = await getCsrf(ctx.base, token);
    const r = await api(ctx.base, token, csrf, 'POST', '/api/orders', { sku: 'supporter_monthly' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.code, 'parent_only');
  } finally {
    await ctx.close();
    f.cleanup();
  }
});

test('webhook 路由：验签失败 401，验签成功开通权益', async () => {
  const f = fixture();
  const payments = fakePayments();
  const ctx = await startServer(f.db, payments);
  try {
    const order = orderStore.createPendingOrder(f.db, {
      familyId: f.familyId, userId: f.userId, sku: 'supporter_lifetime', mode: 'test'
    });
    const event = makeEvent('order.completed', order.order_no, order.sku,
      { listPrice: { subtotal: '149.00', total: '149.00', taxAmount: '0' } });
    const body = JSON.stringify(event);

    let res = await fetch(ctx.base + '/api/payments/waffo/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-waffo-signature': 'bad' },
      body
    });
    assert.strictEqual(res.status, 401);

    res = await fetch(ctx.base + '/api/payments/waffo/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-waffo-signature': 'good' },
      body
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(orderStore.getOrderByNo(f.db, order.order_no).status, 'paid');
    assert.strictEqual(orderEntitlements(f.db, f.familyId).length, 3);
  } finally {
    await ctx.close();
    f.cleanup();
  }
});

test('verifyWebhook 包装：无效签名抛 invalid_signature', () => {
  assert.throws(
    () => waffo.verifyWebhook('{"a":1}', 't=123,v1=not-a-signature'),
    err => err.code === 'invalid_signature'
  );
});
