-- Offerly: учёт вызовов встроенной модели (дефект D-4006) — чей расход съедает дневной лимит Workers AI.
-- Только новая таблица, существующие данные не меняются. Личных данных нет: сутки UTC, область API, модель, счётчики.
CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT NOT NULL,                            -- сутки UTC: в этот момент Cloudflare обнуляет лимит
  path TEXT NOT NULL,                           -- область запроса, первые два сегмента: /api/lesson
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, path, model)
);
