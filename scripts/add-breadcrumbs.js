/* 全站注入 BreadcrumbList JSON-LD（步骤 4：结构化数据）。
 * 运行：node scripts/add-breadcrumbs.js
 *
 * 规则：
 * - 每个内容页一个 BreadcrumbList，@id 为「页面 URL + #breadcrumb」，保证各 URL 独立；
 * - 已含 BreadcrumbList 的页面跳过（新页面在生成时已自带），可重复运行（幂等）；
 * - 面包屑名称在此处显式维护（短名，不必与 <title> 一致），en 与 zh 各一套；
 * - 首页（/ 与 /en/ 与 /zh/）与 /play/（WebApplication 实体）不注面包屑。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const SITE = 'https://tangyuanmath.com';

/* 面包屑路径表：path（不含 /index.html）→ [{ name, url? }]，最后一项不带 url */
const TRAILS = {
  /* ---------- en ---------- */
  'en/about': [{ name: 'Home', url: `${SITE}/` }, { name: 'About' }],
  'en/pricing': [{ name: 'Home', url: `${SITE}/` }, { name: 'Pricing' }],
  'en/faq': [{ name: 'Home', url: `${SITE}/` }, { name: 'FAQ' }],
  'en/privacy': [{ name: 'Home', url: `${SITE}/` }, { name: 'Privacy Policy' }],
  'en/terms': [{ name: 'Home', url: `${SITE}/` }, { name: 'Terms of Service' }],
  'en/refund': [{ name: 'Home', url: `${SITE}/` }, { name: 'Refund Policy' }],
  'en/tips': [{ name: 'Home', url: `${SITE}/` }, { name: 'Math Tips' }],
  'en/worksheets': [{ name: 'Home', url: `${SITE}/` }, { name: 'Worksheets' }],
  'en/two-digit-multiplication': [{ name: 'Home', url: `${SITE}/` }, { name: 'Two-Digit Multiplication' }],
  'en/mistake-review': [{ name: 'Home', url: `${SITE}/` }, { name: 'Mistake Review' }],
  'en/blog': [{ name: 'Home', url: `${SITE}/` }, { name: 'Blog' }],
  'en/blog/history-of-mental-math': [{ name: 'Home', url: `${SITE}/` }, { name: 'Blog', url: `${SITE}/en/blog/` }, { name: 'The History of Mental Math' }],
  'en/blog/multiply-2-digit-by-3-digit': [{ name: 'Home', url: `${SITE}/` }, { name: 'Blog', url: `${SITE}/en/blog/` }, { name: 'How to Multiply 2-Digit by 3-Digit Numbers' }],
  'en/blog/playing-games-with-my-daughter': [{ name: 'Home', url: `${SITE}/` }, { name: 'Blog', url: `${SITE}/en/blog/` }, { name: 'Playing Games with My Daughter' }],
  'en/blog/rows-and-columns-in-arrays': [{ name: 'Home', url: `${SITE}/` }, { name: 'Blog', url: `${SITE}/en/blog/` }, { name: 'Rows and Columns in Arrays' }],
  'en/blog/what-is-repeated-addition': [{ name: 'Home', url: `${SITE}/` }, { name: 'Blog', url: `${SITE}/en/blog/` }, { name: 'What Is Repeated Addition?' }],
  'en/learn': [{ name: 'Home', url: `${SITE}/` }, { name: 'Learn' }],
  'en/learn/what-is-multiplication': [{ name: 'Home', url: `${SITE}/` }, { name: 'Learn', url: `${SITE}/en/learn/` }, { name: 'Lesson 1: What Is Multiplication?' }],
  'en/learn/arrays': [{ name: 'Home', url: `${SITE}/` }, { name: 'Learn', url: `${SITE}/en/learn/` }, { name: 'Lesson 2: Rows and Columns' }],
  'en/learn/skip-counting': [{ name: 'Home', url: `${SITE}/` }, { name: 'Learn', url: `${SITE}/en/learn/` }, { name: 'Lesson 3: Skip Counting' }],
  'en/learn/swap-rule': [{ name: 'Home', url: `${SITE}/` }, { name: 'Learn', url: `${SITE}/en/learn/` }, { name: 'Lesson 4: The Swap Trick' }],
  'en/learn/easy-facts': [{ name: 'Home', url: `${SITE}/` }, { name: 'Learn', url: `${SITE}/en/learn/` }, { name: 'Lesson 5: Free Wins' }],
  'en/learn/nines': [{ name: 'Home', url: `${SITE}/` }, { name: 'Learn', url: `${SITE}/en/learn/` }, { name: 'Lesson 6: The Nines Secret' }],
  'en/learn/break-apart': [{ name: 'Home', url: `${SITE}/` }, { name: 'Learn', url: `${SITE}/en/learn/` }, { name: 'Lesson 7: Break It Apart' }],
  'en/learn/you-know-more': [{ name: 'Home', url: `${SITE}/` }, { name: 'Learn', url: `${SITE}/en/learn/` }, { name: 'Lesson 8: You Know Most of It' }],
  'en/learn/teaching-plan': [{ name: 'Home', url: `${SITE}/` }, { name: 'Learn', url: `${SITE}/en/learn/` }, { name: 'Lesson 9: The Coaching Plan' }],
  'en/weekly-puzzle': [{ name: 'Home', url: `${SITE}/` }, { name: 'Weekly Puzzle' }],
  'en/weekly-puzzle/chicken-rabbit': [{ name: 'Home', url: `${SITE}/` }, { name: 'Weekly Puzzle', url: `${SITE}/en/weekly-puzzle/` }, { name: 'Puzzle #1: Heads and Legs' }],
  'en/weekly-puzzle/bikes-and-trikes': [{ name: 'Home', url: `${SITE}/` }, { name: 'Weekly Puzzle', url: `${SITE}/en/weekly-puzzle/` }, { name: 'Puzzle #2: Bikes and Trikes' }],

  /* ---------- zh ---------- */
  'zh/about': [{ name: '首页', url: `${SITE}/zh/` }, { name: '关于' }],
  'zh/pricing': [{ name: '首页', url: `${SITE}/zh/` }, { name: '定价' }],
  'zh/faq': [{ name: '首页', url: `${SITE}/zh/` }, { name: '常见问题' }],
  'zh/privacy': [{ name: '首页', url: `${SITE}/zh/` }, { name: '隐私政策' }],
  'zh/terms': [{ name: '首页', url: `${SITE}/zh/` }, { name: '服务条款' }],
  'zh/refund': [{ name: '首页', url: `${SITE}/zh/` }, { name: '退款政策' }],
  'zh/tips': [{ name: '首页', url: `${SITE}/zh/` }, { name: '速算秘籍' }],
  'zh/worksheets': [{ name: '首页', url: `${SITE}/zh/` }, { name: '练习卷' }],
  'zh/two-digit-multiplication': [{ name: '首页', url: `${SITE}/zh/` }, { name: '两位数乘法' }],
  'zh/mistake-review': [{ name: '首页', url: `${SITE}/zh/` }, { name: '错题复习' }],
  'zh/blog': [{ name: '首页', url: `${SITE}/zh/` }, { name: '博客' }],
  'zh/blog/history-of-mental-math': [{ name: '首页', url: `${SITE}/zh/` }, { name: '博客', url: `${SITE}/zh/blog/` }, { name: '速算的历史' }],
  'zh/blog/multiply-2-digit-by-3-digit': [{ name: '首页', url: `${SITE}/zh/` }, { name: '博客', url: `${SITE}/zh/blog/` }, { name: '两位数乘三位数' }],
  'zh/blog/playing-games-with-my-daughter': [{ name: '首页', url: `${SITE}/zh/` }, { name: '博客', url: `${SITE}/zh/blog/` }, { name: '陪女儿玩游戏，做出了汤圆数学' }],
  'zh/blog/rows-and-columns-in-arrays': [{ name: '首页', url: `${SITE}/zh/` }, { name: '博客', url: `${SITE}/zh/blog/` }, { name: '阵列里的行和列' }],
  'zh/blog/what-is-repeated-addition': [{ name: '首页', url: `${SITE}/zh/` }, { name: '博客', url: `${SITE}/zh/blog/` }, { name: '什么是重复加法' }],
  'zh/learn': [{ name: '首页', url: `${SITE}/zh/` }, { name: '启蒙课' }],
  'zh/learn/what-is-multiplication': [{ name: '首页', url: `${SITE}/zh/` }, { name: '启蒙课', url: `${SITE}/zh/learn/` }, { name: '第 1 节：乘法是什么' }],
  'zh/learn/arrays': [{ name: '首页', url: `${SITE}/zh/` }, { name: '启蒙课', url: `${SITE}/zh/learn/` }, { name: '第 2 节：行和列' }],
  'zh/learn/skip-counting': [{ name: '首页', url: `${SITE}/zh/` }, { name: '启蒙课', url: `${SITE}/zh/learn/` }, { name: '第 3 节：跳着数' }],
  'zh/learn/swap-rule': [{ name: '首页', url: `${SITE}/zh/` }, { name: '启蒙课', url: `${SITE}/zh/learn/` }, { name: '第 4 节：交换律' }],
  'zh/learn/easy-facts': [{ name: '首页', url: `${SITE}/zh/` }, { name: '启蒙课', url: `${SITE}/zh/learn/` }, { name: '第 5 节：免费胜利' }],
  'zh/learn/nines': [{ name: '首页', url: `${SITE}/zh/` }, { name: '启蒙课', url: `${SITE}/zh/learn/` }, { name: '第 6 节：9 的秘诀' }],
  'zh/learn/break-apart': [{ name: '首页', url: `${SITE}/zh/` }, { name: '启蒙课', url: `${SITE}/zh/learn/` }, { name: '第 7 节：拆数法' }],
  'zh/learn/you-know-more': [{ name: '首页', url: `${SITE}/zh/` }, { name: '启蒙课', url: `${SITE}/zh/learn/` }, { name: '第 8 节：只剩十句' }],
  'zh/learn/teaching-plan': [{ name: '首页', url: `${SITE}/zh/` }, { name: '启蒙课', url: `${SITE}/zh/learn/` }, { name: '第 9 节：陪练计划' }],
  'zh/weekly-puzzle': [{ name: '首页', url: `${SITE}/zh/` }, { name: '每周趣题' }],
  'zh/weekly-puzzle/chicken-rabbit': [{ name: '首页', url: `${SITE}/zh/` }, { name: '每周趣题', url: `${SITE}/zh/weekly-puzzle/` }, { name: '第 1 期：鸡兔同笼' }],
  'zh/weekly-puzzle/bikes-and-trikes': [{ name: '首页', url: `${SITE}/zh/` }, { name: '每周趣题', url: `${SITE}/zh/weekly-puzzle/` }, { name: '第 2 期：自行车与三轮车' }]
};

function breadcrumbLd(pagePath, trail) {
  const items = trail.map((t, i) => {
    const base = `{"@type": "ListItem", "position": ${i + 1}, "name": "${t.name}"`;
    return i < trail.length - 1 ? base + `, "item": "${t.url}"}` : base + '}';
  }).join(',\n    ');
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "@id": "${SITE}/${pagePath}/#breadcrumb",
  "itemListElement": [
    ${items}
  ]
}
</script>`;
}

let injected = 0, skipped = 0;
for (const [pagePath, trail] of Object.entries(TRAILS)) {
  const file = path.join(PUBLIC, pagePath, 'index.html');
  if (!fs.existsSync(file)) {
    console.warn(`MISSING: ${pagePath}`);
    continue;
  }
  let html = fs.readFileSync(file, 'utf8');
  if (html.includes('"@type": "BreadcrumbList"')) { skipped++; continue; }
  html = html.replace('</head>', breadcrumbLd(pagePath, trail) + '\n</head>');
  fs.writeFileSync(file, html);
  injected++;
}
console.log(`injected: ${injected}, already had breadcrumbs: ${skipped}`);
