-- Offerly: учётная запись первого пользователя и журнал ошибок (только добавление колонок, данные не меняются)
-- Карточка ошибки получает правило одной строкой и источник (seed, assessment, lesson) — для FSRS-повторов в 3.3.
ALTER TABLE error_cards ADD COLUMN rule TEXT;
ALTER TABLE error_cards ADD COLUMN source TEXT;
-- Профиль: целевой уровень и время ежедневного уведомления (из концепта §9; настройка — 4.4/4.6).
ALTER TABLE profiles ADD COLUMN target_level TEXT;
ALTER TABLE profiles ADD COLUMN notify_at TEXT;
