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
  },
  {
    version: 2,
    name: 'google-login',
    sql: `
      ALTER TABLE users ADD COLUMN google_id TEXT;
      -- 部分唯一索引：google_id 为空（纯密码账号）不受约束
      CREATE UNIQUE INDEX idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;
    `
  },
  {
    /* M1.5 Live Race（DESIGN §6、§13.3）
     * attempts 需要容纳 mode='versus'，但 SQLite 不能直接修改 CHECK 约束，
     * 因此按「建新表 → 拷贝 → 删旧表 → 改名」重建；迁移期间 foreign_keys 关闭
     * （见 initDb），否则 DROP TABLE 会级联删掉 attempt_questions 的历史数据。 */
    version: 3,
    name: 'live-race',
    sql: `
      CREATE TABLE attempts_v3 (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id      INTEGER NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
        client_event_id TEXT NOT NULL,
        mode            TEXT NOT NULL CHECK (mode IN ('practice','challenge','mistakes','versus')),
        difficulty      TEXT NOT NULL,
        level           INTEGER,
        passed          INTEGER NOT NULL DEFAULT 0,
        used_time_s     INTEGER,
        active_time_ms  INTEGER,
        created_at      INTEGER NOT NULL,
        received_at     INTEGER NOT NULL,
        UNIQUE (profile_id, client_event_id)
      );
      INSERT INTO attempts_v3
        (id, profile_id, client_event_id, mode, difficulty, level, passed, used_time_s, active_time_ms, created_at, received_at)
        SELECT id, profile_id, client_event_id, mode, difficulty, level, passed, used_time_s, active_time_ms, created_at, received_at
        FROM attempts;
      DROP TABLE attempts;
      ALTER TABLE attempts_v3 RENAME TO attempts;
      CREATE INDEX idx_attempts_profile ON attempts(profile_id, created_at);

      -- 对局主体：仅登录档案落库；游客对局全程在内存里
      CREATE TABLE matches (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code   TEXT NOT NULL,
        mode        TEXT NOT NULL DEFAULT 'versus' CHECK (mode = 'versus'),
        difficulty  TEXT NOT NULL,
        count       INTEGER NOT NULL,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER NOT NULL
      );

      -- 座位与名次；display_name 是系统生成名，不是儿童档案昵称（DESIGN 13.0）
      CREATE TABLE match_players (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id     INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        profile_id   INTEGER NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
        seat         INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        solved       INTEGER NOT NULL DEFAULT 0,
        used_ms      INTEGER,
        rank         INTEGER,
        disconnected INTEGER NOT NULL DEFAULT 0,
        UNIQUE (match_id, seat)
      );
      CREATE INDEX idx_match_players_profile ON match_players(profile_id);
    `
  },
  {
    /* M2 权益表（DESIGN §6）：会员权益以 entitlements 为准，不使用 users.plan 字段。
     * source_type/source_id 记录来源，退款时只撤销该来源的权益，不影响其他有效来源。
     * orders / payment_events 表随支付渠道接入时另行迁移。 */
    version: 4,
    name: 'entitlements',
    sql: `
      CREATE TABLE entitlements (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        feature_key TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('order','redeem','grant')),
        source_id   TEXT,
        starts_at   INTEGER NOT NULL,
        expires_at  INTEGER,
        revoked_at  INTEGER
      );
      CREATE INDEX idx_entitlements_user_feature ON entitlements(user_id, feature_key);
    `
  }
];

function initDb(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  /* 迁移期间关闭外键：重建表（DROP TABLE attempts）在开启外键时会级联删除子表数据。
   * PRAGMA foreign_keys 不能在事务内修改，因此必须在跑迁移之前设置。 */
  db.pragma('foreign_keys = OFF');

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

  db.pragma('foreign_keys = ON');
  // 迁移后自检：外键不一致说明重建过程出了问题，宁可启动失败也不带病运行
  const violations = db.pragma('foreign_key_check');
  if (violations.length) {
    throw new Error('数据库外键校验失败：' + JSON.stringify(violations.slice(0, 5)));
  }
  return db;
}

module.exports = { initDb, MIGRATIONS };
