import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../template/scripts/quality-gate/config.mts';
import {
  countLines,
  countViolations,
  eslintArgs,
  excluder,
  globToRegExp,
  oversizedFiles,
  parseEslintJson,
} from '../template/scripts/quality-gate/lint.mts';

test('globToRegExp supports **, * and ? on POSIX paths', () => {
  const cases: Array<[string, string, boolean]> = [
    ['**/*.test.*', 'a.test.ts', true],
    ['**/*.test.*', 'src/x/a.test.tsx', true],
    ['**/*.test.*', 'src/test.ts', false],
    ['**/__snapshots__/**', 'src/__snapshots__/a.snap', true],
    ['dist/**', 'dist/a.js', true],
    ['dist/**', 'src/dist/a.js', false],
    ['*.js', 'a.js', true],
    ['*.js', 'src/a.js', false],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['src/(x).ts', 'src/(x).ts', true],
  ];
  for (const [glob, path, expected] of cases) {
    assert.equal(globToRegExp(glob).test(path), expected, `${glob} vs ${path}`);
  }
  const excluded = excluder(DEFAULT_CONFIG.exclude);
  assert.equal(excluded('src/a.test.ts'), true);
  assert.equal(excluded('src/a.ts'), false);
});

test('parseEslintJson lists every linted file and keeps only messages with a rule', () => {
  const json = JSON.stringify([
    {
      filePath: '/repo/src/a.ts',
      messages: [
        { ruleId: 'max-depth', severity: 1 },
        { ruleId: null, severity: 2, message: 'Parsing error' },
        { ruleId: 'complexity', severity: 2 },
      ],
      suppressedMessages: [{ ruleId: 'max-depth', severity: 1, suppressions: [{ kind: 'file' }] }],
    },
    { filePath: '/repo/src/clean.ts', messages: [] },
  ]);
  assert.deepEqual(parseEslintJson(json, '/repo'), {
    files: ['src/a.ts', 'src/clean.ts'],
    messages: [
      { file: 'src/a.ts', rule: 'max-depth', severity: 1 },
      { file: 'src/a.ts', rule: 'complexity', severity: 2 },
    ],
  });
});

test('countViolations counts quality rules per file and rule, sorted, skipping excluded files', () => {
  const messages = [
    { file: 'src/b.ts', rule: 'max-depth', severity: 1 as const },
    { file: 'src/a.ts', rule: 'max-params', severity: 1 as const },
    { file: 'src/a.ts', rule: 'complexity', severity: 1 as const },
    { file: 'src/a.ts', rule: 'complexity', severity: 1 as const },
    { file: 'src/a.ts', rule: 'no-unused-vars', severity: 2 as const },
    { file: 'src/a.test.ts', rule: 'complexity', severity: 1 as const },
  ];
  const result = countViolations(messages, ['complexity', 'max-depth', 'max-params'], excluder(['**/*.test.*']));
  assert.equal(result.total, 4);
  assert.deepEqual(Object.keys(result.perFile), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(Object.keys(result.perFile['src/a.ts'] ?? {}), ['complexity', 'max-params']);
  assert.deepEqual(result.perFile['src/a.ts'], { complexity: 2, 'max-params': 1 });
});

test('eslintArgs injects every quality rule as a warning', () => {
  const args = eslintArgs(
    { command: 'npx eslint', args: ['src', 'test'], qualityRules: { complexity: 20, 'no-eval': true } },
    'reports/eslint.json',
  );
  assert.deepEqual(args, [
    'src',
    'test',
    '--format',
    'json',
    '--output-file',
    'reports/eslint.json',
    '--no-warn-ignored',
    '--rule',
    'complexity: [1, 20]',
    '--rule',
    'no-eval: 1',
  ]);
});

test('countLines and oversizedFiles', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  const sources = new Map([
    ['src/small.ts', 'a\nb\n'],
    ['src/long.ts', 'x\n'.repeat(5)],
    ['src/heavy.ts', `${'é'.repeat(10)}\n`],
  ]);
  assert.deepEqual(oversizedFiles(sources, { maxLines: 4, maxBytes: 15 }), {
    'src/heavy.ts': { lines: 1, bytes: 21 },
    'src/long.ts': { lines: 5, bytes: 10 },
  });
});
