import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

/** Ребро графа импортов: откуда, куда (относительный путь от корня репозитория) и несёт ли оно код во время выполнения. */
export interface Edge { from: string; to: string; typeOnly: boolean; spec: string }

export interface ImportGraph {
  files: string[];
  edges: Edge[];
  /** Внешние пакеты по файлам (всё, что не начинается с точки). */
  external: Map<string, Set<string>>;
}

const SOURCE = /\.(ts|tsx)$/;

/** Все исходники под указанными папками, без .d.ts, в порядке обхода. */
export function listSources(roots: string[], cwd = process.cwd()): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full); continue; }
      if (SOURCE.test(name) && !name.endsWith('.d.ts')) out.push(relative(cwd, full).split('\\').join('/'));
    }
  };
  for (const r of roots) walk(resolve(cwd, r));
  return out;
}

// Между ключевым словом и `from` — только имена, скобки и переносы: кавычка или точка с запятой обрывают ложное совпадение с кодом.
const IMPORT_RE = /\b(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Все спецификаторы в скобках помечены `type` — импорт не несёт кода. */
function allSpecifiersAreTypes(clause: string): boolean {
  const m = clause.match(/\{([\s\S]*)\}/);
  if (!m) return false;
  const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
  return names.length > 0 && names.every(n => /^type\s+/.test(n)) && !/^\s*\w+\s*,/.test(clause);
}

function resolveSpec(from: string, spec: string, cwd: string): string | null {
  const base = normalize(join(dirname(from), spec));
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try { if (statSync(resolve(cwd, c)).isFile()) return c.split('\\').join('/'); } catch { /* нет такого файла */ }
  }
  return null;
}

/** Статический граф импортов: только текст, без компилятора — достаточно для правил границ и циклов. */
export function importGraph(roots: string[], cwd = process.cwd()): ImportGraph {
  const files = listSources(roots, cwd);
  const edges: Edge[] = [];
  const external = new Map<string, Set<string>>();
  for (const file of files) {
    const text = readFileSync(resolve(cwd, file), 'utf-8');
    const add = (spec: string, typeOnly: boolean) => {
      if (!spec.startsWith('.')) { if (!external.has(file)) external.set(file, new Set()); external.get(file)!.add(spec); return; }
      const to = resolveSpec(file, spec, cwd);
      if (to) edges.push({ from: file, to, typeOnly, spec });
    };
    for (const m of text.matchAll(IMPORT_RE)) {
      const [, , typeKeyword, clause, spec] = m;
      add(spec, Boolean(typeKeyword) || allSpecifiersAreTypes(clause));
    }
    for (const m of text.matchAll(DYNAMIC_RE)) add(m[1], false);
  }
  return { files, edges, external };
}

/** Элементарные циклы в графе (по рёбрам, прошедшим фильтр), каждый — список файлов, замкнутый первым элементом. */
export function cycles(graph: ImportGraph, keep: (e: Edge) => boolean = e => !e.typeOnly): string[][] {
  const next = new Map<string, string[]>();
  for (const e of graph.edges) if (keep(e)) { if (!next.has(e.from)) next.set(e.from, []); next.get(e.from)!.push(e.to); }
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const found: string[][] = [];
  const seen = new Set<string>();
  const visit = (u: string) => {
    color.set(u, 1); stack.push(u);
    for (const v of next.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 0) visit(v);
      else if (c === 1) {
        const cyc = [...stack.slice(stack.indexOf(v)), v];
        const key = [...cyc.slice(0, -1)].sort().join('|');
        if (!seen.has(key)) { seen.add(key); found.push(cyc); }
      }
    }
    stack.pop(); color.set(u, 2);
  };
  for (const f of graph.files) if ((color.get(f) ?? 0) === 0) visit(f);
  return found;
}

/** Число строк в файле (для бюджетов размера). */
export function lineCount(file: string, cwd = process.cwd()): number {
  return readFileSync(resolve(cwd, file), 'utf-8').split('\n').length;
}
