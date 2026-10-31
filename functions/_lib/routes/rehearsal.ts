/** Репетиция интервью (4.1) и голос (4.2). Ошибки RehearsalError и VoiceError уходят в app.onError. */
import { today as rehearsalToday, startOrResume as startRehearsal, answer as answerRehearsal, rescore as rescoreRehearsal, abandon as abandonRehearsal, QUESTION_COUNT, ANSWER_WORDS, REPLACEMENTS } from '../rehearsal';
import { recordSpeech, speak, publicSpeech, validateTtsText, MAX_AUDIO_BYTES, MAX_SECONDS, MAX_TTS_CHARS, STT_MODEL, TTS_MODEL } from '../voice';
import { area, bodyOf, profileOf, requireAuth, unlocked } from './context';

export function rehearsalRoutes() {
  const r = area();
  const rehearsalMeta = { questions: QUESTION_COUNT, words: ANSWER_WORDS, replacements: REPLACEMENTS };

  /** Сегодня: репетиция ли по программе, сегодняшняя репетиция (идёт — с текущим вопросом, прошла — с разбором) и последняя прежняя. */
  r.get('/rehearsal', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, ...rehearsalMeta, ...(await rehearsalToday(c.get('store'), user.id, user.tz)) });
  });

  /** Начать репетицию (модель пишет сценарий по целевой позиции — до минуты; не написала — встроенный) или продолжить начатую. */
  r.post('/rehearsal/start', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, ...rehearsalMeta, rehearsal: await startRehearsal(c.env, c.get('store'), user.id, user.tz, await profileOf(c)) });
  });

  /** Ответ на текущий вопрос: {turnId, answer}. После последнего — разбор всего разговора моделью (до минуты):
   *  пять осей, что сказано хорошо, три фразы заменить (уходят в журнал). Сбой разбора — reviewNote, повтор через /rehearsal/review. */
  r.post('/rehearsal/answer', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    const raw = body.speechId ? { text: body.answer, speechId: body.speechId } : body.answer;
    const rehearsal = await answerRehearsal(c.env, c.get('store'), user.id, body.turnId, raw, user.tz, await profileOf(c));
    return c.json({ ok: true, ...rehearsalMeta, rehearsal, unlocked: await unlocked(c) });
  });

  /** Разобрать последнюю завершённую репетицию заново: когда разбора нет (сбой модели) или {force: true}. */
  r.post('/rehearsal/review', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    return c.json({ ok: true, ...rehearsalMeta, rehearsal: await rescoreRehearsal(c.env, c.get('store'), user.id, user.tz, await profileOf(c), body?.force === true) });
  });

  /** Бросить начатую репетицию: следующий start напишет новый сценарий. */
  r.post('/rehearsal/abandon', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, abandoned: await abandonRehearsal(c.get('store'), user.id, user.tz) });
  });

  // --- голос ---

  const voiceMeta = { maxBytes: MAX_AUDIO_BYTES, maxSeconds: MAX_SECONDS, maxChars: MAX_TTS_CHARS, stt: STT_MODEL, tts: TTS_MODEL };

  /** Распознать запись речи: multipart с полем audio (WAV 16 кГц моно — клиент перекодирует сам; WebM/MP4/OGG/MP3 — как есть).
   *  Ответ — запись speech_takes: расшифровка и мерки (темп, паузы, заполнители, беглость); её id передаётся с ответом
   *  репетиции, чтобы беглость вошла в оси. Текст расшифровки ученик может поправить перед отправкой. */
  r.post('/voice/transcribe', requireAuth, async (c) => {
    const userId = c.get('auth')!.user.id;
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_AUDIO_BYTES + 4096) return c.json({ ok: false, error: 'audio_too_large' }, 413);
    const ct = c.req.header('content-type') ?? '';
    let bytes: Uint8Array | null = null; let mime = '';
    if (ct.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      const file = body.audio ?? body.file;
      if (file instanceof File) { bytes = new Uint8Array(await file.arrayBuffer()); mime = file.type || ''; }
    } else if (ct.startsWith('audio/') || ct.startsWith('video/')) {
      bytes = new Uint8Array(await c.req.arrayBuffer()); mime = ct;
    }
    const p = await profileOf(c);
    const hint = p?.keywords?.length ? p.keywords.slice(0, 12).join(', ') : undefined;
    const take = await recordSpeech(c.env, c.get('store'), userId, bytes ?? new Uint8Array(0), mime, { hint });
    return c.json({ ok: true, ...voiceMeta, speech: publicSpeech(take) });
  });

  /** Озвучить реплику тренера: {text} до MAX_TTS_CHARS знаков → MP3 (MeloTTS). */
  r.post('/voice/speak', requireAuth, async (c) => {
    const body = await bodyOf(c);
    const v = validateTtsText(body?.text);
    if (!v.ok) return c.json({ ok: false, error: 'tts_text_invalid', reason: v.reason }, 400);
    const s = await speak(c.env, v.text);
    return new Response(s.audio, { status: 200, headers: { 'content-type': s.mime, 'cache-control': 'private, max-age=3600', 'x-tts-model': s.model } });
  });

  /** Справочник голоса: пределы записи и текста, модели. */
  r.get('/voice/meta', requireAuth, (c) => c.json({ ok: true, ...voiceMeta }));

  return r;
}
