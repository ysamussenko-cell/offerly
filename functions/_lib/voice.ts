/** Голос (4.2): запись из браузера → Whisper на Workers AI → текст; озвучка реплик тренера через MeloTTS.
 *  Голосовой ответ доступен на любой вопрос занятия, теста и репетиции: клиент пишет звук, отдаёт его сюда,
 *  получает расшифровку и подставляет её в поле ответа — дальше ответ идёт обычным путём (проверка по эталону
 *  или экзаменатор). Расшифровка и мерки речи сохраняются записью speech_takes, а ответ ссылается на неё по id:
 *  ось «беглость речи» в репетиции считается по сохранённым меркам, а не по словам клиента.
 *  Мерки беглости — эвристика по временным меткам слов Whisper, без модели: темп (слов в минуту), паузы дольше
 *  PAUSE_SEC между словами, заполнители (um, uh, er…). Балл 0–100 по единой шкале ступеней (scoring.ts): темп
 *  переводится в балл по опорным точкам TEMPO_POINTS (A2 ≈ 60 слов/мин, B1 ≈ 85, B2 ≈ 110–135, C1 ≈ 160),
 *  паузы и заполнители снимают баллы. Это не оценка содержания — её даёт экзаменатор по расшифровке. */
import type { Env as ProviderEnv } from './providers';
import type { Bytes } from './types';
import { DomainError } from './errors';

/** Модель распознавания: турбо принимает base64 и отдаёт длительность и метки слов; запасная — массив байтов. */
export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const STT_FALLBACK_MODEL = '@cf/openai/whisper';
/** Озвучка: MeloTTS, английский голос тренера. */
export const TTS_MODEL = '@cf/myshell-ai/melotts';

/** Предел размера записи (WAV 16 кГц моно 16 бит ≈ 32 КБ/с: две минуты ≈ 3,8 МБ). */
export const MAX_AUDIO_BYTES = 6 * 1024 * 1024;
/** Предел длительности записи на клиенте — секунд; длиннее не пишется. */
export const MAX_SECONDS = 120;
/** Предел текста для озвучки — знаков. */
export const MAX_TTS_CHARS = 600;
/** Пауза между словами дольше этого — считается паузой речи. */
export const PAUSE_SEC = 1.0;
/** Минимум слов и секунд, чтобы мерки имели смысл. */
export const MIN_WORDS = 5;
export const MIN_SECONDS = 3;
/** Какие типы записи принимаются (WAV — основной: клиент перекодирует в него; остальное — как есть, если перекодировать не удалось). */
export const AUDIO_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'video/webm', 'video/mp4'];

/** Опорные точки темпа: слов в минуту → балл беглости (между точками — линейно). */
export const TEMPO_POINTS: [number, number][] = [[0, 0], [40, 10], [60, 25], [85, 40], [110, 55], [135, 70], [160, 85], [190, 95]];
/** Штраф за паузы: баллов за каждую паузу в минуту речи, не больше PAUSE_CAP. */
export const PAUSE_PENALTY = 1.5, PAUSE_CAP = 20;
/** Штраф за заполнители: баллов за каждый на сто слов, не больше FILLER_CAP. */
export const FILLER_PENALTY = 2, FILLER_CAP = 12;
const FILLER = /^(u+m+|u+h+|e+r+m*|h+m+|m+m+|a+h+|u+h+m+|uh-huh|mhm)$/i;

export interface TranscriptWord { word: string; start: number; end: number }
export interface Transcript { text: string; words: TranscriptWord[]; duration: number; model: string }

export interface SpeechMetrics {
  words: number; duration: number; wpm: number; pauses: number; longestPause: number; fillers: number; fluency: number;
}

export interface SpeechTake extends SpeechMetrics {
  id: string; userId: string; text: string; model: string | null; createdAt: string;
}

export interface SpeechStore {
  insertSpeech(take: SpeechTake): Promise<void>;
  /** Запись речи пользователя по id; чужая или неизвестная — null. */
  getSpeech(id: string, userId: string): Promise<SpeechTake | null>;
}

