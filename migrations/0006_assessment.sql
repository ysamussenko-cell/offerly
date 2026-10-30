-- Offerly: адаптивный тест уровня — ход теста и ответы (только добавление колонок и индексов, данные не меняются)
-- Таблицы assessments и attempts созданы в 0001.
ALTER TABLE assessments ADD COLUMN status TEXT DEFAULT 'active';   -- active | finished | abandoned
ALTER TABLE assessments ADD COLUMN current_level TEXT;              -- уровень, с которого берётся следующее задание
ALTER TABLE assessments ADD COLUMN updated_at TEXT;
ALTER TABLE attempts ADD COLUMN position INTEGER;                   -- номер задания в тесте, с 1
ALTER TABLE attempts ADD COLUMN level TEXT;                         -- уровень задания в момент выдачи
ALTER TABLE attempts ADD COLUMN answered_at TEXT;                   -- NULL — задание выдано, ответа ещё нет (точка продолжения)
CREATE INDEX IF NOT EXISTS idx_assessments_user ON assessments(user_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_attempts_assessment ON attempts(assessment_id, position);
CREATE INDEX IF NOT EXISTS idx_attempts_user_item ON attempts(user_id, item_id);
