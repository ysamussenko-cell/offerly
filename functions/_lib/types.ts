/** Общие типы оценивания, которыми обмениваются модули теста (assessment.ts), оценки (scoring.ts) и журнала (cards.ts).
 *  Они вынесены сюда, чтобы модули не ссылались друг на друга по кругу: попытка принадлежит тесту, но её читает
 *  оценка осей; ошибка письма рождается у экзаменатора, но из неё заводится карточка журнала. Здесь только типы —
 *  кода во время выполнения модуль не несёт, а из items.ts берётся лишь тип уровня. */
import type { Level } from './items';

/** Одно выданное задание теста или среза; ответ и оценка заполняются по мере прохождения. */
export interface Attempt {
  id: string;
  userId: string;
  assessmentId: string;
  itemId: string;
  position: number;
  /** Фактический уровень выданного задания. */
  level: Level;
  answer: string | null;
  /** 1 — верно, 0 — неверно, null — ещё не отвечено или не проверяется сравнением (письмо). */
  correct: number | null;
  /** Проценты: mcq и исправление — 0/100, чтение — 0/50/100, письмо — null до оценки моделью. */
  score: number | null;
  feedback: string | null;
  /** JSON оценки письма моделью (WritingEval из scoring.ts); у остальных заданий null. */
  detail: string | null;
  createdAt: string;
  answeredAt: string | null;
}

/** Реальная ошибка из текста ученика, найденная экзаменатором письма: цитата, исправление, правило одной строкой. */
export interface WritingError {
  original: string; corrected: string; note: string;
  /** Тема ошибки из справочника карточек (CARD_TOPICS в cards.ts); null, если экзаменатор её не назвал. */
  topic?: string | null;
}
