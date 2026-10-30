-- Offerly: анкета знакомства (только добавление колонок, данные не меняются)
-- target_role, interview_date, interview_format, minutes_per_day уже есть в 0001; tz — в users.
ALTER TABLE profiles ADD COLUMN native_language TEXT;
ALTER TABLE profiles ADD COLUMN onboarded_at TEXT;
