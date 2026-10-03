import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addUntracked,
  coverageTotals,
  measurePatchCoverage,
  parseAddedLines,
  parseLcov,
} from '../template/scripts/quality-gate/coverage.mts';

const CWD = '/repo';
const LCOV = `TN:
SF:/repo/src/a.ts
FN:1,foo
FNDA:1,foo
FNF:2
FNH:1
DA:1,1
DA:2,0
DA:3,4
BRF:4
BRH:1
LF:3
LH:2
end_of_record
SF:src/b.ts
DA:10,0
DA:11,2
end_of_record
`;

test('parseLcov keys files by repository path and reads the summary records', () => {
  const files = parseLcov(LCOV, CWD);
  assert.deepEqual([...files.keys()], ['src/a.ts', 'src/b.ts']);
  const a = files.get('src/a.ts');
  assert.ok(a);
  assert.deepEqual(a.found, { lines: 3, functions: 2, branches: 4 });
  assert.deepEqual(a.hit, { lines: 2, functions: 1, branches: 1 });
  assert.equal(a.lineHits.get(3), 4);
});

test('parseLcov derives LF/LH from DA records when the summary is missing', () => {
  const b = parseLcov(LCOV, CWD).get('src/b.ts');
  assert.ok(b);
  assert.equal(b.found.lines, 2);
  assert.equal(b.hit.lines, 1);
});

test('coverageTotals aggregates files and treats nothing-to-cover as 100%', () => {
  const totals = coverageTotals(parseLcov(LCOV, CWD).values());
  assert.deepEqual(totals, { lines: 60, functions: 50, branches: 25 });
  assert.deepEqual(coverageTotals([]), { lines: 100, functions: 100, branches: 100 });
});

test('parseAddedLines reads added ranges from the hunk headers of a -U0 diff', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -0,0 +1,3 @@',
    '+x',
    '+y',
    '+z',
    '@@ -10 +13 @@',
    '-old',
    '+new',
    '@@ -20,2 +23,0 @@',
    '-gone',
    '-gone',
    'diff --git a/old.ts b/old.ts',
    '--- a/old.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-a',
    '-b',
    '',
  ].join('\n');
  assert.deepEqual([...parseAddedLines(diff)], [['src/a.ts', [1, 2, 3, 13]]]);
});

test('measurePatchCoverage counts only instrumented added lines and skips small changes', () => {
  const coverage = parseLcov(LCOV, CWD);
  const added = new Map([
    ['src/a.ts', [1, 2, 3, 4]],
    ['src/b.ts', [10, 11]],
    ['docs/readme.md', [1]],
  ]);
  assert.deepEqual(measurePatchCoverage(added, coverage, 1), {
    status: 'measured',
    coverable: 5,
    covered: 3,
    percentage: 60,
  });
  const skipped = measurePatchCoverage(added, coverage, 20);
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.status === 'skipped' ? skipped.reason : '', /only 5 changed lines/);
});

test('addUntracked counts every instrumented line of an untracked file as added', () => {
  const coverage = parseLcov(LCOV, CWD);
  const added = addUntracked(new Map([['src/a.ts', [1]]]), ['src/a.ts', 'src/b.ts', 'README.md'], coverage);
  assert.deepEqual([...added], [
    ['src/a.ts', [1]],
    ['src/b.ts', [10, 11]],
  ]);
});
