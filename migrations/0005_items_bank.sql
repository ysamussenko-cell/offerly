-- Offerly: банк заданий — состояние проверки вторым прогоном (только добавление колонок и индексов, данные не меняются)
-- Таблица items создана в 0001: kind, level, topic, domain, prompt, options (JSON), answer, rubric (JSON), explanation.
ALTER TABLE items ADD COLUMN status TEXT DEFAULT 'draft';      -- draft | verified | rejected
ALTER TABLE items ADD COLUMN check_note TEXT;                   -- вывод проверяющего прогона одной строкой
ALTER TABLE items ADD COLUMN checked_level TEXT;                -- уровень, который независимо оценил проверяющий прогон
ALTER TABLE items ADD COLUMN verified_at TEXT;
ALTER TABLE items ADD COLUMN fingerprint TEXT;                  -- нормализованный текст задания — защита от дублей
ALTER TABLE items ADD COLUMN source TEXT;                       -- модель, которая написала задание
CREATE INDEX IF NOT EXISTS idx_items_bank ON items(level, topic, kind, status);
CREATE INDEX IF NOT EXISTS idx_items_fingerprint ON items(fingerprint);
