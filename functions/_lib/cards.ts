/** Журнал ошибок: каждая ошибка ученика — карточка с темой, правилом одной строкой, примером «как написано»
 *  и исправлением «как надо». Карточки создаются из неверных исправлений и выборов варианта (в тесте и разминке)
 *  и из ошибок письма, найденных экзаменатором; повторяются по FSRS (fsrs.ts) в конце дневного занятия
 *  и гаснут после RETIRE_AFTER верных подряд. Повторившаяся после гашения ошибка возвращает карточку в оборот.
 *  Одна и та же ошибка (по тексту «как написано») не заводит вторую карточку; источник карточки запоминается
 *  в origin, поэтому пересчёт теста карточки не дублирует. */
import { TOPICS, fingerprintOf, topicById, type Item, type Topic } from './items';
import { review, RETIRE_AFTER, MIN_INTERVAL, type Grade } from './fsrs';
import type { WritingError } from './types';
import { addDays } from './dates';

/** Темы карточек: темы банка заданий плюс «ответ на вопрос задания» — ось оценки, которой в банке нет. */
export const CARD_TOPICS: Topic[] = [
  ...TOPICS,
  { id: 'task-response', label: 'Ответ на вопрос задания', hint: 'answering exactly the question asked, for the stated reader, before adding context' },
];

export const cardTopicById = (id: unknown): Topic | undefined => topicById(id) ?? CARD_TOPICS.find(t => t.id === id);

/** Сколько карточек заводится из одного письма. */
export const WRITING_CARDS_MAX = 3;

export interface ErrorCard {
  id: string;
  userId: string;
  topic: string;
  /** Правило одной строкой по-русски. */
  rule: string | null;
  /** Как написал ученик. */
  example: string | null;
  /** Как надо. */
  correction: string | null;
  /** Откуда карточка: seed | assessment | lesson. */
  source: string | null;
  /** Ключ источника (попытка теста или шаг занятия, для письма — с номером ошибки); null у seed и старых карточек. */
  origin: string | null;
  stability: number;
  difficulty: number;
  /** Дата следующего повтора (YYYY-MM-DD); null — не запланирован (новая без срока или погашена). */
  due: string | null;
  reps: number;
  lapses: number;
  /** Верных подряд; RETIRE_AFTER гасят карточку. */
  streak: number;
  /** Дата последнего повтора (YYYY-MM-DD). */
  reviewedAt: string | null;
  retired: boolean;
  createdAt: string;
}

export type CardPatch = Partial<Pick<ErrorCard, 'reps' | 'lapses' | 'due' | 'stability' | 'difficulty' | 'retired' | 'streak' | 'reviewedAt'>>;

export interface CardStore {
  /** Карточки пользователя: сначала к повтору (по due), погашенные — в конце. */
  listCards(userId: string): Promise<ErrorCard[]>;
  getCard(id: string): Promise<ErrorCard | null>;
  /** Итог повтора: счётчики FSRS и следующая дата. */
  updateCard(id: string, patch: CardPatch): Promise<void>;
  /** Вставка карточек; совпадение id или (user_id, origin) с существующей — пропуск. Возвращает число вставленных. */
  insertCards(cards: ErrorCard[]): Promise<number>;
}

/** Карточка готова к повтору: не погашена, есть пример и исправление, срок наступил или не назначен. */
export const dueForReview = (c: ErrorCard, today: string) => !c.retired && !!c.example && !!c.correction && (c.due == null || c.due <= today);

/** Что отдаём наружу: карточка с подписью темы, сколько верных подряд осталось до гашения. */
export const publicCard = (c: ErrorCard) => ({
  id: c.id, topic: c.topic, topicLabel: cardTopicById(c.topic)?.label ?? c.topic, rule: c.rule, example: c.example, correction: c.correction,
  source: c.source, due: c.due, reps: c.reps, lapses: c.lapses, streak: c.streak, left: c.retired ? 0 : Math.max(0, RETIRE_AFTER - c.streak),
  reviewedAt: c.reviewedAt, retired: c.retired, createdAt: c.createdAt,
});
export type PublicCard = ReturnType<typeof publicCard>;

