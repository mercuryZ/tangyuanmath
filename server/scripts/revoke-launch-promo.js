#!/usr/bin/env node
/* 一次性清理：撤销历史「免费 3 个月」上线赠送（source_type='promo', source_id='launch-2026'）。
 *
 * 默认只统计，不修改数据：
 *   node scripts/revoke-launch-promo.js
 * 确认后执行：
 *   node scripts/revoke-launch-promo.js --yes
 *
 * 新注册已不再发放该权益；这个脚本只用于清掉旧数据库里剩余的赠送。
 * 撤销后家庭仍保留免费练习与全部学习数据，只是 Live Race / 自定义练习卷会锁定。
 */
'use strict';

const config = require('../src/config');
const { initDb } = require('../src/db');

const PROMO_SOURCE = 'launch-2026';
const db = initDb(config.dbFile);

const count = db.prepare(
  `SELECT COUNT(*) AS c, COUNT(DISTINCT family_id) AS families
   FROM entitlements
   WHERE source_type = 'promo' AND source_id = ? AND revoked_at IS NULL`
).get(PROMO_SOURCE);

console.log('数据库：' + config.dbFile);
console.log('待撤销：' + count.c + ' 条 promo 权益，涉及 ' + count.families + ' 个家庭');

if (!process.argv.includes('--yes')) {
  console.log('这是 dry run；确认后加 --yes 执行。');
  db.close();
  process.exit(0);
}

const result = db.prepare(
  `UPDATE entitlements SET revoked_at = ?
   WHERE source_type = 'promo' AND source_id = ? AND revoked_at IS NULL`
).run(Date.now(), PROMO_SOURCE);

console.log('已撤销 ' + result.changes + ' 条权益。');
db.close();
