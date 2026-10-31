/** Экран настроек (4.6): свой ключ провайдера модели, общее время уведомлений, экспорт данных.
 *
 *  Ключ провайдера хранится только зашифрованным — AES-256-GCM на WebCrypto, в поле key_enc лежит «v1.<iv>.<шифртекст>»
 *  (base64url), а id пользователя подмешан как дополнительные данные (AAD): шифртекст одного пользователя не расшифруется
 *  под другим. Мастер-ключ — секрет KEYS_SECRET (любая строка, из неё берётся SHA-256), а если его нет — случайные 32 байта,
 *  один раз созданные и записанные в app_settings под ключом «keyring» (тот же приём, что у VAPID в push.ts). Смена
 *  мастер-ключа делает сохранённые ключи нечитаемыми: экран показывает «ключ не читается — введите заново».
 *
 *  Расшифрованный ключ живёт только в памяти запроса: middleware кладёт его в env.USER_PROVIDER, chat() в providers.ts
 *  берёт его, когда вызывающий не задал провайдера явно. Наружу (GET /api/settings, экспорт) уходят провайдер, модель и
 *  последние четыре знака ключа — сам ключ не возвращается никогда. */
import { PROVIDERS, chat, type Env as ProviderEnv, type ProviderId, type UserProvider } from './providers';
import type { Assessment, Attempt } from './assessment';
import type { SpeechTake } from './voice';

export const KEYRING_SETTING_KEY = 'keyring';
export const KEY_MIN_CHARS = 8;
export const KEY_MAX_CHARS = 512;
export const MODEL_MAX_CHARS = 120;
export const HINT_CHARS = 4;
export const CHECK_PROMPT = 'Reply with the single word: ok';

export interface SettingsEnv { KEYS_SECRET?: string }

export interface ProviderKey {
  userId: string; provider: ProviderId; model: string | null;
  keyEnc: string; keyHint: string;
  checkedAt: string | null; checkNote: string | null;
  createdAt: string; updatedAt: string;
}

export interface SettingsStore {
  getProviderKey(userId: string): Promise<ProviderKey | null>;
  /** Один пользователь — один ключ: повторное сохранение заменяет провайдера, модель и шифртекст. */
  saveProviderKey(k: ProviderKey): Promise<void>;
  deleteProviderKey(userId: string): Promise<boolean>;
  /** Для экспорта: все тесты и срезы пользователя по времени начала, все записи речи. */
  listAssessments(userId: string): Promise<Assessment[]>;
  listSpeeches(userId: string): Promise<SpeechTake[]>;
  getSetting(key: string): Promise<string | null>;
  initSetting(key: string, value: string, nowIso: string): Promise<string>;
}

export class SettingsError extends Error {
  constructor(public code: 'key_invalid' | 'key_unreadable' | 'key_none' | 'key_check_failed', public reason?: string, message?: string) { super(message ?? code); }
}

// ---------- base64url и шифрование ----------

const b64url = {
  encode(bytes: Uint8Array): string {
    let s = ''; for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(b, c => c.charCodeAt(0));
  },
};
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Мастер-ключ: из секрета окружения (SHA-256 строки) или из app_settings (создаётся один раз). */
export async function masterKey(env: SettingsEnv, store: Pick<SettingsStore, 'getSetting' | 'initSetting'>, nowIso = new Date().toISOString()): Promise<{ key: CryptoKey; source: 'env' | 'db' }> {
  let raw: Uint8Array;
  let source: 'env' | 'db';
  if (env.KEYS_SECRET && env.KEYS_SECRET.trim()) {
    raw = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(env.KEYS_SECRET.trim())));
    source = 'env';
  } else {
    const existing = await store.getSetting(KEYRING_SETTING_KEY);
    const value = existing ?? await store.initSetting(KEYRING_SETTING_KEY, b64url.encode(crypto.getRandomValues(new Uint8Array(32))), nowIso);
    try { raw = b64url.decode(value); } catch { raw = new Uint8Array(0); }
    if (raw.length !== 32) throw new SettingsError('key_unreadable', 'keyring', 'в app_settings лежит повреждённая запись keyring');
    source = 'db';
  }
  const key = await crypto.subtle.importKey('raw', raw as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { key, source };
}

