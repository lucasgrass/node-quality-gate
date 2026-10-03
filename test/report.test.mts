import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../template/scripts/quality-gate/config.mts';
import { compare } from '../template/scripts/quality-gate/ratchet.mts';
import { MARKER, annotations, renderMarkdown, truncate } from '../template/scripts/quality-gate/report.mts';
import type { Report } from '../template/scripts/quality-gate/types.mts';
import { BASELINE, CURRENT } from './ratchet.test.mts';

function report(overrides: Partial<Report> = {}): Report {
  const verdict = compare(BASELINE, CURRENT, { status: 'skipped', reason: 'test' }, DEFAULT_CONFIG);
  return {
    ...verdict,
    tool: 'node-quality-gate 0.1.0',
    status: verdict.regressions.length === 0 ? 'pass' : 'fail',
    generatedAt: '2026-10-03T12:00:00.000Z',
    baselineSource: 'quality-gate.baseline.json (commit abc1234, 2026-10-01)',
    baseline: BASELINE,
    current: CURRENT,
    patchCoverage: { status: 'measured', coverable: 45, covered: 40, percentage: 88.89 },
    duplicatedBlocks: [],
    ...overrides,
  };
}

test('renderMarkdown shows the three tables with deltas, the lists and the marker', () => {
  const markdown = renderMarkdown(report(), DEFAULT_CONFIG);
  const expectedLines = [
    '## Quality gate ❌ 5 regressions',
    'Baseline: quality-gate.baseline.json (commit abc1234, 2026-10-01)',
    '| Lines | 7.16% | 10.42% | +3.26% |',
    '| Functions | 7.11% | 9.81% | +2.7% |',
    '| Branches | 5.48% | 7.97% | +2.49% |',
    'Patch coverage: **88.89%** of 45 changed lines (minimum 80%, warning only).',
    '| Percentage | 2.2% | 2.04% | -0.16% |',
    '| Fragments | 95 | 95 | — |',
    '| Quality rule violations | 483 | 467 | -16 |',
    '| Oversized files | 19 | 17 | -2 |',
    '### Regressions',
    '- max-depth violations increased in electron/local-llm/LocalLLMService.js (2 -> 9)',
    '### Improvements',
    '- Duplication fell from 2.2% to 2.04%',
    'Run `node scripts/quality-gate/cli.mts baseline` to lock them in.',
    '<sub>node-quality-gate 0.1.0</sub>',
    MARKER,
  ];
  const lines = markdown.split('\n');
  for (const expected of expectedLines) assert.ok(lines.includes(expected), `missing line: ${expected}`);
  assert.ok(!markdown.includes('### Warnings'));
});

test('renderMarkdown on a first run shows dashes and no baseline', () => {
  const markdown = renderMarkdown(
    report({ baseline: null, baselineSource: 'none (first run)', regressions: [], improvements: [], status: 'pass', patchCoverage: { status: 'skipped', reason: 'only 3 changed lines to cover (minimum 20)' } }),
    DEFAULT_CONFIG,
  );
  assert.ok(markdown.startsWith('## Quality gate ✅ passed\n\nBaseline: none (first run)\n'));
  assert.ok(markdown.includes('| Lines | — | 10.42% | — |'));
  assert.ok(markdown.includes('Patch coverage: skipped (only 3 changed lines to cover (minimum 20)).'));
});

test('annotations stay within 10 per level and escape newlines', () => {
  const regressions = Array.from({ length: 12 }, (_, i) => `regression ${i + 1}`);
  const lines = annotations(report({ regressions, warnings: ['careful\nnow'], improvements: ['better'] }));
  const errors = lines.filter((line) => line.startsWith('::error'));
  assert.equal(errors.length, 10);
  assert.equal(errors[0], '::error title=Quality gate::regression 1');
  assert.equal(errors[9], '::error title=Quality gate::regression 10 (and 2 more, see the job summary)');
  assert.deepEqual(lines.filter((line) => line.startsWith('::warning')), ['::warning title=Quality gate::careful%0Anow']);
  assert.deepEqual(lines.filter((line) => line.startsWith('::notice')), [
    '::notice title=Quality gate::1 metric improved; run the baseline command to lock them in.',
  ]);
});

test('truncate keeps the text under the limit and ends with the marker', () => {
  const text = `${'é'.repeat(1000)}\n${MARKER}\n`;
  assert.equal(truncate(text, 10_000), text);
  const cut = truncate(text, 500);
  assert.ok(Buffer.byteLength(cut) <= 500);
  assert.ok(cut.endsWith(`${MARKER}\n`));
  assert.ok(cut.includes('Report truncated'));
  assert.ok(!cut.includes('�'));
});
