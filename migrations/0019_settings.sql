-- Offerly: экран настроек (4.6) — свой ключ провайдера модели. Только новая таблица, существующие данные не меняются.
-- Ключ хранится только зашифрованным (AES-256-GCM, WebCrypto): мастер-ключ — секрет KEYS_SECRET, а если его нет —
-- запись «keyring» в app_settings (создаётся один раз). Смена мастер-ключа делает сохранённые ключи нечитаемыми —
-- пользователю придётся ввести ключ заново (экран это покажет).
CREATE TABLE IF NOT EXISTS provider_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  provider TEXT NOT NULL,                       -- id провайдера из providers.ts (anthropic, groq, …); встроенная модель ключа не требует
  model TEXT,                                   -- своя модель провайдера; NULL — модель по умолчанию из providers.ts
  key_enc TEXT NOT NULL,                        -- v1.<iv>.<шифртекст> в base64url; открытый ключ в базу не попадает
  key_hint TEXT NOT NULL,                       -- последние четыре знака ключа — чтобы узнать, какой ключ лежит
  checked_at TEXT,                              -- момент последней успешной проверки ключа коротким вызовом модели
  check_note TEXT,                              -- итог последней проверки: ok | error:<текст>
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
