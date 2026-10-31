/** Программа на четыре недели (концепт §2, §9): по профилю ошибок и дате собеседования строится план —
 *  одна слабая тема в день, два формата письма по очереди (отзыв рецензента и объяснение неспециалисту),
 *  раз в неделю репетиция интервью (воскресенье), каждые две недели контрольный срез, в субботу — смешанное
 *  повторение недели и орфография. План виден целиком, темы занятий можно переставлять местами.
 *
 *  Профиль ошибок складывается из журнала (карточки по темам), неверных ответов последнего завершённого теста
 *  или среза и его осей: тема весит тем больше, чем больше по ней карточек и ошибок, и получает добавку,
 *  если ось, к которой она относится, ниже порога B2. Темы распределяются по дням пропорционально весу
 *  с чередованием — одна и та же тема два дня подряд не идёт. Модель здесь не нужна: план детерминирован
 *  и объясним (у каждого дня записана причина выбора темы). Занятие по дню — 3.2, повторы карточек — 3.3. */
import { TOPICS, type Item, type Topic } from './items';
import { CARD_TOPICS, type ErrorCard } from './cards';
import { AXES, AXIS_LABELS, BAND, LEVEL_THRESHOLD, LEXICAL_TOPICS, type Axes, type Axis } from './scoring';
import type { Assessment, Attempt } from './assessment';
import type { Profile } from './profile';
import { daysBetween, todayIn } from './onboarding';

export const PROGRAM_DAYS = 28;
/** Контрольный срез — в конце каждой второй недели. */
export const CHECKPOINT_EVERY = 14;
/** Короткая программа (собеседование раньше чем через две недели) заканчивается срезом, если в ней хотя бы неделя. */
export const MIN_DAYS_FOR_CHECKPOINT = 7;
export const DEFAULT_MINUTES = 20;
export const CHECKPOINT_MINUTES = 15;
/** Ось ниже порога B2 считается слабой — её темы получают добавку к весу. */
export const WEAK_AXIS = 2 * BAND + LEVEL_THRESHOLD;

export const FORMATS = ['lesson', 'rehearsal', 'checkpoint'] as const;
export type DayFormat = typeof FORMATS[number];
export const FORMAT_LABELS: Record<DayFormat, string> = { lesson: 'занятие', rehearsal: 'репетиция интервью', checkpoint: 'контрольный срез' };

export const WRITING_FORMATS = ['review', 'explain'] as const;
export type WritingFormat = typeof WRITING_FORMATS[number];
export const WRITING_LABELS: Record<WritingFormat, string> = { review: 'отзыв рецензента', explain: 'объяснение неспециалисту' };

export const DAY_STATUSES = ['planned', 'done', 'skipped'] as const;
export type DayStatus = typeof DAY_STATUSES[number];

/** Субботняя тема: повторение карточек недели и орфография. */
export const MIXED_TOPIC: Topic = { id: 'mixed', label: 'Смешанное повторение', hint: 'mixed review of the week’s topics, error cards and spelling' };
/** Темы программы: темы журнала (банк + ответ на вопрос задания) и смешанное повторение. */
export const PROGRAM_TOPICS: Topic[] = [...CARD_TOPICS, MIXED_TOPIC];
export const programTopicById = (id: unknown): Topic | undefined => PROGRAM_TOPICS.find(t => t.id === id);
/** Темы, из которых выбираются занятия будних дней. */
export const LESSON_TOPICS: Topic[] = CARD_TOPICS;

/** К какой оси относится тема: лексические — словарь, союзы и относительные — связность, ответ на вопрос — своя ось, остальное — грамматика. */
export const AXIS_TOPICS: Record<Axis, string[]> = {
  grammar: TOPICS.filter(t => !LEXICAL_TOPICS.includes(t.id)).map(t => t.id),
  vocabulary: LEXICAL_TOPICS,
  coherence: ['conjunctions', 'relative'],
  taskResponse: ['task-response'],
  fluency: [],
};

