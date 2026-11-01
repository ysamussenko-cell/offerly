export const FILES: Record<string, { read(s: string): string | undefined; write(s: string, v: string): string }>;
export function nextVersion(current: string, arg: string): string;
export function readVersions(root?: string): Record<string, string | undefined>;
export function mismatches(root?: string): string[];
export function setVersion(root: string, arg: string): { from: string; to: string };