// ---------- повтор ----------

/** Итог повтора карточки по FSRS: что записать в карточку. */
export function reviewPatch(c: ErrorCard, correct: boolean, today: string): Required<CardPatch> {
  const g: Grade = correct ? 'good' : 'again';
  const n = review({ stability: c.stability, difficulty: c.difficulty, reps: c.reps, lapses: c.lapses, streak: c.streak, reviewedAt: c.reviewedAt }, g, today);
  return { stability: n.stability, difficulty: n.difficulty, reps: n.reps, lapses: n.lapses, streak: n.streak, reviewedAt: n.reviewedAt, due: n.due, retired: n.retired };
}

// ---------- создание из ошибок ----------

const LETTERS = ['A', 'B', 'C', 'D'];

/** Заготовка карточки: тема, правило, как написано, как надо и ключ источника. */
export interface CardDraft { topic: string; rule: string | null; example: string; correction: string; origin: string }

/** Заготовка из неверного ответа на задание с эталоном. Исправление: карточка показывает исходное предложение
 *  с ошибкой — его и надо исправить, как и в задании. Выбор варианта: предложение с выбранным и с верным словом.
 *  Чтение и письмо карточек этим путём не дают. */
export function draftFromItem(item: Item, answer: string | null, origin: string): CardDraft | null {
  if (!topicById(item.topic)) return null;
  if (item.kind === 'correction') {
    if (!item.prompt || !item.answer) return null;
    return { topic: item.topic, rule: item.explanation, example: item.prompt, correction: item.answer, origin };
  }
  if (item.kind === 'mcq') {
    const opts = Array.isArray(item.options) ? item.options as string[] : [];
    const chosen = opts[LETTERS.indexOf(answer ?? '')];
    const right = opts[LETTERS.indexOf(item.answer)];
    if (!chosen || !right || chosen === right || !item.prompt.includes('___')) return null;
    return { topic: item.topic, rule: item.explanation, example: item.prompt.replace('___', chosen), correction: item.prompt.replace('___', right), origin };
  }
  return null;
}

/** Заготовки из ошибок письма: тему называет экзаменатор; без темы — тема занятия (fallbackTopic), иначе ошибка пропускается. */
export function draftsFromWriting(errors: WritingError[], origin: string, fallbackTopic: string | null): CardDraft[] {
  const out: CardDraft[] = [];
  errors.forEach((e, i) => {
    if (out.length >= WRITING_CARDS_MAX) return;
    const topic = cardTopicById(e.topic) ? e.topic as string : cardTopicById(fallbackTopic) ? fallbackTopic as string : null;
    if (!topic || !e.original || !e.corrected) return;
    out.push({ topic, rule: e.note || null, example: e.original, correction: e.corrected, origin: `${origin}:w${i + 1}` });
  });
  return out;
}

export interface CreateOpts { now?: () => string; id?: () => string }
export interface Created { created: ErrorCard[]; revived: ErrorCard[]; skipped: number }

/** Заводит карточки из заготовок: та же ошибка (по тексту «как написано») у активной карточки — пропуск,
 *  у погашенной — карточка возвращается в оборот на завтра с обнулённой серией. Новые карточки получают срок
 *  на завтра: в сегодняшнем занятии они не всплывают, в следующем — повторяются первыми из новых. */
