-- Offerly: достижения за навык и бонусная задача (только новая таблица и колонка, существующие данные не меняются)
-- Достижение открывается один раз и запоминается с датой; само условие считается по ответам (achievements.ts),
-- таблица нужна, чтобы дата и факт открытия не менялись при пересчётах и чтобы показать «новое» один раз.
CREATE TABLE IF NOT EXISTS achievements (
  user_id TEXT NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,                 -- ключ из каталога: streak5:<тема> | review-clean | explain-clean | writing-c1 | stretch3 | retired-1 | retired-10 | bonus-1 | bonus-5 | warmup-perfect
  unlocked_at TEXT NOT NULL,          -- когда открыто (ISO)
  detail TEXT,                        -- одной строкой: чем открыто (дата занятия, тема)
  seen_at TEXT,                       -- когда показано на главном экране; NULL — ещё не показано
  PRIMARY KEY (user_id, code)
);
-- Бонусная задача после занятия: NULL — не предлагалась; offered — предложена; declined — отклонена;
-- active — выдана, ждёт ответа; correct | wrong — решена. Верный бонус удваивает вклад занятия в готовность.
ALTER TABLE lessons ADD COLUMN bonus TEXT;
