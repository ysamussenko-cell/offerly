/** Cron-Worker ежедневного письма (4.4) и push-напоминания (4.5): раз в CRON_STEP_MINUTES минут перебирает пользователей
 *  с включённым письмом или напоминанием и шлёт тем, у кого в их поясе наступило назначенное время (runDigest в
 *  functions/_lib/digest.ts, runPush в functions/_lib/push.ts). Работает с той же базой D1, что и Pages-приложение.
 *  GET / — состояние без адресов (версия, база, почта, ключи VAPID, сколько ждёт письма и напоминания сегодня);
 *  POST /run с заголовком x-digest-key = DIGEST_KEY (если секрет задан) — прогон вне расписания для проверки. */
import { d1Store } from '../../functions/_lib/auth';
import { d1ProfileStore } from '../../functions/_lib/profile';
import { d1AssessmentStore } from '../../functions/_lib/assessment';
import { d1CardStore } from '../../functions/_lib/cards';
import { d1ProgramStore } from '../../functions/_lib/program';
import { d1LessonStore } from '../../functions/_lib/lesson';
import { d1RehearsalStore } from '../../functions/_lib/rehearsal';
import { d1DigestStore, digestState, runDigest, CRON, type DigestEnv, type Store as DigestDeps } from '../../functions/_lib/digest';
import { d1PushStore, runPush, VAPID_SETTING_KEY, type PushEnv, type Store as PushDeps } from '../../functions/_lib/push';
import { VERSION } from '../../functions/_lib/version';

export { VERSION };

export type Store = DigestDeps & PushDeps;

export interface Env extends DigestEnv, PushEnv {
  DB: D1Database;
  /** Ключ для POST /run вне расписания; без него маршрут закрыт. */
  DIGEST_KEY?: string;
}

/** Хранилище рассылки — те же d1-модули, что и в приложении. */
export const makeStore = (env: Env): Store => ({
  ...d1Store(env.DB), ...d1ProfileStore(env.DB), ...d1AssessmentStore(env.DB), ...d1CardStore(env.DB),
  ...d1ProgramStore(env.DB), ...d1LessonStore(env.DB), ...d1RehearsalStore(env.DB), ...d1DigestStore(env.DB), ...d1PushStore(env.DB),
});

/** Состояние для GET /: без адресов и имён — сколько пользователей ждут письма и напоминания и в каком они состоянии. */
export async function status(env: Env, now = new Date()) {
  let db: 'ok' | 'missing' | 'error' = 'missing';
  const counts: Record<string, number> = {};
  const pushCounts: Record<string, number> = {};
  let users = 0, pushUsers = 0;
  let vapid: 'env' | 'db' | 'pending' = env.VAPID_PRIVATE_KEY ? 'env' : 'pending';
  if (env.DB) {
    try {
      await env.DB.prepare('select 1').first();
      db = 'ok';
      const store = makeStore(env);
      for (const { user, profile } of await store.listDigestUsers()) {
        users++;
        const s = digestState(profile, user.tz, now).state;
        counts[s] = (counts[s] ?? 0) + 1;
      }
      for (const { user, setting } of await store.listPushUsers()) {
        pushUsers++;
        const s = digestState({ notifyAt: setting.pushAt, digestSentOn: setting.sentOn }, user.tz, now).state;
        pushCounts[s] = (pushCounts[s] ?? 0) + 1;
      }
      if (vapid === 'pending' && (await store.getSetting(VAPID_SETTING_KEY))) vapid = 'db';
    } catch { db = 'error'; }
  }
  return { ok: db === 'ok', version: VERSION, db, mail: env.RESEND_API_KEY ? 'ok' : 'missing', cron: CRON, users, states: counts, push: { vapid, users: pushUsers, states: pushCounts }, at: now.toISOString() };
}

/** Один проход расписания: письмо и напоминание независимо — сбой одного не мешает другому. */
export async function runAll(env: Env, store: Store) {
  const [digest, push] = await Promise.allSettled([runDigest(env, store), runPush(env, store)]);
  const unwrap = (r: PromiseSettledResult<unknown>) => r.status === 'fulfilled' ? r.value : { error: String(r.reason instanceof Error ? r.reason.message : r.reason).slice(0, 300) };
  return { digest: unwrap(digest), push: unwrap(push) };
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runAll(env, makeStore(env)).then(r => console.log(JSON.stringify(r))));
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    if (req.method === 'GET' && url.pathname === '/') return json(await status(env));
    if (req.method === 'POST' && url.pathname === '/run') {
      if (!env.DIGEST_KEY || req.headers.get('x-digest-key') !== env.DIGEST_KEY) return json({ ok: false, error: 'not_found' }, 404);
      return json({ ok: true, report: await runAll(env, makeStore(env)) });
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },
};
