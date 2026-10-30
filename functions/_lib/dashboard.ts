/** Главный экран (концепт §4): готовность к собеседованию 0–100, обратный отсчёт, серия дней с одной заморозкой
 *  в неделю, недельная цель в минутах и план текущей недели. Всё считается из уже записанных данных — последнего
 *  теста или среза, занятий и дней программы — без отдельных счётчиков, поэтому цифры всегда сходятся с журналом.
 *
 *  Готовность: сводный балл последнего завершённого теста или среза (пять осей с весами, scoring.ts) плюс вклад
 *  занятий после него (до GAIN_PER_LESSON за занятие, пропорционально баллу; верно решённая бонусная задача
 *  умножает вклад занятия на BONUS_MULTIPLIER — lesson.ts) минус пропуски занятий программы
 *  (MISS_PENALTY за день, не больше MISS_CAP в сумме — «медленно, без наказания»; день под заморозкой не считается
 *  пропуском). Темп — прирост за последние FORECAST_DAYS дней; по нему прогноз: через сколько дней следующая
 *  ступень CEFR и какой будет готовность к дате собеседования.
 *
 *  Серия: дни подряд с пройденным занятием. День программы с занятием, оставшийся без занятия, рвёт серию,
 *  если в его календарной неделе (пн–вс) заморозка ещё не потрачена; первая такая дыра в неделе закрывается
 *  заморозкой сама. Дни без программы, репетиции и срезы (до 4.1 и 4.3 недоступны) серию не рвут и не растят;
 *  сегодня ещё открыт. Минуты недели — по шагам занятий: от выдачи шага до ответа, но не больше STEP_CAP_MINUTES
 *  за шаг, чтобы пауза между подходами не засчитывалась. Недельная цель — своя (PUT /api/dashboard/goal),
 *  по умолчанию минуты в день из анкеты × GOAL_DAYS_DEFAULT. */
import type { Assessment, AssessmentStore } from './assessment';
import { LEVELS, type Level } from './items';
import { BONUS_MULTIPLIER, type Lesson, type LessonStep, type LessonStore } from './lesson';
import { DEFAULT_MINUTES, todayIn, daysBetween } from './onboarding';
import type { Profile } from './profile';
import { addDays, publicDay, weekdayOf, WEEKDAYS_RU, type ProgramDay, type ProgramStore, type PublicDay } from './program';
import { bandStart, LEVEL_THRESHOLD, nextStep, scoreToLevel } from './scoring';

/** Максимальный вклад одного занятия в готовность (при балле 100). */
export const GAIN_PER_LESSON = 2;
/** Падение готовности за пропущенное занятие программы и предел падения в сумме. */
export const MISS_PENALTY = 1;
export const MISS_CAP = 10;
/** Окно для оценки темпа: прирост готовности за столько последних дней. */
export const FORECAST_DAYS = 7;
/** Больше стольких минут один шаг занятия не стоит — остальное считается паузой. */
export const STEP_CAP_MINUTES = 10;
/** Недельная цель по умолчанию: минуты в день × столько дней. */
export const GOAL_DAYS_DEFAULT = 5;
export const GOAL_MIN = 15;
export const GOAL_MAX = 1260;
/** Заморозок на календарную неделю. */
export const FREEZES_PER_WEEK = 1;
export const DEFAULT_TARGET: Level = 'C1';

