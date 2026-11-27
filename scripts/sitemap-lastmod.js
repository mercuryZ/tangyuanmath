/* 批量脚本：给 sitemap.xml 的每个 <url> 写 <lastmod>。
 * - 默认按 git 每个文件最后一次提交日期（--from-git 行为，也是默认）；
 *   没有提交记录的文件回退到今天。
 * - --date=YYYY-MM-DD 强制全部用同一天（大改版当天一次性刷新用）。
 * 幂等：已存在 lastmod 会更新为计算值。用法：node scripts/sitemap-lastmod.js [--date=YYYY-MM-DD]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', 'public');
const SITEMAP = path.join(ROOT, 'sitemap.xml');

const dateArg = process.argv.find(a => a.startsWith('--date='));
const forceDate = dateArg ? dateArg.split('=')[1] : null;
const today = new Date().toISOString().slice(0, 10);

/* loc → 本地文件（/ 与 /en/ 都对应 index.html，其余按路径找目录下的 index.html） */
function locToFile(loc) {
  let p = loc.replace(/^https:\/\/tangyuanmath\.com/, '');
  if (p === '' || p === '/') return 'index.html';
  p = p.replace(/\/$/, '');
  return p + '/index.html';
}

function gitDate(relFile) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', relFile], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8'
    }).trim() || today;
  } catch { return today; }
}

let xml = fs.readFileSync(SITEMAP, 'utf8');
let updated = 0, added = 0;

xml = xml.replace(/<url>([\s\S]*?)<\/url>/g, (block, inner) => {
  const loc = (inner.match(/<loc>([^<]*)<\/loc>/) || [])[1];
  if (!loc) return block;
  const d = forceDate || gitDate(locToFile(loc));
  if (inner.includes('<lastmod>')) {
    updated++;
    return block.replace(/<lastmod>[^<]*<\/lastmod>/, '<lastmod>' + d + '</lastmod>');
  }
  updated++;
  return block.replace(/<\/url>/, '  <lastmod>' + d + '</lastmod>\n</url>');
});

fs.writeFileSync(SITEMAP, xml);
console.log('lastmod 已写入 ' + updated + ' 条' + (forceDate ? '（统一 ' + forceDate + '）' : '（按 git 提交日期）'));