export const WEEKDAYS_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export interface ProgramDay {
  id: string;
  userId: string;
  /** YYYY-MM-DD в поясе пользователя. */
  dayDate: string;
  /** Номер дня с начала программы, с 1; неделя — с 1. */
  position: number;
  week: number;
  format: DayFormat;
  topic: string;
  /** Формат письма дня у занятий; у репетиции и среза null. */
  writing: WritingFormat | null;
  /** Почему выбрана тема — одной строкой. */
  reason: string | null;
  status: DayStatus;
  minutes: number | null;
  score: number | null;
  completedAt: string | null;
  generatedAt: string | null;
  updatedAt: string | null;
}

export type ProgramDayPatch = Partial<Pick<ProgramDay, 'topic' | 'reason' | 'updatedAt' | 'status' | 'score' | 'completedAt'>>;

export interface ProgramStore {
  /** Дни программы пользователя по дате. */
  listProgramDays(userId: string): Promise<ProgramDay[]>;
  getProgramDay(id: string): Promise<ProgramDay | null>;
  /** Удаляет ещё не пройденные (planned) дни с даты fromDate и вставляет новые — одной пачкой. Пройденные дни остаются. */
  replacePlannedDays(userId: string, fromDate: string, days: ProgramDay[]): Promise<void>;
  /** Перестановка темы (3.1) и итог занятия дня: status, score, completedAt (3.2). */
  updateProgramDay(id: string, patch: ProgramDayPatch): Promise<void>;
}

// ---------- профиль ошибок ----------

export interface TopicWeight {
  topic: string;
  label: string;
  /** Итоговый вес: карточки ×2 + ошибки теста + слабые оси (+1 за каждую) + 1 базовый. */
  weight: number;
  cards: number;
  mistakes: number;
  weakAxes: Axis[];
}

export interface ErrorProfile {
  topics: TopicWeight[];
  axes: Axes | null;
  assessment: { id: string; kind: Assessment['kind']; level: string | null; finishedAt: string | null } | null;
  cards: number;
}

export const CARD_WEIGHT = 2;
export const BASE_WEIGHT = 1;

/** Веса тем по журналу, неверным ответам теста и осям. Темы без данных получают базовый вес — чтобы без теста
 *  и журнала программа всё равно обходила все темы по кругу. */
export function errorProfile(cards: ErrorCard[], assessment: Assessment | null, attempts: Attempt[], items: Map<string, Item>): ErrorProfile {
  const cardCount = new Map<string, number>();
  for (const c of cards) if (!c.retired) cardCount.set(c.topic, (cardCount.get(c.topic) ?? 0) + 1);
  const mistakeCount = new Map<string, number>();
  for (const a of attempts) {
    if (a.answeredAt == null || a.correct !== 0) continue;
    const topic = items.get(a.itemId)?.topic;
    if (topic) mistakeCount.set(topic, (mistakeCount.get(topic) ?? 0) + 1);
  }
  const axes = assessment?.axes ?? null;
  const weak = AXES.filter(x => axes && axes[x] != null && (axes[x] as number) < WEAK_AXIS);
  const topics = LESSON_TOPICS.map(t => {
    const c = cardCount.get(t.id) ?? 0, m = mistakeCount.get(t.id) ?? 0;
    const weakAxes = weak.filter(x => AXIS_TOPICS[x].includes(t.id));
    return { topic: t.id, label: t.label, weight: BASE_WEIGHT + c * CARD_WEIGHT + m + weakAxes.length, cards: c, mistakes: m, weakAxes };
  });
  return {
    topics,
    axes,
    assessment: assessment ? { id: assessment.id, kind: assessment.kind, level: assessment.level, finishedAt: assessment.finishedAt } : null,
    cards: [...cardCount.values()].reduce((s, n) => s + n, 0),
  };
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};

