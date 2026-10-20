/* 数据库自动备份（DESIGN 12.2）
 * - 用 better-sqlite3 的在线备份 API（SQLite Online Backup）导出，不直接复制正在写入的 .db 文件；
 * - 落盘前用 scrypt 派生密钥 + AES-256-GCM 加密；
 * - 默认每天一次、保留 30 天；每次创建后立刻解密并跑 integrity_check / foreign_key_check；
 * - 调度器跑在 Web 进程内（单实例部署），失败只记日志，绝不拖垮服务。
 *
 * 密钥来源优先级：调用参数 → TM_BACKUP_KEY → <backupDir>/backup.key（首次自动生成）。
 * 自动生成的密钥与备份同盘，只防备份文件被单独拷走后泄露；灾难恢复时请把
 * TM_BACKUP_KEY 设在服务端环境变量里，或另行离线保存 backup.key。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');

const config = require('./config');

const MAGIC = Buffer.from('TMBK');
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + 1 + SALT_LEN + 1 + IV_LEN; // 35
const FILE_RE = /^tangyuan-(\d{8})T(\d{6})Z\.db\.enc$/;
const KEY_FILE = 'backup.key';
const DAY_MS = 24 * 3600 * 1000;

let warnedAboutKeyFile = false;

/* ---------- 目录 / 文件 ---------- */

function defaultBackupDir(dbFile) {
  return path.join(path.dirname(dbFile), 'backups');
}

async function ensureBackupDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(dir, 0o700); } catch (e) { /* Windows 等平台忽略 */ }
}

/* 进程被强杀时可能留下临时明文/半成品密文；一小时后清掉，避免明文长期占用磁盘。
 * 正式备份只在加密并通过校验后才改成 tangyuan-*.db.enc，所以列表里不会出现半成品。 */
async function cleanStaleTemps(dir, now) {
  let entries;
  try { entries = await fsp.readdir(dir); } catch (e) { return; }
  for (const name of entries) {
    if (!/^\.tmp-[0-9a-f]+\.(db|enc)$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = await fsp.stat(file);
      if (now - st.mtimeMs > 3600 * 1000) await fsp.rm(file, { force: true });
    } catch (e) { /* 已被其他进程清理 */ }
  }
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatStamp(date) {
  return date.getUTCFullYear() + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate()) +
    'T' + pad2(date.getUTCHours()) + pad2(date.getUTCMinutes()) + pad2(date.getUTCSeconds()) + 'Z';
}

function parseStamp(name) {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const s = m[1] + m[2]; // YYYYMMDDHHMMSS
  return Date.UTC(
    Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)),
    Number(s.slice(8, 10)), Number(s.slice(10, 12)), Number(s.slice(12, 14))
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ---------- 密钥 ---------- */

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 16384, r: 8, p: 1 });
}

/* 返回 { key, source }。TM_BACKUP_KEY 由运维设置；未设置时用同目录密钥文件，
 * 保证开箱即用，同时反复提醒密钥必须离开这台机器保存。 */
async function resolveKey(opts) {
  if (opts.key) return { key: String(opts.key), source: 'option' };
  if (config.backupKey) return { key: String(config.backupKey), source: 'env' };

  const file = path.join(opts.backupDir, KEY_FILE);
  try {
    const existing = (await fsp.readFile(file, 'utf8')).trim();
    if (existing) return { key: existing, source: 'file' };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const generated = crypto.randomBytes(32).toString('base64');
  try {
    await fsp.writeFile(file, generated + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return { key: (await fsp.readFile(file, 'utf8')).trim(), source: 'file' };
  }
  return { key: generated, source: 'generated' };
}

/* ---------- 加密格式：TMBK | ver | saltLen | salt | ivLen | iv | ciphertext | tag ---------- */

function buildHeader(salt, iv) {
  return Buffer.concat([
    MAGIC, Buffer.from([VERSION, salt.length]), salt, Buffer.from([iv.length]), iv
  ]);
}

function parseHeader(buf) {
  if (buf.length < HEADER_LEN) throw new Error('备份文件过短，格式不正确');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是有效的 Tangyuan Math 备份文件');
  if (buf[4] !== VERSION) throw new Error('不支持的备份格式版本：' + buf[4]);
  const saltLen = buf[5];
  const ivLen = buf[6 + saltLen];
  if (saltLen !== SALT_LEN || ivLen !== IV_LEN || buf.length !== HEADER_LEN) {
    throw new Error('备份文件头损坏');
  }
  return {
    header: buf.subarray(0, HEADER_LEN),
    salt: buf.subarray(6, 6 + saltLen),
    iv: buf.subarray(7 + saltLen, 7 + saltLen + ivLen)
  };
}

async function readAt(file, length, position) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    if (bytesRead !== length) throw new Error('备份文件被截断');
    return buf;
  } finally {
    await fh.close();
  }
}

