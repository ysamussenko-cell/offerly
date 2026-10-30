-- Offerly: оценка теста по пяти осям (только добавление колонок, данные не меняются)
-- Оси grammar, vocabulary, coherence, task_response, fluency в assessments есть с 0001.
ALTER TABLE assessments ADD COLUMN overall INTEGER;       -- сводный балл 0–100, из которого выводится уровень
ALTER TABLE assessments ADD COLUMN scored_at TEXT;        -- когда посчитаны оси
ALTER TABLE assessments ADD COLUMN scoring_note TEXT;     -- почему письмо не оценено (ошибка модели) — NULL, если всё прошло
ALTER TABLE attempts ADD COLUMN detail TEXT;              -- JSON: оценка письма моделью (оси, ошибки, переписанный вариант)
