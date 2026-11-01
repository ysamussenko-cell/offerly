/** Типы для scripts/smoke.mjs — чтобы тесты проверялись tsc (tsconfig.tests.json). */
export type Level = 'notice' | 'warning' | 'error';
export interface Annotation { group: string; level: Level; title: string; message: string }
export interface SmokeContext { base: string; fetch: typeof fetch; worker: string; retries: number; retryDelayMs: number; sleep: (ms: number) => Promise<void>; deep: Record<string, unknown> | null }
export type Check = (ctx: SmokeContext) => Promise<Array<Omit<Annotation, 'group'>>>;
export interface SmokeOptions {
  groups?: string[];
  fetch?: typeof fetch;
  worker?: string;
  retries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}
export const GROUPS: Record<'health' | 'smoke' | 'deep' | 'install', Check[]>;
export function escapeData(s: string): string;
export function annotation(level: Level, title: string, message: string): string;
export function runSmoke(base: string, opts?: SmokeOptions): Promise<{ ok: boolean; annotations: Annotation[] }>;
export function parseArgs(argv: string[]): { base: string; groups: string[] | undefined; worker: string; waitSeconds: number };