export async function encryptSecret(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, utf8(plaintext)));
  return `v1.${b64url.encode(iv)}.${b64url.encode(ct)}`;
}

/** null — шифртекст не читается этим мастер-ключом (ключ сменился) или повреждён. */
export async function decryptSecret(key: CryptoKey, enc: string, aad: string): Promise<string | null> {
  const parts = enc.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64url.decode(parts[1]), additionalData: utf8(aad) }, key, b64url.decode(parts[2]));
    return new TextDecoder().decode(plain);
  } catch { return null; }
}

// ---------- ключ провайдера ----------

export interface KeyInput { provider: ProviderId; apiKey: string; model: string | null }

/** Тело PUT /api/settings/key: провайдер из списка (не встроенный), ключ без пробелов 8–512 знаков с префиксом провайдера,
 *  если тот известен, модель — необязательная строка до 120 знаков из букв, цифр, «.-_:/». */
export function parseKeyBody(body: unknown): { ok: true; value: KeyInput } | { ok: false; reason: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const provider = PROVIDERS.find(p => p.id === b.provider);
  if (!provider || provider.id === 'workers-ai') return { ok: false, reason: 'provider' };
  const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
  if (apiKey.length < KEY_MIN_CHARS || apiKey.length > KEY_MAX_CHARS || /\s/.test(apiKey)) return { ok: false, reason: 'key' };
  if (provider.prefix && !apiKey.startsWith(provider.prefix)) return { ok: false, reason: 'prefix' };
  let model: string | null = null;
  if (b.model != null && b.model !== '') {
    if (typeof b.model !== 'string') return { ok: false, reason: 'model' };
    model = b.model.trim();
    if (!model || model.length > MODEL_MAX_CHARS || !/^[\w.\-:/]+$/.test(model)) return { ok: false, reason: 'model' };
    if (model === provider.defaultModel) model = null;
  }
  return { ok: true, value: { provider: provider.id, apiKey, model } };
}

export const keyHint = (apiKey: string) => `…${apiKey.slice(-HINT_CHARS)}`;

/** Зашифровать и сохранить ключ; прежняя проверка сбрасывается. */
export async function saveKey(env: SettingsEnv, store: SettingsStore, userId: string, input: KeyInput, nowIso = new Date().toISOString()): Promise<ProviderKey> {
  const { key } = await masterKey(env, store, nowIso);
  const prev = await store.getProviderKey(userId);
  const row: ProviderKey = {
    userId, provider: input.provider, model: input.model, keyEnc: await encryptSecret(key, input.apiKey, userId), keyHint: keyHint(input.apiKey),
    checkedAt: null, checkNote: null, createdAt: prev?.createdAt ?? nowIso, updatedAt: nowIso,
  };
  await store.saveProviderKey(row);
  return row;
}

/** Провайдер пользователя для env.USER_PROVIDER: null — своего ключа нет или он не читается (тогда работает встроенная модель). */
export async function userProvider(env: SettingsEnv, store: SettingsStore, userId: string): Promise<UserProvider | null> {
  const row = await store.getProviderKey(userId);
  if (!row) return null;
  const { key } = await masterKey(env, store);
  const apiKey = await decryptSecret(key, row.keyEnc, userId);
  if (!apiKey) return null;
  return { provider: row.provider, apiKey, model: row.model, fallback: true };
}

