-- Offerly: карточки ошибок по FSRS (только добавление колонок и индекса, существующие данные не меняются)
-- streak — верных подряд (три гасят карточку); reviewed_at — дата последнего повтора, нужна FSRS для расчёта
-- вероятности вспомнить; origin — ключ источника (попытка теста или шаг занятия), чтобы пересчёт не дублировал карточки.
ALTER TABLE error_cards ADD COLUMN streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE error_cards ADD COLUMN reviewed_at TEXT;
ALTER TABLE error_cards ADD COLUMN origin TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_origin ON error_cards(user_id, origin) WHERE origin IS NOT NULL;
