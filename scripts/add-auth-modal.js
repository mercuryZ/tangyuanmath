/* 一次性脚本：给 public/ 下所有使用 site.css 的静态页注入悬浮登录框资源。
 * - <link rel="stylesheet" href="/css/auth-modal.css?v=…"> 放在 site.css 之后；
 * - <script src="/js/auth-modal.js?v=…" defer></script> 放在 header.js 之后（没有则放在 </body> 前）。
 * 可重复运行：已存在则跳过。用法：node scripts/add-auth-modal.js [--check]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public');
const CSS_TAG = '<link rel="stylesheet" href="/css/auth-modal.css?v=20261125a">';
const JS_TAG = '<script src="/js/auth-modal.js?v=20261125a" defer></script>';
const CHECK_ONLY = process.argv.includes('--check');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

let changed = 0;
let skipped = 0;
const report = [];

for (const file of walk(ROOT, [])) {
  let html = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  // 只处理公开站点页（有 site.css）；家长中心 / 管理后台用自己的页面
  const cssMatch = html.match(/<link rel="stylesheet" href="([^"]*site\.css[^"]*)">/);
  if (!cssMatch) { skipped++; continue; }

  let next = html;
  if (!next.includes('/css/auth-modal.css')) {
    // 插在 site.css 后面，保证变量与基础样式先生效
    next = next.replace(cssMatch[0], cssMatch[0] + '\n' + CSS_TAG);
  }
  if (!next.includes('/js/auth-modal.js')) {
    const headerScript = next.match(/<script src="([^"]*header\.js[^"]*)"[^>]*><\/script>/);
    if (headerScript) {
      next = next.replace(headerScript[0], headerScript[0] + '\n' + JS_TAG);
    } else {
      next = next.replace(/<\/body>/, JS_TAG + '\n</body>');
    }
  }

  if (next !== html) {
    changed++;
    report.push('  + ' + rel);
    if (!CHECK_ONLY) fs.writeFileSync(file, next);
  }
}

console.log((CHECK_ONLY ? '[check] 需要注入：' : '已注入：') + changed + ' 个文件，跳过 ' + skipped + ' 个');
if (CHECK_ONLY) console.log(report.join('\n'));
