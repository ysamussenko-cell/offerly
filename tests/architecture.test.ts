import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { importGraph, cycles, lineCount, listSources } from './helpers/imports';
import { mismatches } from '../scripts/release-version.mjs';

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
    // Единственное исключение — functions/_lib/version.ts читает версию из package.json (встраивается при сборке).
    const crossing = graph.edges.filter(e =>
      (e.from.startsWith('src/') && !e.to.startsWith('src/')) ||
      (e.from.startsWith('functions/') && !e.to.startsWith('functions/') && !(e.from === 'functions/_lib/version.ts' && e.to === 'package.json')));
    expect(crossing.map(e => `${e.from} → ${e.to}`)).toEqual([]);
  });

  it('Worker рассылки переиспользует functions/_lib и не лезет во фронт', () => {
    const bad = graph.edges.filter(e => e.from.startsWith('workers/') && !e.to.startsWith('functions/_lib/') && !e.to.startsWith('workers/'));
    expect(bad.map(e => `${e.from} → ${e.to}`)).toEqual([]);
  });

  it('Hono знают только app.ts и routes/context.ts (area); точка входа Pages импортирует только app.ts и version.ts', () => {
    const hono = [...graph.external.entries()].filter(([, pkgs]) => [...pkgs].some(p => p === 'hono' || p.startsWith('hono/'))).map(([f]) => f);
    expect(hono).toEqual(['functions/_lib/app.ts', 'functions/_lib/routes/context.ts']);
    const entry = graph.edges.filter(e => e.from === 'functions/api/[[route]].ts').map(e => e.to);
    expect(entry).toEqual(['functions/_lib/app.ts', 'functions/_lib/version.ts']);
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

  it('основа API без зависимостей: errors, auth, providers, dates, mail, release, types; extract — только errors, onboarding и fsrs — только dates', () => {
    const leaves = ['errors', 'auth', 'providers', 'dates', 'mail', 'release', 'types'].map(n => `functions/_lib/${n}.ts`);
    for (const leaf of leaves) {
      expect(graph.edges.filter(e => e.from === leaf && !e.typeOnly).map(e => e.to), leaf).toEqual([]);
    }
    expect(graph.edges.filter(e => e.from === 'functions/_lib/extract.ts' && !e.typeOnly).map(e => e.to)).toEqual(['functions/_lib/errors.ts']);
    for (const f of ['onboarding', 'fsrs']) {
      expect(graph.edges.filter(e => e.from === `functions/_lib/${f}.ts` && !e.typeOnly).map(e => e.to), f).toEqual(['functions/_lib/dates.ts']);
    }
  });

  it('календарь сервера в одном месте: сегодня в поясе, сдвиг и разница дат — только в dates.ts (с 0.25.10)', () => {
    // До 0.25.10 addDays жил в четырёх копиях (program, cards, fsrs, digest) — fsrs и cards копировали его, чтобы не замкнуть круг через program.
    const serverFiles = graph.files.filter(f => (f.startsWith('functions/') || f.startsWith('workers/')) && f !== 'functions/_lib/dates.ts');
    const offenders = serverFiles.filter(f => /86_?400_?000|Intl\.DateTimeFormat\('en-CA'|(const|function) (addDays\w*|todayIn|weekdayOf)\b/.test(readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
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

  it('подсказки модели репетиции — в rehearsal-prompts.ts: в rehearsal.ts нет системных подсказок, обратного импорта нет', () => {
    expect(readFileSync('functions/_lib/rehearsal.ts', 'utf-8')).not.toMatch(/role:\s*'system'/);
    expect(readFileSync('functions/_lib/rehearsal-prompts.ts', 'utf-8')).toMatch(/role:\s*'system'/);
    expect(graph.edges.filter(e => e.from === 'functions/_lib/rehearsal-prompts.ts' && e.to === 'functions/_lib/rehearsal.ts')).toEqual([]);
    expect(lineCount('functions/_lib/rehearsal.ts')).toBeLessThan(600);
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

  it('типы тестов проверяются: tsconfig.tests.json покрывает tests/** типами DOM и Workers вместе, Actions гоняет lint:tests перед сборкой', () => {
    const cfg = JSON.parse(readFileSync('tsconfig.tests.json', 'utf-8'));
    expect(cfg.extends).toBe('./tsconfig.app.json');
    expect(cfg.include).toEqual(['tests']);
    expect(cfg.compilerOptions.types).toEqual(expect.arrayContaining(['node', '@cloudflare/workers-types']));
    expect(cfg.compilerOptions.noEmit).toBe(true);
    const scripts = JSON.parse(readFileSync('package.json', 'utf-8')).scripts as Record<string, string>;
    expect(scripts['lint:tests']).toBe('tsc -p tsconfig.tests.json');
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf-8');
    expect(workflow.indexOf('npm run lint:tests')).toBeGreaterThan(workflow.indexOf('run: npm test'));
    expect(workflow.indexOf('npm run lint:tests')).toBeLessThan(workflow.indexOf('run: npm run build'));
    // Байты, которые уходят в Blob/Response/WebCrypto, объявлены типом Bytes (Uint8Array<ArrayBuffer>) — иначе под типами DOM тесты не сойдутся.
    expect(readFileSync('functions/_lib/types.ts', 'utf-8')).toMatch(/export type Bytes = Uint8Array<ArrayBuffer>;/);
    const tsVersion = JSON.parse(readFileSync('package.json', 'utf-8')).devDependencies.typescript as string;
    expect(Number(tsVersion.replace(/^\D*/, '').split('.')[1])).toBeGreaterThanOrEqual(7); // Uint8Array<…> появился в TypeScript 5.7
  });

  it('стенд Playwright работает на настоящем SQL: createApp с хранилищами D1 поверх node:sqlite, memoryStore в e2e не импортируется (с 0.25.12)', () => {
    const server = readFileSync('e2e/server.ts', 'utf-8');
    expect(server).toMatch(/from '\.\.\/tests\/helpers\/sqliteD1'/);
    expect(server).toMatch(/createApp\(E2E_VERSION\)/);
    for (const f of readdirSync('e2e').filter(f => f.endsWith('.ts'))) expect(readFileSync(`e2e/${f}`, 'utf-8'), `e2e/${f}`).not.toMatch(/memoryStore/);
  });

  it('API-тесты целиком на настоящем SQL (sqlStore): memoryStore удалён и не возвращается (перевод 0.25.13–0.25.15)', () => {
    expect(existsSync('tests/helpers/memoryStore.ts')).toBe(false);
    const tests = readdirSync('tests').filter(f => f.endsWith('.test.ts'));
    const users = tests.filter(f => f !== 'architecture.test.ts').filter(f => /helpers\/memoryStore/.test(readFileSync(`tests/${f}`, 'utf-8')));
    expect(users).toEqual([]);
    for (const f of ['auth', 'api', 'onboarding', 'items', 'voice', 'desktop', 'errors', 'release', 'smoke', 'achievements', 'cards', 'dashboard', 'digest', 'program', 'seed', 'settings', 'assessment', 'checkpoint', 'lesson', 'push', 'rehearsal', 'scoring'])
      expect(readFileSync(`tests/${f}.test.ts`, 'utf-8'), f).toMatch(/import \{[^}]*sqlStore[^}]*\} from '\.\/helpers\/sqliteD1'/);
  });

  it('версия задаётся в package.json: API и Worker читают её через functions/_lib/version.ts, остальное правит release:version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')).version as string;
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/);
    // Ни одного литерала версии в коде сервера и Worker — только импорт из version.ts.
    const literal = graph.files.filter(f => (f.startsWith('functions/') || f.startsWith('workers/')) && /\bVERSION\s*=\s*['"]/.test(readFileSync(f, 'utf-8')));
    expect(literal).toEqual([]);
    expect(readFileSync('functions/_lib/version.ts', 'utf-8')).toContain(`from '../../package.json'`);
    const users = graph.edges.filter(e => e.to === 'functions/_lib/version.ts').map(e => e.from).sort();
    expect(users).toEqual(['functions/api/[[route]].ts', 'workers/digest/index.ts']);
    // Файлы других инструментов (npm, Tauri, Cargo) сверяет тот же модуль, что их поднимает.
    expect(mismatches()).toEqual([]);
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
