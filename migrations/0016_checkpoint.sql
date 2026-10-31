-- 4.3 Контрольный срез: укороченный тест (8 адаптивных заданий, чтение, письмо) раз в две недели по программе.
-- Таблица assessments создана в 0001, kind=checkpoint предусмотрен там же.
ALTER TABLE assessments ADD COLUMN adaptive_count INTEGER;  -- сколько первых позиций адаптивные: 12 у теста уровня, 8 у среза; NULL — 12
ALTER TABLE assessments ADD COLUMN program_day_id TEXT;     -- день программы format=checkpoint, по которому пройден срез; NULL — вне плана
CREATE INDEX IF NOT EXISTS idx_assessments_user_kind ON assessments(user_id, kind, status, started_at);
