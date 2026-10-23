/* PDF 练习卷生成与下载（DESIGN §9，M2 首期）
 * - 纯渲染函数 renderWorksheetPdf 与路由解耦，样张脚本与测试复用；
 * - 题型与因子范围由本文件维护（练习卷可用 1–9 / 11–19 表与自定义范围），服务端自带去重生成；
 * - 门禁：entitlements 表的 pdf_worksheet 权益（M2 验收「非会员不能生成付费 PDF」）；
 * - 防滥用：PDF 专用限流 + 进程内并发上限（DESIGN 9.2）。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const mw = require('./middleware');
const { hasFamilyEntitlement } = require('./entitlements');

/* 练习卷专用题型与因子范围（与游戏端的 DIFFICULTIES 解耦：
 * 练习卷需要 1–9 / 11–19 表，且支持自定义范围，而游戏难度仍沿用原枚举）。 */
const DIFFICULTIES = {
  times_tables_9:     { a: [1, 9],   b: [1, 9] },
  times_tables_11_19: { a: [11, 19], b: [11, 19] },
  two_by_one:         { a: [10, 99], b: [2, 9] }, // 一位数不含 1
  two_by_two:         { a: [10, 99], b: [10, 99] }
};
const DIFFICULTY_KEYS = Object.keys(DIFFICULTIES);
const CUSTOM_DIFFICULTY = 'custom';
const CUSTOM_MIN = 1;
const CUSTOM_MAX = 99;

const FONT_ZH = path.resolve(__dirname, '../fonts/NotoSansSC-Subset.ttf'); // OFL 许可，允许嵌入分发（见 fonts/OFL.txt）
const MASCOT_PNG = path.resolve(__dirname, '../assets/tangyuan-pdf.png'); // 打印尺寸小图，控制 PDF 体积

/* ---------- 标签文案（en 用 WinAnsi 内置字体；zh 字形集见 scripts/subset_font.py） ---------- */
const T = {
  en: {
    title: 'Tangyuan Math — Multiplication Worksheet',
    answersTitle: 'Answers',
    answersNote: 'Answer page — print separately only if you want it.',
    tableTitle: 'Times Table 1–9',
    tableSub: 'Free printable practice · tangyuanmath.com',
    tableAnswersTitle: 'Answer Key · Times Table 1–9',
    tableAnswersSub: 'Tangyuan Math · tangyuanmath.com',
    name: 'Name', date: 'Date', score: 'Score',
    footerBrand: 'Tangyuan Math · tangyuanmath.com',
    pageOf: (n, m) => `Page ${n} of ${m}`,
    difficulty: {
      times_tables_9: 'Times tables 1–9',
      times_tables_11_19: 'Times tables 11–19',
      two_by_one: '2-digit × 1-digit',
      two_by_two: '2-digit × 2-digit'
    },
    custom: 'Custom'
  },
  zh: {
    title: '汤圆数学 · 乘法练习卷',
    answersTitle: '答案',
    answersNote: '答案页 —— 可单独选印。',
    tableTitle: '九九乘法表',
    tableSub: '1–9 · 免费打印 · tangyuanmath.com',
    tableAnswersTitle: '九九乘法表 · 答案',
    tableAnswersSub: '汤圆数学 · tangyuanmath.com',
    name: '姓名', date: '日期', score: '得分',
    footerBrand: '汤圆数学 · tangyuanmath.com',
    pageOf: (n, m) => `第 ${n} 页 / 共 ${m} 页`,
    difficulty: {
      times_tables_9: '乘法口诀（1–9）',
      times_tables_11_19: '乘法口诀（11–19）',
      two_by_one: '两位数 × 一位数',
      two_by_two: '两位数 × 两位数'
    },
    custom: '自定义'
  }
};

/* ---------- 纸张（pt）：en 默认 Letter，zh 默认 A4（DESIGN 9.2） ---------- */
const PAPER = {
  letter: { width: 612, height: 792 },
  a4: { width: 595.28, height: 841.89 }
};

