/* 配置：环境变量优先，默认面向本地开发（DESIGN 10.2：密钥只在服务端环境） */
'use strict';

const path = require('node:path');

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
  // 邮件发送：M1 开发环境用 console（把链接打到服务端日志），生产接 SMTP
  mailTransport: process.env.TM_MAIL_TRANSPORT || 'console',
  smtpUrl: process.env.TM_SMTP_URL || '',
  mailFrom: process.env.TM_MAIL_FROM || 'Tangyuan Math <no-reply@example.invalid>',
  // 公开基址（拼验证/重置链接）
  publicBaseUrl: process.env.TM_PUBLIC_BASE_URL || 'http://127.0.0.1:3000'
};