const clamp = (x: number) => Math.max(0, Math.min(100, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Понедельник недели, в которую входит дата. */
export const weekStart = (iso: string): string => addDays(iso, -((weekdayOf(iso) + 6) % 7));

// ---------- серия ----------

export interface StreakInfo {
  /** Дней подряд с занятием (сегодня — если уже пройдено). */
  current: number;
  best: number;
  todayDone: boolean;
  /** Заморозка этой недели ещё не потрачена. */
  freezeAvailable: boolean;
  /** Даты, закрытые заморозкой, — по всей истории. */
  frozen: string[];
  /** Пропущенные дни занятий, не закрытые заморозкой (рвали серию). */
  missed: string[];
  lastDone: string | null;
}

/** Серия по датам: done — дни с пройденным занятием, required — дни программы с занятием. Проход по календарю
 *  от первой даты до сегодня; первая дыра в неделе закрывается заморозкой, вторая рвёт серию. */
export function computeStreak(done: Set<string>, required: Set<string>, today: string): StreakInfo {
  const all = [...done, ...required].filter(d => d <= today).sort();
  const out: StreakInfo = { current: 0, best: 0, todayDone: done.has(today), freezeAvailable: true, frozen: [], missed: [], lastDone: null };
  if (!all.length) return out;
  const freezes = new Map<string, number>();
  let run = 0;
  for (let d = all[0]; d <= today; d = addDays(d, 1)) {
    if (done.has(d)) { run++; out.lastDone = d; }
    else if (d === today || !required.has(d)) { /* сегодня ещё открыт; дни без занятия серию не трогают */ }
    else {
      const w = weekStart(d);
      const used = freezes.get(w) ?? 0;
      if (used < FREEZES_PER_WEEK) { freezes.set(w, used + 1); out.frozen.push(d); }
      else { out.missed.push(d); run = 0; }
    }
    out.best = Math.max(out.best, run);
  }
  out.current = run;
  out.freezeAvailable = (freezes.get(weekStart(today)) ?? 0) < FREEZES_PER_WEEK;
  return out;
}

// ---------- минуты ----------

/** Минуты занятия по его шагам: от выдачи до ответа, не больше STEP_CAP_MINUTES за шаг; шаг без ответа не считается. */
export function lessonMinutes(steps: LessonStep[]): number {
  let ms = 0;
  for (const s of steps) {
    if (!s.answeredAt) continue;
    const dt = Date.parse(s.answeredAt) - Date.parse(s.createdAt);
    if (Number.isFinite(dt) && dt > 0) ms += Math.min(dt, STEP_CAP_MINUTES * 60_000);
  }
  return Math.round(ms / 60_000);
}

/** Недельная цель: своя из профиля или минуты в день × GOAL_DAYS_DEFAULT. */
export function weeklyGoal(profile: Profile | null): { minutes: number; custom: boolean } {
  if (profile?.weeklyGoalMinutes != null) return { minutes: profile.weeklyGoalMinutes, custom: true };
  return { minutes: (profile?.minutesPerDay ?? DEFAULT_MINUTES) * GOAL_DAYS_DEFAULT, custom: false };
}

export function parseGoal(raw: unknown): { ok: true; minutes: number | null } | { ok: false; reason: 'range' | 'format' } {
  if (raw == null || raw === '') return { ok: true, minutes: null };
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: 'format' };
  if (n < GOAL_MIN || n > GOAL_MAX) return { ok: false, reason: 'range' };
  return { ok: true, minutes: n };
}

// ---------- готовность ----------

export interface ReadinessInput {
  assessment: Assessment | null;
  /** Завершённые занятия с баллом (и исходом бонуса). */
  lessons: Pick<Lesson, 'dayDate' | 'score' | 'status' | 'finishedAt' | 'bonus'>[];
  /** Даты пропущенных занятий программы (без закрытых заморозкой). */
  missed: string[];
  today: string;
  tz: string;
}

export interface ReadinessBreakdown {
  value: number | null;
  base: number | null;
  /** Откуда база: тест уровня, контрольный или исходный срез и его дата (в поясе ученика). */
  baseKind: Assessment['kind'] | null;
  baseDate: string | null;
  level: Level | null;
  gained: number;
  lost: number;
  lessons: number;
  /** Занятий с верно решённым бонусом — их вклад удвоен. */
  bonuses: number;
  missed: number;
}

/** Готовность на дату: база из среза плюс занятия после него (бонус удваивает занятие) минус пропуски после него. */
export function readinessAt(inp: ReadinessInput, date: string): ReadinessBreakdown {
  const a = inp.assessment;
  const empty: ReadinessBreakdown = { value: null, base: null, baseKind: null, baseDate: null, level: null, gained: 0, lost: 0, lessons: 0, bonuses: 0, missed: 0 };
  if (!a || a.overall == null) return empty;
  const baseDate = todayIn(inp.tz, new Date(a.finishedAt ?? a.startedAt));
  const lessons = inp.lessons.filter(l => l.status === 'finished' && l.score != null && l.dayDate > baseDate && l.dayDate <= date);
  const gained = round1(lessons.reduce((s, l) => s + GAIN_PER_LESSON * (l.score as number) / 100 * (l.bonus === 'correct' ? BONUS_MULTIPLIER : 1), 0));
  const missed = inp.missed.filter(d => d > baseDate && d <= date);
  const lost = Math.min(MISS_CAP, missed.length * MISS_PENALTY);
  const value = Math.round(clamp(a.overall + gained - lost));
  return { value, base: a.overall, baseKind: a.kind, baseDate, level: scoreToLevel(value), gained, lost, lessons: lessons.length, bonuses: lessons.filter(l => l.bonus === 'correct').length, missed: missed.length };
}

export interface Forecast {
  /** Прирост готовности в день за последние FORECAST_DAYS дней. */
  perDay: number;
  /** Следующая ступень CEFR: сколько баллов не хватает и через сколько дней при текущем темпе (null — темп нулевой). */
  next: { level: Level; points: number; days: number | null } | null;
  /** Ожидаемая готовность к дате собеседования при текущем темпе; null — дата не задана или прошла. */
  atInterview: number | null;
  /** Целевой уровень и его порог в баллах; reached — порог уже взят. */
  target: { level: Level; points: number; reached: boolean };
}

export function forecast(now: ReadinessBreakdown, before: ReadinessBreakdown, daysLeft: number | null, target: Level): Forecast {
  const targetPoints = bandStart(target) + LEVEL_THRESHOLD;
  const t = { level: target, points: targetPoints, reached: now.value != null && now.value >= targetPoints };
  if (now.value == null) return { perDay: 0, next: null, atInterview: null, target: t };
  const perDay = round1(((now.value - (before.value ?? now.value)) / FORECAST_DAYS));
  const n = nextStep(now.value);
  const next = n ? { level: n.level, points: n.points, days: perDay > 0 ? Math.ceil(n.points / perDay) : null } : null;
  const atInterview = daysLeft != null && daysLeft >= 0 ? Math.round(clamp(now.value + perDay * daysLeft)) : null;
  return { perDay, next, atInterview, target: t };
}

// ---------- план недели ----------

export type WeekStatus = 'done' | 'active' | 'today' | 'planned' | 'missed' | 'frozen' | 'unavailable' | 'free';

export interface WeekDay {
  date: string;
  weekday: string;
  today: boolean;
  past: boolean;
  day: PublicDay | null;
  status: WeekStatus;
  /** Минуты занятий за день. */
  minutes: number;
  score: number | null;
}

export function weekPlan(days: ProgramDay[], lessons: { dayDate: string; status: Lesson['status']; score: number | null; minutes: number }[], streak: StreakInfo, today: string): WeekDay[] {
  const start = weekStart(today);
  const out: WeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const d = days.filter(x => x.dayDate === date).sort((a, b) => (a.status === 'planned' ? 1 : 0) - (b.status === 'planned' ? 1 : 0))[0] ?? null;
    const ls = lessons.filter(l => l.dayDate === date);
    const fin = ls.find(l => l.status === 'finished');
    const minutes = ls.reduce((s, l) => s + l.minutes, 0);
    let status: WeekStatus;
    if (fin || d?.status === 'done') status = 'done';
    else if (ls.some(l => l.status === 'active')) status = 'active';
    else if (!d) status = 'free';
    else if (d.format !== 'lesson') status = 'unavailable';
    else if (date === today) status = 'today';
    else if (date > today) status = 'planned';
    else if (streak.frozen.includes(date)) status = 'frozen';
    else status = 'missed';
    out.push({ date, weekday: WEEKDAYS_RU[weekdayOf(date)], today: date === today, past: date < today, day: d ? publicDay(d, today) : null, status, minutes, score: fin?.score ?? d?.score ?? null });
  }
  return out;
}

