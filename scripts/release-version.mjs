#!/usr/bin/env node
/**
 * Поднять версию Offerly одной командой (из обзора 31.10.2026: «версия живёт в пяти файлах»).
 *
 *   npm run release:version -- patch | minor | major | X.Y.Z
 *   npm run release:version -- --check          — только сверить, код выхода 1 при расхождении
 *
 * Источник — package.json. API и Worker читают его сами (functions/_lib/version.ts), поэтому правятся только файлы,
 * которые читают другие инструменты: package-lock.json (npm), tauri.conf.json, Cargo.toml и Cargo.lock (Tauri и Cargo).
 * Правило CLAUDE.md: исправление — patch, новая возможность — minor. Раздел CHANGELOG.md пишется руками.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Файлы с версией и как её читать/писать. Пути — от корня репозитория. */
export const FILES = {
  'package.json': {
    read: s => JSON.parse(s).version,
    write: (s, v) => s.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${v}$2`),
  },
  'package-lock.json': {
    // Две записи: корень файла и packages[""] — обе про сам проект.
    read: s => { const j = JSON.parse(s); return j.version === j.packages?.['']?.version ? j.version : `${j.version}/${j.packages?.['']?.version}`; },
    write: (s, v) => s.replace(/^(\s{2}"version":\s*")[^"]+(")/m, `$1${v}$2`).replace(/("packages":\s*\{\s*"":\s*\{\s*"name":\s*"offerly",\s*"version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  'desktop/src-tauri/tauri.conf.json': {
    read: s => JSON.parse(s).version,
    write: (s, v) => s.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${v}$2`),
  },
  'desktop/src-tauri/Cargo.toml': {
    read: s => s.match(/^\[package\][^[]*?^version = "([^"]+)"/m)?.[1],
    write: (s, v) => s.replace(/^(\[package\][^[]*?^version = ")[^"]+(")/m, `$1${v}$2`),
  },
  'desktop/src-tauri/Cargo.lock': {
    read: s => s.match(/^name = "offerly"\nversion = "([^"]+)"/m)?.[1],
    write: (s, v) => s.replace(/^(name = "offerly"\nversion = ")[^"]+(")/m, `$1${v}$2`),
  },
};

/** Следующая версия: ключевое слово (patch/minor/major) от текущей или явная X.Y.Z, строго больше текущей. */
export function nextVersion(current, arg) {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`текущая версия «${current}» не в формате X.Y.Z`);
  const [maj, min, pat] = m.slice(1).map(Number);
  const next = arg === 'patch' ? `${maj}.${min}.${pat + 1}` : arg === 'minor' ? `${maj}.${min + 1}.0` : arg === 'major' ? `${maj + 1}.0.0` : arg;
  const n = SEMVER.exec(next ?? '');
  if (!n) throw new Error(`«${arg}» — не patch, minor, major и не X.Y.Z`);
  const cmp = n.slice(1).map(Number).map((x, i) => x - [maj, min, pat][i]).find(d => d !== 0) ?? 0;
  if (cmp <= 0) throw new Error(`новая версия ${next} должна быть больше текущей ${current}`);
  return next;
}

/** Версия в каждом файле; undefined — файл без узнаваемой записи (значит, формат поменялся и скрипт надо поправить). */
export function readVersions(root = process.cwd()) {
  return Object.fromEntries(Object.entries(FILES).map(([f, h]) => [f, h.read(readFileSync(join(root, f), 'utf-8'))]));
}

/** Расхождения с package.json: список «файл: версия». Пусто — всё сходится. */
export function mismatches(root = process.cwd()) {
  const all = readVersions(root);
  const pkg = all['package.json'];
  return Object.entries(all).filter(([, v]) => v !== pkg).map(([f, v]) => `${f}: ${v ?? 'не найдена'} (package.json ${pkg})`);
}

/** Записать версию во все файлы; бросает, если после записи что-то не сошлось (запись не узнана форматом). */
export function setVersion(root, arg) {
  const current = readVersions(root)['package.json'];
  const next = nextVersion(current, arg);
  for (const [f, h] of Object.entries(FILES)) {
    const path = join(root, f);
    writeFileSync(path, h.write(readFileSync(path, 'utf-8'), next));
  }
  const left = mismatches(root);
  if (left.length || readVersions(root)['package.json'] !== next) throw new Error(`версия записана не везде: ${left.join('; ')}`);
  return { from: current, to: next };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = process.argv[2];
  try {
    if (!arg || arg === '--check') {
      const left = mismatches();
      if (left.length) { console.error(`Версии расходятся:\n  ${left.join('\n  ')}`); process.exit(1); }
      console.log(`Версия ${readVersions()['package.json']} совпадает во всех файлах.`);
    } else {
      const { from, to } = setVersion(process.cwd(), arg);
      console.log(`${from} → ${to}: ${Object.keys(FILES).join(', ')}. Не забыть раздел «## ${to} …» в CHANGELOG.md.`);
    }
  } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
