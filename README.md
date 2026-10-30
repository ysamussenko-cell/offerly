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

Документы: `ROADMAP.md` (задачи), `STATE.json` (текущее состояние цикла), `CHANGELOG.md`, концепт — `docs/concept.md`.
