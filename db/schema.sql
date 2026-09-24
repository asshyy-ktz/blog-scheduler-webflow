-- blog-scheduler-webflow: local persistence schema (SQLite dialect; ANSI-friendly so another DB can be swapped in via server/db.ts)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS installations (
  site_id        TEXT PRIMARY KEY,
  timezone       TEXT NOT NULL DEFAULT 'UTC',          -- IANA zone; all timestamps are stored in UTC
  collection_id  TEXT,                                 -- mapped Blog collection
  field_map      TEXT NOT NULL DEFAULT '{}',           -- JSON: title/slug/body/author/publishDate -> CMS field slug
  panel_token    TEXT NOT NULL,                        -- secret used by the App Panel (X-Panel-Token)
  needs_reauth   INTEGER NOT NULL DEFAULT 0,
  webhook_ids    TEXT NOT NULL DEFAULT '[]',
  installed_at   TEXT NOT NULL,
  uninstalled_at TEXT
);

-- Ciphertext only (AES-256-GCM); see server/services/token-store.ts
CREATE TABLE IF NOT EXISTS oauth_tokens (
  site_id    TEXT PRIMARY KEY REFERENCES installations(site_id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id                TEXT PRIMARY KEY,
  site_id           TEXT NOT NULL REFERENCES installations(site_id) ON DELETE CASCADE,
  item_id           TEXT,                              -- Webflow CMS item id once a draft exists
  title             TEXT NOT NULL,
  slug              TEXT NOT NULL DEFAULT '',
  body              TEXT NOT NULL DEFAULT '',
  author            TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea','draft','review','scheduled','published')),
  scheduled_at      TEXT,                              -- UTC ISO-8601
  published_at      TEXT,                              -- UTC ISO-8601
  publish_state     TEXT NOT NULL DEFAULT 'idle' CHECK (publish_state IN ('idle','publishing','retrying','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT,
  last_error        TEXT,
  idempotency_key   TEXT,
  claimed_at        TEXT,
  is_archived       INTEGER NOT NULL DEFAULT 0,
  remote_updated_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_item ON posts(site_id, item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_calendar ON posts(site_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, publish_state, scheduled_at);

CREATE TABLE IF NOT EXISTS publish_runs (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES installations(site_id) ON DELETE CASCADE,
  trigger     TEXT NOT NULL CHECK (trigger IN ('poll','manual','recovery')),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  due_count   INTEGER NOT NULL DEFAULT 0,
  published   INTEGER NOT NULL DEFAULT 0,
  retried     INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_site ON publish_runs(site_id, started_at);

CREATE TABLE IF NOT EXISTS publish_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES publish_runs(id) ON DELETE CASCADE,
  site_id         TEXT NOT NULL REFERENCES installations(site_id) ON DELETE CASCADE,
  post_id         TEXT NOT NULL,
  item_id         TEXT,
  title           TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('published','recovered','retry','failed')),
  attempt         INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  message         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);
-- A given idempotency key can be recorded as successfully published at most once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_log_once ON publish_log(idempotency_key) WHERE outcome IN ('published','recovered');
CREATE INDEX IF NOT EXISTS idx_log_site ON publish_log(site_id, created_at);
