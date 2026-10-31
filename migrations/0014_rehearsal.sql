-- Offerly: репетиция интервью текстом (только новые таблицы, существующие данные не меняются)
-- Сценарий по целевой позиции пишется моделью при старте и целиком сохраняется вопросами в rehearsal_turns —
-- он и есть эталон разбора: у каждого вопроса записано, что должен содержать сильный ответ (rubric).
-- После последнего ответа экзаменатор разбирает весь разговор: пять осей, что сказано хорошо, три фразы заменить.
CREATE TABLE IF NOT EXISTS rehearsals (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), program_day_id TEXT, day_date TEXT NOT NULL,
  target_role TEXT,                             -- целевая позиция сценария (из анкеты или резюме)
  level TEXT NOT NULL,                          -- уровень ученика по последнему тесту или срезу
  status TEXT NOT NULL DEFAULT 'active',        -- active | finished | abandoned
  question_count INTEGER NOT NULL,
  script_model TEXT,                            -- модель, написавшая сценарий; NULL — встроенный сценарий
  overall INTEGER, grammar INTEGER, vocabulary INTEGER, coherence INTEGER, task_response INTEGER, fluency INTEGER,
  review TEXT,                                  -- JSON разбора (RehearsalReview): уровень, резюме, что хорошо, три фразы заменить
  review_note TEXT,                             -- почему разбор не получился (сбой модели); NULL — разбор полный
  started_at TEXT NOT NULL, finished_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS rehearsal_turns (
  id TEXT PRIMARY KEY, rehearsal_id TEXT NOT NULL REFERENCES rehearsals(id), user_id TEXT REFERENCES users(id),
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,                           -- experience | mistake | explain | star | role
  question TEXT NOT NULL,                       -- вопрос интервьюера по-английски
  rubric TEXT,                                  -- JSON массив строк по-русски: что должен содержать сильный ответ
  answer TEXT, score INTEGER, feedback TEXT,    -- ответ ученика; балл и строка разбора — после оценки всего разговора
  created_at TEXT NOT NULL, answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rehearsals_user_day ON rehearsals(user_id, day_date);
CREATE INDEX IF NOT EXISTS idx_rehearsal_turns_rehearsal ON rehearsal_turns(rehearsal_id, position);
