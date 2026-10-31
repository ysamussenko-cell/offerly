import { describe, it, expect } from 'vitest';
import {
  normalizeTranscript, speechMetrics, tempoScore, transcribe, recordSpeech, checkAudio, validateTtsText, normalizeTts, speak, selfTestVoice,
  toBase64, fromBase64, d1SpeechStore, publicSpeech, VoiceError, STT_MODEL, STT_FALLBACK_MODEL, TTS_MODEL, MAX_AUDIO_BYTES, PAUSE_SEC, TEMPO_POINTS,
  type Transcript, type SpeechTake,
} from '../functions/_lib/voice';
import { rehearsalAxes, answer, startOrResume, reviewPrompt, type Turn } from '../functions/_lib/rehearsal';
import { memoryStore } from './helpers/memoryStore';
import { d1Of, freshDb } from './helpers/sqliteD1';
import type { Env } from '../functions/_lib/providers';

const ENV = { DB: null, AI: { run: async () => ({}) }, APP_NAME: 'Offerly' } as unknown as Env;
const NOW = '2026-10-31T06:00:00.000Z';
const USER = 'u1';

/** Запись из N байтов (как WAV с заголовком). */
const audio = (n = 4096) => { const b = new Uint8Array(n); b.set([0x52, 0x49, 0x46, 0x46]); return b; };

/** Ответ турбо-модели Whisper: сегменты с метками слов и длительность. */
const TURBO = {
  transcription_info: { language: 'en', language_probability: 0.99, duration: 12.0, duration_after_vad: 11.2 },
  text: 'I led the commissioning of two boilers, um, and we reduced the start-up time by forty percent.',
  word_count: 17,
  segments: [
    { start: 0.2, end: 5.4, text: 'I led the commissioning of two boilers, um,', words: [
      { word: 'I', start: 0.2, end: 0.4 }, { word: 'led', start: 0.4, end: 0.7 }, { word: 'the', start: 0.7, end: 0.8 }, { word: 'commissioning', start: 0.8, end: 1.6 },
      { word: 'of', start: 1.6, end: 1.7 }, { word: 'two', start: 1.7, end: 1.9 }, { word: 'boilers,', start: 1.9, end: 2.5 }, { word: 'um,', start: 4.0, end: 4.3 },
    ] },
    { start: 5.5, end: 12.0, text: 'and we reduced the start-up time by forty percent.', words: [
      { word: 'and', start: 5.5, end: 5.6 }, { word: 'we', start: 5.6, end: 5.7 }, { word: 'reduced', start: 5.7, end: 6.2 }, { word: 'the', start: 6.2, end: 6.3 },
      { word: 'start-up', start: 6.3, end: 6.8 }, { word: 'time', start: 6.8, end: 7.1 }, { word: 'by', start: 7.1, end: 7.2 }, { word: 'forty', start: 7.2, end: 7.6 }, { word: 'percent.', start: 7.6, end: 8.2 },
    ] },
  ],
  vtt: 'WEBVTT',
};

/** Ответ базовой модели: слова без сегментов и без длительности. */
const BASE = { text: 'Hello there', word_count: 2, words: [{ word: 'Hello', start: 0.1, end: 0.5 }, { word: 'there', start: 0.6, end: 1.0 }], vtt: '' };

