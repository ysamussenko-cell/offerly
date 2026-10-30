/** Достижения за навык (концепт §4): привязаны к тому, что ученик сделал по-английски, а не к кликам и дням —
 *  «пять заданий подряд без ошибки по теме», «первый отзыв рецензента без правок», «письмо уровня C1»,
 *  «три растяжки подряд», погашенные карточки, решённые бонусы, разминка без ошибок. Условие каждого считается
 *  по уже записанным ответам (попытки теста, шаги занятий, карточки, занятия) — отдельных счётчиков нет, поэтому
 *  прогресс «3 из 5» всегда сходится с журналом. Факт и дата открытия пишутся в таблицу achievements один раз
 *  (миграция 0013): пересчёт не отнимает открытое, а «новое» показывается, пока не отмечено увиденным.
 *  Достижение за речь («десять минут без пауз») появится с голосом (4.2) — здесь его нет, чтобы не выдумывать. */
import type { Kind, Level } from './items';
import { LEVELS, TOPICS } from './items';
import type { ErrorCard } from './cards';
import type { Lesson, Part } from './lesson';
import type { WritingFormat } from './program';
import { parseWritingEval } from './scoring';
import { todayIn } from './onboarding';

/** Верных подряд по теме для достижения. */
export const TOPIC_STREAK = 5;
/** Верных растяжек подряд (задания ступенью выше уровня занятия). */
export const STRETCH_STREAK = 3;
export const RETIRED_TARGETS = [1, 10] as const;
export const BONUS_TARGETS = [1, 5] as const;
export const WRITING_TOP_LEVEL: Level = 'C1';

export type Group = 'topic' | 'writing' | 'stretch' | 'cards' | 'bonus' | 'lesson';
export const GROUP_LABELS: Record<Group, string> = { topic: 'темы', writing: 'письмо', stretch: 'растяжка', cards: 'журнал', bonus: 'бонусы', lesson: 'занятие' };

/** Отвеченное задание ученика — из теста или занятия, с темой и уровнем задания. */
export interface AnswerRecord {
  /** Когда отвечено (ISO). */
  at: string;
  source: 'assessment' | 'lesson';
  lessonId: string | null;
  part: Part | null;
  kind: Kind;
  topic: string;
  level: Level | null;
  /** Уровень занятия — для растяжки; у теста null. */
  lessonLevel: Level | null;
  writingFormat: WritingFormat | null;
  correct: number | null;
  score: number | null;
  /** JSON оценки письма (WritingEval) у письма; иначе null. */
  detail: string | null;
}

export interface AchievementRow {
  userId: string;
  code: string;
  unlockedAt: string;
  /** Чем открыто — дата события в поясе ученика (YYYY-MM-DD) или null. */
  detail: string | null;
  seenAt: string | null;
}

export interface AchievementStore {
  /** Все отвеченные задания пользователя по времени ответа (попытки теста и шаги занятий с заданием). */
  answerLog(userId: string): Promise<AnswerRecord[]>;
  listAchievements(userId: string): Promise<AchievementRow[]>;
  /** Вставка открытых достижений; уже существующие (user_id, code) пропускаются. Возвращает число вставленных. */
  insertAchievements(rows: AchievementRow[]): Promise<number>;
  /** Отметить все открытые достижения увиденными. */
  markAchievementsSeen(userId: string, nowIso: string): Promise<void>;
}

export interface Context {
  log: AnswerRecord[];
  cards: Pick<ErrorCard, 'retired'>[];
  lessons: Pick<Lesson, 'id' | 'status' | 'warmupCount' | 'bonus' | 'dayDate' | 'finishedAt'>[];
  tz: string;
}

export interface Progress { value: number; target: number; detail: string | null }

export interface AchievementDef {
  code: string;
  title: string;
  description: string;
  group: Group;
  target: number;
  check(ctx: Context): Progress;
}

const idx = (l: Level | null) => (l ? LEVELS.indexOf(l) : -1);
const dateOf = (iso: string, tz: string) => { try { return todayIn(tz, new Date(iso)); } catch { return iso.slice(0, 10); } };
const graded = (r: AnswerRecord) => r.correct != null && r.kind !== 'writing' && (r.source === 'assessment' || r.part === 'warmup' || r.part === 'bonus');

/** Серия верных подряд: лучшая (с датой её достижения) и текущая хвостовая. Для прогресса показывается текущая,
 *  пока лучшая не достигла цели. */
export function streakProgress(rows: AnswerRecord[], target: number, tz: string): Progress {
  let run = 0, best = 0, reached: string | null = null;
  for (const r of rows) {
    run = r.correct === 1 ? run + 1 : 0;
    if (run > best) best = run;
    if (run === target && !reached) reached = dateOf(r.at, tz);
  }
  return best >= target ? { value: best, target, detail: reached } : { value: run, target, detail: null };
}

