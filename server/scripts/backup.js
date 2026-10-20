#!/usr/bin/env node
/* 备份运维 CLI（DESIGN 12.2）
 *
 *   node scripts/backup.js now                    立即生成一份加密备份
 *   node scripts/backup.js list                   列出备份
 *   node scripts/backup.js verify [文件名]        解密并跑 integrity_check（默认最新一份）
 *   node scripts/backup.js decrypt 文件名 输出路径  解密出 .db 供恢复（默认拒绝覆盖）
 *   node scripts/backup.js prune                  按保留天数清理
 *
 * 恢复流程见 README「Backups」一节：停服务 → 解密 → 校验 → 替换 app.db →
 * 删除 app.db-wal / app.db-shm → 启动（启动时会自动补齐迁移）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const config = require('../src/config');
const backup = require('../src/backup');

const dbFile = config.dbFile;
const backupDir = config.backupDir || backup.defaultBackupDir(dbFile);

function options(extra) {
  return Object.assign({
    dbFile,
    backupDir,
    key: config.backupKey || undefined,
    retentionDays: config.backupRetentionDays,
    log: console
  }, extra || {});
}

function openDatabase() {
  if (!fs.existsSync(dbFile)) throw new Error('数据库不存在：' + dbFile);
  const db = new Database(dbFile, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

function backupFile(name) {
  const base = path.basename(String(name || ''));
  if (!backup.FILE_RE.test(base)) throw new Error('不是备份文件名：' + name);
  return path.join(backupDir, base);
}

async function newestBackup() {
  const items = await backup.listBackups(backupDir);
  if (!items.length) throw new Error('还没有备份：' + backupDir);
  return items[0];
}

function formatDate(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

async function main() {
  const mode = process.argv[2] || 'now';

  if (mode === 'now') {
    const db = openDatabase();
    try {
      const info = await backup.createBackup(db, options());
      console.log('已创建 ' + info.file + ' (' + backup.formatBytes(info.bytes) + ')');
      if (info.pruned.length) console.log('已清理 ' + info.pruned.length + ' 份过期备份');
    } finally {
      db.close();
    }
    return;
  }

  if (mode === 'list') {
    const items = await backup.listBackups(backupDir);
    if (!items.length) {
      console.log('还没有备份：' + backupDir);
      return;
    }
    console.log('目录：' + backupDir);
    for (const it of items) {
      console.log('  ' + formatDate(it.createdAt) + '  ' + backup.formatBytes(it.size).padStart(9) + '  ' + it.name);
    }
    return;
  }

  if (mode === 'verify') {
    const target = process.argv[3] ? backupFile(process.argv[3]) : (await newestBackup()).file;
    const { key } = await backup.resolveKey(options());
    await backup.verifyBackupFile(target, key);
    console.log('校验通过：' + target);
    return;
  }

  if (mode === 'decrypt') {
    const name = process.argv[3];
    const out = process.argv[4];
    if (!name || !out) throw new Error('用法：node scripts/backup.js decrypt <备份文件> <输出.db>');
    if (fs.existsSync(out) && !process.argv.includes('--force')) {
      throw new Error('输出文件已存在（加 --force 覆盖）：' + out);
    }
    if (fs.existsSync(out)) fs.rmSync(out);
    const { key } = await backup.resolveKey(options());
    await backup.decryptFile(backupFile(name), out, key);
    console.log('已解密到 ' + out);
    console.log('恢复前请停止服务，并删除目标库旁边的 -wal / -shm 文件。');
    return;
  }

  if (mode === 'prune') {
    const deleted = await backup.pruneBackups(backupDir, config.backupRetentionDays, Date.now(), console);
    console.log('已清理 ' + deleted.length + ' 份过期备份');
    return;
  }

  if (mode === 'help' || mode === '--help' || mode === '-h') {
    console.log('用法：node scripts/backup.js [now|list|verify|decrypt|prune]');
    console.log('  now                       立即备份');
    console.log('  list                      列出备份');
    console.log('  verify [文件名]           解密并校验（默认最新一份）');
    console.log('  decrypt <文件名> <输出>   解密出 .db');
    console.log('  prune                     清理超过保留期的备份');
    return;
  }

  throw new Error('未知命令：' + mode + '（可用：now / list / verify / decrypt / prune）');
}

main().catch(err => {
  console.error('备份命令失败：' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
