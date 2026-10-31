-- Offerly: голос (4.2) — только новая таблица и новая колонка, существующие данные не меняются.
-- Запись речи распознаётся Whisper на Workers AI; расшифровка и мерки беглости (темп, паузы, заполнители)
-- хранятся здесь, а ответ ученика ссылается на запись по id — оси считаются по сохранённым меркам, не по словам клиента.
CREATE TABLE IF NOT EXISTS speech_takes (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
  text TEXT NOT NULL,                           -- расшифровка речи (английский)
  duration REAL NOT NULL,                       -- длительность записи, секунды
  words INTEGER NOT NULL,                       -- слов в расшифровке
  wpm INTEGER NOT NULL,                         -- темп, слов в минуту
  pauses INTEGER NOT NULL,                      -- пауз дольше порога
  longest_pause REAL NOT NULL,                  -- самая длинная пауза, секунды
  fillers INTEGER NOT NULL,                     -- заполнителей (um, uh, er…)
  fluency INTEGER NOT NULL,                     -- беглость 0–100 по единой шкале ступеней
  model TEXT,                                   -- модель распознавания
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_speech_takes_user ON speech_takes(user_id, created_at);
ALTER TABLE rehearsal_turns ADD COLUMN speech_id TEXT;  -- запись речи, если ответ дан голосом
