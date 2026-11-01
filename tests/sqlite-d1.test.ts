import { describe, it, expect } from 'vitest';
import { d1Of, freshDb, sqlStore } from './helpers/sqliteD1';

/** Обёртка node:sqlite под D1 — на ней стоят тесты хранилищ и стенд Playwright, где запросы идут параллельно. */
describe('sqliteD1', () => {
  it('параллельные batch не попадают в чужую транзакцию и проходят оба', async () => {
    const d1 = d1Of(freshDb());
    const ins = (id: string) => d1.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(id, `${id}@x.test`, '2026-11-01T00:00:00Z');
    const [a, b] = await Promise.all([d1.batch([ins('a1'), ins('a2')]), d1.batch([ins('b1'), ins('b2')])]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    const { results } = await d1.prepare('SELECT id FROM users ORDER BY id').all();
    expect(results.map(r => r.id)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('ошибка в batch откатывает весь пакет', async () => {
    const d1 = d1Of(freshDb());
    const ins = (id: string) => d1.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(id, `${id}@x.test`, '2026-11-01T00:00:00Z');
    await expect(d1.batch([ins('c1'), ins('c1')])).rejects.toThrow();
    expect(await d1.prepare('SELECT id FROM users').first()).toBeNull();
    // после отката база принимает новый пакет
    await d1.batch([ins('c2')]);
    expect((await d1.prepare('SELECT id FROM users').all()).results).toHaveLength(1);
  });

  it('sqlStore: хранилища D1 пишут в ту же базу, rows отдаёт колонки в camelCase, внешние ключи соблюдаются', async () => {
    const { store, rows, addUser } = sqlStore();
    const take = { id: 's0', userId: 'nobody', text: 'x', duration: 1, words: 1, wpm: 60, pauses: 0, longestPause: 0, fillers: 0, fluency: 50, model: 'm', createdAt: '2026-11-01T00:00:00Z' };
    await expect(store.insertSpeech(take)).rejects.toThrow(/FOREIGN KEY/);
    addUser('u1', 'u1@x.test', 'Europe/Moscow');
    expect(rows('SELECT id, tz, created_at FROM users')).toEqual([{ id: 'u1', tz: 'Europe/Moscow', createdAt: expect.any(String) }]);
    expect((await store.findUserByEmail('u1@x.test'))?.id).toBe('u1');
    expect(await store.getProfile('u1')).toBeNull();
    await store.insertSpeech({ ...take, userId: 'u1' });
    expect(rows('SELECT user_id, longest_pause FROM speech_takes')).toEqual([{ userId: 'u1', longestPause: 0 }]);
  });
});
