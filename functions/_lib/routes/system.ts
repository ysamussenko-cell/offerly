/** Открытые служебные маршруты: состояние сервиса, релиз для страницы установки, список провайдеров, проба модели. */
import { chat, PROVIDERS } from '../providers';
import { selfTestExtract } from '../extract';
import { analyzeResume, SELF_TEST_RESUME } from '../profile';
import { selfTestVoice } from '../voice';
import { VAPID_SETTING_KEY } from '../push';
import { fetchRelease, CACHE_SECONDS as RELEASE_CACHE_SECONDS } from '../release';
import { area, bodyOf } from './context';

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
    // ?deep=1 — прогон извлечения текста на крошечных встроенных PDF и DOCX: проверяет, что pdf.js и zip работают в этой среде.
    if (c.req.query('deep') === '1' || c.req.query('deep') === '2') {
      out.extract = await selfTestExtract();
      // и один короткий вызов встроенной модели — ловит ошибки Workers AI (лимиты, имя модели, формат ответа)
      try {
        const reply = await chat(c.env, [{ role: 'user', content: 'Reply with the single word: ok' }], { maxTokens: 8 });
        out.ai_chat = reply.trim() ? 'ok' : 'error: empty reply';
      } catch (e) { out.ai_chat = `error: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`; }
      // ?deep=2 — полный разбор встроенного тестового резюме моделью: воспроизводит путь «резюме → профиль» в проде.
      if (c.req.query('deep') === '2') {
        try {
          const a = await analyzeResume(c.env, SELF_TEST_RESUME);
          out.analysis = `ok: ${a.specialty} / ${a.industry} / ${a.years} лет / ${a.keywords.length} терминов`;
        } catch (e) { out.analysis = `error: ${String(e instanceof Error ? e.message : e).slice(0, 400)}`; }
        // голосовой контур: MeloTTS озвучивает фразу, Whisper её распознаёт — проверка обеих моделей без записи с микрофона
        out.voice = await selfTestVoice(c.env);
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

  r.post('/ai/ping', async (c) => {
    const body = await bodyOf(c);
    const text = await chat(c.env, [
      { role: 'system', content: 'You are an English coach. Answer in one short sentence.' },
      { role: 'user', content: body.prompt ?? 'Say hello to a thermal power engineer preparing for an interview.' },
    ], { provider: body.provider, apiKey: body.apiKey, model: body.model, maxTokens: 120 });
    return c.json({ text });
  });

  return r;
}