async function encryptFile(src, dest, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const header = buildHeader(salt, iv);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  cipher.setAAD(header);

  await fsp.writeFile(dest, header, { mode: 0o600, flag: 'wx' });
  try {
    await pipeline(
      fs.createReadStream(src),
      cipher,
      fs.createWriteStream(dest, { flags: 'a', mode: 0o600 })
    );
    await fsp.appendFile(dest, cipher.getAuthTag());
  } catch (err) {
    await fsp.rm(dest, { force: true });
    throw err;
  }
}

async function decryptFile(src, dest, passphrase) {
  const st = await fsp.stat(src);
  if (st.size < HEADER_LEN + TAG_LEN) throw new Error('备份文件过短，格式不正确');

  const head = await readAt(src, HEADER_LEN, 0);
  const { header, salt, iv } = parseHeader(head);
  const tag = await readAt(src, TAG_LEN, st.size - TAG_LEN);

  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);

  try {
    await pipeline(
      fs.createReadStream(src, { start: HEADER_LEN, end: st.size - TAG_LEN - 1 }),
      decipher,
      fs.createWriteStream(dest, { mode: 0o600, flag: 'wx' })
    );
  } catch (err) {
    await fsp.rm(dest, { force: true });
    // GCM 校验失败时 OpenSSL 的报错不直观，换成可操作的提示
    if (err && (err.code === 'ERR_OSSL_BAD_DECRYPT' || /bad decrypt|Unsupported state/i.test(err.message))) {
      throw new Error('解密失败：密钥错误或备份文件已损坏');
    }
    throw err;
  }
}

/* ---------- 校验 / 列表 / 清理 ---------- */

