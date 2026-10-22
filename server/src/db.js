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
  },
  {
    /* 家庭会员（DESIGN §5、§6、§8）
     * - 家庭上限：2 位家长 + 2 名子女（在应用层强制）；
     * - 既有用户即家庭（family.id = users.id），迁移与回填全部用纯 SQL；
     * - 子女通过用户名 + 密码登录，会话与家长会话共用 sessions 表；
     * - 权益改为家庭维度，source_type 增加 promo（上线赠送 3 个月）。 */
    version: 5,
    name: 'families',
    sql: `
      CREATE TABLE families (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at  INTEGER NOT NULL,
        is_personal INTEGER NOT NULL DEFAULT 1 CHECK (is_personal IN (0,1))
      );

      INSERT INTO families (id, created_at, is_personal)
        SELECT id, created_at, 1 FROM users;

      ALTER TABLE users ADD COLUMN family_id INTEGER REFERENCES families(id) ON DELETE SET NULL;
      ALTER TABLE users ADD COLUMN family_role TEXT NOT NULL DEFAULT 'owner'
        CHECK (family_role IN ('owner','coparent'));
      UPDATE users SET family_id = id, family_role = 'owner';
      CREATE INDEX idx_users_family ON users(family_id);
      CREATE UNIQUE INDEX idx_users_family_owner ON users(family_id) WHERE family_role = 'owner';

      ALTER TABLE child_profiles ADD COLUMN family_id INTEGER REFERENCES families(id) ON DELETE CASCADE;
      ALTER TABLE child_profiles ADD COLUMN username TEXT;
      ALTER TABLE child_profiles ADD COLUMN username_normalized TEXT;
      ALTER TABLE child_profiles ADD COLUMN password_hash TEXT;
      ALTER TABLE child_profiles ADD COLUMN last_login_at INTEGER;
      UPDATE child_profiles
        SET family_id = (SELECT family_id FROM users WHERE users.id = child_profiles.user_id);
      CREATE INDEX idx_profiles_family ON child_profiles(family_id);
      CREATE UNIQUE INDEX idx_profiles_username ON child_profiles(username_normalized)
        WHERE username_normalized IS NOT NULL;

      CREATE TABLE family_invites (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        family_id        INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
        email_normalized TEXT NOT NULL,
        token_hash       TEXT NOT NULL UNIQUE,
        invited_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at       INTEGER NOT NULL,
        accepted_at      INTEGER,
        accepted_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        revoked_at       INTEGER,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_family_invites_family ON family_invites(family_id, accepted_at);
      CREATE UNIQUE INDEX idx_family_invites_pending
        ON family_invites(family_id, email_normalized)
        WHERE accepted_at IS NULL AND revoked_at IS NULL;

      CREATE TABLE sessions_v5 (
        token_hash       TEXT PRIMARY KEY,
        user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
        child_profile_id INTEGER REFERENCES child_profiles(id) ON DELETE CASCADE,
        expires_at       INTEGER NOT NULL,
        created_at       INTEGER NOT NULL,
        CHECK ((user_id IS NOT NULL) + (child_profile_id IS NOT NULL) = 1)
      );
      INSERT INTO sessions_v5 (token_hash, user_id, child_profile_id, expires_at, created_at)
        SELECT token_hash, user_id, NULL, expires_at, created_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v5 RENAME TO sessions;
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE INDEX idx_sessions_child ON sessions(child_profile_id);

      CREATE TABLE entitlements_v5 (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        family_id   INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
        user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        feature_key TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('order','redeem','grant','promo')),
        source_id   TEXT,
        starts_at   INTEGER NOT NULL,
        expires_at  INTEGER,
        revoked_at  INTEGER
      );
      INSERT INTO entitlements_v5
        (id, family_id, user_id, feature_key, source_type, source_id, starts_at, expires_at, revoked_at)
        SELECT e.id, u.family_id, e.user_id, e.feature_key, e.source_type, e.source_id,
               e.starts_at, e.expires_at, e.revoked_at
        FROM entitlements e JOIN users u ON u.id = e.user_id;
      DROP TABLE entitlements;
      ALTER TABLE entitlements_v5 RENAME TO entitlements;
      CREATE INDEX idx_entitlements_family_feature ON entitlements(family_id, feature_key);
      -- 旧 CLI 允许重复授予；先去重再建幂等唯一索引
      DELETE FROM entitlements
        WHERE source_id IS NOT NULL AND revoked_at IS NULL
          AND id NOT IN (
            SELECT MIN(id) FROM entitlements
            WHERE source_id IS NOT NULL AND revoked_at IS NULL
            GROUP BY family_id, feature_key, source_type, source_id
          );
      CREATE UNIQUE INDEX idx_entitlements_source
        ON entitlements(family_id, feature_key, source_type, source_id)
        WHERE source_id IS NOT NULL AND revoked_at IS NULL;

      -- 上线赠送：每个既有家庭 3 个月 Supporter
      INSERT OR IGNORE INTO entitlements
        (family_id, user_id, feature_key, source_type, source_id, starts_at, expires_at)
        SELECT f.id,
               (SELECT id FROM users WHERE users.family_id = f.id AND users.family_role = 'owner' LIMIT 1),
               k.feature_key, 'promo', 'launch-2026',
               CAST(strftime('%s','now') AS INTEGER) * 1000,
               CAST(strftime('%s','now','+3 months') AS INTEGER) * 1000
        FROM families f
        CROSS JOIN (
          SELECT 'pdf_worksheet' AS feature_key
          UNION ALL SELECT 'celebration_image'
          UNION ALL SELECT 'live_race'
        ) k;
    `
  },
  {
    /* Waffo Pancake 托管结账（DESIGN §6、§8.4）
     * - orders：本站订单，金额存最小货币单位；order_no 同时作为 Waffo 的
     *   orderMerchantExternalId / metadata.orderNo，webhook 靠它找回家庭；
     * - payment_events：按 (provider, event_id) 去重，保证 webhook 重试幂等；
     * - 权益仍写 entitlements，source_type='order'、source_id=orders.order_no。 */
    version: 6,
    name: 'waffo-orders',
    sql: `
      CREATE TABLE orders (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no               TEXT NOT NULL UNIQUE,
        family_id              INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
        purchased_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sku                    TEXT NOT NULL CHECK (sku IN
                                 ('supporter_monthly','supporter_yearly','supporter_lifetime')),
        amount_minor           INTEGER NOT NULL CHECK (amount_minor > 0),
        currency               TEXT NOT NULL CHECK (currency IN ('USD')),
        status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                                 ('pending','paid','canceling','past_due','canceled',
                                  'failed','expired','refunded','partially_refunded','disputed')),
        provider               TEXT NOT NULL DEFAULT 'waffo',
        provider_checkout_id   TEXT,
        provider_order_id      TEXT,
        provider_payment_id    TEXT,
        mode                   TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','prod')),
        current_period_end     INTEGER,
        last_event_at          INTEGER,
        expires_at             INTEGER,
        paid_at                INTEGER,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      );
      CREATE INDEX idx_orders_family ON orders(family_id, created_at);
      CREATE UNIQUE INDEX idx_orders_provider_checkout
        ON orders(provider, provider_checkout_id)
        WHERE provider_checkout_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_orders_provider_order
        ON orders(provider, provider_order_id)
        WHERE provider_order_id IS NOT NULL;

      CREATE TABLE payment_events (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        provider          TEXT NOT NULL,
        event_id          TEXT NOT NULL,
        event_type        TEXT NOT NULL,
        order_no          TEXT,
        processing_status TEXT NOT NULL CHECK (processing_status IN ('processed','ignored')),
        reason            TEXT,
        processed_at      INTEGER NOT NULL,
        UNIQUE (provider, event_id)
      );
      CREATE INDEX idx_payment_events_order ON payment_events(order_no, processed_at);
    `
  },
  {
    /* $1 尝鲜（7 天）：orders.sku 的 CHECK 枚举需要纳入 supporter_trial7。
     * SQLite 不能直接改 CHECK，按「建新表 → 拷贝 → 删旧表 → 改名」重建（同 v3 做法）。
     * 迁移期间外键关闭（见 initDb），DROP 不会级联；payment_events.order_no 只是文本无外键。 */
    version: 7,
    name: 'trial-sku',
    sql: `
      CREATE TABLE orders_v7 (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no               TEXT NOT NULL UNIQUE,
        family_id              INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
        purchased_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sku                    TEXT NOT NULL CHECK (sku IN
                                 ('supporter_trial7','supporter_monthly','supporter_yearly',
                                  'supporter_lifetime')),
        amount_minor           INTEGER NOT NULL CHECK (amount_minor > 0),
        currency               TEXT NOT NULL CHECK (currency IN ('USD')),
        status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                                 ('pending','paid','canceling','past_due','canceled',
                                  'failed','expired','refunded','partially_refunded','disputed')),
        provider               TEXT NOT NULL DEFAULT 'waffo',
        provider_checkout_id   TEXT,
        provider_order_id      TEXT,
        provider_payment_id    TEXT,
        mode                   TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','prod')),
        current_period_end     INTEGER,
        last_event_at          INTEGER,
        expires_at             INTEGER,
        paid_at                INTEGER,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      );
      INSERT INTO orders_v7
        (id, order_no, family_id, purchased_by, sku, amount_minor, currency, status,
         provider, provider_checkout_id, provider_order_id, provider_payment_id, mode,
         current_period_end, last_event_at, expires_at, paid_at, created_at, updated_at)
      SELECT id, order_no, family_id, purchased_by, sku, amount_minor, currency, status,
             provider, provider_checkout_id, provider_order_id, provider_payment_id, mode,
             current_period_end, last_event_at, expires_at, paid_at, created_at, updated_at
      FROM orders;
      DROP TABLE orders;
      ALTER TABLE orders_v7 RENAME TO orders;
      CREATE INDEX idx_orders_family ON orders(family_id, created_at);
      CREATE UNIQUE INDEX idx_orders_provider_checkout
        ON orders(provider, provider_checkout_id)
        WHERE provider_checkout_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_orders_provider_order
        ON orders(provider, provider_order_id)
        WHERE provider_order_id IS NOT NULL;
    `
  },
  {
    /* 优惠码（DESIGN §6 redeem_codes）：库存只存哈希（sha256，与 sessions/invites 同一套），
     * 明文码仅在创建响应里出现一次。单次使用；兑换写 entitlements source_type='redeem'。
     * expires_at 双职责：码本身的兑换截止；被管理端禁用时置为当前时间。 */
    version: 8,
    name: 'redeem-codes',
    sql: `
      CREATE TABLE redeem_codes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash       TEXT NOT NULL UNIQUE,
        sku             TEXT NOT NULL CHECK (sku IN
                          ('supporter_trial7','supporter_monthly','supporter_yearly',
                           'supporter_lifetime')),
        note            TEXT,
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      INTEGER NOT NULL,
        expires_at      INTEGER,
        used_family_id  INTEGER REFERENCES families(id) ON DELETE SET NULL,
        used_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        used_at         INTEGER
      );
      CREATE INDEX idx_redeem_codes_created ON redeem_codes(created_at DESC);
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
