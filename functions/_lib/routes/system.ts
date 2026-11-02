/** Открытые служебные маршруты: состояние сервиса, релиз для страницы установки, список провайдеров. */
import { chat, PROVIDERS } from '../providers';
import { selfTestExtract } from '../extract';
import { analyzeResume, SELF_TEST_RESUME } from '../profile';
import { selfTestVoice } from '../voice';
import { VAPID_SETTING_KEY } from '../push';
import { fetchRelease, CACHE_SECONDS as RELEASE_CACHE_SECONDS } from '../release';
import { DEEP_CHECK_TTL_MS, type DeepResult } from '../usage';
import { area, type Env } from './context';

/** Вызовы модели самопроверки: ловят лимиты, имя модели, формат ответа; голос — MeloTTS озвучивает фразу, Whisper её распознаёт. */
async function deepModelCheck(env: Env): Promise<DeepResult> {
  let ai_chat: string, analysis: string;
  try {
    const reply = await chat(env, [{ role: 'user', content: 'Reply with the single word: ok' }], { maxTokens: 8 });
    ai_chat = reply.trim() ? 'ok' : 'error: empty reply';
  } catch (e) { ai_chat = `error: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`; }
  try {
    const a = await analyzeResume(env, SELF_TEST_RESUME);
    analysis = `ok: ${a.specialty} / ${a.industry} / ${a.years} лет / ${a.keywords.length} терминов`;
  } catch (e) { analysis = `error: ${String(e instanceof Error ? e.message : e).slice(0, 400)}`; }
  return { ai_chat, analysis, voice: await selfTestVoice(env) };
}

export function systemRoutes(version: string) {
  const r = area();

  r.get('/health', async (c) => {
    let db: 'ok' | 'missing' | 'error' = 'missing';
    let ai: 'ok' | 'missing' | 'error' = 'missing';
    if (c.env.DB) {
      try { await c.env.DB.prepare('select 1').first(); db = 'ok'; } catch { db = 'error'; }
    }
    if (c.env.AI) ai = 'ok';
    // push: откуда ключи VAPID — секреты окружения, запись в app_settings или ещё не создавались (создаются при первом GET /api/push)
    let push: 'env' | 'db' | 'pending' | 'error' = c.env.VAPID_PRIVATE_KEY ? 'env' : 'pending';
    if (push === 'pending' && db === 'ok') { try { push = (await c.get('store').getSetting(VAPID_SETTING_KEY)) ? 'db' : 'pending'; } catch { push = 'error'; } }
    const out: Record<string, unknown> = { ok: db === 'ok' && ai === 'ok', version, db, ai, mail: c.env.RESEND_API_KEY ? 'ok' : 'missing', push };
    // ?deep=1 — прогон извлечения текста на крошечных встроенных PDF и DOCX: проверяет, что pdf.js и zip работают в этой среде. Модель не вызывается.
    if (c.req.query('deep') === '1' || c.req.query('deep') === '2') out.extract = await selfTestExtract();
    // ?deep=2 — ещё и модель: чат, разбор тестового резюме, голос. Маршрут открыт без входа, поэтому модель зовём
    // не чаще раза в полчаса на версию (usage.ts), остальным — последний итог с пометкой времени.
    if (c.req.query('deep') === '2') {
      const store = c.get('store');
      const now = new Date();
      const nowIso = now.toISOString();
      try {
        if (await store.claimDeepCheck(version, nowIso, new Date(now.getTime() - DEEP_CHECK_TTL_MS).toISOString())) {
          const result = await deepModelCheck(c.env);
          await store.saveDeepCheck({ version, at: nowIso, result });
          Object.assign(out, result);
        } else {
          const last = await store.lastDeepCheck();
          Object.assign(out, last?.result ?? { ai_chat: 'pending', analysis: 'pending', voice: 'pending' }, { deep_cached_at: last?.at ?? null });
        }
        out.ai_usage = await store.aiUsage(nowIso.slice(0, 10));
      } catch (e) {
        out.ai_chat = `error: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`;
      }
    }
    return c.json(out);
  });

  /** Страница установки (5.1): есть ли установщик для Windows в последнем релизе GitHub. Открытый маршрут — страница доступна без входа. */
  r.get('/release', async (c) => {
    const release = await fetchRelease(c.env);
    return c.json({ ok: true, ...release }, 200, { 'cache-control': `public, max-age=${RELEASE_CACHE_SECONDS}` });
  });

  r.get('/providers', (c) => c.json(PROVIDERS.map(({ id, name, short, keyUrl, defaultModel, free }) => ({ id, name, short, keyUrl, defaultModel, free }))));

  return r;
}