const topicStreak = (topic: string, label: string): AchievementDef => ({
  code: `streak5:${topic}`, group: 'topic', target: TOPIC_STREAK,
  title: `Пять подряд без ошибки — ${label.toLowerCase()}`,
  description: `Пять верных ответов подряд на задания темы «${label}» в тесте, разминке и бонусе.`,
  check: ctx => streakProgress(ctx.log.filter(r => r.topic === topic && graded(r)), TOPIC_STREAK, ctx.tz),
});

const cleanWriting = (format: WritingFormat, code: string, title: string, label: string): AchievementDef => ({
  code, group: 'writing', target: 1, title,
  description: `Письмо формата «${label}», в котором экзаменатор не нашёл ни одной ошибки.`,
  check: ctx => {
    const hits = ctx.log.filter(r => r.kind === 'writing' && r.writingFormat === format && (parseWritingEval(r.detail)?.errors.length ?? -1) === 0);
    return { value: hits.length, target: 1, detail: hits.length ? dateOf(hits[0].at, ctx.tz) : null };
  },
});

const countDef = (code: string, group: Group, target: number, title: string, description: string, count: (ctx: Context) => { n: number; at: string | null }): AchievementDef => ({
  code, group, target, title, description,
  check: ctx => { const { n, at } = count(ctx); return { value: n, target, detail: n >= target && at ? dateOf(at, ctx.tz) : null }; },
});

const nth = <T,>(xs: T[], n: number) => xs[n - 1] ?? null;

/** Каталог: темы банка по пять подряд, письмо без правок двух форматов, письмо C1, растяжка, карточки, бонусы, разминка. */
export const ACHIEVEMENTS: AchievementDef[] = [
  ...TOPICS.map(t => topicStreak(t.id, t.label)),
  cleanWriting('review', 'review-clean', 'Первый отзыв рецензента без правок', 'отзыв рецензента'),
  cleanWriting('explain', 'explain-clean', 'Первое объяснение неспециалисту без правок', 'объяснение неспециалисту'),
  countDef('writing-c1', 'writing', 1, `Письмо уровня ${WRITING_TOP_LEVEL}`, `Экзаменатор оценил текст письма как ${WRITING_TOP_LEVEL} — в тесте или занятии.`, ctx => {
    const hits = ctx.log.filter(r => r.kind === 'writing' && parseWritingEval(r.detail)?.level === WRITING_TOP_LEVEL);
    return { n: hits.length, at: hits[0]?.at ?? null };
  }),
  {
    code: 'stretch3', group: 'stretch', target: STRETCH_STREAK, title: 'Три растяжки подряд',
    description: 'Три верных ответа подряд на задания разминки ступенью выше своего уровня.',
    check: ctx => streakProgress(ctx.log.filter(r => r.part === 'warmup' && r.correct != null && idx(r.level) > idx(r.lessonLevel)), STRETCH_STREAK, ctx.tz),
  },
  ...RETIRED_TARGETS.map(n => countDef(`retired-${n}`, 'cards', n, n === 1 ? 'Первая погашенная карточка' : `${n} погашенных карточек`,
    n === 1 ? 'Ошибка из журнала повторена верно три раза подряд и погашена.' : `${n} карточек журнала погашены — каждая тремя верными повторами подряд.`,
    ctx => ({ n: ctx.cards.filter(c => c.retired).length, at: null }))),
  ...BONUS_TARGETS.map(n => countDef(`bonus-${n}`, 'bonus', n, n === 1 ? 'Первый бонус решён' : `${n} бонусов решены`,
    n === 1 ? 'Бонусная задача ступенью выше решена верно — вклад занятия в готовность удвоен.' : `${n} бонусных задач ступенью выше решены верно.`,
    ctx => { const hits = ctx.lessons.filter(l => l.bonus === 'correct'); return { n: hits.length, at: nth(hits, n)?.finishedAt ?? null }; })),
  countDef('warmup-perfect', 'lesson', 1, 'Разминка без ошибок', 'Все задания разминки занятия решены верно, включая две растяжки.', ctx => {
    const byLesson = new Map<string, AnswerRecord[]>();
    for (const r of ctx.log) if (r.lessonId && r.part === 'warmup') byLesson.set(r.lessonId, [...(byLesson.get(r.lessonId) ?? []), r]);
    const hits = ctx.lessons.filter(l => { const rows = byLesson.get(l.id) ?? []; return rows.length >= l.warmupCount && rows.every(r => r.correct === 1); });
    const rows = hits[0] ? byLesson.get(hits[0].id)! : [];
    return { n: hits.length, at: rows.length ? rows[rows.length - 1].at : null };
  }),
];

export const achievementByCode = (code: string) => ACHIEVEMENTS.find(a => a.code === code);

export interface PublicAchievement {
  code: string; title: string; description: string; group: Group; groupLabel: string;
  unlocked: boolean; unlockedAt: string | null; detail: string | null; new: boolean;
  progress: { value: number; target: number };
}

export function publicAchievement(def: AchievementDef, p: Progress, row: AchievementRow | null): PublicAchievement {
  return {
    code: def.code, title: def.title, description: def.description, group: def.group, groupLabel: GROUP_LABELS[def.group],
    unlocked: !!row, unlockedAt: row?.unlockedAt ?? null, detail: row?.detail ?? p.detail, new: !!row && !row.seenAt,
    progress: { value: Math.min(p.value, p.target), target: p.target },
  };
}

