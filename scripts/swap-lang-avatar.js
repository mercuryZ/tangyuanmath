/* 批量脚本：头部导航里「语言按钮」与「家长中心（头像）」交换位置，并把语言按钮
 * 从纯文字胶囊（中文/EN）改成地球图标 + 目标语言名（桌面只显示图标，移动抽屉带文字）。
 * 未来加新语言时，只需把这个链接升级成下拉，图标入口不变。
 * 同时把 site.css 版本号升到 20261127b（配合 site.css 里的新样式）。
 * 可重复运行：已交换过的页面会因匹配不到旧模式而跳过。用法：node scripts/swap-lang-avatar.js [--check]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public');
const CHECK_ONLY = process.argv.includes('--check');
const CSS_OLD = 'site.css?v=20261127a';
const CSS_NEW = 'site.css?v=20261127b';

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/* 头部里的相邻两行：<a href="/account/">…</a> 换行缩进 <a class="lang-switch" …>文字</a>。
 * 页脚的中文/EN 链接没有 lang-switch 类，不会被匹配。捕获组：
 * 1=账号行缩进 2=账号锚点 3=语言行缩进 4=整个旧语言锚点 5~8=href/hreflang/lang/文字 */
const PAIR_RE = /^([ \t]*)(<a href="\/account\/">[^<]*<\/a>)\n([ \t]*)(<a class="lang-switch" href="([^"]*)" hreflang="([^"]*)" lang="([^"]*)">([^<]*)<\/a>)/m;

/* 修复历史版本脚本的错位产物：旧锚点和新锚点连在一行（行首无缩进），
 * 形如 <a class="lang-switch" …旧…></a><a class="lang-switch" …新含图标…></a>。
 * 6=下一行账号链接的缩进（与语言行原缩进相同），用它把两行都缩回去。 */
const BROKEN_RE = /^<a class="lang-switch" href="([^"]*)" hreflang="([^"]*)" lang="([^"]*)">([^<]*)<\/a>(<a class="lang-switch" href="\1" hreflang="\2" lang="\3" aria-label="\4" title="\4"><svg class="ico" aria-hidden="true"><use href="\/img\/icons\.svg#ico-globe"\/><\/svg><span class="lang-name">\4<\/span><\/a>)\n([ \t]*)(<a href="\/account\/">[^<]*<\/a>)/m;

function swap(html) {
  return html.replace(PAIR_RE, (m, ind1, accountTag, ind2, _old, href, hreflang, lang, text) => {
    const langTag =
      `<a class="lang-switch" href="${href}" hreflang="${hreflang}" lang="${lang}" aria-label="${text}" title="${text}">` +
      `<svg class="ico" aria-hidden="true"><use href="/img/icons.svg#ico-globe"/></svg>` +
      `<span class="lang-name">${text}</span></a>`;
    return `${ind2}${langTag}\n${ind1}${accountTag}`;
  });
}

function repair(html) {
  return html.replace(BROKEN_RE, (m, _h, _hl, _l, _t, newTag, ind, accountTag) =>
    `${ind}${newTag}\n${ind}${accountTag}`);
}

const files = walk(ROOT, []);
let swapped = 0;
let repaired = 0;
let versioned = 0;
const problems = [];

for (const file of files) {
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  let touched = false;

  if (BROKEN_RE.test(after)) {
    after = repair(after);
    repaired++;
    touched = true;
  }

  if (after.includes('class="lang-switch"') && PAIR_RE.test(after)) {
    after = swap(after);
    swapped++;
    touched = true;
  } else if (after.includes('class="lang-switch"') && !after.includes('lang-name')) {
    problems.push(path.relative(ROOT, file) + '：有 lang-switch 但没匹配到相邻的 /account/ 链接');
  }

  if (after.includes(CSS_OLD)) {
    after = after.split(CSS_OLD).join(CSS_NEW);
    touched = true;
    versioned++;
  }

  if (touched && !CHECK_ONLY) fs.writeFileSync(file, after);
}

console.log(`页面总数：${files.length}`);
console.log(`修复错位行：${repaired} 个文件${CHECK_ONLY ? '（预览，未写入）' : ''}`);
console.log(`交换 语言按钮↔家长中心：${swapped} 个文件${CHECK_ONLY ? '（预览，未写入）' : ''}`);
console.log(`site.css 版本 ${CSS_OLD} → ${CSS_NEW}：${versioned} 个文件${CHECK_ONLY ? '（预览，未写入）' : ''}`);
if (problems.length) {
  console.log('需要人工检查：');
  for (const p of problems) console.log('  - ' + p);
}