export type VoiceErrorCode = 'audio_missing' | 'audio_unsupported' | 'audio_too_large' | 'audio_empty' | 'stt_failed' | 'tts_failed' | 'tts_text_invalid';
const VOICE_STATUS: Record<VoiceErrorCode, number> = { audio_missing: 400, audio_unsupported: 415, audio_too_large: 413, audio_empty: 422, stt_failed: 502, tts_failed: 502, tts_text_invalid: 400 };
export class VoiceError extends DomainError {
  declare code: VoiceErrorCode;
  constructor(code: VoiceErrorCode, message?: string) { super(code, VOICE_STATUS[code], message); }
}

const round = (x: number) => Math.round(Math.max(0, Math.min(100, x)));
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN; return Number.isFinite(n) ? n : null; };
export const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

// ---------- base64 ----------

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Bytes {
  const s = atob(b64.replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------- распознавание ----------

/** Приводит ответ Whisper (обеих моделей) к расшифровке: текст, метки слов, длительность. null — текста нет. */
export function normalizeTranscript(raw: unknown, model: string): Transcript | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, any>;
  const text = typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim() : '';
  const words: TranscriptWord[] = [];
  const push = (w: any) => {
    if (!w || typeof w !== 'object') return;
    const word = typeof w.word === 'string' ? w.word.trim() : '';
    const start = num(w.start), end = num(w.end);
    if (!word || start == null || end == null || end < start) return;
    words.push({ word, start, end });
  };
  if (Array.isArray(o.words)) o.words.forEach(push);
  else if (Array.isArray(o.segments)) for (const s of o.segments) if (s && Array.isArray(s.words)) s.words.forEach(push);
  words.sort((a, b) => a.start - b.start);
  const info = o.transcription_info && typeof o.transcription_info === 'object' ? o.transcription_info : {};
  const duration = num(info.duration) ?? (words.length ? words[words.length - 1].end : 0);
  if (!text) return null;
  return { text, words, duration: Math.max(0, duration), model };
}

/** Мерки речи по расшифровке: темп, паузы, заполнители, балл беглости. */
export function speechMetrics(t: Pick<Transcript, 'text' | 'words' | 'duration'>): SpeechMetrics {
  const words = Math.max(countWords(t.text), t.words.length);
  const duration = Math.max(t.duration, t.words.length ? t.words[t.words.length - 1].end : 0);
  const minutes = duration / 60;
  const wpm = minutes > 0 ? Math.round(words / minutes) : 0;
  let pauses = 0, longestPause = 0;
  for (let i = 1; i < t.words.length; i++) {
    const gap = t.words[i].start - t.words[i - 1].end;
    if (gap > longestPause) longestPause = gap;
    if (gap > PAUSE_SEC) pauses++;
  }
  longestPause = Math.round(longestPause * 10) / 10;
  const fillers = t.words.length
    ? t.words.filter(w => FILLER.test(w.word.replace(/[^a-z-]/gi, ''))).length
    : t.text.split(/\s+/).filter(w => FILLER.test(w.replace(/[^a-z-]/gi, ''))).length;
  let fluency: number;
  if (words < MIN_WORDS || duration < MIN_SECONDS) fluency = Math.min(10, tempoScore(wpm));
  else {
    const pausePenalty = Math.min(PAUSE_CAP, (pauses / Math.max(minutes, 0.25)) * PAUSE_PENALTY);
    const fillerPenalty = Math.min(FILLER_CAP, (fillers / words) * 100 * FILLER_PENALTY);
    fluency = round(tempoScore(wpm) - pausePenalty - fillerPenalty);
  }
  return { words, duration: Math.round(duration * 10) / 10, wpm, pauses, longestPause, fillers, fluency };
}

/** Балл за темп по опорным точкам, линейно между ними. */
export function tempoScore(wpm: number): number {
  const pts = TEMPO_POINTS;
  if (wpm <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x0, y0] = pts[i - 1];
    if (wpm <= x1) return round(y0 + (y1 - y0) * (wpm - x0) / (x1 - x0));
  }
  return pts[pts.length - 1][1];
}

