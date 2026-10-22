/* 一次性脚本：生成提交进仓库的「免费样张」PDF（DESIGN 9.2 固定示例，人人可下载）。
 * 在 server/ 目录运行：node scripts/make-samples.js
 * 样张与 Supporter 自定义生成的区别在 /en|zh/worksheets/ 页面上明确标注。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { renderWorksheetPdf, renderMultiplicationTablePdf } = require('../src/pdf');
const config = require('../src/config');

const SAMPLES = [
  { kind: 'table', locale: 'en', paper: 'letter', file: 'multiplication-table-1-9-letter-landscape.pdf' },
  { kind: 'worksheet', locale: 'en', difficulty: 'two_by_one', count: 20, paper: 'a4', file: 'two-digit-by-one-digit-a4.pdf' },
  { kind: 'table', locale: 'zh', paper: 'letter', file: 'multiplication-table-1-9-letter-landscape.pdf' },
  { kind: 'worksheet', locale: 'zh', difficulty: 'two_by_one', count: 20, paper: 'a4', file: 'two-digit-by-one-digit-a4.pdf' }
];

(async () => {
  for (const s of SAMPLES) {
    const out = s.kind === 'table'
      ? await renderMultiplicationTablePdf({ locale: s.locale, paper: s.paper })
      : await renderWorksheetPdf({
        locale: s.locale, difficulty: s.difficulty, count: s.count, paper: s.paper, answers: 1
      });
    const dir = path.resolve(__dirname, '..', '..', 'public', s.locale, 'worksheets', 'samples');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, s.file), Buffer.from(out.bytes));
    console.log(`${s.locale}/${s.file}: ${out.pageCount} pages, ${out.bytes.length} bytes`);
  }
})().catch(e => { console.error(e); process.exit(1); });
