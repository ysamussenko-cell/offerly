import { describe, it, expect } from 'vitest';
import { d1Of, freshDb } from './helpers/sqliteD1';

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
});