/** Проверка ключа одним коротким вызовом модели без отката на встроенную; итог записывается в checked_at / check_note. */
export async function checkKey(env: SettingsEnv & ProviderEnv, store: SettingsStore, userId: string, nowIso = new Date().toISOString()): Promise<{ row: ProviderKey; ok: boolean; reply: string | null; detail: string | null }> {
  const row = await store.getProviderKey(userId);
  if (!row) throw new SettingsError('key_none');
  const { key } = await masterKey(env, store, nowIso);
  const apiKey = await decryptSecret(key, row.keyEnc, userId);
  if (!apiKey) throw new SettingsError('key_unreadable', 'master', 'сохранённый ключ не читается текущим мастер-ключом — введите ключ заново');
  let ok = false, reply: string | null = null, detail: string | null = null;
  try {
    reply = (await chat(env, [{ role: 'user', content: CHECK_PROMPT }], { provider: row.provider, apiKey, model: row.model ?? undefined, maxTokens: 8 })).trim();
    ok = reply.length > 0;
    if (!ok) detail = 'пустой ответ';
  } catch (e) { detail = String(e instanceof Error ? e.message : e).slice(0, 300); }
  const updated: ProviderKey = { ...row, checkedAt: ok ? nowIso : row.checkedAt, checkNote: ok ? 'ok' : `error:${detail}`, updatedAt: nowIso };
  await store.saveProviderKey(updated);
  return { row: updated, ok, reply, detail };
}