/** Причина выбора темы одной строкой: «3 карточки в журнале, 1 ошибка в тесте, ось «Словарь» 50». */
export function reasonText(w: TopicWeight, axes: Axes | null): string {
  const parts: string[] = [];
  if (w.cards) parts.push(`${w.cards} ${plural(w.cards, 'карточка', 'карточки', 'карточек')} в журнале`);
  if (w.mistakes) parts.push(`${w.mistakes} ${plural(w.mistakes, 'ошибка', 'ошибки', 'ошибок')} в тесте`);
  for (const x of w.weakAxes) if (axes && axes[x] != null) parts.push(`ось «${AXIS_LABELS[x].toLowerCase()}» ${axes[x]}`);
  return parts.length ? parts.join(', ') : 'повторение по кругу: ошибок по теме пока не записано';
}

// ---------- календарь ----------

export const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** 0 — воскресенье … 6 — суббота; дата уже в поясе пользователя, поэтому считается как календарная. */
export const weekdayOf = (iso: string): number => new Date(Date.parse(`${iso}T00:00:00Z`)).getUTCDay();

/** Длина программы: четыре недели, но не дальше дня перед собеседованием; если собеседование сегодня,
 *  прошло или не назначено — четыре недели. */
export function programLength(startDate: string, interviewDate: string | null): number {
  if (!interviewDate) return PROGRAM_DAYS;
  const d = daysBetween(startDate, interviewDate);
  if (d < 1) return PROGRAM_DAYS;
  return Math.min(PROGRAM_DAYS, d);
}

/** Позиции контрольных срезов: 14 и 28 в пределах длины; короткая программа от недели заканчивается срезом. */
export function checkpointPositions(total: number): number[] {
  const out: number[] = [];
  for (let p = CHECKPOINT_EVERY; p <= total; p += CHECKPOINT_EVERY) out.push(p);
  if (!out.length && total >= MIN_DAYS_FOR_CHECKPOINT) out.push(total);
  return out;
}

export type Slot = { position: number; date: string; week: number; kind: DayFormat | 'mixed' };

/** Разметка дней: срез — по позиции, воскресенье — репетиция (если воскресенье занято срезом — репетиция в субботу),
 *  суббота — смешанное повторение, остальное — занятия. */
export function layout(startDate: string, total: number): Slot[] {
  const cps = new Set(checkpointPositions(total));
  const out: Slot[] = [];
  for (let p = 1; p <= total; p++) {
    const date = addDays(startDate, p - 1);
    const wd = weekdayOf(date);
    let kind: Slot['kind'] = 'lesson';
    if (cps.has(p)) kind = 'checkpoint';
    else if (wd === 0) kind = 'rehearsal';
    else if (wd === 6) kind = cps.has(p + 1) && p + 1 <= total ? 'rehearsal' : 'mixed';
    out.push({ position: p, date, week: Math.floor((p - 1) / 7) + 1, kind });
  }
  return out;
}

/** Темы занятий по весам: на каждый слот — тема с наибольшим weight / (уже назначено + 1), не та, что вчера.
 *  Так тяжёлые темы встречаются чаще, лёгкие — реже, но все идут по кругу, а подряд тема не повторяется. */
export function assignTopics(slots: number, weights: TopicWeight[]): TopicWeight[] {
  const taken = new Map<string, number>();
  const out: TopicWeight[] = [];
  let prev: string | null = null;
  for (let i = 0; i < slots; i++) {
    let best: TopicWeight | null = null, bestScore = -1;
    for (const w of weights) {
      if (w.topic === prev && weights.length > 1) continue;
      const score = w.weight / ((taken.get(w.topic) ?? 0) + 1);
      if (score > bestScore) { best = w; bestScore = score; }
    }
    if (!best) break;
    out.push(best);
    taken.set(best.topic, (taken.get(best.topic) ?? 0) + 1);
    prev = best.topic;
  }
  return out;
}

export interface BuildInput {
  userId: string;
  startDate: string;
  interviewDate: string | null;
  minutesPerDay: number | null;
  targetRole: string | null;
  profile: ErrorProfile;
  /** Даты, занятые уже пройденными днями, — генератор их не трогает. */
  occupied?: Set<string>;
  /** Пересборка идущей программы: дни раньше этой даты не строятся заново. */
  fromDate?: string;
  now: string;
  id: () => string;
}

