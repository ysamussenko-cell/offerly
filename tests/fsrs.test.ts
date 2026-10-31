import { describe, it, expect } from 'vitest';
import {
  W, DESIRED_RETENTION, MIN_INTERVAL, MAX_INTERVAL, RETIRE_AFTER, retrievability, intervalFor, initialStability, initialDifficulty,
  nextDifficulty, recallStability, forgetStability, daysBetween, isNew, review, type FsrsState,
} from '../functions/_lib/fsrs';

const fresh: FsrsState = { stability: 1, difficulty: 5, reps: 0, lapses: 0, streak: 0, reviewedAt: null };
const TODAY = '2026-11-02';

describe('формулы FSRS', () => {
  it('вероятность вспомнить: сразу — 1, через S дней — ровно 0,9, дальше — ниже', () => {
    expect(retrievability(10, 0)).toBe(1);
    expect(retrievability(10, 10)).toBeCloseTo(DESIRED_RETENTION, 6);
    expect(retrievability(10, 30)).toBeLessThan(0.8);
    expect(retrievability(0, 5)).toBeLessThan(1); // нулевая стабильность не ломает расчёт
  });
  it('интервал при желаемой удержке 0,9 равен стабильности, в границах от дня до полугода', () => {
    expect(intervalFor(4)).toBe(4);
    expect(intervalFor(0.3)).toBe(MIN_INTERVAL);
    expect(intervalFor(1000)).toBe(MAX_INTERVAL);
    expect(intervalFor(10, 0.8)).toBeGreaterThan(10); // меньшая удержка — длиннее интервал
  });
  it('начальные значения: стабильность — w0 (неверно) и w2 (верно); сложность 1–10, после неверного выше', () => {
    expect(initialStability('again')).toBeCloseTo(W[0], 6);
    expect(initialStability('good')).toBeCloseTo(W[2], 6);
    expect(initialDifficulty('good')).toBeCloseTo(W[4], 6);
    expect(initialDifficulty('again')).toBeGreaterThan(initialDifficulty('good'));
    expect(initialDifficulty('again')).toBeLessThanOrEqual(10);
  });
  it('сложность после ответа: неверный повышает, верный почти не меняет (лёгкое подтягивание к среднему), края 1 и 10 не пробиваются', () => {
    expect(nextDifficulty(5, 'again')).toBeGreaterThan(5.5);
    expect(nextDifficulty(5, 'good')).toBeCloseTo(5, 1);
    expect(nextDifficulty(8, 'good')).toBeLessThan(8);
    expect(nextDifficulty(10, 'again')).toBe(10);
    expect(nextDifficulty(1, 'good')).toBeGreaterThanOrEqual(1); expect(nextDifficulty(1, 'good')).toBeLessThan(1.2);
  });
  it('стабильность: верный ответ растит, тем сильнее, чем ниже вероятность вспомнить; неверный — роняет и не выше прежней', () => {
    const s1 = recallStability(10, 5, 0.9), s2 = recallStability(10, 5, 0.7);
    expect(s1).toBeGreaterThan(10); expect(s2).toBeGreaterThan(s1);
    expect(recallStability(10, 9, 0.9)).toBeLessThan(s1); // трудная карточка растёт медленнее
    const f = forgetStability(10, 5, 0.9);
    expect(f).toBeLessThan(10); expect(f).toBeGreaterThan(0);
    expect(forgetStability(0.5, 5, 0.9)).toBeLessThanOrEqual(0.5);
  });
  it('дни между датами не отрицательные; новая карточка — без повторов', () => {
    expect(daysBetween('2026-11-02', '2026-11-06')).toBe(4);
    expect(daysBetween('2026-11-06', '2026-11-02')).toBe(0);
    expect(isNew(fresh)).toBe(true);
    expect(isNew({ ...fresh, reviewedAt: TODAY })).toBe(false);
    expect(isNew({ ...fresh, lapses: 1 })).toBe(false);
  });
});

describe('повтор карточки', () => {
  it('первый верный: срок через ~4 дня (w2), серия 1, reps 1; первый неверный: завтра, lapses 1, серия 0', () => {
    const g = review(fresh, 'good', TODAY);
    expect(g).toMatchObject({ reps: 1, lapses: 0, streak: 1, reviewedAt: TODAY, due: '2026-11-06', retired: false, interval: 4 });
    expect(g.stability).toBeCloseTo(W[2], 3);
    const a = review(fresh, 'again', TODAY);
    expect(a).toMatchObject({ reps: 0, lapses: 1, streak: 0, due: '2026-11-03', retired: false, interval: MIN_INTERVAL });
    expect(a.difficulty).toBeGreaterThan(g.difficulty);
  });
  it('верные подряд удлиняют интервалы, третий верный гасит карточку (due null); неверный обнуляет серию', () => {
    let s: FsrsState = fresh, date = TODAY;
    const intervals: number[] = [];
    for (let i = 0; i < RETIRE_AFTER; i++) {
      const n = review(s, 'good', date);
      intervals.push(n.interval);
      if (i < RETIRE_AFTER - 1) { expect(n.retired).toBe(false); expect(n.due).not.toBeNull(); date = n.due!; }
      else { expect(n).toMatchObject({ retired: true, due: null, interval: 0, streak: RETIRE_AFTER }); }
      s = n;
    }
    expect(intervals[1]).toBeGreaterThan(intervals[0]);
    // после двух верных неверный: серия 0, карточка завтра, стабильность упала
    let t: FsrsState = review(fresh, 'good', TODAY);
    t = review(t, 'good', t.reviewedAt!);
    const stableBefore = t.stability;
    const miss = review(t, 'again', '2026-11-20');
    expect(miss).toMatchObject({ streak: 0, lapses: 1, reps: 2, due: '2026-11-21', retired: false });
    expect(miss.stability).toBeLessThan(stableBefore);
    // снова верно — серия начинается с единицы, до гашения ещё два
    expect(review(miss, 'good', '2026-11-21').streak).toBe(1);
  });
  it('поздний повтор (вероятность вспомнить ниже) даёт больший прирост стабильности, чем ранний', () => {
    const base = review(fresh, 'good', TODAY); // S ≈ 3,7, due через 4 дня
    const early = review(base, 'good', '2026-11-03');
    const late = review(base, 'good', '2026-11-20');
    expect(late.stability).toBeGreaterThan(early.stability);
    expect(late.interval).toBeGreaterThan(early.interval);
  });
  it('старая карточка без даты повтора, но со счётчиками, считается по формулам повтора, а не как новая', () => {
    const legacy: FsrsState = { stability: 1, difficulty: 5, reps: 1, lapses: 0, streak: 0, reviewedAt: null };
    const n = review(legacy, 'good', TODAY);
    expect(n.reps).toBe(2); expect(n.stability).toBeGreaterThan(1); expect(n.stability).not.toBeCloseTo(W[2], 2);
  });
});
