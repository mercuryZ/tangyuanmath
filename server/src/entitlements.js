/* 权益查询与授予（DESIGN §6、§8.2）
 * 会员权益以 entitlements 表为准（不使用 users.plan）；
 * 判断「当前有效」= starts_at ≤ now 且（expires_at 为空或 > now）且 revoked_at 为空。
 */
'use strict';

/* Supporter Edition 覆盖的权益键（DESIGN 8.2 权益矩阵） */
const SUPPORTER_FEATURES = ['pdf_worksheet', 'celebration_image'];

const ACTIVE_SQL = `
  SELECT id, feature_key, source_type, source_id, starts_at, expires_at, revoked_at
  FROM entitlements
  WHERE user_id = ?
    AND starts_at <= ?
    AND (expires_at IS NULL OR expires_at > ?)
    AND revoked_at IS NULL
  ORDER BY feature_key, id`;

function listActiveEntitlements(db, userId, now) {
  const t = now === undefined ? Date.now() : now;
  return db.prepare(ACTIVE_SQL).all(userId, t, t);
}

/* 去重后的有效权益键列表，供 /api/me 与前端徽章使用 */
function activeFeatureKeys(db, userId, now) {
  const seen = new Set();
  for (const row of listActiveEntitlements(db, userId, now)) seen.add(row.feature_key);
  return [...seen].sort();
}

function hasEntitlement(db, userId, featureKey, now) {
  return activeFeatureKeys(db, userId, now).includes(featureKey);
}

/* 授予权益；source_type='grant' 用于管理员/内测脚本，'order'/'redeem' 留给支付轮 */
function grantEntitlement(db, { userId, featureKey, sourceType = 'grant', sourceId = null, startsAt = Date.now(), ttlMs = null }) {
  const expiresAt = ttlMs === null ? null : startsAt + ttlMs;
  const info = db.prepare(
    `INSERT INTO entitlements (user_id, feature_key, source_type, source_id, starts_at, expires_at)
     VALUES (?,?,?,?,?,?)`
  ).run(userId, featureKey, sourceType, sourceId, startsAt, expiresAt);
  return info.lastInsertRowid;
}

/* 撤销某来源授予且仍有效的权益；返回撤销条数 */
function revokeBySource(db, userId, sourceType) {
  const info = db.prepare(
    `UPDATE entitlements SET revoked_at = ?
     WHERE user_id = ? AND source_type = ? AND revoked_at IS NULL`
  ).run(Date.now(), userId, sourceType);
  return info.changes;
}

module.exports = {
  SUPPORTER_FEATURES,
  listActiveEntitlements,
  activeFeatureKeys,
  hasEntitlement,
  grantEntitlement,
  revokeBySource
};
