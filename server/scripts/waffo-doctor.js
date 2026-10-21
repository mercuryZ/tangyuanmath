#!/usr/bin/env node
/* Waffo 配置诊断（不打印私钥）
 *
 *   node scripts/waffo-doctor.js          只检查环境变量与商品 ID 是否齐全
 *   node scripts/waffo-doctor.js --api    额外调用 Waffo API，验证密钥/店铺/商品/价格
 *
 * 本地使用生产配置：
 *   node --env-file=../.env.production scripts/waffo-doctor.js --api
 * Render Shell：
 *   cd /opt/render/project/src/server && node scripts/waffo-doctor.js --api
 */
'use strict';

const config = require('../src/config');
const waffo = require('../src/waffo');

function printStatus() {
  const st = waffo.status();
  console.log('WAFFO_ENVIRONMENT = ' + st.environment + '  (input: ' + st.environmentInput + ')');
  console.log('Merchant ID       = ' + (st.merchantId || '(missing)'));
  console.log('Store ID          = ' + (st.storeId || '(missing)'));
  console.log('Private key       = ' + (st.privateKeyPresent
    ? (st.privateKeyValid ? 'present, parse OK' : 'present, PARSE FAILED')
    : 'MISSING'));
  for (const [sku, p] of Object.entries(st.products)) {
    console.log('  ' + sku.padEnd(20) + ' ' + (p.productId || '(missing product ID)') +
      (p.configured ? '  [ready]' : '  [NOT READY]'));
  }
  const total = Object.keys(st.products).length;
  const ready = Object.values(st.products).filter(p => p.configured).length;
  console.log('Checkout ready    = ' + ready + '/' + total +
    (ready === total ? ' (all plans)' : ready > 0 ? ' (some plans)' : ' (NO)'));
  return st;
}

async function checkApi(st) {
  if (!waffo.isConfigured()) {
    console.log('\n[api] skipped: private key / merchant ID / store ID is missing');
    return false;
  }
  console.log('\n[api] calling Waffo with the current environment/key ...');
  let data;
  try {
    data = await waffo.listProducts();
  } catch (err) {
    console.error('[api] FAILED: ' + (err && err.message ? err.message : err));
    if (err && err.status) console.error('[api] HTTP status: ' + err.status);
    if (err && err.errors) console.error('[api] ' + JSON.stringify(err.errors, null, 2));
    return false;
  }

  const rows = [];
  for (const p of data.onetimeProducts || []) rows.push({ id: p.id, type: 'onetime', name: p.name, prices: p.prices, status: p.status });
  for (const p of data.subscriptionProducts || []) rows.push({ id: p.id, type: 'subscription', name: p.name, prices: p.prices, status: p.status });
  console.log('[api] OK — ' + rows.length + ' product(s) visible to this key/environment:');
  const byId = new Map();
  for (const row of rows) {
    const price = (row.prices || []).find(x => x.currency === waffo.CURRENCY);
    const amount = price && price.priceInfo ? price.priceInfo.amount : null;
    byId.set(row.id, amount);
    console.log('  ' + row.type.padEnd(12) + ' ' + row.id.padEnd(28) + ' ' +
      (amount || '?').padStart(8) + ' ' + waffo.CURRENCY + '  ' + (row.status || '') + '  ' + row.name);
  }

  let ok = true;
  for (const [sku, p] of Object.entries(st.products)) {
    if (!p.productId) { ok = false; continue; }
    const expected = waffo.minorToDisplay(waffo.SKUS[sku].amountMinor);
    if (!byId.has(p.productId)) {
      console.warn('[api] WARNING: ' + sku + ' product ID ' + p.productId + ' is not visible in this environment');
      ok = false;
    } else if (byId.get(p.productId) !== expected) {
      console.warn('[api] WARNING: ' + sku + ' price is ' + (byId.get(p.productId) || 'unknown') +
        ', expected ' + expected + ' — update/publish the product in Waffo');
      ok = false;
    }
  }
  return ok;
}

async function main() {
  const st = printStatus();
  let ok = st.privateKeyValid && st.merchantId && st.storeId &&
    Object.values(st.products).every(p => p.configured);
  if (process.argv.includes('--api')) {
    ok = (await checkApi(st)) && ok;
  }
  console.log('\n' + (ok ? 'RESULT: Waffo looks ready.' : 'RESULT: configuration is incomplete — see warnings above.'));
  if (!ok) process.exitCode = 1;
}

main().catch(err => {
  console.error('doctor failed: ' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
