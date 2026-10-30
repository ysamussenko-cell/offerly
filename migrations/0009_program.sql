-- Offerly: программа на четыре недели (только добавление колонок и индекса, данные не меняются)
-- Таблица program_days создана в 0001: day_date, topic, format (lesson | rehearsal | checkpoint), status, minutes, score, completed_at.
ALTER TABLE program_days ADD COLUMN writing TEXT;        -- формат письма дня: review (отзыв рецензента) | explain (объяснение неспециалисту) | NULL
ALTER TABLE program_days ADD COLUMN week INTEGER;        -- номер недели программы, с 1
ALTER TABLE program_days ADD COLUMN position INTEGER;    -- номер дня программы, с 1
ALTER TABLE program_days ADD COLUMN reason TEXT;         -- почему выбрана тема: карточки журнала, ошибки теста, ось оценки — одной строкой
ALTER TABLE program_days ADD COLUMN generated_at TEXT;   -- когда построена программа (одно значение у всех дней одной сборки)
ALTER TABLE program_days ADD COLUMN updated_at TEXT;     -- последняя перестановка темы
CREATE INDEX IF NOT EXISTS idx_program_user_status ON program_days(user_id, status, day_date);
