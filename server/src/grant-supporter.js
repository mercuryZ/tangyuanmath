/* 管理脚本：授予/撤销 Supporter 权益（M2 支付渠道未接入期间的客服/内测通道）
 * 用法（在 server/ 目录）：
 *   node src/grant-supporter.js <email>           # 授予 Supporter 全部权益（source_type='grant'）
 *   node src/grant-supporter.js <email> --revoke  # 撤销该账号所有 grant 来源的权益
 * 不是 HTTP 接口：只有能登录服务器的运营人员可执行。
 */
'use strict';

const config = require('./config');
const { initDb } = require('./db');
const { normalizeEmail } = require('./util');
const { SUPPORTER_FEATURES, grantEntitlement, revokeBySource, activeFeatureKeys } = require('./entitlements');

function main() {
  const [emailArg, flag] = process.argv.slice(2);
  if (!emailArg || (flag && flag !== '--revoke')) {
    console.log('Usage: node src/grant-supporter.js <email> [--revoke]');
    process.exit(2);
  }
  const email = normalizeEmail(emailArg);
  const db = initDb(config.dbFile);
  const user = db.prepare('SELECT id FROM users WHERE email_normalized = ?').get(email);
  if (!user) {
    console.log(`No account found for ${email}`);
    process.exit(1);
  }
  if (flag === '--revoke') {
    const n = revokeBySource(db, user.id, 'grant');
    console.log(`Revoked ${n} grant-source entitlement(s) for ${email}.`);
  } else {
    for (const key of SUPPORTER_FEATURES) grantEntitlement(db, {
      userId: user.id, featureKey: key, sourceType: 'grant', sourceId: 'cli'
    });
    console.log(`Granted ${SUPPORTER_FEATURES.join(', ')} to ${email}.`);
  }
  console.log('Active entitlements:', activeFeatureKeys(db, user.id).join(', ') || '(none)');
}

main();
