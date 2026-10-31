import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { importGraph, cycles, lineCount, listSources } from './helpers/imports';

/**
 * Архитектурные правила из обзора docs/review-2026-10-31.md. Падение теста — не «сломалось»,
 * а «границы сдвинулись»: либо вернуть код в рамки, либо осознанно поменять правило здесь и в обзоре.
 */

const graph = importGraph(['functions', 'src', 'workers']);
const libFiles = graph.files.filter(f => f.startsWith('functions/_lib/'));
const routeFiles = libFiles.filter(f => f.startsWith('functions/_lib/routes/'));
const srcFiles = graph.files.filter(f => f.startsWith('src/'));
const routeCount = (f: string) => readFileSync(f, 'utf-8').match(/\b(app|r)\.(get|post|put|delete)\(/g)?.length ?? 0;

describe('границы слоёв', () => {
  it('фронт и API не импортируют друг друга — общаются только по HTTP', () => {
    const crossing = graph.edges.filter(e =>
      (e.from.startsWith('src/') && !e.to.startsWith('src/')) ||
      (e.from.startsWith('functions/') && !e.to.startsWith('functions/')));
    expect(crossing.map(e => `${e.from} → ${e.to}`)).toEqual([]);
  });

  it('Worker рассылки переиспользует functions/_lib и не лезет во фронт', () => {
    const bad = graph.edges.filter(e => e.from.startsWith('workers/') && !e.to.startsWith('functions/_lib/') && !e.to.startsWith('workers/'));
    expect(bad.map(e => `${e.from} → ${e.to}`)).toEqual([]);
  });

  it('Hono знают только app.ts и routes/context.ts (area); точка входа Pages импортирует только app.ts', () => {
    const hono = [...graph.external.entries()].filter(([, pkgs]) => [...pkgs].some(p => p === 'hono' || p.startsWith('hono/'))).map(([f]) => f);
    expect(hono).toEqual(['functions/_lib/app.ts', 'functions/_lib/routes/context.ts']);
    const entry = graph.edges.filter(e => e.from === 'functions/api/[[route]].ts').map(e => e.to);
    expect(entry).toEqual(['functions/_lib/app.ts']);
  });

  it('SQL к D1 пишут только модули functions/_lib (Worker — лишь проверка связи)', () => {
    const offenders = [...srcFiles, ...graph.files.filter(f => f.startsWith('functions/api/'))]
      .filter(f => /\.prepare\(/.test(readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
    const worker = readFileSync('workers/digest/index.ts', 'utf-8');
    expect(worker.match(/\.prepare\(/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('внешние пакеты в API — только hono и unpdf', () => {
    const used = new Set<string>();
    for (const [f, pkgs] of graph.external) if (f.startsWith('functions/')) for (const p of pkgs) used.add(p.split('/')[0]);
    expect([...used].sort()).toEqual(['hono', 'unpdf']);
  });
});

describe('циклы импортов', () => {
  it('во время выполнения циклов нет', () => {
    expect(cycles(graph).map(c => c.join(' → '))).toEqual([]);
  });

  it('циклов нет и через типы: общие типы оценивания живут в functions/_lib/types.ts, режим экрана теста — в src/api.ts', () => {
    // Три цикла из обзора (scoring ↔ cards, scoring ↔ assessment, Checkpoint ↔ Assessment) сняты в 0.25.3 — новые не заводить.
    expect(cycles(graph, () => true).map(c => c.join(' → '))).toEqual([]);
    const types = readFileSync('functions/_lib/types.ts', 'utf-8');
    expect(types).toMatch(/export interface Attempt\b/);
    expect(types).toMatch(/export interface WritingError\b/);
    expect(graph.edges.filter(e => e.from === 'functions/_lib/types.ts').map(e => `${e.to}${e.typeOnly ? ' (тип)' : ''}`)).toEqual(['functions/_lib/items.ts (тип)']);
    for (const f of ['functions/_lib/assessment.ts', 'functions/_lib/scoring.ts']) {
      expect(readFileSync(f, 'utf-8'), `${f}: типы Attempt и WritingError объявлены один раз — в types.ts`).not.toMatch(/export (interface|type) (Attempt|WritingError)\b/);
    }
    expect(readFileSync('src/api.ts', 'utf-8')).toMatch(/export type AssessmentMode\b/);
    expect(readFileSync('src/screens/Assessment.tsx', 'utf-8')).not.toMatch(/export type Mode\b/);
  });

  it('основа API без зависимостей: errors, auth, providers, onboarding, fsrs, mail, release, types; extract — только errors', () => {
    const leaves = ['errors', 'auth', 'providers', 'onboarding', 'fsrs', 'mail', 'release', 'types'].map(n => `functions/_lib/${n}.ts`);
    for (const leaf of leaves) {
      expect(graph.edges.filter(e => e.from === leaf && !e.typeOnly).map(e => e.to), leaf).toEqual([]);
    }
    expect(graph.edges.filter(e => e.from === 'functions/_lib/extract.ts' && !e.typeOnly).map(e => e.to)).toEqual(['functions/_lib/errors.ts']);
  });

  it('ошибки областей наследуют DomainError, а маршруты не ловят их сами — это делает app.onError', () => {
    const areaErrors = libFiles.filter(f => f !== 'functions/_lib/errors.ts' && /export class \w+Error extends /.test(readFileSync(f, 'utf-8')));
    for (const f of areaErrors) {
      const text = readFileSync(f, 'utf-8');
      expect(text, f).toMatch(/export class \w+Error extends DomainError\b/);
      expect(graph.edges.some(e => e.from === f && e.to === 'functions/_lib/errors.ts' && !e.typeOnly), `${f} импортирует DomainError`).toBe(true);
    }
    expect(areaErrors.length).toBeGreaterThanOrEqual(8);
    for (const f of [...routeFiles, 'functions/_lib/app.ts']) {
      const text = readFileSync(f, 'utf-8');
      const checks = [...text.matchAll(/instanceof (\w+Error)\b/g)].map(m => m[1]).filter(n => n !== 'Error' && n !== 'DomainError');
      expect(checks, `${f}: нет своих xFail и instanceof XError`).toEqual([]);
      expect(text, `${f}: статусы ошибок живут в модулях областей`).not.toMatch(/_STATUS\b/);
    }
    expect(readFileSync('functions/_lib/app.ts', 'utf-8')).toContain('app.onError(');
  });
});

describe('бюджеты размера', () => {
  it('модуль functions/_lib — не больше 900 строк, экран — не больше 500, клиент API — не больше 500', () => {
    const over = [
      ...libFiles.filter(f => lineCount(f) > 900),
      ...srcFiles.filter(f => f.startsWith('src/screens/') && lineCount(f) > 500),
      ...(lineCount('src/api.ts') > 500 ? ['src/api.ts'] : []),
    ];
    expect(over.map(f => `${f}: ${lineCount(f)}`)).toEqual([]);
  });

  it('app.ts — только склейка (≤ 120 строк, без своих маршрутов); маршруты — в routes/*, модуль области ≤ 350 строк, всего 50–90', () => {
    expect(routeCount('functions/_lib/app.ts')).toBe(0);
    expect(lineCount('functions/_lib/app.ts')).toBeLessThanOrEqual(120);
    expect(routeFiles.length).toBeGreaterThanOrEqual(8);
    const total = routeFiles.reduce((n, f) => n + routeCount(f), 0);
    expect(total).toBeGreaterThanOrEqual(50);
    expect(total).toBeLessThanOrEqual(90);
    expect(routeFiles.filter(f => lineCount(f) > 350).map(f => `${f}: ${lineCount(f)}`)).toEqual([]);
    // каждая область подключена в app.ts; маршруты не импортируют друг друга (общее — только routes/context.ts)
    const app = readFileSync('functions/_lib/app.ts', 'utf-8');
    for (const f of routeFiles.filter(f => !f.endsWith('/context.ts'))) expect(app, f).toContain(`from './routes/${f.split('/').pop()!.replace(/\.ts$/, '')}'`);
    const cross = graph.edges.filter(e => e.from.startsWith('functions/_lib/routes/') && e.to.startsWith('functions/_lib/routes/') && !e.to.endsWith('/context.ts'));
    expect(cross.map(e => `${e.from} → ${e.to}`)).toEqual([]);
  });
});

describe('тесты и версии', () => {
  it('каждый модуль functions/_lib и каждый модуль src вне экранов задействован хотя бы в одном тесте', () => {
    const tests = listSources(['tests']).filter(f => f.endsWith('.test.ts'));
    const imported = new Set<string>();
    for (const t of tests) {
      for (const m of readFileSync(t, 'utf-8').matchAll(/from\s*['"](\.\.?\/[^'"]+)['"]/g)) imported.add(m[1].replace(/^\.\.\//, '').replace(/\.tsx?$/, ''));
    }
    // Модуль, который во время выполнения тянут покрытые тестами модули (app.ts → routes/* → routes/context.ts), тоже считается проверенным.
    const covered = new Set(graph.files.filter(f => imported.has(f.replace(/\.tsx?$/, ''))));
    for (let grown = true; grown;) {
      grown = false;
      for (const e of graph.edges) if (!e.typeOnly && covered.has(e.from) && !covered.has(e.to)) { covered.add(e.to); grown = true; }
    }
    const reachable = (f: string) => covered.has(f);
    const untested = [...libFiles, ...srcFiles.filter(f => !f.startsWith('src/screens/') && f.endsWith('.ts'))].filter(f => !reachable(f));
    // Известные исключения: main.tsx — точка входа; nav.ts, wakeLock.ts, manifest.ts проверяются сценариями Playwright (e2e/), а не Vitest.
    expect(untested.filter(f => !['src/nav.ts', 'src/wakeLock.ts', 'src/manifest.ts'].includes(f))).toEqual([]);
  });

  it('версия одна во всех пяти местах', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')).version as string;
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/);
    const route = readFileSync('functions/api/[[route]].ts', 'utf-8').match(/const VERSION = '([^']+)'/)?.[1];
    const worker = readFileSync('workers/digest/index.ts', 'utf-8').match(/export const VERSION = '([^']+)'/)?.[1];
    const tauri = JSON.parse(readFileSync('desktop/src-tauri/tauri.conf.json', 'utf-8')).version as string;
    const cargo = readFileSync('desktop/src-tauri/Cargo.toml', 'utf-8').match(/^version = "([^"]+)"/m)?.[1];
    expect({ route, worker, tauri, cargo }).toEqual({ route: pkg, worker: pkg, tauri: pkg, cargo: pkg });
    const changelog = readFileSync('CHANGELOG.md', 'utf-8');
    expect(changelog, 'CHANGELOG.md должен содержать раздел текущей версии').toContain(`## ${pkg} `);
  });
});

describe('миграции', () => {
  const files = readdirSync('migrations').filter(f => f.endsWith('.sql')).sort();

  it('нумерация NNNN_имя.sql сплошная, без пропусков и дублей', () => {
    expect(files.map(f => f.slice(0, 4))).toEqual(files.map((_, i) => String(i + 1).padStart(4, '0')));
    expect(files.every(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  it('старые миграции не правятся — суммы совпадают со снимком tests/migrations.sha256; новая миграция = новая строка в снимке', () => {
    const snapshot = Object.fromEntries(readFileSync('tests/migrations.sha256', 'utf-8').trim().split('\n').map(l => { const [hash, name] = l.trim().split(/\s+/); return [name, hash]; }));
    const actual = Object.fromEntries(files.map(f => [f, createHash('sha256').update(readFileSync(`migrations/${f}`)).digest('hex')]));
    const changed = Object.keys(snapshot).filter(f => actual[f] !== snapshot[f]);
    expect(changed, 'изменены или удалены старые миграции').toEqual([]);
    const missing = files.filter(f => !snapshot[f]);
    expect(missing, 'добавьте строку `sha256  имя` в tests/migrations.sha256 (cd migrations && sha256sum NNNN_*.sql)').toEqual([]);
  });

  it('миграции не удаляют и не переписывают существующие данные без подтверждения (DROP, DELETE, UPDATE, ALTER … DROP/RENAME)', () => {
    // Подтверждённые Юрием исключения перечислять здесь по имени файла.
    const confirmed: string[] = [];
    const risky = files.filter(f => !confirmed.includes(f)).filter(f => /\b(drop\s+(table|column|index)|delete\s+from|update\s+\w+\s+set|alter\s+table\s+\w+\s+(drop|rename))\b/i.test(readFileSync(`migrations/${f}`, 'utf-8').replace(/--[^\n]*/g, '')));
    expect(risky).toEqual([]);
  });

  it('seed-миграция первого пользователя есть, а служебный засев стенда в прод не попадает', () => {
    expect(existsSync('migrations/0008_first_user.sql')).toBe(true);
    for (const f of ['functions/_lib/app.ts', ...routeFiles]) expect(readFileSync(f, 'utf-8'), f).not.toContain('__e2e');
  });
});
