/** Контрольный срез (концепт §2 «Промежуточный срез»): раз в две недели по программе — укороченный вариант стартового
 *  теста (восемь адаптивных заданий со старта с текущего уровня, чтение, письмо), сравнение с предыдущим тестом или
 *  срезом и честный вывод «уровень вырос / не изменился / снизился». Сам тест ведёт assessment.ts с kind=checkpoint;
 *  здесь — привязка к дню программы (format=checkpoint, status → done с баллом), расписание (сегодня ли срез, когда
 *  следующий) и корректировка программы: после среза незавершённые дни пересобираются по свежему профилю ошибок —
 *  новый срез становится точкой отсчёта и для готовности (dashboard.ts), и для весов тем (program.ts).
 *  Срез можно пройти и вне плана — тогда ни день программы, ни сама программа не трогаются. */
import type { Env as ProviderEnv } from './providers';
import type { Domain } from './items';
import {
  startOrResume as startAssessment, answer as answerAssessment, rescore as rescoreAssessment, abandon as abandonAssessment, current as currentAssessment,
  type RunOpts as AssessmentOpts, type Store as AssessmentStoreFull, type View as AssessmentView,
} from './assessment';
import { generateProgram, current as currentProgram, publicDay, type ProgramDay, type ProgramStore, type ProgramDeps, type PublicDay } from './program';
import type { Profile } from './profile';
import { todayIn } from './onboarding';

export type Store = AssessmentStoreFull & ProgramStore & ProgramDeps;

export interface RunOpts extends AssessmentOpts { /** Пересобирать программу после среза (по умолчанию да). */ adjust?: boolean }

export interface View extends AssessmentView {
  /** День программы, к которому привязан срез; null — вне плана. */
  day: PublicDay | null;
  /** Программа пересобрана этим ответом (последний ответ среза по плану или пересчёт с новым баллом). */
  programAdjusted: boolean;
}

export interface TodayInfo {
  today: string;
  /** Сегодня по программе срез. */
  scheduled: boolean;
  day: PublicDay | null;
  /** Ближайший запланированный срез после сегодняшнего дня. */
  next: PublicDay | null;
  /** Активный срез или последний завершённый; null — срезов ещё не было. */
  checkpoint: View | null;
}

const domainOf = (p: Profile | null): Domain => ({ specialty: p?.specialty ?? null, industry: p?.industry ?? null, targetRole: p?.targetRole ?? null, keywords: p?.keywords ?? [] });

/** Сегодняшний день-срез программы: пройденный раньше запланированного (как в lesson.ts). */
async function dayOf(store: Store, userId: string, today: string): Promise<{ day: ProgramDay | null; next: ProgramDay | null }> {
  const all = (await store.listProgramDays(userId)).filter(d => d.format === 'checkpoint');
  const day = all.filter(d => d.dayDate === today).sort((a, b) => (a.status === 'planned' ? 1 : 0) - (b.status === 'planned' ? 1 : 0))[0] ?? null;
  const next = all.filter(d => d.dayDate > today && d.status === 'planned').sort((a, b) => a.dayDate.localeCompare(b.dayDate))[0] ?? null;
  return { day, next };
}

async function dayById(store: Store, id: string | null): Promise<ProgramDay | null> { return id ? store.getProgramDay(id) : null; }

async function withDay(store: Store, v: AssessmentView, today: string, adjusted = false): Promise<View> {
  const d = await dayById(store, v.programDayId);
  return { ...v, day: d ? publicDay(d, today) : null, programAdjusted: adjusted };
}

/** Что сегодня: срез ли по программе, следующий срез, активный или последний пройденный срез. */
export async function today(store: Store, userId: string, tz: string, opts: RunOpts = {}): Promise<TodayInfo> {
  const now = opts.now ?? (() => new Date().toISOString());
  const t = todayIn(tz, new Date(now()));
  const { day, next } = await dayOf(store, userId, t);
  const cur = await currentAssessment(store, userId, 'checkpoint');
  return { today: t, scheduled: !!day, day: day ? publicDay(day, t) : null, next: next ? publicDay(next, t) : null, checkpoint: cur ? await withDay(store, cur, t) : null };
}

/** Начать срез или продолжить начатый. Новый срез привязывается к сегодняшнему непройденному дню-срезу, если он есть. */
export async function startOrResume(env: ProviderEnv, store: Store, userId: string, tz: string, profile: Profile | null, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const t = todayIn(tz, new Date(now()));
  const { day } = await dayOf(store, userId, t);
  const v = await startAssessment(env, store, userId, domainOf(profile), { ...opts, kind: 'checkpoint', programDayId: day && day.status !== 'done' ? day.id : null });
  return withDay(store, v, t);
}

/** Ответ на текущее задание; после последнего — оценка, день программы → done с баллом, пересборка программы. */
export async function answer(env: ProviderEnv, store: Store, userId: string, attemptId: unknown, raw: unknown, tz: string, profile: Profile | null, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const t = todayIn(tz, new Date(now()));
  const v = await answerAssessment(env, store, userId, attemptId, raw, domainOf(profile), { ...opts, kind: 'checkpoint' });
  let adjusted = false;
  if (v.status === 'finished') adjusted = await finish(store, userId, tz, profile, v, opts);
  return withDay(store, v, t, adjusted);
}

/** Пересчитать последний завершённый срез (письмо не оценено или force); день и программа обновляются по новому баллу. */
export async function rescore(env: ProviderEnv, store: Store, userId: string, tz: string, profile: Profile | null, force = false, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const t = todayIn(tz, new Date(now()));
  const v = await rescoreAssessment(env, store, userId, { ...opts, kind: 'checkpoint' }, force);
  const adjusted = await finish(store, userId, tz, profile, v, opts);
  return withDay(store, v, t, adjusted);
}

/** Бросить начатый срез: следующий start начнёт новый; день программы остаётся запланированным. */
export async function abandon(store: Store, userId: string, opts: RunOpts = {}): Promise<boolean> {
  return abandonAssessment(store, userId, { ...opts, kind: 'checkpoint' });
}

/** После завершённого среза: день программы → done с сводным баллом, идущая программа пересобирается с завтрашнего дня
 *  по новому профилю ошибок (пройденные дни и сегодняшний срез остаются). Возвращает, пересобрана ли программа. */
async function finish(store: Store, userId: string, tz: string, profile: Profile | null, v: AssessmentView, opts: RunOpts): Promise<boolean> {
  const now = opts.now ?? (() => new Date().toISOString());
  const ts = now();
  const day = await dayById(store, v.programDayId);
  const score = v.result?.overall ?? null;
  const changed = !!day && (day.status !== 'done' || day.score !== score);
  if (day && changed) await store.updateProgramDay(day.id, { status: 'done', score, completedAt: day.completedAt ?? ts, updatedAt: ts });
  // Пересборка — только для среза по плану и только когда его балл записан впервые или изменился (пересчёт без изменений
  // программу не трогает): в день среза занятия нет, и замена оставшихся planned-дней ничего не ломает.
  // Срез вне плана программу не трогает (сегодняшнее занятие могло идти) — пересобрать можно кнопкой в карточке «Программа».
  if (opts.adjust === false || !changed) return false;
  const prog = await currentProgram(store, userId, tz, profile, now);
  const t = todayIn(tz, new Date(ts));
  if (!prog || prog.endDate <= t) return false; // программы нет или она кончается сегодня — пересобирать нечего
  await generateProgram(store, userId, tz, profile, { now, id: opts.id });
  return true;
}
