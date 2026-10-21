/* 支付 API（DESIGN §7.1、§8.4）
 * POST /api/orders              创建托管结账（家长、已验证邮箱）
 * GET  /api/orders              家庭最近订单
 * GET  /api/orders/:orderNo     查询订单（返回页轮询用，不因访问而开通权益）
 * POST /api/orders/:orderNo/cancel  取消订阅续费
 * POST /api/payments/waffo/webhook   Waffo 验签回调（在 index.js 用 express.raw 挂载）
 */
'use strict';

const express = require('express');

const config = require('./config');
const mw = require('./middleware');
const orderStore = require('./order-store');
const waffo = require('./waffo');

function publicOrder(order) {
  return {
    orderNo: order.order_no,
    sku: order.sku,
    amountMinor: order.amount_minor,
    currency: order.currency,
    status: order.status,
    mode: order.mode,
    currentPeriodEnd: order.current_period_end,
    paidAt: order.paid_at,
    createdAt: order.created_at
  };
}

function hasActiveOrder(db, familyId, kind, now) {
  const t = now === undefined ? Date.now() : now;
  if (kind === 'onetime') {
    return !!db.prepare(
      `SELECT 1 FROM orders WHERE family_id = ? AND sku = 'supporter_lifetime'
         AND status = 'paid' LIMIT 1`
    ).get(familyId);
  }
  return !!db.prepare(
    `SELECT 1 FROM orders WHERE family_id = ? AND sku <> 'supporter_lifetime'
       AND status IN ('paid','canceling','past_due')
       AND (current_period_end IS NULL OR current_period_end > ?) LIMIT 1`
  ).get(familyId, t);
}

