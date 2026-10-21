/* Waffo Pancake 托管结账（DESIGN §8.3 / §8.4）
 * - 服务端用 API Key 创建 checkout session，前端只拿 checkoutUrl，私钥永不出服务端；
 * - 金额以「分」存库，Waffo 用展示金额字符串（如 "4.99"），两端都按 USD 校验；
 * - webhook 使用 SDK 的 RSA-SHA256 验签，必须读原始 body（见 index.js 的 express.raw）；
 * - 默认 test 环境；上线时设 WAFFO_ENVIRONMENT=prod 并换生产 API Key。
 */
'use strict';

const crypto = require('node:crypto');

const config = require('./config');

const PROVIDER = 'waffo';
const CURRENCY = 'USD';

/* SKU 是本站自己的商品标识；Waffo 商品 ID 通过环境变量映射，不写死。 */
const SKUS = {
  /* 尝鲜价：$1 体验 7 天完整会员。一次性付款、不续费；每家庭限购一次（路由层守卫）。 */
  supporter_trial7: {
    kind: 'onetime', months: null, trialDays: 7, amountMinor: 100, currency: CURRENCY,
    name: 'Tangyuan Math Supporter — 7-Day Trial'
  },
  supporter_monthly: {
    kind: 'subscription', months: 1, amountMinor: 499, currency: CURRENCY,
    name: 'Tangyuan Math Supporter — Monthly'
  },
  supporter_yearly: {
    kind: 'subscription', months: 12, amountMinor: 4900, currency: CURRENCY,
    name: 'Tangyuan Math Supporter — Yearly'
  },
  supporter_lifetime: {
    kind: 'onetime', months: null, amountMinor: 14900, currency: CURRENCY,
    name: 'Tangyuan Math Supporter — Lifetime'
  }
};

const WEBHOOK_EVENTS = [
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
];

function paymentError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function productIdFor(sku) {
  if (sku === 'supporter_trial7') return config.waffoProductTrial7;
  if (sku === 'supporter_monthly') return config.waffoProductMonthly;
  if (sku === 'supporter_yearly') return config.waffoProductYearly;
  if (sku === 'supporter_lifetime') return config.waffoProductLifetime;
  return '';
}

function isConfigured() {
  return Boolean(config.waffoMerchantId && config.waffoStoreId && config.waffoPrivateKey);
}

function isCheckoutConfigured(sku) {
  return isConfigured() && Boolean(productIdFor(sku));
}

/* 诊断用：只返回布尔值与公开 ID，绝不返回或打印私钥。 */
function keyValidationPem(raw) {
  const pem = String(raw || '').replace(/\\n/g, '\n').trim();
  if (!pem) return null;
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(pem)) return pem;
  const compact = pem.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(compact)) return null;
  const wrapped = compact.match(/.{1,64}/g);
  return wrapped
    ? '-----BEGIN PRIVATE KEY-----\n' + wrapped.join('\n') + '\n-----END PRIVATE KEY-----'
    : null;
}

function status() {
  let keyValid = false;
  if (config.waffoPrivateKey) {
    try {
      const pem = keyValidationPem(config.waffoPrivateKey);
      if (pem) { crypto.createPrivateKey(pem); keyValid = true; }
    } catch (e) { keyValid = false; }
  }
  const products = {};
  for (const sku of Object.keys(SKUS)) {
    products[sku] = {
      productId: productIdFor(sku) || null,
      configured: Boolean(isConfigured() && productIdFor(sku))
    };
  }
  return {
    environment: config.waffoEnvironment,
    environmentInput: config.waffoEnvironmentInput || '(unset)',
    merchantId: config.waffoMerchantId || null,
    storeId: config.waffoStoreId || null,
    privateKeyPresent: Boolean(config.waffoPrivateKey),
    privateKeyValid: keyValid,
    products
  };
}

let client = null;