/* ---------- 参数校验（纯函数，供路由与测试复用） ---------- */
/* 自定义范围：四个 1–99 的整数，且 min ≤ max */
function parseCustomRange(q) {
  const out = {};
  for (const name of ['aMin', 'aMax', 'bMin', 'bMax']) {
    const raw = q[name];
    if (raw === undefined || !/^\d{1,2}$/.test(String(raw))) {
      throw { code: 'invalid_range', msg: `${name} must be an integer between ${CUSTOM_MIN} and ${CUSTOM_MAX}.` };
    }
    const n = Number(raw);
    if (n < CUSTOM_MIN || n > CUSTOM_MAX) {
      throw { code: 'invalid_range', msg: `${name} must be between ${CUSTOM_MIN} and ${CUSTOM_MAX}.` };
    }
    out[name] = n;
  }
  if (out.aMin > out.aMax || out.bMin > out.bMax) {
    throw { code: 'invalid_range', msg: 'Each range minimum must not be greater than its maximum.' };
  }
  return { a: [out.aMin, out.aMax], b: [out.bMin, out.bMax] };
}

function normalizeParams(input) {
  const q = input || {};
  const locale = q.locale === undefined
    ? (q.userLocale === 'zh' ? 'zh' : 'en')
    : q.locale;
  if (locale !== 'en' && locale !== 'zh') throw { code: 'invalid_locale', msg: 'locale must be en or zh.' };

  let count = 20;
  if (q.count !== undefined) {
    if (!/^\d{1,3}$/.test(String(q.count))) throw { code: 'invalid_count', msg: 'count must be an integer between 5 and 100.' };
    count = Number(q.count);
    if (count < 5 || count > 100) throw { code: 'invalid_count', msg: 'count must be between 5 and 100.' };
  }

  const difficulty = q.difficulty === undefined ? 'times_tables_9' : q.difficulty;
  if (difficulty !== CUSTOM_DIFFICULTY && !DIFFICULTY_KEYS.includes(difficulty)) {
    throw {
      code: 'invalid_difficulty',
      msg: 'difficulty must be one of: ' + DIFFICULTY_KEYS.concat(CUSTOM_DIFFICULTY).join(', ') + '.'
    };
  }
  const range = difficulty === CUSTOM_DIFFICULTY ? parseCustomRange(q) : undefined;

  const paper = q.paper === undefined ? (locale === 'zh' ? 'a4' : 'letter') : q.paper;
  if (paper !== 'letter' && paper !== 'a4') throw { code: 'invalid_paper', msg: 'paper must be letter or a4.' };

  let answers = 0;
  if (q.answers !== undefined) {
    if (q.answers !== '0' && q.answers !== '1' && q.answers !== 0 && q.answers !== 1) {
      throw { code: 'invalid_answers', msg: 'answers must be 0 or 1.' };
    }
    answers = Number(q.answers);
  }

  const params = { count, difficulty, paper, answers, locale };
  if (range) params.range = range;
  return params;
}

/* ---------- 题目生成：与游戏端同款去重逻辑，count 放宽到 5–100（DESIGN 9.1） ---------- */
function randInt(rng, min, max) {
  if (rng) return Math.floor(rng() * (max - min + 1)) + min;
  return crypto.randomInt(min, max + 1);
}

function generateQuestions(difficulty, count, rng, range) {
  const def = range || DIFFICULTIES[difficulty];
  if (!def) throw new Error('unknown difficulty: ' + difficulty);
  const seen = Object.create(null);
  const out = [];
  let guard = 0;
  const maxGuard = count * 60;
  while (out.length < count && guard < maxGuard) {
    guard++;
    const a = randInt(rng, def.a[0], def.a[1]);
    const b = randInt(rng, def.b[0], def.b[1]);
    const key = a <= b ? `${a}x${b}` : `${b}x${a}`; // a×b 与 b×a 视为同一题（DESIGN 2.4）
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ a, b, answer: a * b });
  }
  while (out.length < count) { // 小题面空间不足时允许重复补足，保证题数
    const a = randInt(rng, def.a[0], def.a[1]);
    const b = randInt(rng, def.b[0], def.b[1]);
    out.push({ a, b, answer: a * b });
  }
  return out;
}

/* ---------- 版式 ---------- */
/* 全灰阶配色（DESIGN 9.2 打印友好、低墨量、黑白清楚）；装饰不挡题。 */
const INK = rgb(0.16, 0.16, 0.16);
const GRAY = rgb(0.45, 0.45, 0.45);
const LIGHT = rgb(0.75, 0.75, 0.75);

