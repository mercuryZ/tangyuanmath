/* 订单与 Waffo webhook 事件处理（DESIGN §6、§8.4）
 * - orders 只记录订单结果（不存卡号等支付凭据）；
 * - payment_events 以 (provider, event_id) 去重，webhook 重试不会重复开通；
 * - 权益写入 entitlements：source_type='order'、source_id=order_no；
 * - 只有验签通过、且订单/店铺/环境/币种都对得上的事件才会开通权益。
 */
'use strict';

const crypto = require('node:crypto');

const { SUPPORTER_FEATURES, grantFamilyEntitlement, revokeFamilySource } = require('./entitlements');
const { addCalendarMonths } = require('./family');
const waffo = require('./waffo');

const PROVIDER = waffo.PROVIDER;
const PENDING_TTL_MS = 3600 * 1000;   // checkout session 1 小时
const REUSE_WINDOW_MS = 30 * 60 * 1000;

const HANDLED_EVENTS = new Set([
  'order.completed',
  'subscription.activated',
  'subscription.payment_succeeded',
  'subscription.renewed',
  'subscription.recovered',
  'subscription.plan_changed',
  'subscription.canceling',
  'subscription.uncanceled',
  'subscription.canceled',
  'subscription.past_due',
  'refund.succeeded',
  'refund.failed'
]);

function pad2(n) { return String(n).padStart(2, '0'); }

function generateOrderNo(now) {
  const d = new Date(now === undefined ? Date.now() : now);
  const stamp = d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  return 'TM-' + stamp + '-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function amountOf(sku) {
  const spec = waffo.SKUS[sku];
  return spec ? spec.amountMinor : null;
}

function createPendingOrder(db, { familyId, userId, sku, mode, now }) {
  const t = now === undefined ? Date.now() : now;
  const orderNo = generateOrderNo(t);
  db.prepare(
    `INSERT INTO orders
       (order_no, family_id, purchased_by, sku, amount_minor, currency, status,
        provider, mode, expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'pending', ?, ?, ?, ?, ?)`
  ).run(orderNo, familyId, userId, sku, amountOf(sku), waffo.CURRENCY, PROVIDER,
    mode || 'test', t + PENDING_TTL_MS, t, t);
  return getOrderByNo(db, orderNo);
}

function getOrderByNo(db, orderNo) {
  return db.prepare('SELECT * FROM orders WHERE order_no = ?').get(String(orderNo || '')) || null;
}

/* 订阅状态事件可能不带 orderMetadata/orderMerchantExternalId，但一定带 Waffo 的
 * 业务订单号（data.orderId）；用首次 activated 时存下的 provider_order_id 兜底。 */
function getOrderByProviderOrderId(db, providerOrderId) {
  return db.prepare('SELECT * FROM orders WHERE provider = ? AND provider_order_id = ?')
    .get(PROVIDER, String(providerOrderId || '')) || null;
}

/* 第三层兜底：checkout 时写入的 merchantProvidedBuyerIdentity 是稳定的家庭标识。
 * 若某些订阅事件既没有 metadata 也没有可匹配的 provider_order_id，仍在 24 小时内
 * 找到该家庭最近一笔 pending 订单。事件本身已验签，身份也由我们在创建会话时提供。 */
