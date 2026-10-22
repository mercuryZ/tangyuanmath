/* 管理后台 API（挂载于 requireAuth + requireAdmin 之后；DESIGN §7.1 之外的管理扩展）
 * - 会员查询：邮箱前缀搜索 → 家庭聚合（家长邮箱/会员状态/有效功能）；
 * - 会员详情：家庭成员、权益原始行（来源/起止）、订单历史；
 * - 手动授予/撤销：把 grant-supporter.js CLI 的能力搬进 UI（source_type='grant'）；
 * - 优惠码：批量生成（明文仅一次）、元数据列表、禁用未用码。
 * 变更操作一律 csrfProtect + 专属限流；错误走统一 {ok:false,code} 信封。
 */
'use strict';

const express = require('express');

const mw = require('./middleware');
const orderStore = require('./order-store');
const redeem = require('./redeem');
const { SKUS } = require('./waffo');
const { normalizeEmail } = require('./util');
const family = require('./family');
const { SUPPORTER_FEATURES, grantFamilyEntitlement, revokeFamilySource, listActiveEntitlements } = require('./entitlements');

const MUTATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 60, keyFn: q => 'u' + q.user.id, name: 'admin-mutate' };

function grantSkuToFamily(db, { familyId, userId, sku, sourceId, now }) {
  const t = now === undefined ? Date.now() : now;
  const expiresAt = redeem.expiryForSku(sku, t);
  for (const featureKey of SUPPORTER_FEATURES) {
    grantFamilyEntitlement(db, {
      familyId, userId: userId || null, featureKey,
      sourceType: 'grant', sourceId, startsAt: t, expiresAt
    });
  }
  return { sku, expiresAt };
}

function buildAdminRouter(db) {
  const r = express.Router();

  /* ---------- 会员查询 ---------- */
  r.get('/members', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return mw.fail(res, 400, 'query_too_short', 'Enter at least 2 characters of an email.');
    const rows = db.prepare(
      `SELECT id, email_normalized, family_id, family_role FROM users
       WHERE email_normalized LIKE ? AND family_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 20`
    ).all(q + '%');
    const seen = new Set();
    const families = [];
    for (const u of rows) {
      if (seen.has(u.family_id)) continue;
      seen.add(u.family_id);
      families.push({
        familyId: u.family_id,
        membership: family.membershipSummary(db, u.family_id),
        parents: db.prepare(
          'SELECT id, email_normalized AS email, family_role AS role FROM users WHERE family_id = ? ORDER BY id'
        ).all(u.family_id)
      });
    }
    mw.ok(res, { families });
  });

  r.get('/members/:familyId', (req, res) => {
    const fid = Number(req.params.familyId);
    const exists = db.prepare('SELECT 1 FROM families WHERE id = ?').get(fid);
    if (!exists) return mw.fail(res, 404, 'family_not_found', 'No such family.');
    const summary = family.familySummary(db, fid);
    const entitlements = listActiveEntitlements(db, fid).map(e => ({
      featureKey: e.feature_key, sourceType: e.source_type, sourceId: e.source_id,
      startsAt: e.starts_at, expiresAt: e.expires_at
    }));
    // 含已撤销/已过期行，便于排查（管理端可见全量）
    const allRows = db.prepare(
      `SELECT feature_key, source_type, source_id, starts_at, expires_at, revoked_at
       FROM entitlements WHERE family_id = ? ORDER BY id`
    ).all(fid);
    const orders = orderStore.listFamilyOrders(db, fid, 50);
    mw.ok(res, { family: summary, membership: family.membershipSummary(db, fid), entitlements, entitlementHistory: allRows, orders });
  });

  /* ---------- 手动授予 / 撤销 ---------- */
  r.post('/grant', mw.rateLimit(MUTATE_LIMIT), mw.csrfProtect, (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const sku = String((req.body && req.body.sku) || '');
    if (!SKUS[sku]) return mw.fail(res, 400, 'invalid_sku', 'Unknown plan.');
    const user = db.prepare('SELECT id, family_id FROM users WHERE email_normalized = ?').get(email);
    if (!user) return mw.fail(res, 404, 'user_not_found', 'No account with that email.');
    const familyId = user.family_id || family.ensureFamilyForUser(db, user.id);
    const out = grantSkuToFamily(db, {
      familyId, userId: user.id, sku,
      sourceId: 'admin:' + req.user.id + ':' + Date.now()
    });
    mw.ok(res, { email, familyId, ...out, membership: family.membershipSummary(db, familyId) });
  });

  r.post('/revoke', mw.rateLimit(MUTATE_LIMIT), mw.csrfProtect, (req, res) => {
    const familyId = Number(req.body && req.body.familyId);
    const sourceType = String((req.body && req.body.sourceType) || '');
    const sourceId = req.body ? req.body.sourceId : undefined;
    if (!familyId || !['order', 'redeem', 'grant', 'promo'].includes(sourceType)) {
      return mw.fail(res, 400, 'invalid_request', 'familyId and sourceType are required.');
    }
    if (!db.prepare('SELECT 1 FROM families WHERE id = ?').get(familyId)) {
      return mw.fail(res, 404, 'family_not_found', 'No such family.');
    }
    const n = revokeFamilySource(db, familyId, sourceType, sourceId === '' ? null : sourceId);
    mw.ok(res, { revoked: n, membership: family.membershipSummary(db, familyId) });
  });

  /* ---------- 优惠码 ---------- */
  r.post('/codes', mw.rateLimit(MUTATE_LIMIT), mw.csrfProtect, (req, res) => {
    const sku = String((req.body && req.body.sku) || '');
    const count = req.body ? req.body.count : undefined;
    const expiresInDays = req.body ? Number(req.body.expiresInDays) : null;
    const note = req.body ? String(req.body.note || '').slice(0, 200) : '';
    let out;
    try {
      out = redeem.createCodes(db, {
        sku, count,
        expiresInDays: Number.isFinite(expiresInDays) && expiresInDays > 0 ? expiresInDays : null,
        note, adminUserId: req.user.id
      });
    } catch (e) {
      return mw.fail(res, 400, e.code || 'invalid_request', e.message);
    }
    mw.ok(res, { codes: out.codes, expiresAt: out.expiresAt, sku });
  });

  r.get('/codes', (req, res) => {
    mw.ok(res, { codes: redeem.listCodes(db, req.query.limit) });
  });

  r.post('/codes/:id/revoke', mw.rateLimit(MUTATE_LIMIT), mw.csrfProtect, (req, res) => {
    const ok = redeem.revokeCode(db, Number(req.params.id));
    if (!ok) return mw.fail(res, 409, 'code_not_revocable', 'Code is used or missing.');
    mw.ok(res, { revoked: true });
  });

  return r;
}

/* 家长侧兑换（挂载为 POST /api/redeem）：限流 + CSRF，事务占用并开通 */
function buildRedeemHandler(db) {
  const limit = mw.rateLimit({
    windowMs: 60 * 60 * 1000, max: 10,
    keyFn: q => 'u' + q.user.id, name: 'redeem'
  });
  return [limit, mw.csrfProtect, (req, res) => {
    const code = req.body ? req.body.code : '';
    try {
      const out = redeem.redeemCode(db, { code, familyId: req.familyId, userId: req.user.id });
      return mw.ok(res, { ...out, membership: family.membershipSummary(db, req.familyId) });
    } catch (e) {
      return mw.fail(res, e.code === 'code_not_found' || e.code === 'code_used' || e.code === 'code_expired'
        ? 400 : 500, e.code || 'internal', e.message);
    }
  }];
}

module.exports = { buildAdminRouter, buildRedeemHandler };