/** Строит дни программы. Письмо чередуется по дням занятий: отзыв рецензента, объяснение неспециалисту. */
export function buildProgram(inp: BuildInput): ProgramDay[] {
  const total = programLength(inp.startDate, inp.interviewDate);
  const slots = layout(inp.startDate, total).filter(s => !inp.occupied?.has(s.date) && (!inp.fromDate || s.date >= inp.fromDate));
  const lessonSlots = slots.filter(s => s.kind === 'lesson').length;
  const topics = assignTopics(lessonSlots, inp.profile.topics);
  const minutes = inp.minutesPerDay ?? DEFAULT_MINUTES;
  const baseline = inp.profile.assessment;
  let li = 0, wi = 0;
  return slots.map(s => {
    const base = { id: inp.id(), userId: inp.userId, dayDate: s.date, position: s.position, week: s.week, status: 'planned' as DayStatus, score: null, completedAt: null, generatedAt: inp.now, updatedAt: null };
    if (s.kind === 'checkpoint') {
      const vs = baseline ? `сравнение с ${baseline.kind === 'baseline' ? 'исходным срезом' : baseline.kind === 'checkpoint' ? 'контрольным срезом' : 'тестом уровня'}${baseline.finishedAt ? ` от ${baseline.finishedAt.slice(0, 10)}` : ''}` : 'первая точка сравнения';
      return { ...base, format: 'checkpoint' as DayFormat, topic: 'mixed', writing: null, reason: `укороченный тест, ${vs}`, minutes: CHECKPOINT_MINUTES };
    }
    if (s.kind === 'rehearsal') {
      return { ...base, format: 'rehearsal' as DayFormat, topic: 'task-response', writing: null, reason: inp.targetRole ? `сценарий по целевой позиции: ${inp.targetRole}` : 'сценарий интервью по профилю резюме', minutes };
    }
    const writing = WRITING_FORMATS[wi++ % WRITING_FORMATS.length];
    if (s.kind === 'mixed') {
      return { ...base, format: 'lesson' as DayFormat, topic: MIXED_TOPIC.id, writing, reason: 'карточки недели и орфография', minutes };
    }
    const w = topics[li++];
    return { ...base, format: 'lesson' as DayFormat, topic: w.topic, writing, reason: reasonText(w, inp.profile.axes), minutes };
  });
}

// ---------- оркестрация ----------

export interface ProgramDeps {
  listCards(userId: string): Promise<ErrorCard[]>;
  latestFinishedAssessment(userId: string): Promise<Assessment | null>;
  listAttempts(assessmentId: string): Promise<Attempt[]>;
  getItem(id: string): Promise<Item | null>;
}

export type Store = ProgramStore & ProgramDeps;

export class ProgramError extends Error {
  constructor(public code: 'program_none' | 'program_invalid', public reason?: string) { super(code); }
}

export interface RunOpts { now?: () => string; id?: () => string }

/** Профиль ошибок пользователя из журнала и последнего завершённого теста или среза. */
export async function loadErrorProfile(store: ProgramDeps, userId: string): Promise<ErrorProfile> {
  const cards = await store.listCards(userId);
  const a = await store.latestFinishedAssessment(userId);
  const attempts = a ? await store.listAttempts(a.id) : [];
  const items = new Map<string, Item>();
  for (const t of attempts) if (!items.has(t.itemId)) { const it = await store.getItem(t.itemId); if (it) items.set(t.itemId, it); }
  return errorProfile(cards, a, attempts, items);
}

/** Строит программу с сегодняшнего дня в поясе пользователя или пересобирает идущую: её начало и пройденные дни
 *  остаются, незавершённые дни с сегодняшнего заменяются по свежему профилю ошибок и дате собеседования.
 *  Когда прежняя программа закончилась — новая начинается сегодня. */