export interface VoiceOpts {
  /** Подмена вызова Workers AI (тесты). */
  aiRun?: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  now?: () => string;
  id?: () => string;
}

const runner = (env: ProviderEnv, opts: VoiceOpts) => opts.aiRun ?? ((model: string, input: Record<string, unknown>) => env.AI.run(model as any, input as any) as Promise<unknown>);

/** Проверка записи до распознавания: есть, поддерживаемого типа, не больше предела. */
export function checkAudio(bytes: Uint8Array | null, mime: string): void {
  if (!bytes || bytes.length === 0) throw new VoiceError('audio_missing', 'запись не пришла');
  const base = mime.split(';')[0].trim().toLowerCase();
  if (base && !AUDIO_TYPES.includes(base)) throw new VoiceError('audio_unsupported', `тип ${base} не поддерживается`);
  if (bytes.length > MAX_AUDIO_BYTES) throw new VoiceError('audio_too_large', 'запись больше предела');
  if (bytes.length < 1024) throw new VoiceError('audio_empty', 'запись слишком короткая');
}

/** Распознавание речи: турбо-модель (base64; подсказка словаря — термины домена), при сбое — базовая (массив байтов).
 *  Пустая расшифровка — audio_empty (в записи нет речи). */
export async function transcribe(env: ProviderEnv, bytes: Uint8Array, opts: VoiceOpts & { hint?: string } = {}): Promise<Transcript> {
  const run = runner(env, opts);
  const errors: string[] = [];
  try {
    const input: Record<string, unknown> = { audio: toBase64(bytes), task: 'transcribe', language: 'en' };
    if (opts.hint) input.initial_prompt = opts.hint.slice(0, 200);
    const t = normalizeTranscript(await run(STT_MODEL, input), STT_MODEL);
    if (t) return t;
    throw new VoiceError('audio_empty', 'речь не распознана');
  } catch (e) {
    if (e instanceof VoiceError && e.code === 'audio_empty') throw e;
    errors.push(`${STT_MODEL}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
  }
  try {
    const t = normalizeTranscript(await run(STT_FALLBACK_MODEL, { audio: [...bytes] }), STT_FALLBACK_MODEL);
    if (t) return t;
    throw new VoiceError('audio_empty', 'речь не распознана');
  } catch (e) {
    if (e instanceof VoiceError && e.code === 'audio_empty') throw e;
    errors.push(`${STT_FALLBACK_MODEL}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
  }
  throw new VoiceError('stt_failed', errors.join('; '));
}

/** Распознать и сохранить запись речи пользователя: расшифровка и мерки в speech_takes. */
export async function recordSpeech(env: ProviderEnv, store: SpeechStore, userId: string, bytes: Uint8Array, mime: string, opts: VoiceOpts & { hint?: string } = {}): Promise<SpeechTake> {
  checkAudio(bytes, mime);
  const t = await transcribe(env, bytes, opts);
  const m = speechMetrics(t);
  const take: SpeechTake = { id: (opts.id ?? (() => crypto.randomUUID()))(), userId, text: t.text, model: t.model, createdAt: (opts.now ?? (() => new Date().toISOString()))(), ...m };
  await store.insertSpeech(take);
  return take;
}

export interface PublicSpeech { id: string; text: string; words: number; duration: number; wpm: number; pauses: number; longestPause: number; fillers: number; fluency: number; createdAt: string }

export const publicSpeech = (s: SpeechTake): PublicSpeech => ({ id: s.id, text: s.text, words: s.words, duration: s.duration, wpm: s.wpm, pauses: s.pauses, longestPause: s.longestPause, fillers: s.fillers, fluency: s.fluency, createdAt: s.createdAt });

/** Мерки речи для разбора (без текста и владельца). */
export const speechSummary = (s: SpeechMetrics): SpeechMetrics => ({ words: s.words, duration: s.duration, wpm: s.wpm, pauses: s.pauses, longestPause: s.longestPause, fillers: s.fillers, fluency: s.fluency });

// ---------- озвучка ----------

/** Текст для озвучки: строка 1–MAX_TTS_CHARS знаков без лишних пробелов. */
export function validateTtsText(raw: unknown): { ok: true; text: string } | { ok: false; reason: 'empty' | 'too_long' } {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!s) return { ok: false, reason: 'empty' };
  if (s.length > MAX_TTS_CHARS) return { ok: false, reason: 'too_long' };
  return { ok: true, text: s };
}