const MARGIN = 48;          // 左右页边距
const TOP_FIRST = 150;      // 首页题区上界（下方是标题/信息/姓名栏）
const TOP_CONT = 64;        // 续页题区上界
const TOP_ANSWERS = 130;    // 答案页题区上界
const BOTTOM = 60;          // 题区下界（页脚之上）
const QUESTION_ROW_H = 44;  // 行高留足手写空间
const ANSWER_ROW_H = 32;
const COLS = 2;

async function loadFonts(doc, locale) {
  if (locale === 'zh') {
    const bytes = fs.readFileSync(FONT_ZH);
    const font = await doc.embedFont(bytes, { subset: true });
    return { font, bold: font }; // 子集字体无粗体变体，答案用字号/灰度区分
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { font, bold };
}

/* 绘制一页题区网格；返回该页实际画到的题目下标（行优先、双栏阅读顺序） */
function drawGrid(page, { questions, startIndex, top, rowH, fonts, withAnswers }) {
  const { width } = page.getSize();
  const colW = (width - MARGIN * 2) / COLS;
  const rows = Math.floor((page.getSize().height - top - BOTTOM) / rowH);
  const size = withAnswers ? 12 : 13;
  let k = startIndex;
  for (let row = 0; row < rows && k < questions.length; row++) {
    const y = page.getSize().height - top - (row + 1) * rowH + (rowH - size) / 2 + 4;
    for (let col = 0; col < COLS && k < questions.length; col++) {
      const q = questions[k];
      const x = MARGIN + col * colW + (col === 0 ? 0 : 18);
      const prefix = `${k + 1})  `;
      const expr = `${q.a} × ${q.b} = `;
      page.drawText(prefix, { x, y, size, font: fonts.font, color: GRAY });
      const px = x + fonts.font.widthOfTextAtSize(prefix, size);
      page.drawText(expr, { x: px, y, size, font: fonts.font, color: INK });
      const ex = px + fonts.font.widthOfTextAtSize(expr, size);
      if (withAnswers) {
        page.drawText(String(q.answer), { x: ex, y, size: size + 1, font: fonts.bold, color: INK });
      } else {
        /* 手写答题线：浅灰细线，比下划线省墨且整齐 */
        page.drawLine({
          start: { x: ex + 2, y: y - 1.5 }, end: { x: x + colW - 30, y: y - 1.5 },
          thickness: 0.7, color: LIGHT
        });
      }
      k++;
    }
  }
  return k;
}

function drawFooter(page, { fonts, L, pageNo, totalPages }) {
  const { width } = page.getSize();
  const y = 28; // 页脚：距页底 28pt（pdf-lib 的 y 自页底向上）
  page.drawText(L.footerBrand, { x: MARGIN, y, size: 8.5, font: fonts.font, color: GRAY });
  const label = L.pageOf(pageNo, totalPages);
  const w = fonts.font.widthOfTextAtSize(label, 8.5);
  page.drawText(label, { x: width - MARGIN - w, y, size: 8.5, font: fonts.font, color: GRAY });
}

/* ---------- 渲染主入口：返回 PDF 字节 ---------- */
function difficultyLabel(locale, difficulty, range) {
  const L = T[locale];
  if (difficulty !== CUSTOM_DIFFICULTY || !range) return L.difficulty[difficulty];
  return `${L.custom} ${range.a[0]}–${range.a[1]} × ${range.b[0]}–${range.b[1]}`;
}

async function renderWorksheetPdf(params) {
  const { count, difficulty, paper, answers, locale, range } = normalizeParams(params);
  const L = T[locale];
  const questions = generateQuestions(difficulty, count, undefined, range);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit); // 自定义字体（中文子集）必须先注册 fontkit
  const fonts = await loadFonts(doc, locale);

  const size = PAPER[paper];
  const qRowCap = (top) => Math.floor((size.height - top - BOTTOM) / QUESTION_ROW_H) * COLS;
  const questionPages = [];
  let cap = qRowCap(TOP_FIRST);
  questionPages.push({ top: TOP_FIRST });
  while (cap < count) {
    questionPages.push({ top: TOP_CONT });
    cap += qRowCap(TOP_CONT);
  }

  const answersPerPage = Math.floor((size.height - TOP_ANSWERS - BOTTOM) / ANSWER_ROW_H) * COLS;
  const answerPageCount = answers ? Math.max(1, Math.ceil(count / answersPerPage)) : 0;
  const totalPages = questionPages.length + answerPageCount;

  /* 首页页眉：标题 + 题型/纸张信息 + 留空姓名/日期/得分（不要求填写儿童姓名，DESIGN 9.2） */
  const first = doc.addPage([size.width, size.height]);
  const meta = `${difficultyLabel(locale, difficulty, range)} · ${paper === 'letter' ? 'US Letter' : 'A4'} · ${count}`;
  first.drawText(L.title, { x: MARGIN, y: size.height - 56, size: 18, font: fonts.bold, color: INK });
  first.drawText(meta, { x: MARGIN, y: size.height - 78, size: 10.5, font: fonts.font, color: GRAY });
  const line = `${L.name} ______________    ${L.date} ____________    ${L.score} ________`;
  first.drawText(line, { x: MARGIN, y: size.height - 104, size: 11, font: fonts.font, color: INK });
  first.drawLine({
    start: { x: MARGIN, y: size.height - 118 }, end: { x: size.width - MARGIN, y: size.height - 118 },
    thickness: 1, color: LIGHT
  });

  /* 汤圆角标：小尺寸置于标题右侧，不挤占题目区（DESIGN 9.2 装饰不挡题） */
  try {
    const png = await doc.embedPng(fs.readFileSync(MASCOT_PNG));
    const h = 44;
    const w = h * (png.width / png.height);
    first.drawImage(png, { x: size.width - MARGIN - w, y: size.height - 56 - h + 10, width: w, height: h, opacity: 0.9 });
  } catch (e) { /* 图片缺失不阻断生成 */ }

  let k = 0;
  for (let p = 0; p < questionPages.length; p++) {
    const page = p === 0 ? first : doc.addPage([size.width, size.height]);
    k = drawGrid(page, { questions, startIndex: k, top: questionPages[p].top, rowH: QUESTION_ROW_H, fonts, withAnswers: false });
    drawFooter(page, { fonts, L, pageNo: p + 1, totalPages });
  }

  /* 答案页：独立成页，可单独选印（DESIGN 9.2） */
  for (let p = 0; p < answerPageCount; p++) {
    const page = doc.addPage([size.width, size.height]);
    page.drawText(L.answersTitle, { x: MARGIN, y: size.height - 56, size: 16, font: fonts.bold, color: INK });
    page.drawText(meta + (p === 0 ? ' · ' + L.answersNote : ''), {
      x: MARGIN, y: size.height - 76, size: 9.5, font: fonts.font, color: GRAY
    });
    drawGrid(page, { questions, startIndex: p * answersPerPage, top: TOP_ANSWERS, rowH: ANSWER_ROW_H, fonts, withAnswers: true });
    drawFooter(page, { fonts, L, pageNo: questionPages.length + p + 1, totalPages });
  }

  const bytes = await doc.save();
  return { bytes, pageCount: totalPages, paper, locale, difficulty, count, answers };
}

