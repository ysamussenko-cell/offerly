/**
 * Общее для всех маршрутов API: окружение, составное хранилище, переменные запроса, проверка сессии и мелкие помощники.
 * Сами маршруты лежат по областям в соседних файлах и собираются в app.ts через `app.route(...)`.
 */
import { Hono } from 'hono';
import type { Env as ProviderEnv } from '../providers';
import { sessionFromToken, readCookie, SESSION_COOKIE, type AuthStore, type User } from '../auth';
import type { MailEnv } from '../mail';
import type { ProfileStore } from '../profile';
import type { OnboardingStore } from '../onboarding';
import type { ItemStore } from '../items';
import type { CardStore } from '../cards';
import type { AssessmentStore } from '../assessment';
import type { ProgramStore } from '../program';
import type { LessonStore } from '../lesson';
import type { DashboardStore } from '../dashboard';
import { syncAchievements, type AchievementStore } from '../achievements';
import type { RehearsalStore } from '../rehearsal';
import type { SpeechStore } from '../voice';
import type { DigestStore } from '../digest';
import type { PushEnv, PushStore } from '../push';
import { userProvider, type SettingsEnv, type SettingsStore } from '../settings';
import type { ReleaseEnv } from '../release';

export interface Env extends ProviderEnv, MailEnv, PushEnv, SettingsEnv, ReleaseEnv {
  /** Адрес приложения для ссылок в письмах; без него — адрес по умолчанию из digest.ts. */
  APP_URL?: string;
  /** Только для локальной разработки: при '1' код входа возвращается в ответе, если почта не настроена. */
  DEV_ECHO_CODE?: string;
}

export type Store = AuthStore & ProfileStore & OnboardingStore & ItemStore & AssessmentStore & CardStore & ProgramStore & LessonStore & DashboardStore & AchievementStore & RehearsalStore & SpeechStore & DigestStore & PushStore & SettingsStore;

export type Auth = { user: User; sessionId: string };
export type Vars = { store: Store; auth: Auth | null };
export type ApiEnv = { Bindings: Env; Variables: Vars };

/** Минимум контекста, который нужен помощникам ниже: совпадает по форме с Context Hono из area(). */
export interface Ctx {
  env: Env;
  get<K extends keyof Vars>(key: K): Vars[K];
}

/** Под-приложение одной области: тот же Env и те же переменные, что у корня. */
export const area = () => new Hono<ApiEnv>();

export const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, locale: u.locale, tz: u.tz });

export const secure = (c: { req: { url: string } }) => new URL(c.req.url).protocol === 'https:';

/** Пользователь текущего запроса; вызывать только после requireAuth. */
export const authOf = (c: Ctx): Auth => c.get('auth')!;

export const requireAuth = async (c: any, next: () => Promise<void>) => {
  const token = readCookie(c.req.header('cookie'), SESSION_COOKIE);
  const found = await sessionFromToken(c.get('store'), token);
  if (!found) return c.json({ ok: false, error: 'unauthorized' }, 401);
  c.set('auth', { user: found.user, sessionId: found.session.id });
  // Свой ключ провайдера (4.6): расшифровывается на время запроса и уходит в env — chat() возьмёт его вместо встроенной модели.
  // Сбой чтения ключа не должен ронять запрос: без него работает встроенная модель.
  try {
    const own = await userProvider(c.env, c.get('store'), found.user.id);
    if (own) c.env = { ...c.env, USER_PROVIDER: own };
  } catch (e) { console.error('provider key unreadable', String(e instanceof Error ? e.message : e).slice(0, 200)); }
  await next();
};

/** Профиль пользователя запроса (или null). */
export const profileOf = async (c: Ctx) => c.get('store').getProfile(authOf(c).user.id);

/** Домен пользователя для генерации заданий: специальность, отрасль, целевая позиция, термины. */
export const domainOf = async (c: Ctx) => {
  const p = await profileOf(c);
  return { specialty: p?.specialty ?? null, industry: p?.industry ?? null, targetRole: p?.targetRole ?? null, keywords: p?.keywords ?? [] };
};

/** После ответа — пересчёт достижений; только что открытые уходят в ответ, чтобы экран показал их сразу. */
export const unlocked = async (c: Ctx) => { const u = authOf(c).user; return (await syncAchievements(c.get('store'), u.id, u.tz)).fresh; };

/** Тело JSON-запроса; пустой или битый JSON — пустой объект, как и прежде. */
export const bodyOf = (c: { req: { json(): Promise<any> } }): Promise<any> => c.req.json().catch(() => ({}));
