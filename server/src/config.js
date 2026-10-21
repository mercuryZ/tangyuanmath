/* 配置：环境变量优先，默认面向本地开发（DESIGN 10.2：密钥只在服务端环境） */
'use strict';

const path = require('node:path');

/* 环境变量从控制台/聊天里复制时经常带引号或首尾空白；统一清理，但绝不打印值。
 * Waffo 私钥支持 PEM（真实换行或字面量 \n）与裸 base64；_BASE64 变量按约定是
 * 「PEM 文件的 base64」，若误放 PEM 也兼容。私钥只存在服务端环境变量里。 */
function cleanEnv(value) {
  let v = String(value == null ? '' : value).trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) v = v.slice(1, -1).trim();
  }
  return v;
}

function readWaffoPrivateKey() {
  const pem = cleanEnv(process.env.WAFFO_PRIVATE_KEY);
  const base64 = cleanEnv(process.env.WAFFO_PRIVATE_KEY_BASE64);
  if (!base64) return pem.replace(/\\n/g, '\n');
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(base64)) return base64.replace(/\\n/g, '\n');
  const decoded = Buffer.from(base64.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(decoded)) return decoded;
  return base64; // 裸 base64 密钥数据，交给 SDK 处理
}

const waffoEnvironmentInput = cleanEnv(process.env.WAFFO_ENVIRONMENT).toLowerCase();
const waffoEnvironment =
  ['prod', 'production', 'live'].includes(waffoEnvironmentInput) ? 'prod' : 'test';
const waffoPrivateKey = readWaffoPrivateKey();

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  // 生产必须通过环境变量覆盖
  sessionSecretHint: process.env.SESSION_SECRET_HINT || 'dev',
  dbFile: process.env.TM_DB_FILE || path.join(__dirname, '..', 'data', 'app.db'),
  publicDir: process.env.TM_PUBLIC_DIR || path.join(__dirname, '..', '..', 'public'),
  // 会话有效期（毫秒），默认 7 天（DESIGN 5.2）
  sessionTtlMs: 7 * 24 * 3600 * 1000,
  // 一次性令牌（邮箱验证 / 密码重置）有效期
  tokenTtlMs: 24 * 3600 * 1000,
  bcryptRounds: 10,
  isProd: process.env.NODE_ENV === 'production',
  // 邮件发送：console（本地/日志）或 cloudflare（Cloudflare Email Service REST API，HTTPS 443）
  mailTransport: process.env.TM_MAIL_TRANSPORT || 'console',
  smtpUrl: process.env.TM_SMTP_URL || '',
  mailFrom: process.env.TM_MAIL_FROM || 'Tangyuan Math <no-reply@example.invalid>',
  // Cloudflare Email Service：账号 ID + 具备「Email Sending: Edit」权限的 API Token
  cfAccountId: process.env.TM_CF_ACCOUNT_ID || '',
  cfApiToken: process.env.TM_CF_API_TOKEN || '',
  // 公开基址（拼验证/重置链接）：Render 上自动用 RENDER_EXTERNAL_URL，自定义域名时用 TM_PUBLIC_BASE_URL 覆盖
  publicBaseUrl: process.env.TM_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://127.0.0.1:3000',
  // Google 登录（OAuth 2.0 授权码重定向流程；两者都配置后功能自动开启）
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  // 每日加密备份（DESIGN 12.2）：默认与数据库同盘（/data/backups），保留 30 天
  backupDisabled: process.env.TM_BACKUP_DISABLED === '1',
  backupDir: process.env.TM_BACKUP_DIR || '',
  backupKey: process.env.TM_BACKUP_KEY || '',
  backupRetentionDays: intEnv('TM_BACKUP_RETENTION_DAYS', 30),
  backupIntervalHours: intEnv('TM_BACKUP_INTERVAL_HOURS', 24),
  /* Waffo Pancake 支付（托管结账）。Merchant/Store ID 是公开标识，允许用 env 覆盖；
   * 私钥必须来自环境变量。默认 test 环境，上线时改 WAFFO_ENVIRONMENT=prod。 */
  waffoMerchantId: cleanEnv(process.env.WAFFO_MERCHANT_ID) || 'MER_47pr6GX7NZmc45XV3Yatqs',
  waffoStoreId: cleanEnv(process.env.WAFFO_STORE_ID) || 'STO_0XhVdBglSpSA3dEQi6gfwt',
  waffoPrivateKey,
  waffoEnvironment,
  waffoEnvironmentInput: waffoEnvironmentInput || '',
  waffoWebhookPublicKey: cleanEnv(process.env.WAFFO_WEBHOOK_PUBLIC_KEY),
  waffoProductMonthly: cleanEnv(process.env.WAFFO_PRODUCT_MONTHLY),
  waffoProductYearly: cleanEnv(process.env.WAFFO_PRODUCT_YEARLY),
  waffoProductLifetime: cleanEnv(process.env.WAFFO_PRODUCT_LIFETIME),
  waffoProductTrial7: cleanEnv(process.env.WAFFO_PRODUCT_TRIAL7)
};

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