async function verifyBackupFile(file, passphrase) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-backup-verify-'));
  const plain = path.join(dir, 'verify.db');
  try {
    await decryptFile(file, plain, passphrase);
    const db = new Database(plain, { readonly: true, fileMustExist: true });
    try {
      const integrity = db.pragma('integrity_check');
      if (!integrity.length || integrity[0].integrity_check !== 'ok') {
        throw new Error('integrity_check 未通过：' + JSON.stringify(integrity.slice(0, 3)));
      }
      const fk = db.pragma('foreign_key_check');
      if (fk.length) throw new Error('外键校验未通过：' + JSON.stringify(fk.slice(0, 3)));
    } finally {
      db.close();
    }
    return true;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function listBackups(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const createdAt = parseStamp(ent.name);
    if (createdAt === null) continue;
    const stat = await fsp.stat(path.join(dir, ent.name));
    out.push({ name: ent.name, file: path.join(dir, ent.name), size: stat.size, createdAt });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function pruneBackups(dir, retentionDays, now, log) {
  const cutoff = now - retentionDays * DAY_MS;
  const deleted = [];
  for (const b of await listBackups(dir)) {
    if (b.createdAt >= cutoff) continue;
    await fsp.rm(b.file, { force: true });
    deleted.push(b.name);
    if (log && log.log) log.log('[backup] pruned ' + b.name);
  }
  return deleted;
}

/* 最近一份备份是否已经超过备份间隔（调度器每小时检查一次，避免定时器漂移）。 */
async function isBackupDue(dir, now, intervalHours) {
  const newest = (await listBackups(dir))[0];
  if (!newest) return true;
  return now - newest.createdAt >= intervalHours * 3600 * 1000;
}

/* ---------- 创建备份 ---------- */

function normalizeOptions(opts) {
  opts = opts || {};
  const dbFile = opts.dbFile || config.dbFile;
  const backupDir = opts.backupDir || config.backupDir || defaultBackupDir(dbFile);
  return {
    dbFile,
    backupDir,
    key: opts.key,
    retentionDays: opts.retentionDays || config.backupRetentionDays || 30,
    log: opts.log || console,
    now: opts.now === undefined ? Date.now() : (opts.now instanceof Date ? opts.now.getTime() : opts.now)
  };
}

async function createBackup(db, opts) {
  const o = normalizeOptions(opts);
  if (o.dbFile === ':memory:') throw new Error('内存数据库无法备份');

  await ensureBackupDir(o.backupDir);
  const { key, source } = await resolveKey(o);
  if (source === 'generated' && !warnedAboutKeyFile) {
    warnedAboutKeyFile = true;
    if (o.log && o.log.warn) {
      o.log.warn('[backup] TM_BACKUP_KEY 未设置，已生成 ' + path.join(o.backupDir, KEY_FILE) +
        '；请把这个密钥另行离线保存，否则磁盘损坏时备份无法恢复。');
    }
  }

  await cleanStaleTemps(o.backupDir, o.now);

  const tempPlain = path.join(o.backupDir, '.tmp-' + crypto.randomBytes(8).toString('hex') + '.db');
  const tempEnc = path.join(o.backupDir, '.tmp-' + crypto.randomBytes(8).toString('hex') + '.enc');
  let dest = null;
  try {
    await db.backup(tempPlain);

    let stamp = new Date(o.now);
    for (let i = 0; i < 60; i++) {
      const candidate = path.join(o.backupDir, 'tangyuan-' + formatStamp(stamp) + '.db.enc');
      if (!fs.existsSync(candidate)) { dest = candidate; break; }
      stamp = new Date(stamp.getTime() + 1000);
    }
    if (!dest) throw new Error('无法生成不重复的备份文件名');

    await encryptFile(tempPlain, tempEnc, key);
    try {
      await verifyBackupFile(tempEnc, key);
    } catch (err) {
      throw new Error('备份校验失败：' + err.message);
    }
    // 只有完整且通过校验的密文才会进入正式文件名，避免半成品被当成最新备份
    await fsp.rename(tempEnc, dest);
  } catch (err) {
    await fsp.rm(tempEnc, { force: true });
    throw err;
  } finally {
    await fsp.rm(tempPlain, { force: true });
  }

  const stat = await fsp.stat(dest);
  const pruned = await pruneBackups(o.backupDir, o.retentionDays, o.now, o.log);
  return {
    name: path.basename(dest),
    file: dest,
    bytes: stat.size,
    createdAt: o.now,
    pruned
  };
}

/* ---------- 调度器 ---------- */

/* 每小时检查一次：距最近备份不足 intervalHours 就跳过；启动后 30 秒做首次检查
 * （新部署/停机一天以上会立刻补一份）。返回停止函数，便于测试或优雅退出。 */
function startBackupScheduler(db, opts) {
  const o = normalizeOptions(opts);
  if (!db || o.dbFile === ':memory:') return () => {};
  const intervalHours = (opts && opts.intervalHours) || config.backupIntervalHours || 24;
  const log = o.log;
  let running = false;

  async function check() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      if (!(await isBackupDue(o.backupDir, now, intervalHours))) return;
      const info = await createBackup(db, Object.assign({}, o, { now }));
      if (log && log.log) {
        log.log('[backup] created ' + info.name + ' (' + formatBytes(info.bytes) + ')' +
          (info.pruned.length ? ', pruned ' + info.pruned.length : ''));
      }
    } catch (err) {
      if (log && log.error) log.error('[backup] failed:', err && err.message ? err.message : err);
    } finally {
      running = false;
    }
  }

  const initial = setTimeout(check, (opts && opts.initialDelayMs) || 30000);
  const timer = setInterval(check, 3600 * 1000);
  if (initial.unref) initial.unref();
  if (timer.unref) timer.unref();
  return () => { clearTimeout(initial); clearInterval(timer); };
}

module.exports = {
  createBackup,
  decryptFile,
  defaultBackupDir,
  formatBytes,
  isBackupDue,
  listBackups,
  pruneBackups,
  resolveKey,
  startBackupScheduler,
  verifyBackupFile,
  FILE_RE,
  KEY_FILE
};
