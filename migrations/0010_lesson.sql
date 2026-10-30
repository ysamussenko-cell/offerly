-- Offerly: дневное занятие (только новые таблицы и колонка, существующие данные не меняются)
-- Занятие по дню программы: разминка из пяти заданий темы дня, письмо формата дня, повтор карточек журнала.
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), program_day_id TEXT, day_date TEXT NOT NULL,
  topic TEXT NOT NULL, writing TEXT,            -- тема и формат письма дня (review | explain | NULL)
  level TEXT NOT NULL,                          -- уровень заданий занятия (по последнему тесту или срезу)
  status TEXT NOT NULL DEFAULT 'active',        -- active | finished
  warmup_count INTEGER NOT NULL DEFAULT 5,      -- сколько заданий в разминке
  review_count INTEGER NOT NULL DEFAULT 0,      -- сколько карточек на повтор назначено при старте
  score INTEGER,                                -- итог занятия 0–100 после завершения
  started_at TEXT NOT NULL, finished_at TEXT, updated_at TEXT
);
-- Шаги занятия: выданное задание или карточка записывается сразу без ответа — точка продолжения.
CREATE TABLE IF NOT EXISTS lesson_steps (
  id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id), user_id TEXT REFERENCES users(id),
  position INTEGER NOT NULL,
  part TEXT NOT NULL,                           -- warmup | writing | review
  item_id TEXT REFERENCES items(id), card_id TEXT REFERENCES error_cards(id), level TEXT,
  answer TEXT, correct INTEGER, score INTEGER, feedback TEXT, detail TEXT, -- detail: JSON оценки письма (WritingEval)
  created_at TEXT NOT NULL, answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lessons_user_day ON lessons(user_id, day_date);
CREATE INDEX IF NOT EXISTS idx_lesson_steps_lesson ON lesson_steps(lesson_id, position);
CREATE INDEX IF NOT EXISTS idx_lesson_steps_user_item ON lesson_steps(user_id, item_id);
-- Формат письменного задания в банке: review (отзыв рецензента) | explain (объяснение неспециалисту) | NULL (без формата).
ALTER TABLE items ADD COLUMN writing_format TEXT;
