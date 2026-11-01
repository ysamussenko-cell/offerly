/** Профиль пользователя из резюме: специальность, отрасль, стаж, ключевые термины — извлекает модель,
 *  результат проверяется и нормализуется здесь, в базу попадает только то, что прошло проверку. */
import { chat, type ChatMessage, type Env as ProviderEnv, type ProviderId } from './providers';

export const MAX_KEYWORDS = 20;
export const MODEL_TEXT_CHARS = 12_000;

export interface Profile {
  userId: string;
  specialty: string | null;
  industry: string | null;
  years: number | null;
  targetRole: string | null;
  keywords: string[];
  summary: string | null;
  resumeText: string | null;
  resumeName: string | null;
  resumeAt: string | null;
  /** Анкета знакомства (см. onboarding.ts); null — вопрос ещё не отвечен. */
  interviewDate: string | null;
  interviewFormat: string | null;
  minutesPerDay: number | null;
  nativeLanguage: string | null;
  onboardedAt: string | null;
  /** Целевой уровень CEFR (seed 2.7; настройка — 4.6) и своя недельная цель в минутах (3.4); null — по умолчанию. */
  targetLevel: string | null;
  weeklyGoalMinutes: number | null;
  /** Ежедневное письмо (4.4): время HH:MM в поясе пользователя, null — выключено; дата последнего письма (в поясе пользователя). */
  notifyAt: string | null;
  digestSentOn: string | null;
  /** Итог дня письма: sent | sent:manual | skipped:<причина> | error:<текст>; без него «день отмечен» читался как «письмо отправлено». */
  digestNote?: string | null;
  updatedAt: string;
}

export interface ProfileStore {
  getProfile(userId: string): Promise<Profile | null>;
  saveResume(userId: string, text: string, name: string | null, nowIso: string): Promise<void>;
  saveAnalysis(userId: string, a: Analysis, nowIso: string): Promise<void>;
}

export interface Analysis { specialty: string | null; industry: string | null; years: number | null; targetRole: string | null; keywords: string[]; summary: string | null }

/** Что отдаём наружу (без полного текста резюме — он длинный, запрашивается отдельно при необходимости). */
export const publicProfile = (p: Profile) => ({
  specialty: p.specialty, industry: p.industry, years: p.years, targetRole: p.targetRole, keywords: p.keywords,
  summary: p.summary, resumeName: p.resumeName, resumeAt: p.resumeAt, resumeChars: p.resumeText?.length ?? 0,
  analyzed: Boolean(p.specialty || p.industry || p.keywords.length),
  interviewDate: p.interviewDate, interviewFormat: p.interviewFormat, minutesPerDay: p.minutesPerDay,
  nativeLanguage: p.nativeLanguage, onboardedAt: p.onboardedAt, onboarded: Boolean(p.onboardedAt),
  targetLevel: p.targetLevel, weeklyGoalMinutes: p.weeklyGoalMinutes, notifyAt: p.notifyAt, digestSentOn: p.digestSentOn, updatedAt: p.updatedAt,
});

const SYSTEM_PROMPT = `You read a candidate's résumé and return a compact professional profile for an English interview coach.
Return ONLY one JSON object with these keys and nothing else (no prose, no markdown fences, no comments):
- specialty: the candidate's profession in Russian, 2–6 words, for example "инженер-теплоэнергетик";
- industry: the industry in Russian, 1–4 words, for example "энергетика";
- years: integer, total years of professional experience estimated from dates; 0 if unknown;
- target_role: the role the résumé is aimed at, in Russian, or null;
- keywords: array of 10–20 strings, the candidate's professional terms IN ENGLISH as they would be said in an English interview (tools, methods, domain terms, standards), lower case unless proper nouns;
- summary: 2–3 sentences in Russian addressed to the candidate as «вы», stating plainly what you understood: who they are, how long they have worked, what they are strong in. Calm and direct, no exclamation marks.
Use only facts present in the résumé. Do not invent employers, degrees or skills.`;

/** Схема ответа для JSON-режима модели — ответ гарантированно разбирается. */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    specialty: { type: 'string' },
    industry: { type: 'string' },
    years: { type: 'integer' },
    target_role: { type: ['string', 'null'] },
    keywords: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['specialty', 'industry', 'years', 'keywords', 'summary'],
};

const RETRY_NOTE = 'Your previous answer was not valid JSON. Return only the JSON object described, nothing else.';

/** Находит первый сбалансированный JSON-объект в ответе модели (модели любят оборачивать его в текст или ```json). */
export function extractJsonObject(raw: string): unknown | null {
  const s = raw.replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** Приводит сырой ответ модели к Analysis; null — если в ответе нет ничего полезного. */
export function normalizeAnalysis(raw: unknown): Analysis | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const yearsNum = typeof o.years === 'number' ? o.years : typeof o.years === 'string' ? parseInt(o.years, 10) : NaN;
  const years = Number.isFinite(yearsNum) && yearsNum > 0 && yearsNum <= 60 ? Math.round(yearsNum) : null;
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const k of Array.isArray(o.keywords) ? o.keywords : []) {
    const t = str(k, 60);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(t);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  const a: Analysis = {
    specialty: str(o.specialty, 120), industry: str(o.industry, 80), years,
    targetRole: str(o.target_role ?? o.targetRole, 120), keywords, summary: str(o.summary, 800),
  };
  if (!a.specialty && !a.industry && !a.keywords.length) return null;
  return a;
}