/** Что отдаём наружу о ключе — без шифртекста. readable — расшифровывается ли он текущим мастер-ключом. */
export function publicKey(row: ProviderKey | null, readable: boolean) {
  if (!row) return null;
  const p = PROVIDERS.find(x => x.id === row.provider);
  return {
    provider: row.provider, providerName: p?.name ?? row.provider, short: p?.short ?? row.provider, model: row.model ?? p?.defaultModel ?? null, custom: row.model != null,
    hint: row.keyHint, readable, checkedAt: row.checkedAt, checkNote: row.checkNote, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

/** Список провайдеров для формы: встроенная модель — отдельно, остальные — с адресом страницы ключей и префиксом. */
export const providerOptions = () => PROVIDERS.filter(p => p.id !== 'workers-ai').map(({ id, name, short, keyUrl, defaultModel, prefix, free }) => ({ id, name, short, keyUrl: keyUrl ?? null, defaultModel, prefix: prefix ?? null, free }));

// ---------- экспорт данных ----------

export interface ExportStore extends SettingsStore {
  getProfile(userId: string): Promise<unknown>;
  listAttempts(assessmentId: string): Promise<Attempt[]>;
  listCards(userId: string): Promise<unknown[]>;
  listProgramDays(userId: string): Promise<unknown[]>;
  listLessons(userId: string): Promise<{ id: string }[]>;
  listSteps(lessonId: string): Promise<unknown[]>;
  listRehearsals(userId: string): Promise<{ id: string }[]>;
  listTurns(rehearsalId: string): Promise<unknown[]>;
  listAchievements(userId: string): Promise<unknown[]>;
  getPushSetting(userId: string): Promise<unknown>;
  listPushSubscriptions(userId: string): Promise<{ id: string; userAgent: string | null; createdAt: string; lastSentAt: string | null; lastError: string | null }[]>;
}

/** Все данные пользователя одним JSON: без ключа провайдера, без адресов и ключей push-подписок, без сессий и кодов входа. */
export async function exportData(store: ExportStore, user: { id: string; email: string; name: string | null; locale: string; tz: string }, version: string, nowIso = new Date().toISOString()) {
  const assessments = await store.listAssessments(user.id);
  const lessons = await store.listLessons(user.id);
  const rehearsals = await store.listRehearsals(user.id);
  const key = await store.getProviderKey(user.id);
  const subs = await store.listPushSubscriptions(user.id);
  return {
    app: 'Offerly', version, exportedAt: nowIso, format: 1,
    user: { id: user.id, email: user.email, name: user.name, locale: user.locale, tz: user.tz },
    profile: await store.getProfile(user.id),
    providerKey: key ? { provider: key.provider, model: key.model, hint: key.keyHint, checkedAt: key.checkedAt, checkNote: key.checkNote, createdAt: key.createdAt } : null,
    assessments: await Promise.all(assessments.map(async a => ({ ...a, attempts: await store.listAttempts(a.id) }))),
    cards: await store.listCards(user.id),
    programDays: await store.listProgramDays(user.id),
    lessons: await Promise.all(lessons.map(async l => ({ ...l, steps: await store.listSteps(l.id) }))),
    rehearsals: await Promise.all(rehearsals.map(async r => ({ ...r, turns: await store.listTurns(r.id) }))),
    achievements: await store.listAchievements(user.id),
    speeches: await store.listSpeeches(user.id),
    push: { setting: await store.getPushSetting(user.id), devices: subs.map(s => ({ id: s.id, userAgent: s.userAgent, createdAt: s.createdAt, lastSentAt: s.lastSentAt, lastError: s.lastError })) },
  };
}

/** Сводка для карточки экспорта: сколько чего накопилось. */
export async function exportCounts(store: ExportStore, userId: string) {
  const [assessments, cards, days, lessons, rehearsals, speeches] = await Promise.all([
    store.listAssessments(userId), store.listCards(userId), store.listProgramDays(userId), store.listLessons(userId), store.listRehearsals(userId), store.listSpeeches(userId),
  ]);
  return { assessments: assessments.length, cards: cards.length, programDays: days.length, lessons: lessons.length, rehearsals: rehearsals.length, speeches: speeches.length };
}

export const exportFileName = (date: string) => `offerly-${date}.json`;

// ---------- хранилище D1 ----------

export function d1SettingsStore(db: D1Database): Pick<SettingsStore, 'getProviderKey' | 'saveProviderKey' | 'deleteProviderKey' | 'listAssessments' | 'listSpeeches'> {
  const toK = (r: any): ProviderKey => ({
    userId: r.user_id, provider: r.provider, model: r.model ?? null, keyEnc: r.key_enc, keyHint: r.key_hint,
    checkedAt: r.checked_at ?? null, checkNote: r.check_note ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const n = (v: unknown) => v == null ? null : Number(v);
  // Те же преобразования строк, что в d1AssessmentStore / d1SpeechStore — таблицы общие, модули не импортируют друг друга.
  const toA = (r: any): Assessment => ({
    id: r.id, userId: r.user_id, kind: r.kind, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at ?? null, level: r.level ?? null,
    currentLevel: r.current_level ?? 'B1', updatedAt: r.updated_at ?? r.started_at,
    axes: r.scored_at ? { grammar: n(r.grammar), vocabulary: n(r.vocabulary), coherence: n(r.coherence), taskResponse: n(r.task_response), fluency: n(r.fluency) } : null,
    overall: n(r.overall), scoredAt: r.scored_at ?? null, scoringNote: r.scoring_note ?? null,
    adaptiveCount: r.adaptive_count == null ? 12 : Number(r.adaptive_count), programDayId: r.program_day_id ?? null,
  });
  const toS = (r: any): SpeechTake => ({
    id: r.id, userId: r.user_id, text: r.text, duration: Number(r.duration), words: Number(r.words), wpm: Number(r.wpm), pauses: Number(r.pauses),
    longestPause: Number(r.longest_pause), fillers: Number(r.fillers), fluency: Number(r.fluency), model: r.model ?? null, createdAt: r.created_at,
  });
  return {
    async getProviderKey(userId) {
      const r = await db.prepare('SELECT * FROM provider_keys WHERE user_id = ?').bind(userId).first();
      return r ? toK(r) : null;
    },
    async saveProviderKey(k) {
      await db.prepare(`INSERT INTO provider_keys (user_id, provider, model, key_enc, key_hint, checked_at, check_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, key_enc = excluded.key_enc, key_hint = excluded.key_hint,
        checked_at = excluded.checked_at, check_note = excluded.check_note, updated_at = excluded.updated_at`)
        .bind(k.userId, k.provider, k.model, k.keyEnc, k.keyHint, k.checkedAt, k.checkNote, k.createdAt, k.updatedAt).run();
    },
    async deleteProviderKey(userId) {
      const r = await db.prepare('DELETE FROM provider_keys WHERE user_id = ?').bind(userId).run();
      return (r.meta?.changes ?? 0) > 0;
    },
    async listAssessments(userId) {
      const rs = await db.prepare('SELECT * FROM assessments WHERE user_id = ? ORDER BY started_at').bind(userId).all();
      return (rs.results as any[]).map(toA);
    },
    async listSpeeches(userId) {
      const rs = await db.prepare('SELECT * FROM speech_takes WHERE user_id = ? ORDER BY created_at').bind(userId).all();
      return (rs.results as any[]).map(toS);
    },
  };
}