function getClient() {
  if (client) return client;
  if (!isConfigured()) {
    throw paymentError('payments_not_configured', 'Waffo payments are not configured on this server.');
  }
  let SDK;
  try { SDK = require('@waffo/pancake-ts'); }
  catch (e) { throw paymentError('sdk_missing', 'The Waffo SDK is not installed.', e); }
  try {
    client = new SDK.WaffoPancake({
      merchantId: config.waffoMerchantId,
      privateKey: config.waffoPrivateKey,
      environment: config.waffoEnvironment
    });
  } catch (e) {
    // 私钥格式错误等；不要把密钥内容带进日志
    throw paymentError('payments_not_configured', 'The Waffo private key is invalid.', e);
  }
  return client;
}

/* 展示金额字符串 → 最小货币单位。USD 固定两位小数。 */
function amountToMinor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function minorToDisplay(minor) {
  return (minor / 100).toFixed(2);
}

function baseUrl() {
  return String(config.publicBaseUrl || '').replace(/\/+$/, '');
}

function successUrlFor(orderNo) {
  return baseUrl() + '/account/?checkout=success&order=' + encodeURIComponent(orderNo);
}

function buyerIdentityFor(familyId) {
  return 'family:' + familyId;
}

/* 创建托管结账。order 是 orders 表里的一行。 */
async function createCheckout(order, opts) {
  opts = opts || {};
  const productId = productIdFor(order.sku);
  if (!productId) {
    throw paymentError('product_not_configured',
      'No Waffo product ID is configured for ' + order.sku + '.');
  }
  const c = getClient();
  const result = await c.checkout.authenticated.create({
    productId,
    currency: CURRENCY,
    buyerIdentity: buyerIdentityFor(order.family_id),
    buyerEmail: opts.buyerEmail || undefined,
    successUrl: successUrlFor(order.order_no),
    expiresInSeconds: 3600,
    language: opts.locale === 'zh' ? 'zh-Hans' : 'en',
    metadata: {
      orderNo: order.order_no,
      sku: order.sku,
      familyId: String(order.family_id)
    },
    orderMerchantExternalId: order.order_no
  }, { idempotencyKey: 'tm-checkout-' + order.order_no });
  return {
    checkoutUrl: result.checkoutUrl,
    sessionId: result.sessionId,
    expiresAt: result.expiresAt
  };
}

/* 验签并解析 webhook。失败统一抛 invalid_signature，路由返回 401。 */
function verifyWebhook(rawBody, signatureHeader) {
  let SDK;
  try { SDK = require('@waffo/pancake-ts'); }
  catch (e) { throw paymentError('sdk_missing', 'The Waffo SDK is not installed.', e); }
  const options = { environment: config.waffoEnvironment };
  if (config.waffoWebhookPublicKey) options.publicKey = config.waffoWebhookPublicKey;
  try {
    return SDK.verifyWebhook(rawBody, signatureHeader, options);
  } catch (e) {
    throw paymentError('invalid_signature', 'Invalid Waffo webhook signature.', e);
  }
}

/* 客户自助门户：取消订阅、更新支付方式、查看账单、提交退款申请。
 * 返回的 URL 带 bearer token（5–15 分钟有效），只能由服务端按当前会话即时签发，
 * 不要缓存、记录日志或放进可分享的页面。 */
async function createPortalLink(buyerIdentity) {
  const c = getClient();
  const result = await c.auth.createCustomerPortalLink({
    storeId: config.waffoStoreId,
    buyerIdentity
  });
  return { portalUrl: result.portalUrl, expiresAt: result.expiresAt };
}

/* 取消订阅续费：Waffo 会保留到当前计费周期结束（状态 canceling）。 */
async function cancelSubscription(providerOrderId) {
  if (!providerOrderId) throw paymentError('missing_provider_order', 'This order has no Waffo order ID yet.');
  const c = getClient();
  const result = await c.orders.cancelSubscription({ orderId: providerOrderId });
  return { orderId: result.orderId, status: result.status };
}

