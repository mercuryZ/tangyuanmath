/* 邮件抽象（DESIGN M1：邮箱验证与密码重置）
 * M1 开发环境 transport=console：验证/重置链接打印到服务端日志（不发送真实邮件）。
 * 生产环境接 SMTP（后续按部署需要引入 nodemailer 并配置 TM_SMTP_URL）。
 * 测试环境可注入 capture 数组直接断言链接内容。
 */
'use strict';

const config = require('./config');

function sendMail(opts, capture) {
  const { to, subject, text } = opts;
  if (capture && Array.isArray(capture)) capture.push({ to, subject, text });
  if (config.mailTransport === 'console') {
    // 避免完整邮箱进日志：只打域名提示（DESIGN 10.2 日志过滤）
    const domain = String(to).split('@')[1] || 'unknown';
    console.log(`[mailer:console] -> *@${domain} | ${subject}\n${text}`);
  }
  // SMTP transport 预留：M1 未引入依赖，配置存在时给出明确错误提示
  else if (config.mailTransport === 'smtp') {
    console.error('[mailer] SMTP transport not wired in M1; set TM_MAIL_TRANSPORT=console for now');
  }
}

function sendVerificationEmail(email, url, capture) {
  sendMail({
    to: email,
    subject: 'Tangyuan Math — verify your email / 验证邮箱',
    text:
      'Welcome to Tangyuan Math!\n\n' +
      'Verify your email address (valid for 24 hours):\n' + url + '\n\n' +
      'If you did not create this account, you can ignore this message.\n' +
      '——\n欢迎来到汤圆数学！请打开以下链接完成邮箱验证（24 小时内有效）：\n' + url +
      '\n如非本人操作，请忽略本邮件。'
  }, capture);
}

function sendResetEmail(email, url, capture) {
  sendMail({
    to: email,
    subject: 'Tangyuan Math — reset your password / 重置密码',
    text:
      'A password reset was requested for your Tangyuan Math account.\n' +
      'Open this link within 24 hours to choose a new password:\n' + url + '\n\n' +
      'If this was not you, you can safely ignore this message.\n' +
      '——\n有人请求重置你的汤圆数学账号密码。请在 24 小时内打开以下链接设置新密码：\n' + url +
      '\n如非本人操作，请忽略本邮件。'
  }, capture);
}

module.exports = { sendMail, sendVerificationEmail, sendResetEmail };
