/**
 * Расход встроенной модели (дефект D-4006): счётчик вызовов Workers AI по областям API
 * и ограничитель дорогой самопроверки /api/health?deep=2, открытой без входа.
 */
import type { Env as ProviderEnv } from './providers';

export interface AiUsageRow { path: string; model: string; calls: number; errors: number }
export interface DeepResult { ai_chat: string; analysis: string; voice: string }
export interface DeepCheck { version: string; at: string; result?: DeepResult }

export interface UsageStore {
  countAiCall(day: string, path: string, model: string, failed: boolean, nowIso: string): Promise<void>;
  aiUsage(day: string): Promise<AiUsageRow[]>;
  /** Атомарно занять самопроверку: true, если для этой версии её ещё не было или прошлая старше границы. */
  claimDeepCheck(version: string, nowIso: string, staleBeforeIso: string): Promise<boolean>;
  saveDeepCheck(check: DeepCheck): Promise<void>;
  lastDeepCheck(): Promise<DeepCheck | null>;
}

/** Самопроверка с моделью — не чаще раза в полчаса на версию: новый деплой проверяется сразу, посторонние запросы лимит не тратят. */
export const DEEP_CHECK_TTL_MS = 30 * 60 * 1000;

/** Область запроса: первые два сегмента, чтобы id в адресе не плодили строки. */
export const usagePath = (path: string) => '/' + path.split('/').filter(Boolean).slice(0, 2).join('/');

/** Привязка AI, которая считает свои вызовы. Сбой учёта не должен мешать ответу модели. */
export function countingAi(ai: ProviderEnv['AI'], path: string, store: Pick<UsageStore, 'countAiCall'>): ProviderEnv['AI'] {
  const count = async (model: string, failed: boolean) => {
    const nowIso = new Date().toISOString();
    try { await store.countAiCall(nowIso.slice(0, 10), path, model, failed, nowIso); }
    catch (e) { console.error('ai usage not counted', String(e instanceof Error ? e.message : e).slice(0, 200)); }
  };
  return new Proxy(ai as object, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (prop !== 'run') return typeof value === 'function' ? value.bind(target) : value;
      return async (model: string, ...rest: unknown[]) => {
        try {
          const out = await value.call(target, model, ...rest);
          await count(model, false);
          return out;
        } catch (e) {
          await count(model, true);
          throw e;
        }
      };
    },
  }) as ProviderEnv['AI'];
}

const DEEP_KEY = 'health_deep';

export function d1UsageStore(db: D1Database): UsageStore {
  return {
    async countAiCall(day, path, model, failed, nowIso) {
      await db.prepare(
        `INSERT INTO ai_usage (day, path, model, calls, errors, updated_at) VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(day, path, model) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors, updated_at = excluded.updated_at`,
      ).bind(day, path, model, failed ? 1 : 0, nowIso).run();
    },
    async aiUsage(day) {
      const r = await db.prepare('SELECT path, model, calls, errors FROM ai_usage WHERE day = ? ORDER BY calls DESC').bind(day).all<AiUsageRow>();
      return r.results ?? [];
    },
    async claimDeepCheck(version, nowIso, staleBeforeIso) {
      const r = await db.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE json_extract(app_settings.value, '$.version') <> ? OR app_settings.updated_at < ?`,
      ).bind(DEEP_KEY, JSON.stringify({ version, at: nowIso }), nowIso, version, staleBeforeIso).run();
      return (r.meta?.changes ?? 0) > 0;
    },
    async saveDeepCheck(check) {
      await db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').bind(JSON.stringify(check), DEEP_KEY).run();
    },
    async lastDeepCheck() {
      const r = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(DEEP_KEY).first<{ value: string }>();
      return r ? JSON.parse(r.value) as DeepCheck : null;
    },
  };
}