describe('расшифровка', () => {
  it('normalizeTranscript: турбо — слова из сегментов и длительность из transcription_info; базовая — слова и конец последнего; мусор — null', () => {
    const t = normalizeTranscript(TURBO, STT_MODEL)!;
    expect(t.text).toBe(TURBO.text);
    expect(t.words).toHaveLength(17);
    expect(t.duration).toBe(12);
    expect(t.model).toBe(STT_MODEL);
    const b = normalizeTranscript(BASE, STT_FALLBACK_MODEL)!;
    expect(b.words).toHaveLength(2);
    expect(b.duration).toBe(1.0);
    expect(normalizeTranscript({ text: '   ' }, STT_MODEL)).toBeNull();
    expect(normalizeTranscript('nope', STT_MODEL)).toBeNull();
    expect(normalizeTranscript({ text: 'ok', words: [{ word: 'ok', start: 1, end: 0.5 }, { word: '', start: 0, end: 1 }] }, STT_MODEL)!.words).toEqual([]);
  });
  it('tempoScore: опорные точки и линейная середина, за пределами — края', () => {
    for (const [x, y] of TEMPO_POINTS) expect(tempoScore(x)).toBe(y);
    expect(tempoScore(72.5)).toBe(33); // между 60→25 и 85→40
    expect(tempoScore(300)).toBe(95);
    expect(tempoScore(-5)).toBe(0);
  });
  it('speechMetrics: темп, паузы дольше порога, заполнители, беглость со штрафами', () => {
    const t = normalizeTranscript(TURBO, STT_MODEL)!;
    const m = speechMetrics(t);
    expect(m.words).toBe(17);
    expect(m.duration).toBe(12);
    expect(m.wpm).toBe(85);
    expect(m.pauses).toBe(2); // 2.5 → 4.0 между «boilers,» и «um,»; 4.3 → 5.5 = 1.2 — тоже пауза
    expect(m.longestPause).toBe(1.5);
    expect(m.fillers).toBe(1);
    // темп 85 → 40; паузы: 2 за 0,25 мин (минимум четверть минуты) = 8 в минуту × 1,5 = 12; заполнители: 1 на 17 слов ≈ 5,9 на сто × 2 ≈ 11,8
    expect(m.fluency).toBe(16);
  });
  it('speechMetrics: без меток слов — темп по тексту и длительности, пауз нет; короткая запись — беглость не выше 10', () => {
    const quick = speechMetrics({ text: 'one two three four five six seven eight nine ten eleven twelve', words: [], duration: 6 });
    expect(quick).toMatchObject({ words: 12, wpm: 120, pauses: 0, longestPause: 0, fillers: 0 });
    expect(quick.fluency).toBe(tempoScore(120));
    const tiny = speechMetrics({ text: 'yes um no', words: [], duration: 2 });
    expect(tiny.fluency).toBeLessThanOrEqual(10);
    expect(tiny.fillers).toBe(1);
    const none = speechMetrics({ text: 'a b c d e f g h', words: [], duration: 0 });
    expect(none.wpm).toBe(0);
  });
  it('паузы считаются по порогу PAUSE_SEC между словами', () => {
    const words = [{ word: 'a', start: 0, end: 0.2 }, { word: 'b', start: 0.2 + PAUSE_SEC + 0.01, end: 1.6 }, { word: 'c', start: 1.6 + PAUSE_SEC - 0.1, end: 2.8 }, { word: 'd', start: 2.9, end: 3.0 }, { word: 'e', start: 3.0, end: 3.2 }];
    const m = speechMetrics({ text: 'a b c d e', words, duration: 3.2 });
    expect(m.pauses).toBe(1);
  });
  it('checkAudio: нет записи, чужой тип, слишком большая, слишком короткая', () => {
    expect(() => checkAudio(null, 'audio/wav')).toThrow(VoiceError);
    expect(() => checkAudio(audio(), 'text/plain')).toThrowError(/не поддерживается/);
    expect(() => checkAudio(audio(MAX_AUDIO_BYTES + 1), 'audio/wav')).toThrowError(/предела/);
    expect(() => checkAudio(audio(100), 'audio/webm;codecs=opus')).toThrowError(/короткая/);
    expect(() => checkAudio(audio(), 'audio/webm;codecs=opus')).not.toThrow();
    expect(() => checkAudio(audio(), '')).not.toThrow();
  });
  it('transcribe: турбо получает base64 и подсказку словаря; сбой турбо → базовая с массивом байтов; обе упали — stt_failed; тишина — audio_empty', async () => {
    const calls: [string, any][] = [];
    const ok = await transcribe(ENV, audio(), { aiRun: async (m, i) => { calls.push([m, i]); return TURBO; }, hint: 'boiler, turbine' });
    expect(ok.model).toBe(STT_MODEL);
    expect(calls[0][0]).toBe(STT_MODEL);
    expect(typeof calls[0][1].audio).toBe('string');
    expect(calls[0][1].initial_prompt).toBe('boiler, turbine');
    expect(calls[0][1].language).toBe('en');

    const fb = await transcribe(ENV, audio(), { aiRun: async (m) => { if (m === STT_MODEL) throw new Error('AI 5007'); return BASE; } });
    expect(fb.model).toBe(STT_FALLBACK_MODEL);
    expect(fb.text).toBe('Hello there');

    await expect(transcribe(ENV, audio(), { aiRun: async () => { throw new Error('AI down'); } })).rejects.toMatchObject({ code: 'stt_failed' });
    await expect(transcribe(ENV, audio(), { aiRun: async () => ({ text: '' }) })).rejects.toMatchObject({ code: 'audio_empty' });
  });
  it('recordSpeech: проверка, распознавание, запись в хранилище с мерками; publicSpeech без владельца', async () => {
    const mem = memoryStore();
    const take = await recordSpeech(ENV, mem.store, USER, audio(), 'audio/wav', { aiRun: async () => TURBO, now: () => NOW, id: () => 's1' });
    expect(take).toMatchObject({ id: 's1', userId: USER, text: TURBO.text, words: 17, wpm: 85, model: STT_MODEL, createdAt: NOW });
    expect(mem.speeches).toHaveLength(1);
    expect(await mem.store.getSpeech('s1', USER)).toMatchObject({ id: 's1' });
    expect(await mem.store.getSpeech('s1', 'other')).toBeNull();
    const pub = publicSpeech(take) as any;
    expect(pub.userId).toBeUndefined();
    expect(pub.fluency).toBe(take.fluency);
    await expect(recordSpeech(ENV, mem.store, USER, audio(10), 'audio/wav', { aiRun: async () => TURBO })).rejects.toMatchObject({ code: 'audio_empty' });
    expect(mem.speeches).toHaveLength(1);
  });
  it('base64 туда и обратно', () => {
    const b = new Uint8Array(70000).map((_, i) => i % 251);
    expect(fromBase64(toBase64(b))).toEqual(b);
    expect(fromBase64('data:audio/mpeg;base64,' + toBase64(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('озвучка', () => {
  it('validateTtsText: пусто, длинно, нормализация пробелов', () => {
    expect(validateTtsText('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateTtsText('x'.repeat(601))).toEqual({ ok: false, reason: 'too_long' });
    expect(validateTtsText('  Tell me   about it. ')).toEqual({ ok: true, text: 'Tell me about it.' });
  });
  it('normalizeTts: base64 в audio, строка, байты, поток; пусто — null', async () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0]);
    expect(await normalizeTts({ audio: toBase64(mp3) })).toEqual(mp3);
    expect(await normalizeTts(toBase64(mp3))).toEqual(mp3);
    expect(await normalizeTts(mp3)).toEqual(mp3);
    expect(await normalizeTts(mp3.buffer)).toEqual(mp3);
    expect(await normalizeTts(new Response(mp3))).toEqual(mp3);
    expect(await normalizeTts({ audio: '' })).toBeNull();
    expect(await normalizeTts(null)).toBeNull();
    expect(await normalizeTts({ nope: 1 })).toBeNull();
  });
  it('speak: MeloTTS получает текст и язык, отдаёт MP3; сбой или пустой ответ — tts_failed', async () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0]);
    let input: any;
    const s = await speak(ENV, 'Tell me about your experience.', { aiRun: async (m, i) => { input = [m, i]; return { audio: toBase64(mp3) }; } });
    expect(input).toEqual([TTS_MODEL, { prompt: 'Tell me about your experience.', lang: 'en' }]);
    expect(s).toMatchObject({ mime: 'audio/mpeg', model: TTS_MODEL });
    expect(s.audio).toEqual(mp3);
    await expect(speak(ENV, 'x', { aiRun: async () => { throw new Error('AI 429'); } })).rejects.toMatchObject({ code: 'tts_failed' });
    await expect(speak(ENV, 'x', { aiRun: async () => ({}) })).rejects.toMatchObject({ code: 'tts_failed' });
  });
  it('selfTestVoice: озвучка → распознавание той же фразы; расхождение и сбой — в строке', async () => {
    const mp3 = new Uint8Array(2048).fill(7);
    const good = await selfTestVoice(ENV, { aiRun: async (m) => m === TTS_MODEL ? { audio: toBase64(mp3) } : { text: 'Good morning, tell me about your experience.', transcription_info: { duration: 3 }, segments: [] } });
    expect(good).toMatch(/^ok: tts 2048 bytes, whisper/);
    const off = await selfTestVoice(ENV, { aiRun: async (m) => m === TTS_MODEL ? { audio: toBase64(mp3) } : { text: 'something else' } });
    expect(off).toMatch(/^mismatch/);
    const bad = await selfTestVoice(ENV, { aiRun: async () => { throw new Error('AI down'); } });
    expect(bad).toMatch(/^error: AI down/);
  });
});

describe('беглость в репетиции', () => {
  const SCRIPT_ANSWER = 'I led the commissioning of two boilers at a district heating plant and we reduced the start-up time by forty percent, which saved fuel and kept the schedule for the whole season of the plant.';
  const take = (id: string, fluency: number): SpeechTake => ({ id, userId: USER, text: SCRIPT_ANSWER, duration: 20, words: 35, wpm: 105, pauses: 1, longestPause: 1.4, fillers: 0, fluency, model: STT_MODEL, createdAt: NOW });
  it('rehearsalAxes: без записей — беглость null и вес выпадает; с записями — среднее, сводный учитывает вес 0,1', () => {
    const review = { axes: { grammar: 62, vocabulary: 58, coherence: 60, taskResponse: 66 } };
    const none = rehearsalAxes(review);
    expect(none.axes.fluency).toBeNull();
    expect(none.overall).toBe(62);
    const some = rehearsalAxes(review, [{ fluency: 40 }, { fluency: 50 }]);
    expect(some.axes.fluency).toBe(45);
    expect(some.overall).toBe(Math.round(0.3 * 62 + 0.2 * 58 + 0.2 * 60 + 0.2 * 66 + 0.1 * 45));
    expect(some.overall).toBe(60);
  });
  it('answer с speechId: запись своя — хранится на вопросе и видна меркой; чужая или неизвестная — answer_invalid speech_unknown; в подсказке экзаменатору ответ помечен как устный', async () => {
    const mem = memoryStore();
    await mem.store.insertSpeech(take('s1', 48));
    const fail = async () => { throw new Error('AI down'); };
    const o = { chatFn: fail, now: () => NOW, id: (() => { let n = 0; return () => `id${++n}`; })() };
    let v = await startOrResume(ENV, mem.store, USER, 'Asia/Almaty', null, o);
    await expect(answer(ENV, mem.store, USER, v.current!.turnId, { text: SCRIPT_ANSWER, speechId: 'nope' }, 'Asia/Almaty', null, o)).rejects.toMatchObject({ code: 'answer_invalid', reason: 'speech_unknown' });
    v = await answer(ENV, mem.store, USER, v.current!.turnId, { text: SCRIPT_ANSWER, speechId: 's1' }, 'Asia/Almaty', null, o);
    expect(v.answered).toBe(1);
    expect(v.spoken).toBe(1);
    expect(v.turns[0].speech).toMatchObject({ wpm: 105, pauses: 1, fillers: 0, fluency: 48 });
    expect(v.turns[0].speech).not.toHaveProperty('text');
    expect(mem.turns[0].speechId).toBe('s1');
    const turns = await mem.store.listTurns(v.id);
    const [, user] = reviewPrompt({ targetRole: null, level: 'B1' }, turns, { specialty: null, industry: null, targetRole: null, keywords: [] });
    expect(user.content).toContain("CANDIDATE'S ANSWER (spoken; automatic transcript");
    expect(user.content.split('(spoken;').length - 1).toBe(1);
    // набранный ответ без speechId — как раньше
    v = await answer(ENV, mem.store, USER, v.current!.turnId, SCRIPT_ANSWER, 'Asia/Almaty', null, o);
    expect(v.turns[1].speech).toBeNull();
    expect(v.spoken).toBe(1);
  });
  it('d1SpeechStore и колонка speech_id на настоящем SQL миграций', async () => {
    const db = d1Of(freshDb());
    await db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(USER, 'u1@example.com').run();
    const store = d1SpeechStore(db);
    await store.insertSpeech(take('s9', 55));
    expect(await store.getSpeech('s9', USER)).toMatchObject({ id: 's9', fluency: 55, wpm: 105, longestPause: 1.4, model: STT_MODEL });
    expect(await store.getSpeech('s9', 'other')).toBeNull();
    const cols = (await db.prepare("SELECT name FROM pragma_table_info('rehearsal_turns')").all()).results.map((r: any) => r.name);
    expect(cols).toContain('speech_id');
  });
  it('TurnView: ответ набран — speech null', () => {
    const t: Turn = { id: 't', rehearsalId: 'r', userId: USER, position: 1, kind: 'experience', question: 'q', rubric: [], answer: null, score: null, feedback: null, speechId: null, createdAt: NOW, answeredAt: null };
    expect(t.speechId).toBeNull();
  });
});

describe('маршруты /api/voice', () => {
  const mp3 = new Uint8Array(2048).fill(3);
  const turbo = { text: 'I led the commissioning of two boilers and we reduced the start-up time by forty percent for the plant.', transcription_info: { duration: 9 }, segments: [] };
  async function session(aiRun: (m: string, i: any) => Promise<any>) {
    const mem = memoryStore();
    const env = { DB: null, AI: { run: aiRun }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
    const { createApp } = await import('../functions/_lib/app');
    const app = createApp('test', () => mem.store);
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, env);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const r1 = await post('/auth/request', { email: 'y@example.com' });
    const { code } = await r1.json() as any;
    const r2 = await post('/auth/verify', { email: 'y@example.com', code });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    return { mem, call, post, h: { cookie }, env };
  }
  const upload = (call: any, h: any, bytes: Uint8Array<ArrayBuffer>, type: string, name = 'answer.wav') => {
    const fd = new FormData();
    fd.append('audio', new File([bytes], name, { type }));
    return call('/voice/transcribe', { method: 'POST', headers: h, body: fd });
  };
  it('без входа — 401 на transcribe, speak и meta', async () => {
    const { call, post } = await session(async () => ({}));
    expect((await call('/voice/meta')).status).toBe(401);
    expect((await post('/voice/speak', { text: 'hi' })).status).toBe(401);
    expect((await upload(call, {}, audio(), 'audio/wav')).status).toBe(401);
  });
  it('transcribe: WAV → запись с расшифровкой и мерками; подсказка словаря из профиля; её id принимает ответ репетиции', async () => {
    const inputs: any[] = [];
    const { call, post, h, mem } = await session(async (m, i) => { inputs.push([m, i]); return m === STT_MODEL ? turbo : { response: '{}' }; });
    mem.profiles.set(mem.users[0].id, { ...(await mem.store.getProfile(mem.users[0].id) ?? {} as any), userId: mem.users[0].id, keywords: ['boiler efficiency', 'steam turbine'] });
    const r = await upload(call, h, audio(50000), 'audio/wav');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j).toMatchObject({ ok: true, maxSeconds: 120, stt: STT_MODEL, tts: TTS_MODEL });
    expect(j.speech).toMatchObject({ text: turbo.text, words: 19, duration: 9, wpm: 127 });
    expect(j.speech.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(j.speech.userId).toBeUndefined();
    expect(inputs[0][1].initial_prompt).toBe('boiler efficiency, steam turbine');
    expect(mem.speeches).toHaveLength(1);
    expect(mem.speeches[0].userId).toBe(mem.users[0].id);
    const meta = await (await call('/voice/meta', { headers: h })).json() as any;
    expect(meta).toMatchObject({ ok: true, maxBytes: MAX_AUDIO_BYTES, maxChars: 600 });
    void post;
  });
  it('transcribe: сырой audio/webm телом тоже принимается; чужой тип — 415; тишина — 422; сбой моделей — 502; без файла — 400', async () => {
    let fail = false, silent = false;
    const { call, h } = await session(async (m) => { if (fail) throw new Error('AI down'); if (silent) return { text: '' }; return m === STT_MODEL ? turbo : {}; });
    const raw = await call('/voice/transcribe', { method: 'POST', headers: { ...h, 'content-type': 'audio/webm;codecs=opus' }, body: audio(30000) });
    expect(raw.status).toBe(200);
    expect(((await raw.json()) as any).speech.words).toBe(19);
    const bad = await upload(call, h, audio(), 'text/plain', 'x.txt');
    expect(bad.status).toBe(415);
    expect(await bad.json()).toMatchObject({ ok: false, error: 'audio_unsupported' });
    silent = true;
    const quiet = await upload(call, h, audio(), 'audio/wav');
    expect(quiet.status).toBe(422);
    expect(await quiet.json()).toMatchObject({ error: 'audio_empty' });
    silent = false; fail = true;
    const down = await upload(call, h, audio(), 'audio/wav');
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ error: 'stt_failed' });
    const none = await call('/voice/transcribe', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{}' });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: 'audio_missing' });
    const big = await call('/voice/transcribe', { method: 'POST', headers: { ...h, 'content-type': 'audio/wav', 'content-length': String(MAX_AUDIO_BYTES * 2) }, body: audio() });
    expect(big.status).toBe(413);
  });
  it('speak: текст → MP3 с типом audio/mpeg; пустой или длинный текст — 400; сбой — 502', async () => {
    let fail = false;
    const { post, h } = await session(async (m, i) => { if (fail) throw new Error('AI 429'); expect(m).toBe(TTS_MODEL); expect(i.lang).toBe('en'); return { audio: toBase64(mp3) }; });
    const r = await post('/voice/speak', { text: 'Tell me about your experience.' }, h);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/mpeg');
    expect(r.headers.get('x-tts-model')).toBe(TTS_MODEL);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(mp3);
    expect((await post('/voice/speak', { text: '' }, h)).status).toBe(400);
    const long = await post('/voice/speak', { text: 'x'.repeat(601) }, h);
    expect(await long.json()).toMatchObject({ error: 'tts_text_invalid', reason: 'too_long' });
    fail = true;
    const down = await post('/voice/speak', { text: 'hi' }, h);
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ error: 'tts_failed' });
  });
  it('health?deep=2 включает строку voice: озвучка и распознавание', async () => {
    const { call } = await session(async (m) => m === TTS_MODEL ? { audio: toBase64(mp3) } : m === STT_MODEL ? { text: 'Good morning. Tell me about your experience.', transcription_info: { duration: 3 }, segments: [] } : { response: '{"specialty":"x","industry":"y","years":1,"keywords":[]}' });
    const j = await (await call('/health?deep=2')).json() as any;
    expect(j.voice).toMatch(/^ok: tts 2048 bytes/);
  });
});
