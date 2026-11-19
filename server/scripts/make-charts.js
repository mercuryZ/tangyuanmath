/* 一次性脚本：生成 /en/multiplication-chart/ 页面挂载的「可打印乘法图表」PDF。
 * 在 server/ 目录运行：node scripts/make-charts.js
 * 两张图（1–12、1–100）× 三个版本（彩色 / 黑白 / 省墨）= 6 个文件，全部提交进仓库，
 * 与 make-samples.js 同理：固定样张人人可下载，不走 /api/pdf。
 * 英文专用（Helvetica 标准字体即可），不依赖 Noto 子集与 fontkit。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

/* 品牌色与线色：与站点 site.css 的 #AC3939 标题色一致 */
const RED = rgb(172 / 255, 57 / 255, 57 / 255);
const INK = rgb(0.18, 0.18, 0.18);
const GRAY = rgb(0.45, 0.45, 0.45);

/* 三个版本的视觉规格：color 有浅色底纹与吉祥物；bw 纯黑线框；ink 细灰线、最省墨 */
const VARIANTS = {
  color: {
    line: rgb(0.87, 0.72, 0.70), lineW: 0.8,
    headFill: rgb(0.965, 0.885, 0.875), headText: RED,
    sqFill: rgb(0.985, 0.945, 0.94), text: INK,
    title: RED, sub: GRAY, mascot: true
  },
  bw: {
    line: rgb(0, 0, 0), lineW: 0.8,
    headFill: null, headText: rgb(0, 0, 0),
    sqFill: null, text: rgb(0, 0, 0),
    title: rgb(0, 0, 0), sub: rgb(0, 0, 0), mascot: false
  },
  ink: {
    line: rgb(0.72, 0.72, 0.72), lineW: 0.5,
    headFill: null, headText: rgb(0.35, 0.35, 0.35),
    sqFill: null, text: rgb(0.25, 0.25, 0.25),
    title: rgb(0.35, 0.35, 0.35), sub: rgb(0.45, 0.45, 0.45), mascot: false
  }
};

const MARGIN = 36;
const TITLE_ZONE = 78;   // 顶部标题区高度
const FOOTER_ZONE = 26;  // 底部页脚高度

function drawCentered(page, text, font, cx, cy, size, color) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: cx - w / 2, y: cy - size * 0.36, size, font, color });
}

/* 通用图表绘制：n×n 乘法网格 + 表头行/列；landscape 时横向纸张。
 * max 是最大因子：1–12 图 = 12×12 个乘积，1–100 图 = 10×10 个乘积（行业惯例，
 * 「1–100 chart」指乘积到 100，不是 100×100 的网格）。 */
async function renderChart({ max, title, variant, landscape }) {
  const V = VARIANTS[variant];
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const base = { width: 612, height: 792 }; // US Letter
  const size = landscape
    ? { width: Math.max(base.width, base.height), height: Math.min(base.width, base.height) }
    : base;
  const page = doc.addPage([size.width, size.height]);
  const sub = 'Follow a row across and a column down — where they meet is the answer.';
  page.drawText(title, { x: MARGIN, y: size.height - 50, size: 24, font: bold, color: V.title });
  page.drawText(sub, { x: MARGIN, y: size.height - 70, size: 10, font: regular, color: V.sub });

  /* 吉祥物只出现在彩色版（黑白/省墨版以省墨为先） */
  if (V.mascot) {
    try {
      const png = await doc.embedPng(fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'tangyuan-pdf.png')));
      const h = 52;
      const w = h * (png.width / png.height);
      page.drawImage(png, { x: size.width - MARGIN - w, y: size.height - 66, width: w, height: h, opacity: 0.95 });
    } catch (e) { /* 图片缺失不阻断生成 */ }
  }

  /* 网格几何：行列各 max+1（含表头） */
  const n = max + 1;
  const gx = MARGIN;
  const gyTop = size.height - TITLE_ZONE - MARGIN;
  const gw = size.width - MARGIN * 2;
  const gh = gyTop - (MARGIN + FOOTER_ZONE);
  const cw = gw / n;
  const ch = gh / n;
  const cellSize = Math.min(cw, ch) >= 40 ? 13 : 11;

  /* 表头底纹（bw/ink 无底纹），对角线平方数浅色标记（仅 color） */
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = gx + c * cw;
      const y = gyTop - (r + 1) * ch;
      const isHead = r === 0 || c === 0;
      if (isHead && V.headFill) {
        page.drawRectangle({ x, y, width: cw, height: ch, color: V.headFill });
      } else if (r === c && V.sqFill) {
        page.drawRectangle({ x, y, width: cw, height: ch, color: V.sqFill });
      }
      const label = r === 0 && c === 0 ? '×' : isHead ? String(r === 0 ? c : r) : String(r * c);
      /* 对角线平方数：color 版已有浅色底纹，bw/ink 版不填色（省墨）但一律加粗数字区分 */
      const f = isHead || (!isHead && r === c) ? bold : regular;
      drawCentered(page, label, f, x + cw / 2, y + ch / 2, isHead ? cellSize + 1 : cellSize, isHead ? V.headText : V.text);
    }
  }

  /* 网格线：先横后竖，一次画完 */
  for (let r = 0; r <= n; r++) {
    const y = gyTop - r * ch;
    page.drawLine({ start: { x: gx, y }, end: { x: gx + gw, y }, thickness: V.lineW, color: V.line });
  }
  for (let c = 0; c <= n; c++) {
    const x = gx + c * cw;
    page.drawLine({ start: { x, y: gyTop }, end: { x, y: gyTop - gh }, thickness: V.lineW, color: V.line });
  }
  /* 外框加重一点，剪裁后更好认 */
  page.drawRectangle({ x: gx, y: gyTop - gh, width: gw, height: gh, borderColor: V.line, borderWidth: V.lineW * 1.6 });

  /* 页脚 */
  const foot = 'tangyuanmath.com · Free multiplication practice, charts and worksheets';
  const fw = regular.widthOfTextAtSize(foot, 8.5);
  page.drawText(foot, { x: (size.width - fw) / 2, y: MARGIN + 2, size: 8.5, font: regular, color: V.sub });

  return Buffer.from(await doc.save());
}

const JOBS = [
  { max: 12, title: 'Multiplication Chart 1–12', landscape: true, file: 'multiplication-chart-1-12-VAR-letter-landscape.pdf' },
  { max: 10, title: 'Multiplication Chart 1–100', landscape: false, file: 'multiplication-chart-1-100-VAR-letter.pdf' }
];

(async () => {
  const outDir = path.resolve(__dirname, '..', '..', 'public', 'en', 'multiplication-chart');
  fs.mkdirSync(outDir, { recursive: true });
  for (const job of JOBS) {
    for (const variant of Object.keys(VARIANTS)) {
      const bytes = await renderChart({ max: job.max, title: job.title, variant, landscape: job.landscape });
      const file = job.file.replace('VAR', variant);
      fs.writeFileSync(path.join(outDir, file), bytes);
      console.log(`${file}: ${bytes.length} bytes`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
