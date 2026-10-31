-- 4.4 Ежедневное письмо (cron-Worker + Resend): задание дня и прогресс. Только добавление колонок, данные не меняются.
-- Время письма — profiles.notify_at (HH:MM в поясе пользователя, добавлено в 0008); NULL — письмо выключено.
ALTER TABLE profiles ADD COLUMN digest_sent_on TEXT;  -- дата YYYY-MM-DD (в поясе пользователя) последнего отправленного или пропущенного письма — не больше одного в день
ALTER TABLE profiles ADD COLUMN digest_sent_at TEXT;  -- момент последней отправки (ISO)
ALTER TABLE profiles ADD COLUMN digest_note TEXT;     -- итог последней попытки: sent | skipped:<причина> | error:<текст> — для диагностики
