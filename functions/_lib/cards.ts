/** Журнал ошибок: каждая ошибка ученика — карточка с темой, правилом одной строкой, примером «как написано»
 *  и исправлением «как надо». Карточки повторяются по FSRS (3.3) и гаснут после трёх верных повторов.
 *  Здесь — тип, справочник тем и хранилище; создание карточек из ошибок теста и занятий — 3.3. */
import { TOPICS, topicById, type Topic } from './items';

/** Темы карточек: темы банка заданий плюс «ответ на вопрос задания» — ось оценки, которой в банке нет. */
export const CARD_TOPICS: Topic[] = [
  ...TOPICS,
  { id: 'task-response', label: 'Ответ на вопрос задания', hint: 'answering exactly the question asked, for the stated reader, before adding context' },
];

export const cardTopicById = (id: unknown): Topic | undefined => topicById(id) ?? CARD_TOPICS.find(t => t.id === id);

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
  stability: number;
  difficulty: number;
  /** Дата следующего повтора (YYYY-MM-DD); null — не запланирован. */
  due: string | null;
  reps: number;
  lapses: number;
  retired: boolean;
  createdAt: string;
}

export type CardPatch = Partial<Pick<ErrorCard, 'reps' | 'lapses' | 'due' | 'stability' | 'difficulty' | 'retired'>>;

export interface CardStore {
  /** Карточки пользователя: сначала к повтору (по due), погашенные — в конце. */
  listCards(userId: string): Promise<ErrorCard[]>;
  getCard(id: string): Promise<ErrorCard | null>;
  /** Итог повтора: счётчики и следующая дата (расписание FSRS — 3.3). */
  updateCard(id: string, patch: CardPatch): Promise<void>;
}

/** Карточка готова к повтору: не погашена, есть пример и исправление, срок наступил или не назначен. */
export const dueForReview = (c: ErrorCard, today: string) => !c.retired && !!c.example && !!c.correction && (c.due == null || c.due <= today);

/** Что отдаём наружу: карточка с подписью темы. */
export const publicCard = (c: ErrorCard) => ({
  id: c.id, topic: c.topic, topicLabel: cardTopicById(c.topic)?.label ?? c.topic, rule: c.rule, example: c.example, correction: c.correction,
  source: c.source, due: c.due, reps: c.reps, lapses: c.lapses, retired: c.retired, createdAt: c.createdAt,
});

export function d1CardStore(db: D1Database): CardStore {
  const toCard = (r: any): ErrorCard => ({
    id: r.id, userId: r.user_id, topic: r.topic, rule: r.rule ?? null, example: r.example ?? null, correction: r.correction ?? null,
    source: r.source ?? null, stability: Number(r.stability ?? 1), difficulty: Number(r.difficulty ?? 5), due: r.due ?? null,
    reps: Number(r.reps ?? 0), lapses: Number(r.lapses ?? 0), retired: Number(r.retired ?? 0) === 1, createdAt: r.created_at,
  });
  const COLS: Record<string, string> = { reps: 'reps', lapses: 'lapses', due: 'due', stability: 'stability', difficulty: 'difficulty', retired: 'retired' };
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
  };
}