// ---------- сборка ----------

export interface DashboardStore {
  /** Своя недельная цель в минутах; null — вернуться к значению по умолчанию. */
  saveWeeklyGoal(userId: string, minutes: number | null, nowIso: string): Promise<void>;
}

export type Store = Pick<AssessmentStore, 'latestFinishedAssessment'> & Pick<LessonStore, 'listLessons' | 'listSteps'> & Pick<ProgramStore, 'listProgramDays'>;

export interface View {
  today: string;
  readiness: ReadinessBreakdown & { forecast: Forecast };
  countdown: { interviewDate: string | null; daysLeft: number | null };
  streak: StreakInfo;
  goal: { minutes: number; custom: boolean; done: number; left: number; default: number; percent: number };
  week: WeekDay[];
  program: { exists: boolean; endDate: string | null; done: number; total: number };
}

export interface RunOpts { now?: () => string }

export async function dashboard(store: Store, userId: string, tz: string, profile: Profile | null, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const today = todayIn(tz, new Date(now()));
  const [assessment, allLessons, days] = await Promise.all([store.latestFinishedAssessment(userId), store.listLessons(userId), store.listProgramDays(userId)]);
  const lessons = allLessons.filter(l => l.dayDate <= today);

  const done = new Set(lessons.filter(l => l.status === 'finished').map(l => l.dayDate));
  for (const d of days) if (d.status === 'done' && d.dayDate <= today) done.add(d.dayDate);
  const required = new Set(days.filter(d => d.format === 'lesson' && d.dayDate <= today).map(d => d.dayDate));
  const streak = computeStreak(done, required, today);

  const inp: ReadinessInput = { assessment, lessons, missed: streak.missed, today, tz };
  const current = readinessAt(inp, today);
  const before = readinessAt(inp, addDays(today, -FORECAST_DAYS));
  const interviewDate = profile?.interviewDate ?? null;
  const daysLeft = interviewDate ? daysBetween(today, interviewDate) : null;
  const target = (LEVELS as readonly string[]).includes(profile?.targetLevel ?? '') ? profile!.targetLevel as Level : DEFAULT_TARGET;

  const start = weekStart(today), end = addDays(start, 6);
  const weekLessons = [] as { dayDate: string; status: Lesson['status']; score: number | null; minutes: number }[];
  for (const l of lessons.filter(l => l.dayDate >= start && l.dayDate <= end)) {
    weekLessons.push({ dayDate: l.dayDate, status: l.status, score: l.score, minutes: lessonMinutes(await store.listSteps(l.id)) });
  }
  const goal = weeklyGoal(profile);
  const doneMinutes = weekLessons.reduce((s, l) => s + l.minutes, 0);
  const def = (profile?.minutesPerDay ?? DEFAULT_MINUTES) * GOAL_DAYS_DEFAULT;

  return {
    today,
    readiness: { ...current, forecast: forecast(current, before, daysLeft, target) },
    countdown: { interviewDate, daysLeft },
    streak,
    goal: { minutes: goal.minutes, custom: goal.custom, done: doneMinutes, left: Math.max(0, goal.minutes - doneMinutes), default: def, percent: Math.min(100, Math.round(doneMinutes / goal.minutes * 100)) },
    week: weekPlan(days, weekLessons, streak, today),
    program: { exists: days.length > 0, endDate: days.length ? days[days.length - 1].dayDate : null, done: days.filter(d => d.status === 'done').length, total: days.length },
  };
}

// ---------- хранилище D1 ----------

export function d1DashboardStore(db: D1Database): DashboardStore {
  return {
    async saveWeeklyGoal(userId, minutes, nowIso) {
      await db.prepare(
        `INSERT INTO profiles (user_id, weekly_goal_minutes, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET weekly_goal_minutes = excluded.weekly_goal_minutes, updated_at = excluded.updated_at`,
      ).bind(userId, minutes, nowIso).run();
    },
  };
}
