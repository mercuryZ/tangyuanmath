/* PDF 练习卷生成与下载（DESIGN §9，M2 首期）
 * - 纯渲染函数 renderWorksheetPdf 与路由解耦，样张脚本与测试复用；
 * - 题型与因子范围复用 public/js/questions.js（UMD，Node 可 require），服务端自带去重生成；
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

const config = require('./config');
const mw = require('./middleware');
const { hasEntitlement } = require('./entitlements');

const TMQuestions = require(path.resolve(__dirname, '..', config.publicDir, 'js', 'questions.js'));
const DIFFICULTIES = TMQuestions.DIFFICULTIES; // 与游戏端同一份因子范围（DESIGN 2.2）
const DIFFICULTY_KEYS = Object.keys(DIFFICULTIES);

const FONT_ZH = path.resolve(__dirname, '../fonts/NotoSansSC-Subset.ttf'); // OFL 许可，允许嵌入分发（见 fonts/OFL.txt）
const MASCOT_PNG = path.resolve(__dirname, '../assets/tangyuan-pdf.png'); // 打印尺寸小图，控制 PDF 体积

/* ---------- 标签文案（en 用 WinAnsi 内置字体；zh 字形集见 scripts/subset_font.py） ---------- */
const T = {
  en: {
    title: 'Tangyuan Math — Multiplication Worksheet',
    answersTitle: 'Answers',
    answersNote: 'Answer page — print separately only if you want it.',
    name: 'Name', date: 'Date', score: 'Score',
    footerBrand: 'Tangyuan Math · tangyuanmath.com',
    pageOf: (n, m) => `Page ${n} of ${m}`,
    difficulty: {
      times_tables_10: 'Times tables 1–10',
      times_tables_12: 'Times tables 1–12',
      two_by_one: '2-digit × 1-digit',
      two_by_two: '2-digit × 2-digit'
    }
  },
  zh: {
    title: '汤圆数学 · 乘法练习卷',
    answersTitle: '答案',
    answersNote: '答案页 —— 可单独选印。',
    name: '姓名', date: '日期', score: '得分',
    footerBrand: '汤圆数学 · tangyuanmath.com',
    pageOf: (n, m) => `第 ${n} 页 / 共 ${m} 页`,
    difficulty: {
      times_tables_10: '乘法口诀（1–10）',
      times_tables_12: '乘法口诀（1–12）',
      two_by_one: '两位数 × 一位数',
      two_by_two: '两位数 × 两位数'
    }
  }
};

/* ---------- 纸张（pt）：en 默认 Letter，zh 默认 A4（DESIGN 9.2） ---------- */
const PAPER = {
  letter: { width: 612, height: 792 },
  a4: { width: 595.28, height: 841.89 }
};

/* ---------- 参数校验（纯函数，供路由与测试复用） ---------- */
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

  const difficulty = q.difficulty === undefined ? 'times_tables_10' : q.difficulty;
  if (!DIFFICULTY_KEYS.includes(difficulty)) {
    throw { code: 'invalid_difficulty', msg: 'difficulty must be one of: ' + DIFFICULTY_KEYS.join(', ') + '.' };
  }

  const paper = q.paper === undefined ? (locale === 'zh' ? 'a4' : 'letter') : q.paper;
  if (paper !== 'letter' && paper !== 'a4') throw { code: 'invalid_paper', msg: 'paper must be letter or a4.' };

  let answers = 0;
  if (q.answers !== undefined) {
    if (q.answers !== '0' && q.answers !== '1' && q.answers !== 0 && q.answers !== 1) {
      throw { code: 'invalid_answers', msg: 'answers must be 0 or 1.' };
    }
    answers = Number(q.answers);
  }

  return { count, difficulty, paper, answers, locale };
}

/* ---------- 题目生成：与游戏端同款去重逻辑，count 放宽到 5–100（DESIGN 9.1） ---------- */
function randInt(rng, min, max) {
  if (rng) return Math.floor(rng() * (max - min + 1)) + min;
  return crypto.randomInt(min, max + 1);
}

function generateQuestions(difficulty, count, rng) {
  const def = DIFFICULTIES[difficulty];
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
async function renderWorksheetPdf(params) {
  const { count, difficulty, paper, answers, locale } = normalizeParams(params);
  const L = T[locale];
  const questions = generateQuestions(difficulty, count);

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
  const meta = `${L.difficulty[difficulty]} · ${paper === 'letter' ? 'US Letter' : 'A4'} · ${count}`;
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
    mw.rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyFn: q => q.user && q.user.id, name: 'pdf' }),
    concurrencyGuard,
    async (req, res) => {
      let params;
      try {
        params = normalizeParams({ ...req.query, userLocale: req.user.locale });
      } catch (e) {
        return mw.fail(res, 400, e.code, e.msg);
      }
      if (!hasEntitlement(db, req.user.id, 'pdf_worksheet')) {
        return mw.fail(res, 403, 'supporter_required', 'Custom worksheet PDF is a Supporter feature.');
      }
      let out;
      try {
        out = await renderWorksheetPdf(params);
      } catch (e) {
        console.error('[pdf-error]', e && e.message ? e.message : e);
        return mw.fail(res, 500, 'internal', 'Could not generate the worksheet.');
      }
      const name = `tangyuan-multiplication-${params.difficulty}-${params.count}-${params.paper}` +
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
  generateQuestions,
  normalizeParams,
  DIFFICULTY_KEYS,
  ZH_STRINGS: T.zh // 供字体子集脚本与测试核对字形覆盖
};