export async function createCards(store: CardStore, userId: string, drafts: CardDraft[], today: string, source: string, opts: CreateOpts = {}): Promise<Created> {
  const res: Created = { created: [], revived: [], skipped: 0 };
  if (!drafts.length) return res;
  const now = opts.now ?? (() => new Date().toISOString());
  const id = opts.id ?? (() => crypto.randomUUID());
  const existing = await store.listCards(userId);
  const byFp = new Map<string, ErrorCard>();
  for (const c of existing) if (c.example) byFp.set(fingerprintOf(c.example), c);
  const byOrigin = new Set(existing.map(c => c.origin).filter(Boolean));
  const fresh: ErrorCard[] = [];
  for (const d of drafts) {
    const fp = fingerprintOf(d.example);
    if (!fp || fingerprintOf(d.example) === fingerprintOf(d.correction) || byOrigin.has(d.origin)) { res.skipped++; continue; }
    const same = byFp.get(fp);
    if (same) {
      if (same.retired) {
        const patch: CardPatch = { retired: false, streak: 0, lapses: same.lapses + 1, due: addDays(today, MIN_INTERVAL) };
        await store.updateCard(same.id, patch);
        res.revived.push({ ...same, ...patch } as ErrorCard);
      } else res.skipped++;
      continue;
    }
    const c: ErrorCard = {
      id: id(), userId, topic: d.topic, rule: d.rule, example: d.example, correction: d.correction, source, origin: d.origin,
      stability: 1, difficulty: 5, due: addDays(today, MIN_INTERVAL), reps: 0, lapses: 0, streak: 0, reviewedAt: null, retired: false, createdAt: now(),
    };
    byFp.set(fp, c); byOrigin.add(d.origin); fresh.push(c);
  }
  if (fresh.length) {
    const n = await store.insertCards(fresh);
    res.created = n === fresh.length ? fresh : fresh.slice(0, n);
  }
  return res;
}

// ---------- хранилище D1 ----------

export function d1CardStore(db: D1Database): CardStore {
  const toCard = (r: any): ErrorCard => ({
    id: r.id, userId: r.user_id, topic: r.topic, rule: r.rule ?? null, example: r.example ?? null, correction: r.correction ?? null,
    source: r.source ?? null, origin: r.origin ?? null, stability: Number(r.stability ?? 1), difficulty: Number(r.difficulty ?? 5), due: r.due ?? null,
    reps: Number(r.reps ?? 0), lapses: Number(r.lapses ?? 0), streak: Number(r.streak ?? 0), reviewedAt: r.reviewed_at ?? null,
    retired: Number(r.retired ?? 0) === 1, createdAt: r.created_at,
  });
  const COLS: Record<string, string> = { reps: 'reps', lapses: 'lapses', due: 'due', stability: 'stability', difficulty: 'difficulty', retired: 'retired', streak: 'streak', reviewedAt: 'reviewed_at' };
  return {
    async listCards(userId) {
      const rs = await db.prepare('SELECT * FROM error_cards WHERE user_id = ? ORDER BY retired, due IS NULL, due, created_at, id').bind(userId).all();
      return (rs.results as any[]).map(toCard);
    },
    async getCard(id) {
      const r = await db.prepare('SELECT * FROM error_cards WHERE id = ?').bind(id).first();
      return r ? toCard(r) : null;
    },
    async updateCard(id, patch) {
      const keys = Object.keys(patch).filter(k => (patch as any)[k] !== undefined && COLS[k]);
      if (!keys.length) return;
      const val = (k: string) => { const v = (patch as any)[k]; return typeof v === 'boolean' ? (v ? 1 : 0) : v; };
      await db.prepare(`UPDATE error_cards SET ${keys.map(k => `${COLS[k]} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map(val), id).run();
    },
    async insertCards(cards) {
      if (!cards.length) return 0;
      const sql = 'INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, origin, stability, difficulty, due, reps, lapses, streak, reviewed_at, retired, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      const rs = await db.batch(cards.map(c => db.prepare(sql).bind(c.id, c.userId, c.topic, c.rule, c.example, c.correction, c.source, c.origin, c.stability, c.difficulty, c.due, c.reps, c.lapses, c.streak, c.reviewedAt, c.retired ? 1 : 0, c.createdAt)));
      return rs.reduce((n, r) => n + Number(r.meta?.changes ?? 0), 0);
    },
  };
}