export async function generateProgram(store: Store, userId: string, tz: string, profile: Profile | null, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const id = opts.id ?? (() => crypto.randomUUID());
  const today = todayIn(tz, new Date(now()));
  const prev = await current(store, userId, tz, profile, now);
  const running = prev && prev.startDate <= today && today <= prev.endDate;
  const startDate = running ? prev.startDate : today;
  const errors = await loadErrorProfile(store, userId);
  const existing = await store.listProgramDays(userId);
  const occupied = new Set(existing.filter(d => d.status !== 'planned' && d.dayDate >= today).map(d => d.dayDate));
  const days = buildProgram({
    userId, startDate, fromDate: today, interviewDate: profile?.interviewDate ?? null, minutesPerDay: profile?.minutesPerDay ?? null,
    targetRole: profile?.targetRole ?? null, profile: errors, occupied, now: now(), id,
  });
  await store.replacePlannedDays(userId, today, days);
  return (await current(store, userId, tz, profile, now))!;
}

/** Переставить темы двух дней занятий местами (ещё не пройденных, не раньше сегодняшнего дня). */
export async function swapDays(store: Store, userId: string, tz: string, profile: Profile | null, aId: unknown, bId: unknown, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  if (typeof aId !== 'string' || typeof bId !== 'string') throw new ProgramError('program_invalid', 'not_found');
  if (aId === bId) throw new ProgramError('program_invalid', 'same');
  const a = await store.getProgramDay(aId), b = await store.getProgramDay(bId);
  if (!a || !b || a.userId !== userId || b.userId !== userId) throw new ProgramError('program_invalid', 'not_found');
  const today = todayIn(tz, new Date(now()));
  for (const d of [a, b]) {
    if (d.format !== 'lesson') throw new ProgramError('program_invalid', 'not_lesson');
    if (d.status !== 'planned') throw new ProgramError('program_invalid', 'not_planned');
    if (d.dayDate < today) throw new ProgramError('program_invalid', 'past');
  }
  const stamp = now();
  await store.updateProgramDay(a.id, { topic: b.topic, reason: b.reason, updatedAt: stamp });
  await store.updateProgramDay(b.id, { topic: a.topic, reason: a.reason, updatedAt: stamp });
  return (await current(store, userId, tz, profile, now))!;
}

// ---------- что видит ученик ----------

export interface PublicDay {
  id: string; date: string; weekday: string; position: number; week: number;
  format: DayFormat; formatLabel: string; topic: string; topicLabel: string;
  writing: WritingFormat | null; writingLabel: string | null; reason: string | null;
  status: DayStatus; minutes: number | null; score: number | null; completedAt: string | null; today: boolean; past: boolean;
}

export interface View {
  generatedAt: string | null;
  startDate: string;
  endDate: string;
  totalDays: number;
  today: string;
  interviewDate: string | null;
  /** Сколько дней каждого формата и сколько занятий по каждой теме — сводка плана. */
  counts: { lessons: number; rehearsals: number; checkpoints: number; done: number };
  topics: { id: string; label: string; days: number }[];
  days: PublicDay[];
}

export const publicDay = (d: ProgramDay, today: string): PublicDay => ({
  id: d.id, date: d.dayDate, weekday: WEEKDAYS_RU[weekdayOf(d.dayDate)], position: d.position, week: d.week,
  format: d.format, formatLabel: FORMAT_LABELS[d.format], topic: d.topic, topicLabel: programTopicById(d.topic)?.label ?? d.topic,
  writing: d.writing, writingLabel: d.writing ? WRITING_LABELS[d.writing] : null, reason: d.reason,
  status: d.status, minutes: d.minutes, score: d.score, completedAt: d.completedAt, today: d.dayDate === today, past: d.dayDate < today,
});

/** Текущая программа: от начала последней сборки (позиция её первого дня отсчитывает начало, даже если сборка
 *  шла с середины) до последнего дня, вместе с пройденными и пропущенными днями прежних сборок в этих датах.
 *  null — программы ещё нет. */
