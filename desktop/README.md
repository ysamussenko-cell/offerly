# Offerly для Windows (Tauri 2)

Обёртка над живым адресом https://offerly-c8b.pages.dev: окно без вкладок, значок в трее (крестик прячет, «Выход» — из меню значка),
нативные уведомления и автообновление по `latest.json` последнего релиза GitHub.

- Конфигурация — `src-tauri/tauri.conf.json`; версия там и в `src-tauri/Cargo.toml` равна версии в `package.json` (проверяет `tests/desktop.test.ts`).
- Иконки рисует `scripts/icons.py` (PIL), `scripts/latest.mjs` собирает `latest.json` для релиза из каталога бандла.
- Сборка и релиз — `.github/workflows/desktop.yml` (windows-latest): запускается при изменениях в `desktop/` и вручную.
  Подпись обновлений — секрет `TAURI_SIGNING_PRIVATE_KEY` (открытый ключ зашит в `tauri.conf.json`); без секрета сборка выходит
  без подписи — страница установки её покажет, но автообновление внутри приложения такой релиз не примет.
- Локально: `npm run tauri -- dev` (нужны Rust и WebView2), `npm run tauri -- build`.
