-- Offerly: резюме и разбор профиля (только добавление колонок, данные не меняются)
ALTER TABLE profiles ADD COLUMN resume_name TEXT;
ALTER TABLE profiles ADD COLUMN resume_at TEXT;
ALTER TABLE profiles ADD COLUMN summary TEXT;