/** Приводит ответ MeloTTS к байтам MP3: base64 в поле audio, либо бинарный ответ. null — звука нет. */
export async function normalizeTts(raw: unknown): Promise<Bytes | null> {
  if (!raw) return null;
  if (raw instanceof Uint8Array) return raw.length ? new Uint8Array(raw) : null;
  if (raw instanceof ArrayBuffer) return raw.byteLength ? new Uint8Array(raw) : null;
  if (typeof (raw as any).arrayBuffer === 'function') { const b = new Uint8Array(await (raw as any).arrayBuffer()); return b.length ? b : null; }
  if (typeof raw === 'string') { try { const b = fromBase64(raw); return b.length ? b : null; } catch { return null; } }
  if (typeof raw === 'object' && typeof (raw as any).audio === 'string') { try { const b = fromBase64((raw as any).audio); return b.length ? b : null; } catch { return null; } }
  return null;
}

/** Озвучка реплики тренера: MP3 от MeloTTS. */
export async function speak(env: ProviderEnv, text: string, opts: VoiceOpts = {}): Promise<{ audio: Bytes; mime: string; model: string }> {
  const run = runner(env, opts);
  let audio: Bytes | null;
  try { audio = await normalizeTts(await run(TTS_MODEL, { prompt: text, lang: 'en' })); }
  catch (e) { throw new VoiceError('tts_failed', String(e instanceof Error ? e.message : e).slice(0, 300)); }
  if (!audio) throw new VoiceError('tts_failed', 'модель не вернула звук');
  return { audio, mime: 'audio/mpeg', model: TTS_MODEL };
}

/** Самопроверка голосового контура для /api/health?deep: озвучить фразу и распознать её же. */
export async function selfTestVoice(env: ProviderEnv, opts: VoiceOpts = {}): Promise<string> {
  const phrase = 'Good morning. Tell me about your experience.';
  try {
    const s = await speak(env, phrase, opts);
    const t = await transcribe(env, s.audio, opts);
    const heard = t.text.toLowerCase();
    const ok = ['morning', 'experience'].every(w => heard.includes(w));
    return `${ok ? 'ok' : 'mismatch'}: tts ${s.audio.length} bytes, whisper «${t.text.slice(0, 80)}» (${t.words.length} words, ${t.duration}s, ${t.model})`;
  } catch (e) { return `error: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`; }
}

// ---------- хранилище D1 ----------

export function d1SpeechStore(db: D1Database): SpeechStore {
  const toS = (r: any): SpeechTake => ({
    id: r.id, userId: r.user_id, text: r.text, duration: Number(r.duration), words: Number(r.words), wpm: Number(r.wpm), pauses: Number(r.pauses),
    longestPause: Number(r.longest_pause), fillers: Number(r.fillers), fluency: Number(r.fluency), model: r.model ?? null, createdAt: r.created_at,
  });
  return {
    async insertSpeech(s) {
      await db.prepare('INSERT INTO speech_takes (id, user_id, text, duration, words, wpm, pauses, longest_pause, fillers, fluency, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(s.id, s.userId, s.text, s.duration, s.words, s.wpm, s.pauses, s.longestPause, s.fillers, s.fluency, s.model, s.createdAt).run();
    },
    async getSpeech(id, userId) {
      const r = await db.prepare('SELECT * FROM speech_takes WHERE id = ? AND user_id = ?').bind(id, userId).first();
      return r ? toS(r) : null;
    },
  };
}
