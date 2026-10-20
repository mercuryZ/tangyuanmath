/* 邮件抽象（DESIGN M1：邮箱验证与密码重置）
 * transport=console：验证/重置链接打印到服务端日志（本地开发默认）。
 * transport=cloudflare：走 Cloudflare Email Service 的 REST API（HTTPS 443，
 *   不经 SMTP，因此不受主机商出站端口策略影响），需配置 TM_CF_ACCOUNT_ID 与 TM_CF_API_TOKEN。
 * 测试环境可注入 capture 数组直接断言链接内容；也可注入 fetchImpl 断言请求体。
 * 发送失败只记日志、不抛出：注册/找回密码的接口契约不因邮件通道故障而改变。
 */
'use strict';

const config = require('./config');

const CF_ENDPOINT_BASE = 'https://api.cloudflare.com/client/v4/accounts/';

/* TM_MAIL_FROM 允许写成 `Tangyuan Math <no-reply@example.com>` 或裸地址；
 * Cloudflare API 的 from 字段要裸地址（DESIGN 10.2：地址之外的信息不进日志）。 */
function bareAddress(mailFrom) {
  const m = /<([^>]+)>/.exec(String(mailFrom || ''));
  return (m ? m[1] : String(mailFrom || '')).trim();
}

/* 纯函数：便于单测断言请求形状，不发起网络请求 */
function buildCloudflareRequest(opts) {
  const { accountId, apiToken, from, to, subject, text } = opts;
  return {
    url: CF_ENDPOINT_BASE + encodeURIComponent(accountId) + '/email/sending/send',
    init: {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + apiToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ from, to, subject, text })
    }
  };
}

async function sendViaCloudflare(opts, fetchImpl) {
  const accountId = config.cfAccountId;
  const apiToken = config.cfApiToken;
  if (!accountId || !apiToken) {
    console.error('[mailer:cloudflare] TM_CF_ACCOUNT_ID / TM_CF_API_TOKEN 未配置，邮件未发送');
    return;
  }
  const req = buildCloudflareRequest({
    accountId,
    apiToken,
    from: bareAddress(config.mailFrom),
    to: opts.to,
    subject: opts.subject,
    text: opts.text
  });
  let resp, json;
  try {
    resp = await (fetchImpl || fetch)(req.url, req.init);
    json = await resp.json();
  } catch (e) {
    console.error('[mailer:cloudflare] 请求失败：', (e && e.message) || e);
    return;
  }
  // 响应按收件人分组：delivered / queued / permanent_bounces
  const result = (json && json.result) || {};
  const bounced = result.permanent_bounces || [];
  if (!resp.ok || (json && json.success === false) || bounced.length) {
    const codes = ((json && json.errors) || []).map(e => e && e.code).join(',');
    console.error(`[mailer:cloudflare] 发送未完全成功 status=${resp.status} codes=${codes} bounced=${bounced.length}`);
  }
}

/* 返回 Promise；调用方可不 await，但绝不会抛出（内部已兜住错误） */
function sendMail(opts, capture, fetchImpl) {
  const { to, subject, text } = opts;
  if (capture && Array.isArray(capture)) capture.push({ to, subject, text });

  if (config.mailTransport === 'console') {
    // 避免完整邮箱进日志：只打域名提示（DESIGN 10.2 日志过滤）
    const domain = String(to).split('@')[1] || 'unknown';
    console.log(`[mailer:console] -> *@${domain} | ${subject}\n${text}`);
    return Promise.resolve();
  }
  if (config.mailTransport === 'cloudflare') {
    return sendViaCloudflare(opts, fetchImpl);
  }
  // 其余值（含遗留的 smtp）：明确报错，不静默丢弃
  console.error(`[mailer] 未知的 TM_MAIL_TRANSPORT=${config.mailTransport}；邮件未发送`);
  return Promise.resolve();
}

function sendVerificationEmail(email, url, capture, fetchImpl) {
  return sendMail({
    to: email,
    subject: 'Tangyuan Math — verify your email / 验证邮箱',
    text:
      'Welcome to Tangyuan Math!\n\n' +
      'Verify your email address (valid for 24 hours):\n' + url + '\n\n' +
      'If you did not create this account, you can ignore this message.\n' +
      '——\n欢迎来到汤圆数学！请打开以下链接完成邮箱验证（24 小时内有效）：\n' + url +
      '\n如非本人操作，请忽略本邮件。'
  }, capture, fetchImpl);
}

function sendResetEmail(email, url, capture, fetchImpl) {
  return sendMail({
    to: email,
    subject: 'Tangyuan Math — reset your password / 重置密码',
    text:
      'A password reset was requested for your Tangyuan Math account.\n' +
      'Open this link within 24 hours to choose a new password:\n' + url + '\n\n' +
      'If this was not you, you can safely ignore this message.\n' +
      '——\n有人请求重置你的汤圆数学账号密码。请在 24 小时内打开以下链接设置新密码：\n' + url +
      '\n如非本人操作，请忽略本邮件。'
  }, capture, fetchImpl);
}

function sendFamilyInviteEmail(email, url, inviterEmail, capture, fetchImpl) {
  return sendMail({
    to: email,
    subject: 'Tangyuan Math — join my family account / 加入家庭账号',
    text:
      'A parent (' + inviterEmail + ') invited you to join their Tangyuan Math family account.\n\n' +
      'Open this link within 7 days to sign in or create your account. You will share one Supporter membership ' +
      '(Live Race and printable worksheets) with up to 2 parents and 2 children.\n' + url + '\n\n' +
      'If you were not expecting this invitation, you can ignore this message.\n' +
      '——\n一位家长（' + inviterEmail + '）邀请你加入汤圆数学的家庭账号。\n' +
      '请在 7 天内打开以下链接登录或注册。加入后，你们将共用一份支持者会员（联机对战与可打印练习卷），' +
      '每个家庭最多 2 位家长和 2 名子女：\n' + url +
      '\n如非本人预期，请忽略本邮件。'
  }, capture, fetchImpl);
}

module.exports = {
  sendMail, sendVerificationEmail, sendResetEmail, sendFamilyInviteEmail,
  buildCloudflareRequest, bareAddress
};
