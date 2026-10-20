#!/usr/bin/env node
/* Waffo Pancake 商品 / webhook 配置（一次性运维脚本）
 *
 *   node scripts/waffo-setup.js products          创建缺失的商品，打印商品 ID
 *   node scripts/waffo-setup.js list              列出店铺现有商品
 *   node scripts/waffo-setup.js webhook <URL>     注册 webhook（test/prod 由环境变量决定）
 *   node scripts/waffo-setup.js publish           把已配置的商品发布到生产环境
 *
 * 需要 WAFFO_PRIVATE_KEY（或 WAFFO_PRIVATE_KEY_BASE64）。商品默认创建在 test 环境；
 * 上线时用生产 API Key 再跑一次 products + publish，并把新的商品 ID 配到生产环境。
 */
'use strict';

const config = require('../src/config');
const waffo = require('../src/waffo');

function printProduct(prefix, p, kind) {
  const price = (p.prices || []).find(x => x.currency === waffo.CURRENCY);
  const amount = price && price.priceInfo ? price.priceInfo.amount : '?';
  console.log(`  ${kind.padEnd(12)} ${p.id.padEnd(28)} ${amount.padStart(8)} ${waffo.CURRENCY}  ${p.status || ''}  ${p.name}`);
  if (prefix) console.log(`    ${prefix}=${p.id}`);
}

function configuredIds() {
  return {
    supporter_monthly: config.waffoProductMonthly,
    supporter_yearly: config.waffoProductYearly,
    supporter_lifetime: config.waffoProductLifetime
  };
}

async function main() {
  const cmd = process.argv[2] || 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('用法：node scripts/waffo-setup.js [products|list|webhook <URL>|publish]');
    return;
  }
  if (!waffo.isConfigured()) {
    throw new Error('未配置 Waffo：请设置 WAFFO_PRIVATE_KEY（或 WAFFO_PRIVATE_KEY_BASE64）和 WAFFO_MERCHANT_ID');
  }
  console.log('环境：' + config.waffoEnvironment + '  店铺：' + config.waffoStoreId);

  if (cmd === 'products') {
    const result = await waffo.ensureProducts();
    for (const warning of result.warnings) console.warn('警告：' + warning);
    console.log(result.created.length
      ? '已创建：' + result.created.join(', ')
      : '三个商品都已存在，未创建新商品。');
    console.log('\n把下面几行加入服务端环境变量：');
    console.log('WAFFO_PRODUCT_MONTHLY=' + result.ids.supporter_monthly);
    console.log('WAFFO_PRODUCT_YEARLY=' + result.ids.supporter_yearly);
    console.log('WAFFO_PRODUCT_LIFETIME=' + result.ids.supporter_lifetime);
    return;
  }

  if (cmd === 'list') {
    const products = await waffo.listProducts();
    console.log('一次性商品：');
    for (const p of products.onetimeProducts || []) printProduct(null, p, 'onetime');
    console.log('订阅商品：');
    for (const p of products.subscriptionProducts || []) printProduct(null, p, 'subscription');
    return;
  }

  if (cmd === 'publish') {
    const ids = configuredIds();
    if (!ids.supporter_monthly || !ids.supporter_yearly || !ids.supporter_lifetime) {
      throw new Error('请先设置三个 WAFFO_PRODUCT_* 环境变量');
    }
    const published = await waffo.publishProducts(ids);
    console.log('已发布到生产环境：');
    for (const [sku, id] of Object.entries(published)) console.log('  ' + sku + ' -> ' + id);
    return;
  }

  if (cmd === 'webhook') {
    const url = process.argv[3];
    if (!url || !/^https?:\/\//.test(url)) {
      throw new Error('用法：node scripts/waffo-setup.js webhook https://your-domain/api/payments/waffo/webhook');
    }
    const webhook = await waffo.registerWebhook(url);
    console.log('已注册 webhook：' + webhook.id + '  testMode=' + webhook.testMode + '  url=' + webhook.url);
    console.log('事件：' + waffo.WEBHOOK_EVENTS.join(', '));
    console.log('提示：SDK 没有 list/remove 之外的查询入口；重复执行会创建重复的 webhook，跑一次即可。');
    return;
  }

  throw new Error('未知命令：' + cmd);
}

main().catch(err => {
  console.error('Waffo 配置失败：' + (err && err.message ? err.message : err));
  if (err && err.errors) console.error(JSON.stringify(err.errors, null, 2));
  process.exitCode = 1;
});
