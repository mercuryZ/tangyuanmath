'use strict';
/* 数据库备份（DESIGN 12.2）：加密、校验、保留期与密钥文件 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
/* 测试文件本身不在 server/ 下，按 server 的依赖解析 better-sqlite3 */
const { createRequire } = require('node:module');
const requireServer = createRequire(path.join(__dirname, '..', 'server', 'package.json'));
const Database = requireServer('better-sqlite3');

process.env.TM_BACKUP_KEY = '';

const { initDb } = require('../server/src/db');
const backup = require('../server/src/backup');

const DAY = 24 * 3600 * 1000;
const KEY = 'unit-test-passphrase';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-backup-'));
  const dbFile = path.join(dir, 'app.db');
  const db = initDb(dbFile);
  db.prepare('INSERT INTO users (email_normalized, password_hash, created_at) VALUES (?,?,?)')
    .run('parent@example.com', 'hash', Date.now());
  return {
    dir,
    dbFile,
    db,
    backupDir: path.join(dir, 'backups'),
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function readUserCount(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT count(*) AS n FROM users').get().n; }
  finally { db.close(); }
}

test('createBackup：密文落盘、可解密、校验通过', async () => {
  const f = fixture();
  try {
    const now = Date.UTC(2026, 9, 20, 3, 15, 0); // 2026-10-20T03:15:00Z
    const info = await backup.createBackup(f.db, {
      dbFile: f.dbFile, backupDir: f.backupDir, key: KEY, retentionDays: 30, now, log: null
    });

    assert.strictEqual(info.name, 'tangyuan-20261020T031500Z.db.enc');
    assert.ok(info.bytes > 0);
    const raw = fs.readFileSync(info.file);
    assert.ok(!raw.includes(Buffer.from('SQLite format 3')), '明文 SQLite 头不应出现在备份里');
    assert.ok(raw.subarray(0, 4).equals(Buffer.from('TMBK')));

    assert.strictEqual(await backup.verifyBackupFile(info.file, KEY), true);

    const out = path.join(f.dir, 'restored.db');
    await backup.decryptFile(info.file, out, KEY);
    assert.strictEqual(readUserCount(out), 1);
  } finally {
    f.cleanup();
  }
});

test('decryptFile：错误密钥被拒绝，且不留下半成品文件', async () => {
  const f = fixture();
  try {
    const info = await backup.createBackup(f.db, {
      dbFile: f.dbFile, backupDir: f.backupDir, key: KEY, log: null
    });
    const out = path.join(f.dir, 'wrong.db');
    await assert.rejects(() => backup.decryptFile(info.file, out, 'not-the-key'), /密钥错误|损坏/);
    assert.strictEqual(fs.existsSync(out), false);
  } finally {
    f.cleanup();
  }
});

test('verifyBackupFile：篡改后的文件校验失败', async () => {
  const f = fixture();
  try {
    const info = await backup.createBackup(f.db, {
      dbFile: f.dbFile, backupDir: f.backupDir, key: KEY, log: null
    });
    const buf = fs.readFileSync(info.file);
    buf[buf.length - 20] ^= 0xff; // 改到密文区，GCM 校验应失败
    fs.writeFileSync(info.file, buf);
    await assert.rejects(() => backup.verifyBackupFile(info.file, KEY), /密钥错误|损坏/);
  } finally {
    f.cleanup();
  }
});

test('pruneBackups：只删除超过保留期、符合命名规则的备份', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    await backup.createBackup(f.db, {
      dbFile: f.dbFile, backupDir: f.backupDir, key: KEY, retentionDays: 365,
      now: now - 40 * DAY, log: null
    });
    await backup.createBackup(f.db, {
      dbFile: f.dbFile, backupDir: f.backupDir, key: KEY, retentionDays: 365,
      now, log: null
    });
    const unrelated = path.join(f.backupDir, 'notes.txt');
    fs.writeFileSync(unrelated, 'keep me');

    const deleted = await backup.pruneBackups(f.backupDir, 30, now, null);

    assert.strictEqual(deleted.length, 1);
    assert.ok(deleted[0].startsWith('tangyuan-'));
    const left = await backup.listBackups(f.backupDir);
    assert.strictEqual(left.length, 1);
    assert.ok(now - left[0].createdAt < DAY);
    assert.strictEqual(fs.existsSync(unrelated), true, '不删除非备份文件');
  } finally {
    f.cleanup();
  }
});

test('未设置密钥时自动生成 backup.key，并复用同一密钥', async () => {
  const f = fixture();
  try {
    const info1 = await backup.createBackup(f.db, {
      dbFile: f.dbFile, backupDir: f.backupDir, log: null
    });
    const keyFile = path.join(f.backupDir, backup.KEY_FILE);
    assert.strictEqual(fs.existsSync(keyFile), true);
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    assert.ok(key.length >= 32);

    const info2 = await backup.createBackup(f.db, {
      dbFile: f.dbFile, backupDir: f.backupDir, now: Date.now() + 1000, log: null
    });
    assert.notStrictEqual(info1.name, info2.name);
    assert.strictEqual(await backup.verifyBackupFile(info1.file, key), true);
    assert.strictEqual(await backup.verifyBackupFile(info2.file, key), true);
  } finally {
    f.cleanup();
  }
});

test('调度器：到期时自动创建备份', async () => {
  const f = fixture();
  try {
    const stop = backup.startBackupScheduler(f.db, {
      dbFile: f.dbFile, backupDir: f.backupDir, key: KEY, log: null,
      initialDelayMs: 5, intervalHours: 24
    });
    await new Promise(resolve => setTimeout(resolve, 600));
    stop();

    const items = await backup.listBackups(f.backupDir);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(await backup.verifyBackupFile(items[0].file, KEY), true);
  } finally {
    f.cleanup();
  }
});

test('isBackupDue：无备份或超过间隔时为 true', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    assert.strictEqual(await backup.isBackupDue(f.backupDir, now, 24), true);

    await backup.createBackup(f.db, {
      dbFile: f.dbFile, backupDir: f.backupDir, key: KEY, now: now - 2 * 3600 * 1000, log: null
    });
    assert.strictEqual(await backup.isBackupDue(f.backupDir, now, 24), false);
    assert.strictEqual(await backup.isBackupDue(f.backupDir, now + 23 * 3600 * 1000, 24), true);
  } finally {
    f.cleanup();
  }
});