export interface AnalyzeOpts { provider?: ProviderId; apiKey?: string; model?: string; chatFn?: typeof chat }

/** Текст резюме → профиль. Одна повторная попытка, если модель вернула не JSON. */
export async function analyzeResume(env: ProviderEnv, text: string, opts: AnalyzeOpts = {}): Promise<Analysis> {
  const call = opts.chatFn ?? chat;
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `RÉSUMÉ:\n\n${text.slice(0, MODEL_TEXT_CHARS)}` },
  ];
  const chatOpts = { provider: opts.provider, apiKey: opts.apiKey, model: opts.model, maxTokens: 900, jsonSchema: ANALYSIS_SCHEMA };
  let reply = await call(env, messages, chatOpts);
  let a = normalizeAnalysis(extractJsonObject(reply));
  if (!a) {
    reply = await call(env, [...messages, { role: 'assistant', content: reply.slice(0, 2000) }, { role: 'user', content: RETRY_NOTE }], chatOpts);
    a = normalizeAnalysis(extractJsonObject(reply));
  }
  if (!a) throw new Error(`модель не вернула профиль; ответ: «${reply.replace(/\s+/g, ' ').slice(0, 200)}»`);
  return a;
}

/** Хранилище профиля на D1 (таблица profiles из миграций 0001 и 0003). */
export function d1ProfileStore(db: D1Database): ProfileStore {
  const toProfile = (r: any): Profile => {
    let keywords: string[] = [];
    try { const k = JSON.parse(r.keywords ?? '[]'); if (Array.isArray(k)) keywords = k.filter((x: unknown) => typeof x === 'string'); } catch { /* повреждённое поле — пустой список */ }
    return {
      userId: r.user_id, specialty: r.specialty ?? null, industry: r.industry ?? null, years: r.years ?? null,
      targetRole: r.target_role ?? null, keywords, summary: r.summary ?? null, resumeText: r.resume_text ?? null,
      resumeName: r.resume_name ?? null, resumeAt: r.resume_at ?? null,
      interviewDate: r.interview_date ?? null, interviewFormat: r.interview_format ?? null,
      minutesPerDay: r.minutes_per_day ?? null, nativeLanguage: r.native_language ?? null, onboardedAt: r.onboarded_at ?? null,
      targetLevel: r.target_level ?? null, weeklyGoalMinutes: r.weekly_goal_minutes == null ? null : Number(r.weekly_goal_minutes),
      notifyAt: r.notify_at ?? null, digestSentOn: r.digest_sent_on ?? null, digestNote: r.digest_note ?? null,
      updatedAt: r.updated_at,
    };
  };
  return {
    async getProfile(userId) {
      const r = await db.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(userId).first();
      return r ? toProfile(r) : null;
    },
    /** Новое резюме сбрасывает прежний разбор: профиль не должен описывать старый файл. Анкетные поля не трогаем. */
    async saveResume(userId, text, name, nowIso) {
      await db.prepare(
        `INSERT INTO profiles (user_id, resume_text, resume_name, resume_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET resume_text = excluded.resume_text, resume_name = excluded.resume_name,
         resume_at = excluded.resume_at, updated_at = excluded.updated_at,
         specialty = NULL, industry = NULL, years = NULL, keywords = NULL, summary = NULL`,
      ).bind(userId, text, name, nowIso, nowIso).run();
    },
    /** Целевую позицию модель заполняет только до анкеты: ответ пользователя важнее догадки по резюме. */
    async saveAnalysis(userId, a, nowIso) {
      await db.prepare(
        `INSERT INTO profiles (user_id, specialty, industry, years, target_role, keywords, summary, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET specialty = excluded.specialty, industry = excluded.industry, years = excluded.years,
         target_role = CASE WHEN profiles.onboarded_at IS NULL THEN excluded.target_role ELSE profiles.target_role END,
         keywords = excluded.keywords, summary = excluded.summary, updated_at = excluded.updated_at`,
      ).bind(userId, a.specialty, a.industry, a.years, a.targetRole, JSON.stringify(a.keywords), a.summary, nowIso).run();
    },
  };
}

/** Короткое тестовое резюме для самопроверки разбора (/api/health?deep=2). */
export const SELF_TEST_RESUME = [
  'Ivan Petrov — Thermal Power Engineer',
  'Experience: 2011–2026, combined heat and power plant, boiler and steam turbine operation, heat balance calculations.',
  'Energy audits of industrial sites; technical reports and feasibility studies.',
  'Skills: boiler efficiency, turbine performance testing, energy audit, heat loss calculation, Excel, Python.',
].join('\n');
