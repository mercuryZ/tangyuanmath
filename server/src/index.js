/* Tangyuan Math 服务端入口（M1）
 * - 同源托管 public/ 静态站点 + /api；
 * - 安全：严格 CSP、请求体限制、CSRF、分级限流、预编译 SQL；
 * - createApp(db) 供测试注入临时数据库。
 */
'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { initDb } = require('./db');
const mw = require('./middleware');
const { buildAuthRouter, meHandler, updateMeHandler } = require('./auth');
const { buildProfilesRouter } = require('./profiles');
const { buildRecordsRouter, buildWrongbookRouter } = require('./records');
const { buildAccountRouter } = require('./account');

function createApp(db, opts) {
  const app = express();
  opts = opts || {};
  app.locals.mailCapture = opts.mailCapture || null; // 测试注入：捕获验证/重置链接

  app.set('trust proxy', 1);
  app.set('x-powered-by', false);
  app.disable('etag');

  app.use(mw.securityHeaders);
  app.use(express.json({ limit: '128kb' }));
  app.use(cookieParser());
  app.use(mw.attachUser(db));

  /* ---------- API ---------- */
  const api = express.Router();

  api.get('/csrf', (req, res) => mw.ok(res, { csrfToken: mw.issueCsrfCookie(req, res) }));
  api.use('/auth', buildAuthRouter(db));
  api.get('/me', meHandler(db));
  api.patch('/me', ...updateMeHandler(db).map(h => h)); // [csrfProtect, handler]
  api.use('/profiles', mw.requireAuth, buildProfilesRouter(db));
  api.use('/account', mw.requireAuth, buildAccountRouter(db));

  /* 档案子资源：先挂 profiles 归属中间件再挂子路由 */
  api.use('/profiles/:id/records', mw.requireAuth, buildRecordsRouter(db));
  api.use('/profiles/:id/wrongbook', mw.requireAuth, buildWrongbookRouter(db));

  /* /api 内的 404 与错误处理：统一 JSON，不外露堆栈（DESIGN 10.2） */
  api.use((req, res) => mw.fail(res, 404, 'not_found', 'No such API endpoint.'));
  api.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err && err.type === 'entity.too.large') return mw.fail(res, 413, 'body_too_large', 'Request body too large.');
    if (err && err.type === 'entity.parse.failed') return mw.fail(res, 400, 'invalid_json', 'Invalid JSON body.');
    console.error('[api-error]', err && err.message ? err.message : err); // 只记消息，不记请求体
    return mw.fail(res, 500, 'internal', 'Something went wrong.');
  });

  app.use('/api', api);

  /* ---------- 无语言前缀的简写路径 → 英文页 ----------
   * 用户与外部审核方常直接输入 /privacy、/about 这类地址。若不重定向，它们会落到
   * 下方 404 兜底：状态码 404 + 正文是首页，容易被误判为「页面不存在/内容不足」。 */
  const BARE_PAGE_REDIRECTS = {
    '/privacy': '/en/privacy/',
    '/about': '/en/about/',
    '/terms': '/en/terms/',
    '/faq': '/en/faq/'
  };
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const target = BARE_PAGE_REDIRECTS[req.path.replace(/\/+$/, '')];
    if (target) return res.redirect(301, target);
    next();
  });

  /* ---------- 静态站点（public/） ---------- */
  app.use(express.static(config.publicDir, {
    extensions: ['html'],
    maxAge: config.isProd ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));

  /* 静态 404 回退到首页语言入口（不吞 /api） */
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return mw.fail(res, 404, 'not_found', 'No such API endpoint.');
    res.status(404).sendFile(require('node:path').join(config.publicDir, 'index.html'));
  });

  return app;
}

/* 直接运行：初始化数据库并监听 */
if (require.main === module) {
  const db = initDb(config.dbFile);
  const app = createApp(db);
  app.listen(config.port, () => {
    console.log(`Tangyuan Math server (M1) listening on http://127.0.0.1:${config.port}`);
    console.log(`  db=${config.dbFile} public=${config.publicDir} mail=${config.mailTransport}`);
    if (!config.isProd) console.log('  development mode: email links are printed to this console');
  });
}

module.exports = { createApp, initDb };