export type Store = AchievementStore & { listCards(userId: string): Promise<ErrorCard[]>; listLessons(userId: string): Promise<Lesson[]> };

export interface RunOpts { now?: () => string }

/** Пересчитать условия и открыть новые достижения. Возвращает весь каталог с прогрессом (открытые — первыми,
 *  по дате; остальные — по близости к цели) и отдельно только что открытые. */
export async function syncAchievements(store: Store, userId: string, tz: string, opts: RunOpts = {}): Promise<{ all: PublicAchievement[]; fresh: PublicAchievement[] }> {
  const now = opts.now ?? (() => new Date().toISOString());
  const [log, cards, lessons, rows] = await Promise.all([store.answerLog(userId), store.listCards(userId), store.listLessons(userId), store.listAchievements(userId)]);
  const ctx: Context = { log, cards, lessons, tz };
  const have = new Map(rows.map(r => [r.code, r]));
  const ts = now();
  const toInsert: AchievementRow[] = [];
  const results: { def: AchievementDef; p: Progress }[] = [];
  for (const def of ACHIEVEMENTS) {
    const p = def.check(ctx);
    results.push({ def, p });
    if (p.value >= p.target && !have.has(def.code)) toInsert.push({ userId, code: def.code, unlockedAt: ts, detail: p.detail, seenAt: null });
  }
  if (toInsert.length) {
    await store.insertAchievements(toInsert);
    for (const r of toInsert) have.set(r.code, r);
  }
  const all = results.map(({ def, p }) => publicAchievement(def, p, have.get(def.code) ?? null));
  all.sort((a, b) => Number(b.unlocked) - Number(a.unlocked)
    || (a.unlocked ? (b.unlockedAt ?? '').localeCompare(a.unlockedAt ?? '') : (b.progress.value / b.progress.target) - (a.progress.value / a.progress.target))
    || ACHIEVEMENTS.findIndex(d => d.code === a.code) - ACHIEVEMENTS.findIndex(d => d.code === b.code));
  const freshCodes = new Set(toInsert.map(r => r.code));
  return { all, fresh: all.filter(a => freshCodes.has(a.code)) };
}

// ---------- хранилище D1 ----------

export function d1AchievementStore(db: D1Database): AchievementStore {
  const n = (v: unknown) => v == null ? null : Number(v);
  const lvl = (v: unknown): Level | null => (LEVELS as readonly string[]).includes(String(v)) ? v as Level : null;
  return {
    async answerLog(userId) {
      const rs = await db.prepare(
        `SELECT a.answered_at AS at, 'assessment' AS source, NULL AS lesson_id, NULL AS part, i.kind, i.topic, a.level, NULL AS lesson_level, i.writing_format, a.correct, a.score, a.detail
           FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.user_id = ? AND a.answered_at IS NOT NULL
         UNION ALL
         SELECT s.answered_at AS at, 'lesson' AS source, s.lesson_id, s.part, i.kind, i.topic, s.level, l.level AS lesson_level, i.writing_format, s.correct, s.score, s.detail
           FROM lesson_steps s JOIN items i ON i.id = s.item_id JOIN lessons l ON l.id = s.lesson_id WHERE s.user_id = ? AND s.answered_at IS NOT NULL
         ORDER BY at`,
      ).bind(userId, userId).all();
      return (rs.results as any[]).map(r => ({
        at: String(r.at), source: r.source === 'lesson' ? 'lesson' : 'assessment', lessonId: r.lesson_id ?? null, part: r.part ?? null,
        kind: r.kind as Kind, topic: String(r.topic), level: lvl(r.level), lessonLevel: lvl(r.lesson_level),
        writingFormat: r.writing_format === 'review' || r.writing_format === 'explain' ? r.writing_format : null,
        correct: n(r.correct), score: n(r.score), detail: r.detail ?? null,
      }));
    },
    async listAchievements(userId) {
      const rs = await db.prepare('SELECT * FROM achievements WHERE user_id = ? ORDER BY unlocked_at').bind(userId).all();
      return (rs.results as any[]).map(r => ({ userId: r.user_id, code: r.code, unlockedAt: r.unlocked_at, detail: r.detail ?? null, seenAt: r.seen_at ?? null }));
    },
    async insertAchievements(rows) {
      let count = 0;
      for (const r of rows) {
        const res = await db.prepare('INSERT OR IGNORE INTO achievements (user_id, code, unlocked_at, detail, seen_at) VALUES (?, ?, ?, ?, ?)').bind(r.userId, r.code, r.unlockedAt, r.detail, r.seenAt).run();
        count += Number((res.meta as any)?.changes ?? 0) > 0 ? 1 : 0;
      }
      return count;
    },
    async markAchievementsSeen(userId, nowIso) {
      await db.prepare('UPDATE achievements SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL').bind(nowIso, userId).run();
    },
  };
}
