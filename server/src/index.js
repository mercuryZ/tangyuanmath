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
const { buildVersusRouter } = require('./match-store');
const { buildPdfRouter } = require('./pdf');
const {
  buildFamilyRouter, familyInviteLandingHandler, familyInvitePendingHandler
} = require('./family-routes');
const { buildOrdersRouter, buildWaffoWebhookHandler } = require('./payment-routes');
const { buildAdminRouter, buildRedeemHandler } = require('./admin-routes');
const { attachLiveRace } = require('./race-ws');
const { startBackupScheduler } = require('./backup');

function createApp(db, opts) {
  const app = express();
  opts = opts || {};
  app.locals.mailCapture = opts.mailCapture || null; // 测试注入：捕获验证/重置链接

  app.set('trust proxy', 1);
  app.set('x-powered-by', false);
  app.disable('etag');

  app.use(mw.securityHeaders);

  /* Waffo webhook 必须拿到原始 body 验签：挂在 express.json 之前，且只对该路径用 express.raw。
   * 测试可注入 opts.payments 替换真实 SDK。 */
  const payments = opts.payments || require('./waffo');
  app.post('/api/payments/waffo/webhook',
    mw.rateLimit({ windowMs: 60000, max: 120, name: 'waffo-webhook' }),
    express.raw({ type: 'application/json', limit: '256kb' }),
    buildWaffoWebhookHandler(db, payments));

  app.use(express.json({ limit: '128kb' }));
  app.use(cookieParser());
  app.use(mw.attachIdentity(db));

  /* ---------- API ---------- */
  const api = express.Router();

  api.get('/csrf', (req, res) => mw.ok(res, { csrfToken: mw.issueCsrfCookie(req, res) }));
  api.use('/auth', buildAuthRouter(db));
  api.get('/me', meHandler(db));
  api.patch('/me', ...updateMeHandler(db).map(h => h)); // [csrfProtect, handler]
  /* 档案子资源必须挂在 /profiles 之前：/profiles 上的 requireAuth 会拦截
   * 所有以 /profiles 开头的路径，包括子女会话允许访问的记录/错题/对战。 */
  api.use('/profiles/:id/records', mw.requirePlayer, buildRecordsRouter(db));
  api.use('/profiles/:id/wrongbook', mw.requirePlayer, buildWrongbookRouter(db));
  api.use('/profiles/:id/versus', mw.requirePlayer, buildVersusRouter(db));

  api.use('/profiles', mw.requireAuth, buildProfilesRouter(db));
  api.use('/account', mw.requireAuth, buildAccountRouter(db));
  api.use('/pdf', mw.requireAuth, buildPdfRouter(db));
  api.use('/orders', mw.requireAuth, buildOrdersRouter(db, payments));
  api.use('/admin', mw.requireAuth, mw.requireAdmin, buildAdminRouter(db));
  api.post('/redeem', mw.requireAuth, ...buildRedeemHandler(db));

  /* 家庭邀请的落地页必须允许未登录访问（Google OAuth 回跳前） */
  api.get('/family/invite/landing', familyInviteLandingHandler(db));
  api.get('/family/invite/pending', familyInvitePendingHandler);
  api.use('/family', mw.requireAuth, buildFamilyRouter(db));

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
    '/faq': '/en/faq/',
    '/tips': '/en/tips/',
    '/blog': '/en/blog/',
    '/worksheets': '/en/worksheets/',
    '/pricing': '/en/pricing/'
  };
  /* 早期邮件里发出去的令牌链接形式（/account/verify-email?token=…、/account/reset?token=…）。
   * 这两个路径没有对应文件，直接访问会 404 并显示首页；这里带 query 转成前端真正解析的地址。 */
  const TOKEN_LINK_REDIRECTS = {
    '/account/verify-email': '/account/?mode=verify',
    '/account/reset': '/account/?mode=reset'
  };
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const path = req.path.replace(/\/+$/, '');
    const target = BARE_PAGE_REDIRECTS[path] || TOKEN_LINK_REDIRECTS[path];
    if (!target) return next();
    const i = req.originalUrl.indexOf('?');
    return res.redirect(301, i === -1 ? target : target + '&' + req.originalUrl.slice(i + 1));
  });

  /* ---------- 静态站点（public/） ---------- */
  app.use(express.static(config.publicDir, {
    extensions: ['html'],
    maxAge: config.isProd ? '1h' : 0,
    setHeaders(res, filePath) {
      /* HTML 与 CSS/JS 必须和最新部署保持一致（CDN 前置会把可缓存资源放大到 4 小时），
       * 用 no-cache 走 304 协商：始终新鲜，代价只是一次再验证请求。
       * 图片/PDF 等内容型资源保留 1 小时缓存。 */
      if (filePath.endsWith('.html') || filePath.endsWith('.css') || filePath.endsWith('.js')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));

  /* 静态 404 回退到首页语言入口（不吞 /api） */
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return mw.fail(res, 404, 'not_found', 'No such API endpoint.');
    res.status(404).sendFile(require('node:path').join(config.publicDir, 'index.html'));
  });

  return app;
}

/* 直接运行：初始化数据库并监听（同一 HTTP 服务同时承载 /api/race/ws 升级） */
if (require.main === module) {
  const db = initDb(config.dbFile);
  const app = createApp(db);
  const server = app.listen(config.port, () => {
    console.log(`Tangyuan Math server (M1.5) listening on http://127.0.0.1:${config.port}`);
    console.log(`  db=${config.dbFile} public=${config.publicDir} mail=${config.mailTransport}`);
    if (!config.isProd) console.log('  development mode: email links are printed to this console');

    /* 每日加密备份（DESIGN 12.2）：默认开启；TM_BACKUP_DISABLED=1 可关闭。
     * 首次检查在启动 30 秒后，此后每小时检查一次，距最近备份满 24 小时才创建。 */
    if (!config.backupDisabled) {
      startBackupScheduler(db, { dbFile: config.dbFile });
      console.log('  backups=every ' + config.backupIntervalHours + 'h, keep ' +
        config.backupRetentionDays + 'd, dir=' +
        (config.backupDir || require('node:path').join(require('node:path').dirname(config.dbFile), 'backups')));
    }

    /* 支付配置自检：只输出布尔值与公开 ID，不输出私钥。 */
    const wp = require('./waffo').status();
    const readyProducts = Object.values(wp.products).filter(p => p.configured).length;
    const totalProducts = Object.keys(wp.products).length;
    console.log('  payments=' + wp.environment + ' key=' +
      (wp.privateKeyValid ? 'ok' : wp.privateKeyPresent ? 'INVALID' : 'missing') +
      ' products=' + readyProducts + '/' + totalProducts);
    if (config.isProd && !config.waffoEnvironmentInput) {
      console.warn('[waffo] WAFFO_ENVIRONMENT is not set in production; defaulting to test — webhooks will be verified with the TEST key');
    }
    if (!wp.privateKeyPresent) {
      console.warn('[waffo] WAFFO_PRIVATE_KEY is missing; online checkout is disabled');
    } else if (!wp.privateKeyValid) {
      console.warn('[waffo] WAFFO_PRIVATE_KEY is present but cannot be parsed (check quotes/newlines/base64)');
    }
    for (const [sku, p] of Object.entries(wp.products)) {
      if (!p.productId) console.warn('[waffo] missing product ID for ' + sku + ' (set WAFFO_PRODUCT_*)');
    }
  });
  attachLiveRace(server, db, { log: console.error });
}

module.exports = { createApp, initDb, attachLiveRace };
