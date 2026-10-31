/**
 * Склейка API: хранилище на запрос, один обработчик ошибок и маршруты по областям из routes/*.
 * Предметная логика и SQL — в модулях functions/_lib, маршруты знают только о них.
 */
import { Hono } from 'hono';
import { d1Store } from './auth';
import { d1ProfileStore } from './profile';
import { d1OnboardingStore } from './onboarding';
import { d1ItemStore } from './items';
import { d1CardStore } from './cards';
import { d1AssessmentStore } from './assessment';
import { d1ProgramStore } from './program';
import { d1LessonStore } from './lesson';
import { d1DashboardStore } from './dashboard';
import { d1AchievementStore } from './achievements';
import { d1RehearsalStore } from './rehearsal';
import { d1SpeechStore } from './voice';
import { d1DigestStore } from './digest';
import { d1PushStore } from './push';
import { d1SettingsStore } from './settings';
import { DomainError } from './errors';
import { type ApiEnv, type Env, type Store } from './routes/context';
import { systemRoutes } from './routes/system';
import { authRoutes } from './routes/auth';
import { profileRoutes } from './routes/profile';
import { itemRoutes } from './routes/items';
import { assessmentRoutes } from './routes/assessment';
import { programRoutes } from './routes/program';
import { rehearsalRoutes } from './routes/rehearsal';
import { dashboardRoutes } from './routes/dashboard';
import { settingsRoutes } from './routes/settings';

export type { Env, Store } from './routes/context';

/** Хранилище из D1: все области в одном объекте. */
export const d1AllStores = (env: Env): Store => ({
  ...d1Store(env.DB), ...d1ProfileStore(env.DB), ...d1OnboardingStore(env.DB), ...d1ItemStore(env.DB), ...d1AssessmentStore(env.DB), ...d1CardStore(env.DB),
  ...d1ProgramStore(env.DB), ...d1LessonStore(env.DB), ...d1DashboardStore(env.DB), ...d1AchievementStore(env.DB), ...d1RehearsalStore(env.DB),
  ...d1SpeechStore(env.DB), ...d1DigestStore(env.DB), ...d1PushStore(env.DB), ...d1SettingsStore(env.DB),
});

/** Тело ответа на ошибку, не относящуюся к предметной области: без стека и внутренних подробностей наружу. */
export const INTERNAL_ERROR = { ok: false as const, error: 'internal' as const };

/** Создаёт приложение API. Хранилище можно подменить (тесты, стенд e2e). */
export function createApp(version: string, makeStore: (env: Env) => Store = d1AllStores) {
  const app = new Hono<ApiEnv>().basePath('/api');

  app.use('*', async (c, next) => {
    c.set('store', makeStore(c.env));
    c.set('auth', null);
    await next();
  });

  // Любая DomainError (тест, срез, занятие, программа, репетиция, голос, настройки, push, резюме) — JSON с её кодом и статусом;
  // ошибки сервера (5xx) попадают в журнал. Всё остальное — 500 с кодом internal, подробности только в журнале.
  app.onError((e, c) => {
    if (e instanceof DomainError) {
      if (e.status >= 500) console.error(`${e.code}: ${e.message}`);
      return c.json(e.toJSON(), e.status as 400);
    }
    console.error('unhandled', c.req.method, c.req.path, String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 1000));
    return c.json(INTERNAL_ERROR, 500);
  });

  app.route('/', systemRoutes(version));
  app.route('/', authRoutes());
  app.route('/', profileRoutes());
  app.route('/', itemRoutes());
  app.route('/', assessmentRoutes());
  app.route('/', programRoutes());
  app.route('/', rehearsalRoutes());
  app.route('/', dashboardRoutes());
  app.route('/', settingsRoutes(version));

  return app;
}