function buildOrdersRouter(db, payments) {
  const r = express.Router();

  const createLimit = mw.rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyFn: req => 'u' + (req.user ? req.user.id : req.ip),
    name: 'order-create'
  });

  r.post('/', createLimit, mw.csrfProtect, async (req, res) => {
    const sku = String((req.body && req.body.sku) || '');
    const spec = waffo.SKUS[sku];
    if (!spec) return mw.fail(res, 400, 'invalid_sku', 'Unknown plan.');

    if (!req.user.emailVerified) {
      return mw.fail(res, 403, 'email_unverified', 'Please verify your email before paying.');
    }
    if (!payments.isCheckoutConfigured(sku)) {
      return mw.fail(res, 503, 'payments_not_configured',
        'Online checkout is not available yet. Please contact us to subscribe.');
    }
    if (hasActiveOrder(db, req.familyId, spec.kind, Date.now())) {
      return mw.fail(res, 409,
        spec.kind === 'onetime' ? 'already_lifetime' : 'already_subscribed',
        spec.kind === 'onetime'
          ? 'This family already has lifetime access.'
          : 'This family already has an active subscription. Cancel it in the Parent Center before starting a new one.');
    }

    const mode = config.waffoEnvironment;
    let order = orderStore.findReusablePendingOrder(db, req.familyId, sku, mode, Date.now());
    if (!order) {
      order = orderStore.createPendingOrder(db, {
        familyId: req.familyId, userId: req.user.id, sku, mode
      });
    } else if (order.amount_minor !== spec.amountMinor) {
      // 复用的 pending 订单要跟随最新定价，避免改价后仍按旧金额快照校验
      db.prepare('UPDATE orders SET amount_minor = ?, updated_at = ? WHERE id = ?')
        .run(spec.amountMinor, Date.now(), order.id);
      order.amount_minor = spec.amountMinor;
    }

    try {
      const session = await payments.createCheckout(order, {
        buyerEmail: req.user.email,
        locale: req.user.locale
      });
      orderStore.setCheckoutSession(db, order.id, session);
      return mw.ok(res, {
        orderNo: order.order_no,
        sku: order.sku,
        checkoutUrl: session.checkoutUrl
      });
    } catch (err) {
      const code = err && err.code;
      if (code === 'payments_not_configured' || code === 'product_not_configured' || code === 'sdk_missing') {
        return mw.fail(res, 503, 'payments_not_configured',
          'Online checkout is not available yet. Please contact us to subscribe.');
      }
      console.error('[waffo] checkout failed:', err && err.message ? err.message : err);
      return mw.fail(res, 502, 'payment_provider_error',
        'The payment provider could not start checkout. Please try again.');
    }
  });

  r.get('/', (req, res) => {
    mw.ok(res, { orders: orderStore.listFamilyOrders(db, req.familyId, 20) });
  });

  /* 客户自助门户：取消订阅、更新支付方式、查看账单、提交退款申请。
   * 链接带 bearer token，必须每次按当前登录家庭即时签发，且不缓存。 */
  const portalLimit = mw.rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    keyFn: req => 'u' + (req.user ? req.user.id : req.ip),
    name: 'billing-portal'
  });
  r.post('/portal', portalLimit, mw.csrfProtect, async (req, res) => {
    if (!orderStore.hasAnyOrder(db, req.familyId)) {
      return mw.fail(res, 404, 'no_orders', 'There are no orders to manage yet.');
    }
    try {
      const link = await payments.createPortalLink(waffo.buyerIdentityFor(req.familyId));
      res.set('Cache-Control', 'no-store');
      res.set('Pragma', 'no-cache');
      return mw.ok(res, link);
    } catch (err) {
      const code = err && err.code;
      if (code === 'payments_not_configured' || code === 'sdk_missing') {
        return mw.fail(res, 503, 'payments_not_configured',
          'Billing management is not available yet. Please contact us.');
      }
      console.error('[waffo] portal link failed:', err && err.message ? err.message : err);
      return mw.fail(res, 502, 'payment_provider_error',
        'The billing portal could not be opened. Please try again.');
    }
  });

  r.get('/:orderNo', (req, res) => {
    const order = orderStore.getOrderByNo(db, req.params.orderNo);
    // 跨家庭一律 404，不泄露订单是否存在
    if (!order || order.family_id !== req.familyId) {
      return mw.fail(res, 404, 'not_found', 'Order not found.');
    }
    const out = publicOrder(order);
    out.cancelable = order.sku !== 'supporter_lifetime' &&
      ['paid', 'canceling', 'past_due'].includes(order.status) &&
      !!order.provider_order_id;
    out.canceling = order.status === 'canceling';
    return mw.ok(res, out);
  });

  r.post('/:orderNo/cancel', mw.csrfProtect, async (req, res) => {
    const order = orderStore.getOrderByNo(db, req.params.orderNo);
    if (!order || order.family_id !== req.familyId) {
      return mw.fail(res, 404, 'not_found', 'Order not found.');
    }
    if (order.sku === 'supporter_lifetime') {
      return mw.fail(res, 400, 'not_a_subscription', 'Lifetime access has no renewal to cancel.');
    }
    if (order.status === 'canceling') {
      return mw.ok(res, { orderNo: order.order_no, status: order.status });
    }
    if (!['paid', 'past_due'].includes(order.status) || !order.provider_order_id) {
      return mw.fail(res, 409, 'not_cancelable', 'This subscription cannot be cancelled yet.');
    }

    try {
      const result = await payments.cancelSubscription(order.provider_order_id);
      const status = result.status === 'canceled' ? 'canceled' : 'canceling';
      db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Date.now(), order.id);
      return mw.ok(res, { orderNo: order.order_no, status });
    } catch (err) {
      console.error('[waffo] cancel failed:', err && err.message ? err.message : err);
      return mw.fail(res, 502, 'payment_provider_error',
        'The subscription could not be cancelled. Please try again or contact us.');
    }
  });

  return r;
}

/* webhook：必须用 express.raw，且不能经过 express.json（验签依赖原始字节）。 */
function buildWaffoWebhookHandler(db, payments) {
  return function waffoWebhook(req, res) {
    let event;
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      if (!raw) return res.status(400).send('Missing body');
      event = payments.verifyWebhook(raw, req.get('x-waffo-signature'));
    } catch (err) {
      return res.status(401).send('Invalid signature');
    }

    try {
      const result = orderStore.processWaffoEvent(db, event, {
        storeId: config.waffoStoreId,
        environment: config.waffoEnvironment
      });
      if (result.status === 'ignored') {
        console.warn('[waffo-webhook] ignored ' + event.eventType + ': ' + result.reason);
      }
      return res.status(200).send('OK');
    } catch (err) {
      console.error('[waffo-webhook] processing failed:', err && err.message ? err.message : err);
      return res.status(500).send('Error');
    }
  };
}

module.exports = { buildOrdersRouter, buildWaffoWebhookHandler, hasActiveOrder };
