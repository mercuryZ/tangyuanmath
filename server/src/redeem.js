/* 优惠码（DESIGN §6 redeem_codes、§7.1 POST /api/redeem）
 * - 明文码只在创建响应里出现一次，库存只存 sha256 哈希（hashToken，与 sessions/invites 同一套）；
 * - 单次使用：占用用带条件的 UPDATE 改动行数保证并发安全；
 * - 兑换时长与 SKU 语义一致（trial7→+3天 / monthly→+1自然月 / yearly→+12自然月 / lifetime→永久），
 *   与现有权益自然叠加（不同来源的有效权益取并集，会员到期取决于最晚一条）。
 */
'use strict';

const crypto = require('node:crypto');

const { SUPPORTER_FEATURES, grantFamilyEntitlement } = require('./entitlements');
const { SKUS } = require('./waffo');
const { addCalendarMonths } = require('./family');
const { hashToken } = require('./util');
const { encryptCode, decryptCode } = require('./code-crypto');

/* 生成可读码：TM-XXXXX-XXXXX（14 位，≤15 位），去掉易混的 0/O/1/I。
 * 旧版 TANGYUAN-XXXXX-XXXXX 仍可兑换，避免已发出的码失效。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateCode() {
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return 'TM-' + s.slice(0, 5) + '-' + s.slice(5);
}

function normalizeCode(input) {
  return String(input == null ? '' : input).trim().toUpperCase().replace(/\s+/g, '');
}

/* SKU → 兑换到期时间（从 now 起算） */
function expiryForSku(sku, now) {
  const spec = SKUS[sku];
  if (!spec) throw new Error('unknown sku: ' + sku);
  if (spec.trialDays) return now + spec.trialDays * 24 * 3600 * 1000;
  if (spec.months) return addCalendarMonths(now, spec.months);
  return null; // lifetime
}

/* 批量创建。返回 { codes: 明文数组（仅此一次）, expiresAt } */
function createCodes(db, { sku, count, expiresInDays, note, adminUserId, now }) {
  if (!SKUS[sku]) throw Object.assign(new Error('Unknown plan.'), { code: 'invalid_sku' });
  const n = Math.floor(Number(count));
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw Object.assign(new Error('count must be 1-100.'), { code: 'invalid_count' });
  }
  const t = now === undefined ? Date.now() : now;
  const expiresAt = expiresInDays ? t + expiresInDays * 24 * 3600 * 1000 : null;
  const insert = db.prepare(
    `INSERT INTO redeem_codes (code_hash, code_enc, sku, note, created_by, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`
  );
  const codes = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const code = generateCode();
      insert.run(hashToken(code), encryptCode(code), sku, note || null, adminUserId || null, t, expiresAt);
      codes.push(code);
    }
  });
  tx();
  return { codes, expiresAt };
}

/* 兑换：占用码 + 开通权益，整体事务。失败抛 {code} 错误。 */
function redeemCode(db, { code, familyId, userId, now }) {
  const normalized = normalizeCode(code);
  if (!/^(TANGYUAN|TM)-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(normalized)) {
    throw Object.assign(new Error('Invalid code format.'), { code: 'code_not_found' });
  }
  const t = now === undefined ? Date.now() : now;
  const row = db.prepare('SELECT * FROM redeem_codes WHERE code_hash = ?').get(hashToken(normalized));
  if (!row) throw Object.assign(new Error('Code not found.'), { code: 'code_not_found' });
  if (row.used_at) throw Object.assign(new Error('Code already used.'), { code: 'code_used' });
  if (row.expires_at !== null && row.expires_at <= t) {
    throw Object.assign(new Error('Code expired.'), { code: 'code_expired' });
  }

  const expiresAt = expiryForSku(row.sku, t);
  const claim = db.prepare(
    'UPDATE redeem_codes SET used_family_id = ?, used_by = ?, used_at = ? WHERE id = ? AND used_at IS NULL'
  );
  const grant = db.prepare(
    `INSERT OR IGNORE INTO entitlements
       (family_id, user_id, feature_key, source_type, source_id, starts_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`
  );
  const tx = db.transaction(() => {
    const claimed = claim.run(familyId, userId || null, t, row.id).changes;
    if (claimed !== 1) throw Object.assign(new Error('Code already used.'), { code: 'code_used' });
    for (const featureKey of SUPPORTER_FEATURES) {
      grant.run(familyId, userId || null, featureKey, 'redeem', 'code:' + row.id, t, expiresAt);
    }
  });
  tx();
  return { sku: row.sku, expiresAt };
}

/* 管理端列表：返回元数据、哈希前缀，以及可逆解密后的完整激活码（旧码无密文时为 null）。 */
function listCodes(db, limit) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = db.prepare(
    `SELECT c.id, c.sku, c.note, c.created_at AS createdAt, c.expires_at AS expiresAt,
            c.used_at AS usedAt,
            su.email_normalized AS usedByEmail,
            substr(c.code_hash, 1, 8) AS hashPrefix,
            c.code_enc AS codeEnc
     FROM redeem_codes c
     LEFT JOIN users su ON su.id = c.used_by
     ORDER BY c.created_at DESC, c.id DESC LIMIT ?`
  ).all(n);
  return rows.map(row => {
    let code = null;
    if (row.codeEnc) {
      try { code = decryptCode(row.codeEnc); }
      catch (e) { console.error('[redeem] code decrypt failed for id ' + row.id); }
    }
    const { codeEnc, ...rest } = row;
    return { ...rest, code };
  });
}

/* 禁用未使用的码（软禁用：置过期时间为当前时刻） */
function revokeCode(db, id, now) {
  const t = now === undefined ? Date.now() : now;
  const info = db.prepare(
    'UPDATE redeem_codes SET expires_at = ? WHERE id = ? AND used_at IS NULL'
  ).run(t, id);
  return info.changes === 1;
}

module.exports = { createCodes, redeemCode, listCodes, revokeCode, expiryForSku, normalizeCode };
