/* 激活码明文的静态加密（AES-256-GCM）。
 * 数据库只保存密文；密钥来自 TM_CODE_ENC_KEY，不随数据库/备份一起分发。
 * 兑换仍以 code_hash 查找，不依赖解密；解密只用于管理后台展示。 */
'use strict';

const crypto = require('node:crypto');
const config = require('./config');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

function encryptCode(plain) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, config.codeEncKey, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}

function decryptCode(blob) {
  if (!blob) return null;
  const parts = String(blob).split('.');
  if (parts.length !== 3) return null;
  const [iv, tag, data] = parts.map(p => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv(ALGO, config.codeEncKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encryptCode, decryptCode };
