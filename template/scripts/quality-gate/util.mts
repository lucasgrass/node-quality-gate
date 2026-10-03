/** Small helpers shared by the quality gate modules. */
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';

/** Repository-relative POSIX path: the form used in reports and in the baseline. */
export function toRepoPath(path: string, cwd: string): string {
  const relativePath = isAbsolute(path) ? relative(cwd, path) : path;
  return relativePath.split('\\').join('/').replace(/^\.\//, '');
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** "7.16%", "2.2%": at most two decimals, trailing zeros dropped. */
export function pct(value: number): string {
  return `${round2(value)}%`;
}

export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const entries = Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runs git and returns stdout, or null when the command fails (unknown ref, not a repository...). */
export function git(args: string[], cwd: string): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}
