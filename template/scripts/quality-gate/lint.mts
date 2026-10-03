/** ESLint run (quality rules injected as warnings), violation counts, file sizes and exclusion globs. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config } from './config.mts';
import type { FileSize, RuleCounts } from './types.mts';
import { isRecord, sortRecord, toRepoPath } from './util.mts';

export type LintMessage = { file: string; rule: string; severity: 1 | 2 };
export type LintResults = { files: string[]; messages: LintMessage[] };
export type Violations = { total: number; perFile: Record<string, RuleCounts> };

/** Arguments appended to the ESLint command: JSON output plus every quality rule at "warn". */
export function eslintArgs(options: Config['eslint'], outputFile: string): string[] {
  const rules = Object.entries(options.qualityRules).flatMap(([rule, option]) => [
    '--rule',
    option === true ? `${rule}: 1` : `${rule}: [1, ${option}]`,
  ]);
  return [...options.args, '--format', 'json', '--output-file', outputFile, '--no-warn-ignored', ...rules];
}

/** Runs ESLint with the project's own config and reads the JSON it writes. Exit code 1 (lint errors) is fine. */
export function runEslint(options: Config['eslint'], outputFile: string, cwd: string): LintResults {
  const [command, ...prefix] = options.command.trim().split(/\s+/);
  if (!command) throw new Error('eslint.command is empty');
  mkdirSync(dirname(outputFile), { recursive: true });
  const result = spawnSync(command, [...prefix, ...eslintArgs(options, outputFile)], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`could not run "${options.command}": ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`ESLint exited with code ${result.status}:\n${result.stderr || result.stdout}`);
  }
  return parseEslintJson(readFileSync(outputFile, 'utf8'), cwd);
}

/** `eslint --format json`: one entry per linted file; suppressed messages are not counted. */
export function parseEslintJson(text: string, cwd: string): LintResults {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('ESLint JSON output is not an array');
  const files: string[] = [];
  const messages: LintMessage[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.filePath !== 'string') continue;
    const file = toRepoPath(entry.filePath, cwd);
    files.push(file);
    const entryMessages: unknown[] = Array.isArray(entry.messages) ? entry.messages : [];
    for (const message of entryMessages) {
      if (!isRecord(message) || typeof message.ruleId !== 'string') continue;
      messages.push({ file, rule: message.ruleId, severity: message.severity === 2 ? 2 : 1 });
    }
  }
  return { files, messages };
}

export function countViolations(
  messages: LintMessage[],
  rules: string[],
  excluded: (file: string) => boolean,
): Violations {
  const perFile: Record<string, RuleCounts> = {};
  let total = 0;
  for (const { file, rule } of messages) {
    if (!rules.includes(rule) || excluded(file)) continue;
    const counts = (perFile[file] ??= {});
    counts[rule] = (counts[rule] ?? 0) + 1;
    total++;
  }
  const sorted: Record<string, RuleCounts> = {};
  for (const [file, counts] of Object.entries(perFile)) sorted[file] = sortRecord(counts);
  return { total, perFile: sortRecord(sorted) };
}

/** Minimal glob support: `**`, `*`, `?`; patterns match repository-relative POSIX paths. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === '*' && glob.charAt(i + 1) === '*') {
      i++;
      if (glob.charAt(i + 1) === '/') {
        i++;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function excluder(patterns: string[]): (file: string) => boolean {
  const expressions = patterns.map(globToRegExp);
  return (file) => expressions.some((expression) => expression.test(file));
}

export function readSources(files: string[], cwd: string): Map<string, string> {
  return new Map(files.map((file) => [file, readFileSync(resolve(cwd, file), 'utf8')]));
}

export function countLines(content: string): number {
  if (content === '') return 0;
  const count = content.split('\n').length;
  return content.endsWith('\n') ? count - 1 : count;
}

/** Files over either limit, with their current size. */
export function oversizedFiles(sources: Map<string, string>, limits: Config['size']): Record<string, FileSize> {
  const oversized: Record<string, FileSize> = {};
  for (const [file, content] of sources) {
    const size = { lines: countLines(content), bytes: Buffer.byteLength(content) };
    if (size.lines > limits.maxLines || size.bytes > limits.maxBytes) oversized[file] = size;
  }
  return sortRecord(oversized);
}
