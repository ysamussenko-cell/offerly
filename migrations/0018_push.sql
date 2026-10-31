-- Offerly: Web Push (4.5) — одно напоминание в день. Только новые таблицы, существующие данные не меняются.
-- Подписки браузеров (endpoint + ключи p256dh/auth из PushManager); у пользователя их может быть несколько — телефон и компьютер.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,                -- адрес push-службы браузера (один браузер — одна подписка)
  p256dh TEXT NOT NULL,                         -- открытый ключ браузера (base64url, 65 байт)
  auth TEXT NOT NULL,                           -- секрет подписки (base64url, 16 байт)
  user_agent TEXT,                              -- чтобы показать «Chrome на Windows» в списке устройств
  created_at TEXT NOT NULL,
  last_sent_at TEXT,                            -- последняя удачная доставка
  last_error TEXT                               -- последняя ошибка push-службы (статус и текст), NULL — всё хорошо
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- Настройка напоминания — отдельно от письма (profiles.notify_at): каналы включаются независимо.
CREATE TABLE IF NOT EXISTS push_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  push_at TEXT,                                 -- HH:MM в поясе пользователя; NULL — напоминание выключено
  sent_on TEXT,                                 -- день (в поясе пользователя) последнего напоминания или пропуска — не больше одного в день
  sent_at TEXT,                                 -- момент последней доставки (ISO)
  note TEXT,                                    -- итог последней попытки: sent | skipped:<причина> | error:<текст>
  updated_at TEXT NOT NULL
);

-- Служебные значения приложения: пара ключей VAPID (vapid_public_key, vapid_private_key), если не заданы секретами окружения.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
