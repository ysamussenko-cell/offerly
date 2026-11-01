import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { FILES, nextVersion, readVersions, mismatches, setVersion } from '../scripts/release-version.mjs';

/** scripts/release-version.mjs правится на копии настоящих файлов репозитория — так ловится смена их формата. */
let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'offerly-version-'));
  for (const f of Object.keys(FILES)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    copyFileSync(f, join(root, f));
  }
});
const current = () => JSON.parse(readFileSync('package.json', 'utf-8')).version as string;

describe('release:version — следующая версия', () => {
  it('patch, minor, major от текущей', () => {
    expect(nextVersion('0.25.10', 'patch')).toBe('0.25.11');
    expect(nextVersion('0.25.10', 'minor')).toBe('0.26.0');
    expect(nextVersion('0.25.10', 'major')).toBe('1.0.0');
  });

  it('явная X.Y.Z — только больше текущей; мусор отклоняется', () => {
    expect(nextVersion('0.25.10', '0.25.12')).toBe('0.25.12');
    expect(nextVersion('0.9.9', '0.10.0')).toBe('0.10.0'); // сравнение числами, не строками
    expect(() => nextVersion('0.25.10', '0.25.10')).toThrow(/больше текущей/);
    expect(() => nextVersion('0.25.10', '0.25.9')).toThrow(/больше текущей/);
    expect(() => nextVersion('0.25.10', 'v0.26.0')).toThrow(/не patch/);
    expect(() => nextVersion('0.25.10', 'fix')).toThrow(/не patch/);
    expect(() => nextVersion('beta', 'patch')).toThrow(/X\.Y\.Z/);
  });
});

describe('release:version — файлы', () => {
  it('в репозитории версия везде одна и узнаётся в каждом файле', () => {
    const all = readVersions();
    expect(Object.keys(all).sort()).toEqual(['desktop/src-tauri/Cargo.lock', 'desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/tauri.conf.json', 'package-lock.json', 'package.json']);
    expect(new Set(Object.values(all))).toEqual(new Set([current()]));
  });

  it('поднимает версию во всех пяти файлах и не трогает чужие версии', () => {
    const before = Object.fromEntries(Object.keys(FILES).map(f => [f, readFileSync(join(root, f), 'utf-8')]));
    expect(setVersion(root, 'minor')).toEqual({ from: current(), to: nextVersion(current(), 'minor') });
    const to = nextVersion(current(), 'minor');
    expect(new Set(Object.values(readVersions(root)))).toEqual(new Set([to]));
    expect(mismatches(root)).toEqual([]);
    // Меняется ровно запись проекта: в Cargo.lock одна строка, в package-lock две, в остальных по одной; зависимости как были.
    for (const f of Object.keys(FILES)) {
      const a = before[f].split('\n'), b = readFileSync(join(root, f), 'utf-8').split('\n');
      expect(b.length, f).toBe(a.length);
      const changed = a.filter((line, i) => line !== b[i]).length;
      expect(changed, f).toBe(f === 'package-lock.json' ? 2 : 1);
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toEqual(JSON.parse(before['package.json']).dependencies);
  });

  it('расхождение видно по файлу', () => {
    const p = join(root, 'desktop/src-tauri/Cargo.toml');
    writeFileSync(p, readFileSync(p, 'utf-8').replace(/^version = "[^"]+"/m, 'version = "0.0.1"'));
    expect(mismatches(root)).toEqual([`desktop/src-tauri/Cargo.toml: 0.0.1 (package.json ${current()})`]);
  });

  it('неузнанный формат — ошибка, а не тихая запись мимо', () => {
    const p = join(root, 'desktop/src-tauri/Cargo.lock');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('name = "offerly"', 'name = "offerly-app"'));
    expect(() => setVersion(root, 'patch')).toThrow(/записана не везде.*Cargo\.lock: не найдена/);
  });
});
