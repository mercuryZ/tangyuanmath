'use strict';
/* 邮件通道单测：console 与 Cloudflare Email Service（不发起真实网络请求） */
const test = require('node:test');
const assert = require('node:assert');

/* 在 require config 之前设置环境变量（config 在加载时求值） */
process.env.TM_MAIL_TRANSPORT = 'cloudflare';
process.env.TM_CF_ACCOUNT_ID = 'acct-123';
process.env.TM_CF_API_TOKEN = 'tok-abc';
process.env.TM_MAIL_FROM = 'Tangyuan Math <no-reply@tangyuanmath.com>';

const mailer = require('../server/src/mailer');

test('bareAddress：从 `Name <addr>` 取出裸地址，裸地址原样返回', () => {
  assert.strictEqual(mailer.bareAddress('Tangyuan Math <no-reply@tangyuanmath.com>'), 'no-reply@tangyuanmath.com');
  assert.strictEqual(mailer.bareAddress('no-reply@tangyuanmath.com'), 'no-reply@tangyuanmath.com');
  assert.strictEqual(mailer.bareAddress(''), '');
});

test('buildCloudflareRequest：端点、Bearer 头与请求体字段正确', () => {
  const req = mailer.buildCloudflareRequest({
    accountId: 'acct-123',
    apiToken: 'tok-abc',
    from: 'no-reply@tangyuanmath.com',
    to: 'parent@example.com',
    subject: 'Tangyuan Math — verify your email / 验证邮箱',
    text: 'https://tangyuanmath.com/account/verify-email?token=xyz'
  });
  assert.strictEqual(
    req.url,
    'https://api.cloudflare.com/client/v4/accounts/acct-123/email/sending/send'
  );
  assert.strictEqual(req.init.method, 'POST');
  assert.strictEqual(req.init.headers.authorization, 'Bearer tok-abc');
  assert.strictEqual(req.init.headers['content-type'], 'application/json');
  const body = JSON.parse(req.init.body);
  assert.strictEqual(body.from, 'no-reply@tangyuanmath.com'); // 裸地址，无显示名
  assert.strictEqual(body.to, 'parent@example.com');
  assert.ok(body.subject.includes('verify your email'));
  assert.ok(body.text.includes('token=xyz'));
});

test('sendVerificationEmail：走 Cloudflare API，from 用配置的发信地址', async () => {
  let seen = null;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ success: true, errors: [], result: { delivered: ['parent@example.com'] } }) };
  };
  await mailer.sendVerificationEmail('parent@example.com', 'https://tangyuanmath.com/account/verify-email?token=t1', null, fakeFetch);
  assert.ok(seen, '发起了请求');
  assert.ok(seen.url.endsWith('/email/sending/send'));
  assert.strictEqual(JSON.parse(seen.init.body).from, 'no-reply@tangyuanmath.com');
  assert.strictEqual(JSON.parse(seen.init.body).to, 'parent@example.com');
});

test('sendResetEmail：文本含重置链接', async () => {
  let body = null;
  const fakeFetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ success: true, errors: [], result: { delivered: ['p@example.com'] } }) };
  };
  await mailer.sendResetEmail('p@example.com', 'https://tangyuanmath.com/account/reset?token=r1', null, fakeFetch);
  assert.ok(body.subject.includes('reset your password'));
  assert.ok(body.text.includes('token=r1'));
});

test('网络异常不抛出：发送失败只记日志，不影响调用方契约', async () => {
  const boomFetch = async () => { throw new Error('network down'); };
  await assert.doesNotReject(
    mailer.sendVerificationEmail('p@example.com', 'https://x/y?token=t', null, boomFetch)
  );
});

test('API 返回错误不抛出', async () => {
  const errFetch = async () => ({
    ok: false, status: 403,
    json: async () => ({ success: false, errors: [{ code: 10203, message: 'email.sending_disabled' }], result: null })
  });
  await assert.doesNotReject(
    mailer.sendResetEmail('p@example.com', 'https://x/y?token=t', null, errFetch)
  );
});

test('capture 注入：即使走网络通道也记录邮件内容供测试断言', async () => {
  const capture = [];
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, errors: [], result: { delivered: [] } }) });
  await mailer.sendVerificationEmail('p@example.com', 'https://x/y?token=t9', capture, fakeFetch);
  assert.strictEqual(capture.length, 1);
  assert.ok(capture[0].text.includes('token=t9'));
});