/* ---------- 免费样张：1–9 九九乘法表 ---------- */
/* 按列排列的三角口诀表：第 1 列 9 个算式，第 2 列 8 个……第 9 列 1 个，共 45 个。 */
function multiplicationTableColumns(max) {
  const n = Number.isInteger(max) && max > 0 ? max : 9;
  const cols = [];
  for (let base = 1; base <= n; base++) {
    const facts = [];
    for (let b = base; b <= n; b++) facts.push({ a: base, b, answer: base * b });
    cols.push({ base, facts });
  }
  return cols;
}

/* 参考儿童乘法表海报：每列一个彩色数字徽章，白卡片 + 浅色行带。 */
const TABLE_COLORS = [
  rgb(0.894, 0.341, 0.180), // 珊瑚
  rgb(0.949, 0.557, 0.169), // 橙
  rgb(0.788, 0.635, 0.153), // 芥黄
  rgb(0.306, 0.624, 0.239), // 绿
  rgb(0.165, 0.616, 0.561), // 青绿
  rgb(0.227, 0.525, 0.784), // 蓝
  rgb(0.357, 0.420, 0.753), // 靛蓝
  rgb(0.557, 0.357, 0.710), // 紫
  rgb(0.831, 0.365, 0.475)  // 粉
];
const TABLE_BG = rgb(1, 0.976, 0.957);
const TABLE_INK = rgb(0.23, 0.16, 0.16);
const TABLE_TITLE = rgb(0.690, 0.165, 0.216);

