/* 权益查询与授予（DESIGN §6、§8.2）
 * 会员权益以 entitlements 表为准（不使用 users.plan）；
 * 权益按「家庭」计，同一家庭的两位家长与子女共享一份会员；
 * 判断「当前有效」= starts_at ≤ now 且（expires_at 为空或 > now）且 revoked_at 为空。
 */
'use strict';

/* Supporter Edition 覆盖的权益键（DESIGN 8.2 权益矩阵） */
const SUPPORTER_FEATURES = ['pdf_worksheet', 'celebration_image', 'live_race'];

const ACTIVE_SQL = `
  SELECT id, family_id, user_id, feature_key, source_type, source_id, starts_at, expires_at, revoked_at
  FROM entitlements
  WHERE family_id = ?
    AND starts_at <= ?
    AND (expires_at IS NULL OR expires_at > ?)
    AND revoked_at IS NULL
  ORDER BY feature_key, id`;

function listActiveEntitlements(db, familyId, now) {
  const t = now === undefined ? Date.now() : now;
  return db.prepare(ACTIVE_SQL).all(familyId, t, t);
}

/* 去重后的有效权益键列表，供 /api/me 与前端徽章使用 */
function activeFamilyFeatureKeys(db, familyId, now) {
  const seen = new Set();
  for (const row of listActiveEntitlements(db, familyId, now)) seen.add(row.feature_key);
  return [...seen].sort();
}

function hasFamilyEntitlement(db, familyId, featureKey, now) {
  return activeFamilyFeatureKeys(db, familyId, now).includes(featureKey);
}

/* 授予权益。source_type='grant' 用于管理员/内测脚本，'promo' 用于上线赠送，
 * 'order'/'redeem' 留给支付轮。
 * 带 source_id 的授予是幂等的：同一家庭 / 功能 / 来源只保留一条有效记录
 * （部分唯一索引 idx_entitlements_source）。 */
function grantFamilyEntitlement(db, {
  familyId, userId = null, featureKey, sourceType = 'grant', sourceId = null,
  startsAt = Date.now(), ttlMs = null, expiresAt
}) {
  const exp = expiresAt !== undefined ? expiresAt : (ttlMs === null ? null : startsAt + ttlMs);
  const info = db.prepare(
    `INSERT OR IGNORE INTO entitlements
       (family_id, user_id, feature_key, source_type, source_id, starts_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(familyId, userId, featureKey, sourceType, sourceId, startsAt, exp);
  return info.changes;
}

/* 撤销某家庭某来源授予且仍有效的权益；返回撤销条数 */
function revokeFamilySource(db, familyId, sourceType, sourceId) {
  if (sourceId === undefined || sourceId === null) {
    return db.prepare(
      `UPDATE entitlements SET revoked_at = ?
       WHERE family_id = ? AND source_type = ? AND revoked_at IS NULL`
    ).run(Date.now(), familyId, sourceType).changes;
  }
  return db.prepare(
    `UPDATE entitlements SET revoked_at = ?
     WHERE family_id = ? AND source_type = ? AND source_id = ? AND revoked_at IS NULL`
  ).run(Date.now(), familyId, sourceType, sourceId).changes;
}

module.exports = {
  SUPPORTER_FEATURES,
  listActiveEntitlements,
  activeFamilyFeatureKeys,
  hasFamilyEntitlement,
  grantFamilyEntitlement,
  revokeFamilySource
};
