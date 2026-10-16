/* 数据库：better-sqlite3 + 版本化迁移（DESIGN §6）
 * - 开外键、WAL、busy_timeout；
 * - 迁移带版本号记录在 migrations 表，按序应用（不依赖 CREATE IF NOT EXISTS 的幂等性）；
 * - 所有查询使用预编译语句（DESIGN 10.2）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let Database;
try { Database = require('better-sqlite3'); }
catch (e) {
  throw new Error('better-sqlite3 未安装：请在 server/ 目录运行 npm install');
}

/* 迁移清单：只追加、不修改历史条目 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'init-m1-core',
    sql: `
      CREATE TABLE users (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        email_normalized   TEXT NOT NULL UNIQUE,
        password_hash      TEXT NOT NULL,
        email_verified_at  INTEGER,
        locale             TEXT NOT NULL DEFAULT 'en',
        timezone           TEXT NOT NULL DEFAULT 'UTC',
        created_at         INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        token_hash  TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at  INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE auth_tokens (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash  TEXT NOT NULL UNIQUE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
        expires_at  INTEGER NOT NULL,
        used_at     INTEGER,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id, purpose);

      CREATE TABLE child_profiles (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        nickname    TEXT NOT NULL,
        avatar_key  TEXT NOT NULL DEFAULT 'tangyuan',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_profiles_user ON child_profiles(user_id);

      CREATE TABLE attempts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id      INTEGER NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
        client_event_id TEXT NOT NULL,
        mode            TEXT NOT NULL CHECK (mode IN ('practice','challenge','mistakes')),
        difficulty      TEXT NOT NULL,
        level           INTEGER,
        passed          INTEGER NOT NULL DEFAULT 0,
        used_time_s     INTEGER,
        active_time_ms  INTEGER,
        created_at      INTEGER NOT NULL,   -- 客户端事件时间
        received_at     INTEGER NOT NULL,   -- 服务端接收时间
        UNIQUE (profile_id, client_event_id)
      );
      CREATE INDEX idx_attempts_profile ON attempts(profile_id, created_at);

      CREATE TABLE attempt_questions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id      INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        position        INTEGER NOT NULL,
        a               INTEGER NOT NULL,
        b               INTEGER NOT NULL,
        first_answer    INTEGER,
        final_answer    INTEGER,
        first_correct   INTEGER,
        final_correct   INTEGER NOT NULL DEFAULT 0,
        active_time_ms  INTEGER,
        UNIQUE (attempt_id, position),
        CHECK (a >= 1 AND a <= 99),
        CHECK (b >= 1 AND b <= 99)
      );

      CREATE TABLE wrong_questions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id    INTEGER NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
        a             INTEGER NOT NULL,
        b             INTEGER NOT NULL,
        user_answer   INTEGER,
        wrong_count   INTEGER NOT NULL DEFAULT 1 CHECK (wrong_count > 0),
        level         INTEGER,
        last_wrong_at INTEGER NOT NULL,
        UNIQUE (profile_id, a, b),
        CHECK (a >= 1 AND a <= 99),
        CHECK (b >= 1 AND b <= 99)
      );
    `
  }
];

function initDb(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');

  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );`);

  const applied = new Set(
    db.prepare('SELECT version FROM migrations').all().map(r => r.version)
  );
  const record = db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?,?,?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, Date.now());
    });
    tx();
  }
  return db;
}

module.exports = { initDb, MIGRATIONS };
