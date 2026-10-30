-- Offerly: вход по почте с кодом (без пароля)
CREATE TABLE IF NOT EXISTS login_codes (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL,
  attempts INTEGER DEFAULT 0, used_at TEXT, expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, -- SHA-256 от токена из cookie
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