function fillRoundedRect(page, x, y, w, h, r, color, opacity) {
  const opts = { color, opacity };
  page.drawRectangle({ ...opts, x: x + r, y, width: w - 2 * r, height: h });
  page.drawRectangle({ ...opts, x, y: y + r, width: w, height: h - 2 * r });
  page.drawEllipse({ ...opts, x: x + r, y: y + r, xScale: r, yScale: r });
  page.drawEllipse({ ...opts, x: x + w - r, y: y + r, xScale: r, yScale: r });
  page.drawEllipse({ ...opts, x: x + r, y: y + h - r, xScale: r, yScale: r });
  page.drawEllipse({ ...opts, x: x + w - r, y: y + h - r, xScale: r, yScale: r });
}

function drawCenteredText(page, text, cx, baseline, size, font, color) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: cx - w / 2, y: baseline, size, font, color });
}

function tintColor(color, amount) {
  return rgb(
    color.red + (1 - color.red) * amount,
    color.green + (1 - color.green) * amount,
    color.blue + (1 - color.blue) * amount
  );
}

function drawTablePage(page, { size, fonts, cols, showAnswers, title, sub, pageNo, totalPages, L, mascot }) {
  page.drawRectangle({ x: 0, y: 0, width: size.width, height: size.height, color: TABLE_BG });
  page.drawText(title, { x: MARGIN, y: size.height - 58, size: 28, font: fonts.bold, color: TABLE_TITLE });
  page.drawText(sub, { x: MARGIN, y: size.height - 82, size: 10.5, font: fonts.font, color: GRAY });
  for (let i = 0; i < 9; i++) {
    page.drawEllipse({ x: MARGIN + 4 + i * 14, y: size.height - 104, xScale: 3.5, yScale: 3.5, color: TABLE_COLORS[i] });
  }
  if (mascot) {
    const h = 56;
    const w = h * (mascot.width / mascot.height);
    page.drawImage(mascot, { x: size.width - MARGIN - w, y: size.height - 112, width: w, height: h, opacity: 0.95 });
  }

  const gap = 4;
  const cardW = (size.width - MARGIN * 2 - gap * 8) / 9;
  const headerH = 50;
  const rowH = 38;
  const cardH = headerH + rowH * 9 + 10;
  const tableTop = size.height - 140;
  const tableBottom = tableTop - cardH;
  const factSize = cardW >= 78 ? 12 : 11.5;
  const badge = 36;

  for (let c = 0; c < cols.length; c++) {
    const color = TABLE_COLORS[c];
    const x = MARGIN + c * (cardW + gap);
    fillRoundedRect(page, x, tableBottom, cardW, cardH, 14, rgb(1, 1, 1));

    /* 交错浅色行带（只画有算式的行） */
    for (let i = 1; i < cols[c].facts.length; i += 2) {
      page.drawRectangle({
        x: x + 3, y: tableTop - headerH - (i + 1) * rowH + 2,
        width: cardW - 6, height: rowH - 4, color, opacity: 0.07
      });
    }

    /* 彩色数字徽章：数字在方格内水平、垂直居中 */
    const badgeTop = tableTop - 45;
    fillRoundedRect(page, x + (cardW - badge) / 2, badgeTop, badge, badge, 12, color);
    drawCenteredText(page, String(cols[c].base), x + cardW / 2, badgeTop + badge / 2 - 19 * 0.35, 19, fonts.bold, rgb(1, 1, 1));

    for (let i = 0; i < cols[c].facts.length; i++) {
      const item = cols[c].facts[i];
      const centerY = tableTop - headerH - (i + 0.5) * rowH;
      const baseline = centerY - factSize * 0.35;
      if (showAnswers) {
        drawCenteredText(page, `${item.a} × ${item.b} = ${item.answer}`, x + cardW / 2, baseline, factSize, fonts.font, TABLE_INK);
      } else {
        const expr = `${item.a} × ${item.b} =`;
        const exprW = fonts.font.widthOfTextAtSize(expr, factSize);
        const tx = x + 7;
        page.drawText(expr, { x: tx, y: baseline, size: factSize, font: fonts.font, color: TABLE_INK });
        page.drawLine({
          start: { x: tx + exprW + 3, y: baseline - 2 },
          end: { x: x + cardW - 6, y: baseline - 2 },
          thickness: 0.6, color: tintColor(color, 0.55)
        });
      }
    }
  }

  drawFooter(page, { fonts, L, pageNo, totalPages });
}

