# Offerly

Личный ИИ-тренер подготовки к собеседованию на английском: резюме → адаптивный тест уровня по специальности → индивидуальная программа → ежедневные занятия 20 минут → репетиции интервью → срезы раз в две недели.

Стек: React + Vite + TypeScript (PWA), Cloudflare Pages Functions (Hono), D1, Workers AI (встроенная модель, распознавание и озвучка речи), режим «свой ключ» для Claude / Gemini / Groq / Mistral / GLM / DeepSeek / Qwen / GPT.

Адрес: https://offerly-c8b.pages.dev · Деплой: GitHub Actions при push в `main`.

## Локально
```
npm ci
npm run build
npx wrangler pages dev dist --d1 DB=offerly --ai AI
```
Миграции: `npx wrangler d1 migrations apply offerly --local`.

## Проверки
```
npm test        # Vitest: модули API и клиента (tests/)
npm run e2e     # Playwright: ключевые сценарии в Chromium на собранном dist (e2e/), нужен `npm run build`
npm run e2e:stand   # поднять стенд e2e руками: dist + API в памяти, код входа на экране, засев POST /__e2e/seed
```
Для `npm run e2e` нужен Chromium Playwright: `npx playwright install --with-deps chromium` (в Actions ставится сам, падение сценариев останавливает деплой).

Документы: `ROADMAP.md` (задачи), `STATE.json` (текущее состояние цикла), `CHANGELOG.md`, концепт — `docs/concept.md`.