function findRecentPendingOrderForFamily(db, familyId, now) {
  return db.prepare(
    `SELECT * FROM orders
     WHERE family_id = ? AND provider = ? AND status = 'pending' AND created_at >= ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(familyId, PROVIDER, now - 24 * 3600 * 1000) || null;
}

/* 同一家庭 + SKU 在 30 分钟内重复点击时复用 pending 订单，配合幂等键避免重复结账。 */
function findReusablePendingOrder(db, familyId, sku, mode, now) {
  const t = now === undefined ? Date.now() : now;
  return db.prepare(
    `SELECT * FROM orders
     WHERE family_id = ? AND sku = ? AND mode = ? AND status = 'pending'
       AND created_at >= ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(familyId, sku, mode || 'test', t - REUSE_WINDOW_MS) || null;
}

function setCheckoutSession(db, orderId, session) {
  const expiresAt = parseDate(session.expiresAt) || (Date.now() + PENDING_TTL_MS);
  db.prepare(
    `UPDATE orders SET provider_checkout_id = ?, expires_at = ?, updated_at = ? WHERE id = ?`
  ).run(session.sessionId || null, expiresAt, Date.now(), orderId);
}

function listFamilyOrders(db, familyId, limit) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  return db.prepare(
    `SELECT order_no AS orderNo, sku, amount_minor AS amountMinor, currency, status,
            mode, current_period_end AS currentPeriodEnd, paid_at AS paidAt,
            created_at AS createdAt
     FROM orders WHERE family_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(familyId, n);
}

function parseDate(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function eventTime(event, fallback) {
  const t = parseDate(event && event.timestamp);
  return t === null ? fallback : t;
}

/* 首次开通或续费时延长同一订单来源的权益。
 * 同一 (family, feature, order_no) 只保留一条有效记录；续费只更新到期时间。 */
function grantOrderEntitlements(db, order, expiresAt, startsAt) {
  const existingStmt = db.prepare(
    `SELECT id FROM entitlements
     WHERE family_id = ? AND feature_key = ? AND source_type = 'order'
       AND source_id = ? AND revoked_at IS NULL`
  );
  /* 续费/重复事件只能延长有效期：expires_at 为 NULL 表示永久，保持 NULL；
   * 否则取旧值与新值的较大者，避免乱序到达的 payment_succeeded 把期限改短。 */
  const bumpStmt = db.prepare(
    `UPDATE entitlements
     SET expires_at = CASE WHEN expires_at IS NULL THEN NULL ELSE MAX(expires_at, ?) END,
         starts_at = MIN(starts_at, ?)
     WHERE id = ?`
  );
  for (const featureKey of SUPPORTER_FEATURES) {
    const row = existingStmt.get(order.family_id, featureKey, order.order_no);
    if (row) {
      bumpStmt.run(expiresAt, startsAt, row.id);
    } else {
      grantFamilyEntitlement(db, {
        familyId: order.family_id,
        userId: order.purchased_by,
        featureKey,
        sourceType: 'order',
        sourceId: order.order_no,
        startsAt,
        expiresAt
      });
    }
  }
}

function revokeOrderEntitlements(db, order) {
  return revokeFamilySource(db, order.family_id, 'order', order.order_no);
}

function updateOrder(db, order, fields) {
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(key + ' = ?');
    values.push(value);
  }
  sets.push('updated_at = ?');
  values.push(Date.now(), order.id);
  db.prepare('UPDATE orders SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

function markPaid(db, order, data, ts, periodEnd) {
  const terminal = order.status === 'refunded' || order.status === 'partially_refunded' || order.status === 'canceled';
  updateOrder(db, order, {
    status: terminal ? order.status : 'paid',
    provider_order_id: data.orderId || order.provider_order_id,
    provider_payment_id: data.paymentId || order.provider_payment_id,
    paid_at: order.paid_at || ts,
    current_period_end: periodEnd || order.current_period_end,
    last_event_at: ts
  });
}

function expiryFor(order, data, at) {
  const spec = waffo.SKUS[order.sku];
  if (!spec || spec.kind === 'onetime') return null;
  const periodEnd = parseDate(data.currentPeriodEnd);
  if (periodEnd !== null) return periodEnd;
  // 没有周期信息时按事件时间顺延，避免延迟到达的事件从「处理时间」重新起算
  return addCalendarMonths(at, spec.months);
}

/* 应用一条已通过验签与订单校验的事件。在事务内调用。 */
function applyEvent(db, order, event, data, ts) {
  const type = event.eventType;
  const spec = waffo.SKUS[order.sku];

  if (type === 'order.completed') {
    const expiresAt = spec.kind === 'onetime' ? null : expiryFor(order, data, ts);
    markPaid(db, order, data, ts, expiresAt);
    grantOrderEntitlements(db, order, expiresAt, ts);
    return;
  }

  if (type === 'subscription.activated' || type === 'subscription.renewed' ||
      type === 'subscription.recovered' || type === 'subscription.plan_changed' ||
      type === 'subscription.payment_succeeded') {
    if (order.status === 'canceled' || order.status === 'refunded' || order.status === 'partially_refunded') {
      return; // 已终止/已退款后到达的延迟支付事件不得重新开通
    }
    const expiresAt = expiryFor(order, data, ts);
    markPaid(db, order, data, ts, expiresAt);
    if (expiresAt !== null) grantOrderEntitlements(db, order, expiresAt, ts);
    return;
  }

  if (type === 'subscription.canceling') {
    if (['canceled', 'refunded', 'partially_refunded'].includes(order.status)) return;
    updateOrder(db, order, {
      status: 'canceling',
      provider_order_id: data.orderId || order.provider_order_id,
      current_period_end: parseDate(data.currentPeriodEnd) || order.current_period_end,
      last_event_at: ts
    });
    return;
  }

  if (type === 'subscription.uncanceled') {
    if (order.status !== 'canceling') return;
    updateOrder(db, order, {
      status: 'paid',
      current_period_end: parseDate(data.currentPeriodEnd) || order.current_period_end,
      last_event_at: ts
    });
    return;
  }

  if (type === 'subscription.canceled') {
    if (['refunded', 'partially_refunded'].includes(order.status)) {
      revokeOrderEntitlements(db, order);
      return; // 保留退款状态，不被后续取消事件覆盖
    }
    updateOrder(db, order, {
      status: 'canceled',
      current_period_end: parseDate(data.currentPeriodEnd) || order.current_period_end,
      last_event_at: ts
    });
    revokeOrderEntitlements(db, order);
    return;
  }

  if (type === 'subscription.past_due') {
    if (['canceled', 'refunded', 'partially_refunded'].includes(order.status)) return;
    updateOrder(db, order, {
      status: 'past_due',
      current_period_end: parseDate(data.currentPeriodEnd) || order.current_period_end,
      last_event_at: ts
    });
    return; // 权益保留到原到期时间，由时间判断自然失效
  }

  if (type === 'refund.succeeded') {
    const refunded = waffo.amountToMinor(data.refundedAmount);
    const status = refunded !== null && refunded < order.amount_minor ? 'partially_refunded' : 'refunded';
    updateOrder(db, order, { status, last_event_at: ts });
    revokeOrderEntitlements(db, order);
    return;
  }

  if (type === 'refund.failed') {
    updateOrder(db, order, { last_event_at: ts });
  }
}

/* 返回 {status:'processed'|'ignored'|'duplicate', ...}；重复事件不重复开通。 */
function processWaffoEvent(db, event, opts) {
  opts = opts || {};
  const now = Date.now();
  const ts = eventTime(event, now);
  const data = (event && event.data) || {};
  const orderNo = (data.orderMetadata && data.orderMetadata.orderNo) ||
    data.orderMerchantExternalId || null;
  const eventId = event && (event.id || [event.eventType, event.eventId, event.timestamp].filter(Boolean).join(':'));
  if (!eventId) throw new Error('Webhook event is missing an id');

  let reason = null;
  if (opts.storeId && event.storeId !== opts.storeId) reason = 'store_mismatch';
  else if (opts.environment && event.mode !== opts.environment) reason = 'environment_mismatch';
  else if (!orderNo && !data.orderId) reason = 'missing_order_reference';

  let order = orderNo ? getOrderByNo(db, orderNo) : null;
  if (!order && data.orderId) order = getOrderByProviderOrderId(db, data.orderId);
  if (!order && data.merchantProvidedBuyerIdentity) {
    const m = /^family:(\d+)$/.exec(String(data.merchantProvidedBuyerIdentity));
    if (m) order = findRecentPendingOrderForFamily(db, Number(m[1]), now);
  }
  const resolvedOrderNo = order ? order.order_no : orderNo;
  if (!reason && !order) reason = 'unknown_order';
  if (!reason && order.provider !== PROVIDER) reason = 'provider_mismatch';
  if (!reason && data.currency && data.currency !== order.currency) reason = 'currency_mismatch';

  const metaSku = data.orderMetadata && data.orderMetadata.sku;
  if (!reason && metaSku && metaSku !== order.sku) reason = 'sku_mismatch';
  if (!reason && !HANDLED_EVENTS.has(event.eventType)) reason = 'unhandled_event';

  const spec = order ? waffo.SKUS[order.sku] : null;
  if (!reason && spec && spec.kind === 'onetime' && String(event.eventType).startsWith('subscription.')) {
    reason = 'sku_type_mismatch';
  }
  /* 一次性付款至少收足标价。用实收金额（含税）或含税总价比较，
   * 不用 subtotal——税内含定价时 subtotal 会小于标价，会误杀正常订单。 */
  if (!reason && event.eventType === 'order.completed') {
    const paidMinor = data.chargedAmount != null
      ? waffo.amountToMinor(data.chargedAmount)
      : (data.listPrice && data.listPrice.total != null ? waffo.amountToMinor(data.listPrice.total) : null);
    if (paidMinor !== null && paidMinor < order.amount_minor) reason = 'amount_mismatch';
  }

  const tx = db.transaction(() => {
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO payment_events
         (provider, event_id, event_type, order_no, processing_status, reason, processed_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(PROVIDER, eventId, String(event.eventType || 'unknown'), resolvedOrderNo,
      reason ? 'ignored' : 'processed', reason, now);
    if (!inserted.changes) return { status: 'duplicate', orderNo: resolvedOrderNo };

    if (reason) return { status: 'ignored', reason, orderNo: resolvedOrderNo };

    try {
      applyEvent(db, order, event, data, ts);
    } catch (err) {
      throw err; // 回滚 payment_events，平台重试时可以再次处理
    }
    return { status: 'processed', eventType: event.eventType, orderNo: resolvedOrderNo };
  });
  return tx();
}

module.exports = {
  PROVIDER,
  PENDING_TTL_MS,
  createPendingOrder,
  findReusablePendingOrder,
  getOrderByNo,
  listFamilyOrders,
  setCheckoutSession,
  processWaffoEvent,
  // 导出便于测试与运维
  grantOrderEntitlements,
  revokeOrderEntitlements
};
