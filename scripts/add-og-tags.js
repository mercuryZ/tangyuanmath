/* 批量脚本：给 public/ 下公开静态页注入 Open Graph + Twitter Card 元信息。
 * - OG 段：og:title/og:description 取页面 <title> 与 meta description，og:url 取 canonical；
 *   /blog/ 下的文章页 og:type=article，其余 website；og:locale 按路径 zh→zh_CN，其余 en_US。
 * - og:image 统一 /img/tangyuan_web.png（480×480，社交分享卡片）。
 * - Twitter 段：summary_large_image + 标题/描述/图（三个首页已有 OG，只补 Twitter 段）。
 * 可重复运行：已存在对应段则跳过。用法：node scripts/add-og-tags.js [--check]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public');
const SITE = 'https://tangyuanmath.com';
const OG_IMAGE = SITE + '/img/tangyuan_web.png';
const CHECK_ONLY = process.argv.includes('--check');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/* 属性值转义：双引号必须转，& 优先转避免二次转义 */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function meta(pattern, html) {
  const m = html.match(pattern);
  return m ? m[1].trim() : null;
}

let ogAdded = 0, twAdded = 0, skipped = 0;
const report = [];

for (const file of walk(ROOT, [])) {
  const html = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (rel.startsWith('account/') || rel.startsWith('admin/')) { skipped++; continue; }

  const title = meta(/<title>([^<]*)<\/title>/, html);
  const desc = meta(/<meta name="description" content="([^"]*)">/, html);
  const canonical = meta(/<link rel="canonical" href="([^"]*)">/, html);
  if (!title || !desc) { skipped++; report.push('  ! 缺 title/description: ' + rel); continue; }

  const isArticle = /^en\/blog\/[^/]+\/index\.html$/.test(rel) || /^zh\/blog\/[^/]+\/index\.html$/.test(rel);
  const locale = rel.startsWith('zh/') ? 'zh_CN' : 'en_US';

  let next = html;
  const added = [];

  if (!next.includes('property="og:title"')) {
    const lines = [
      '<meta property="og:title" content="' + esc(title) + '">',
      '<meta property="og:description" content="' + esc(desc) + '">',
      '<meta property="og:type" content="' + (isArticle ? 'article' : 'website') + '">'
    ];
    if (canonical) lines.push('<meta property="og:url" content="' + esc(canonical) + '">');
    lines.push(
      '<meta property="og:site_name" content="Tangyuan Math">',
      '<meta property="og:locale" content="' + locale + '">',
      '<meta property="og:image" content="' + OG_IMAGE + '">',
      '<meta property="og:image:width" content="480">',
      '<meta property="og:image:height" content="480">'
    );
    next = next.replace('</head>', lines.join('\n') + '\n</head>');
    ogAdded++; added.push('og');
  }

  if (!next.includes('name="twitter:card"')) {
    const lines = [
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:title" content="' + esc(title) + '">',
      '<meta name="twitter:description" content="' + esc(desc) + '">',
      '<meta name="twitter:image" content="' + OG_IMAGE + '">'
    ];
    next = next.replace('</head>', lines.join('\n') + '\n</head>');
    twAdded++; added.push('twitter');
  }

  if (next !== html) {
    report.push('  + ' + rel + (added.length ? ' (' + added.join(' + ') + ')' : ''));
    if (!CHECK_ONLY) fs.writeFileSync(file, next);
  } else {
    skipped++;
  }
}

console.log((CHECK_ONLY ? '[check] OG 注入 ' : 'OG 已注入 ') + ogAdded + ' 页，Twitter 补齐 ' + twAdded + ' 页，跳过 ' + skipped + ' 页');
if (CHECK_ONLY) console.log(report.join('\n'));
