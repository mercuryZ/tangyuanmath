/* 管理脚本：授予/撤销家庭成员权益（M2 支付渠道未接入期间的客服/内测通道）
 * 用法（在 server/ 目录）：
 *   node src/grant-supporter.js <email>                 # 授予全部 Supporter 权益（永久 grant）
 *   node src/grant-supporter.js <email> --months 3      # 授予 3 个自然月
 *   node src/grant-supporter.js <email> --revoke        # 撤销该家庭所有 grant 来源权益
 * 不是 HTTP 接口：只有能登录服务器的运营人员可执行。
 */
'use strict';

const config = require('./config');
const { initDb } = require('./db');
const { normalizeEmail } = require('./util');
const {
  SUPPORTER_FEATURES, grantFamilyEntitlement, revokeFamilySource, activeFamilyFeatureKeys
} = require('./entitlements');
const family = require('./family');

function main() {
  const args = process.argv.slice(2);
  const emailArg = args[0];
  const revoke = args.includes('--revoke');
  const monthsIdx = args.indexOf('--months');
  const months = monthsIdx >= 0 ? Number(args[monthsIdx + 1]) : null;
  if (!emailArg || (monthsIdx >= 0 && (!Number.isFinite(months) || months <= 0))) {
    console.log('Usage: node src/grant-supporter.js <email> [--months N] [--revoke]');
    process.exit(2);
  }
  const email = normalizeEmail(emailArg);
  const db = initDb(config.dbFile);
  const user = db.prepare('SELECT id, family_id FROM users WHERE email_normalized = ?').get(email);
  if (!user) {
    console.log(`No account found for ${email}`);
    process.exit(1);
  }
  const familyId = user.family_id || family.ensureFamilyForUser(db, user.id);
  if (revoke) {
    const n = revokeFamilySource(db, familyId, 'grant');
    console.log(`Revoked ${n} grant-source entitlement(s) for the family of ${email}.`);
  } else {
    const now = Date.now();
    const expiresAt = months ? family.addCalendarMonths(now, months) : undefined;
    let granted = 0;
    const tx = db.transaction(() => {
      for (const key of SUPPORTER_FEATURES) {
        granted += grantFamilyEntitlement(db, {
          familyId, userId: user.id, featureKey: key, sourceType: 'grant',
          sourceId: 'cli', startsAt: now, expiresAt
        });
      }
    });
    tx();
    console.log(`Granted ${granted}/${SUPPORTER_FEATURES.length} entitlement(s) to the family of ${email}.`);
  }
  console.log('Active entitlements:', activeFamilyFeatureKeys(db, familyId).join(', ') || '(none)');
}

main();
