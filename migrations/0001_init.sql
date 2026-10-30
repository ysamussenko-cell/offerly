-- Offerly: исходная схема
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, locale TEXT DEFAULT 'ru', tz TEXT DEFAULT 'Asia/Almaty',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  specialty TEXT, industry TEXT, years INTEGER, target_role TEXT, interview_date TEXT, interview_format TEXT,
  minutes_per_day INTEGER DEFAULT 20, resume_text TEXT, keywords TEXT, -- JSON array
  provider TEXT DEFAULT 'workers-ai', api_key_enc TEXT, updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, -- mcq | correction | writing | speaking | reading
  level TEXT NOT NULL, -- A2 | B1 | B2 | C1
  topic TEXT NOT NULL, domain TEXT, prompt TEXT NOT NULL, options TEXT, answer TEXT, rubric TEXT, explanation TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), kind TEXT NOT NULL, -- placement | checkpoint
  started_at TEXT DEFAULT (datetime('now')), finished_at TEXT, level TEXT,
  grammar INTEGER, vocabulary INTEGER, coherence INTEGER, task_response INTEGER, fluency INTEGER, readiness INTEGER
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), assessment_id TEXT, item_id TEXT REFERENCES items(id),
  answer TEXT, correct INTEGER, score INTEGER, feedback TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS error_cards (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), topic TEXT NOT NULL, example TEXT, correction TEXT,
  stability REAL DEFAULT 1, difficulty REAL DEFAULT 5, due TEXT, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0,
  retired INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS program_days (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), day_date TEXT NOT NULL, topic TEXT NOT NULL,
  format TEXT NOT NULL, -- lesson | rehearsal | checkpoint
  status TEXT DEFAULT 'planned', minutes INTEGER, score INTEGER, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS streaks (
  user_id TEXT PRIMARY KEY REFERENCES users(id), current INTEGER DEFAULT 0, best INTEGER DEFAULT 0,
  freezes INTEGER DEFAULT 1, last_day TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON error_cards(user_id, due);
CREATE INDEX IF NOT EXISTS idx_program_user_day ON program_days(user_id, day_date);