/* ---------- 商品 / webhook 配置（scripts/waffo-setup.js 使用） ---------- */

async function listProducts() {
  const c = getClient();
  const result = await c.graphql.query({
    query: `query ($storeId: String!) {
      onetimeProducts(storeId: $storeId) {
        id name status
        prices { currency priceInfo { amount taxCategory } }
      }
      subscriptionProducts(storeId: $storeId) {
        id name billingPeriod status
        prices { currency priceInfo { amount taxCategory } }
      }
    }`,
    variables: { storeId: config.waffoStoreId }
  });
  if (result.errors && result.errors.length) {
    throw paymentError('waffo_graphql_error', result.errors[0].message || 'Waffo GraphQL query failed.');
  }
  return result.data || {};
}

function taxCategoryFor(sku) {
  return SKUS[sku].kind === 'onetime' ? 'digital_goods' : 'saas';
}

/* 按商品名查找；不存在则创建。返回 {ids, created, warnings}。
 * 商品默认创建在 test 环境，发布到生产需另行 publish。 */
async function ensureProducts() {
  const c = getClient();
  const existing = await listProducts();
  const onetime = existing.onetimeProducts || [];
  const subs = existing.subscriptionProducts || [];
  const ids = {};
  const created = [];
  const warnings = [];

  for (const [sku, spec] of Object.entries(SKUS)) {
    const pool = spec.kind === 'onetime' ? onetime : subs;
    const match = pool.find(p => p.name === spec.name);
    if (match) {
      ids[sku] = match.id;
      const price = (match.prices || []).find(p => p.currency === CURRENCY);
      const amount = price && price.priceInfo ? price.priceInfo.amount : null;
      if (amount !== minorToDisplay(spec.amountMinor)) {
        warnings.push(sku + ': existing product price is ' + (amount || 'unknown') +
          ', expected ' + minorToDisplay(spec.amountMinor));
      }
      continue;
    }
    const base = {
      storeId: config.waffoStoreId,
      name: spec.name,
      prices: { [CURRENCY]: { amount: minorToDisplay(spec.amountMinor), taxCategory: taxCategoryFor(sku) } },
      description: 'Tangyuan Math Supporter family membership',
      successUrl: baseUrl() + '/account/',
      metadata: { sku }
    };
    let result;
    if (spec.kind === 'onetime') {
      result = await c.onetimeProducts.create(base);
    } else {
      result = await c.subscriptionProducts.create(Object.assign({}, base, { billingPeriod: spec.months === 12 ? 'yearly' : 'monthly' }));
    }
    ids[sku] = result.product.id;
    created.push(sku);
  }
  return { ids, created, warnings };
}

async function publishProducts(ids) {
  const c = getClient();
  const out = {};
  for (const [sku, spec] of Object.entries(SKUS)) {
    const id = ids[sku] || productIdFor(sku);
    if (!id) continue;
    const result = spec.kind === 'onetime'
      ? await c.onetimeProducts.publish({ id })
      : await c.subscriptionProducts.publish({ id });
    out[sku] = result.product ? result.product.id : id;
  }
  return out;
}

async function registerWebhook(url) {
  const c = getClient();
  const result = await c.webhooks.add({
    storeId: config.waffoStoreId,
    channel: 'http',
    url,
    events: WEBHOOK_EVENTS,
    testMode: config.waffoEnvironment === 'test'
  });
  return result.webhook;
}

module.exports = {
  PROVIDER,
  CURRENCY,
  SKUS,
  WEBHOOK_EVENTS,
  amountToMinor,
  minorToDisplay,
  buyerIdentityFor,
  createCheckout,
  isConfigured,
  isCheckoutConfigured,
  status,
  productIdFor,
  verifyWebhook,
  createPortalLink,
  cancelSubscription,
  listProducts,
  ensureProducts,
  publishProducts,
  registerWebhook
};