async function renderMultiplicationTablePdf(params) {
  const q = params || {};
  const locale = q.locale === 'zh' ? 'zh' : 'en';
  const paper = q.paper === 'a4' ? 'a4' : 'letter';
  const L = T[locale];
  const cols = multiplicationTableColumns(9);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts = await loadFonts(doc, locale);
  /* 横向纸张：给 9 列口诀表更多横向空间 */
  const base = PAPER[paper];
  const size = { width: Math.max(base.width, base.height), height: Math.min(base.width, base.height) };

  let mascot = null;
  try {
    mascot = await doc.embedPng(fs.readFileSync(MASCOT_PNG));
  } catch (e) { /* 图片缺失不阻断生成 */ }

  const pages = [
    { title: L.tableTitle, sub: L.tableSub, answers: false },
    { title: L.tableAnswersTitle, sub: L.tableAnswersSub, answers: true }
  ];
  pages.forEach((p, i) => {
    const page = doc.addPage([size.width, size.height]);
    drawTablePage(page, {
      size, fonts, cols, showAnswers: p.answers,
      title: p.title, sub: p.sub,
      pageNo: i + 1, totalPages: pages.length, L, mascot
    });
  });

  const bytes = await doc.save();
  return { bytes, pageCount: pages.length, paper, locale, kind: 'table', count: cols.reduce((n, col) => n + col.facts.length, 0) };
}

/* ---------- 路由 ---------- */
/* 进程内并发上限：pdf-lib 渲染是同步 CPU 且输入有界（≤100 题、≤ ~8 页，单次毫秒级），
 * 无需额外超时——这里只防止并发请求在事件循环里堆叠（DESIGN 9.2 限制并发）。 */
const MAX_IN_FLIGHT = 3;
let inFlight = 0;
function concurrencyGuard(req, res, next) {
  if (inFlight >= MAX_IN_FLIGHT) {
    return mw.fail(res, 503, 'pdf_busy', 'The worksheet service is busy, please retry in a moment.');
  }
  inFlight++;
  let done = false;
  const dec = () => { if (!done) { done = true; inFlight--; } };
  res.once('finish', dec);
  res.once('close', dec);
  next();
}

function buildPdfRouter(db) {
  const r = express.Router();

  /* GET /api/pdf/worksheet?count=20&difficulty=two_by_two&paper=letter&answers=1&locale=en
   * PDF 响应不套 {ok,...} 信封（DESIGN 7.1 例外条款） */
  r.get('/worksheet',
    mw.rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyFn: q => q.user && q.user.familyId, name: 'pdf' }),
    concurrencyGuard,
    async (req, res) => {
      let params;
      try {
        params = normalizeParams({ ...req.query, userLocale: req.user.locale });
      } catch (e) {
        return mw.fail(res, 400, e.code, e.msg);
      }
      if (!hasFamilyEntitlement(db, req.user.familyId, 'pdf_worksheet')) {
        return mw.fail(res, 403, 'supporter_required', 'Custom worksheet PDF is a Supporter feature.');
      }
      let out;
      try {
        out = await renderWorksheetPdf(params);
      } catch (e) {
        console.error('[pdf-error]', e && e.message ? e.message : e);
        return mw.fail(res, 500, 'internal', 'Could not generate the worksheet.');
      }
      const rangePart = params.difficulty === 'custom' && params.range
        ? `-${params.range.a[0]}-${params.range.a[1]}x${params.range.b[0]}-${params.range.b[1]}`
        : '';
      const name = `tangyuan-multiplication-${params.difficulty}${rangePart}-${params.count}-${params.paper}` +
        (params.answers ? '-answers' : '') + '.pdf';
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store' // 个性化响应不进公共缓存（DESIGN 9.2）
      });
      res.send(Buffer.from(out.bytes));
    });

  return r;
}

module.exports = {
  buildPdfRouter,
  renderWorksheetPdf,
  renderMultiplicationTablePdf,
  multiplicationTableColumns,
  generateQuestions,
  normalizeParams,
  DIFFICULTY_KEYS,
  ZH_STRINGS: T.zh // 供字体子集脚本与测试核对字形覆盖
};