export async function current(store: ProgramStore, userId: string, tz: string, profile: Profile | null, now: () => string = () => new Date().toISOString()): Promise<View | null> {
  const all = await store.listProgramDays(userId);
  if (!all.length) return null;
  const generatedAt = all.reduce<string | null>((m, d) => d.generatedAt && (!m || d.generatedAt > m) ? d.generatedAt : m, null);
  const build = all.filter(d => d.generatedAt === generatedAt);
  const first = build[0] ?? all[0];
  const startDate = addDays(first.dayDate, 1 - Math.max(1, first.position));
  const days = all.filter(d => d.dayDate >= startDate);
  const today = todayIn(tz, new Date(now()));
  const endDate = days[days.length - 1].dayDate;
  const topics = new Map<string, number>();
  for (const d of days) if (d.format === 'lesson') topics.set(d.topic, (topics.get(d.topic) ?? 0) + 1);
  return {
    generatedAt, startDate, endDate, totalDays: days.length, today, interviewDate: profile?.interviewDate ?? null,
    counts: {
      lessons: days.filter(d => d.format === 'lesson').length, rehearsals: days.filter(d => d.format === 'rehearsal').length,
      checkpoints: days.filter(d => d.format === 'checkpoint').length, done: days.filter(d => d.status === 'done').length,
    },
    topics: PROGRAM_TOPICS.filter(t => topics.has(t.id)).map(t => ({ id: t.id, label: t.label, days: topics.get(t.id)! })),
    days: days.map(d => publicDay(d, today)),
  };
}

// ---------- хранилище D1 ----------

export function d1ProgramStore(db: D1Database): ProgramStore {
  const n = (v: unknown) => v == null ? null : Number(v);
  const toDay = (r: any): ProgramDay => ({
    id: r.id, userId: r.user_id, dayDate: r.day_date, position: Number(r.position ?? 0), week: Number(r.week ?? 0),
    format: (FORMATS as readonly string[]).includes(r.format) ? r.format : 'lesson', topic: r.topic,
    writing: (WRITING_FORMATS as readonly string[]).includes(r.writing) ? r.writing : null, reason: r.reason ?? null,
    status: (DAY_STATUSES as readonly string[]).includes(r.status) ? r.status : 'planned', minutes: n(r.minutes), score: n(r.score),
    completedAt: r.completed_at ?? null, generatedAt: r.generated_at ?? null, updatedAt: r.updated_at ?? null,
  });
  const insert = (d: ProgramDay) => db.prepare(
    'INSERT INTO program_days (id, user_id, day_date, topic, format, status, minutes, score, completed_at, writing, week, position, reason, generated_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(d.id, d.userId, d.dayDate, d.topic, d.format, d.status, d.minutes, d.score, d.completedAt, d.writing, d.week, d.position, d.reason, d.generatedAt, d.updatedAt);
  const COLS: Record<string, string> = { topic: 'topic', reason: 'reason', updatedAt: 'updated_at', status: 'status', score: 'score', completedAt: 'completed_at' };
  return {
    async listProgramDays(userId) {
      const rs = await db.prepare('SELECT * FROM program_days WHERE user_id = ? ORDER BY day_date, position, id').bind(userId).all();
      return (rs.results as any[]).map(toDay);
    },
    async getProgramDay(id) {
      const r = await db.prepare('SELECT * FROM program_days WHERE id = ?').bind(id).first();
      return r ? toDay(r) : null;
    },
    async replacePlannedDays(userId, fromDate, days) {
      await db.batch([
        db.prepare("DELETE FROM program_days WHERE user_id = ? AND status = 'planned' AND day_date >= ?").bind(userId, fromDate),
        ...days.map(insert),
      ]);
    },
    async updateProgramDay(id, patch) {
      const keys = Object.keys(patch).filter(k => (patch as any)[k] !== undefined && COLS[k]);
      if (!keys.length) return;
      await db.prepare(`UPDATE program_days SET ${keys.map(k => `${COLS[k]} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map(k => (patch as any)[k]), id).run();
    },
  };
}
