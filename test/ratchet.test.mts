import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, type Config } from '../template/scripts/quality-gate/config.mts';
import { compare, parseBaseline, toBaseline } from '../template/scripts/quality-gate/ratchet.mts';
import type { Metrics, PatchCoverage } from '../template/scripts/quality-gate/types.mts';

const LLM = 'electron/local-llm/LocalLLMService.js';
const API_TAB = 'src/components/settings/ApiTab.js';
const SKIPPED: PatchCoverage = { status: 'skipped', reason: 'test' };

/** The numbers from the original pipeline's PR comment. */
export const BASELINE: Metrics = {
  coverage: { lines: 7.16, functions: 7.11, branches: 5.48 },
  duplication: { percentage: 2.2, fragments: 95 },
  violations: { qualityRules: 483, oversizedFiles: 19 },
  oversized: { [LLM]: { lines: 1008, bytes: 36385 }, [API_TAB]: { lines: 3064, bytes: 154245 } },
  ruleViolations: { [LLM]: { 'max-depth': 2 } },
};

export const CURRENT: Metrics = {
  coverage: { lines: 10.42, functions: 9.81, branches: 7.97 },
  duplication: { percentage: 2.04, fragments: 95 },
  violations: { qualityRules: 467, oversizedFiles: 17 },
  oversized: { [LLM]: { lines: 1140, bytes: 42083 }, [API_TAB]: { lines: 3144, bytes: 158588 } },
  ruleViolations: { [LLM]: { 'max-depth': 9 } },
};

test('compare reproduces the regressions and improvements of the reference report', () => {
  const verdict = compare(BASELINE, CURRENT, SKIPPED, DEFAULT_CONFIG);
  assert.deepEqual(verdict.regressions, [
    `${LLM} grew from 1008 to 1140 lines while already over the limit`,
    `${LLM} grew from 36385 to 42083 bytes while already over the limit`,
    `${API_TAB} grew from 3064 to 3144 lines while already over the limit`,
    `${API_TAB} grew from 154245 to 158588 bytes while already over the limit`,
    `max-depth violations increased in ${LLM} (2 -> 9)`,
  ]);
  assert.deepEqual(verdict.improvements, [
    'Lines coverage improved from 7.16% to 10.42%',
    'Functions coverage improved from 7.11% to 9.81%',
    'Branches coverage improved from 5.48% to 7.97%',
    'Duplication fell from 2.2% to 2.04%',
    'Quality rule violations decreased from 483 to 467',
    'Oversized files decreased from 19 to 17',
  ]);
  assert.deepEqual(verdict.warnings, []);
});

test('compare passes without a baseline and within the tolerance', () => {
  assert.deepEqual(compare(null, CURRENT, SKIPPED, DEFAULT_CONFIG), { regressions: [], warnings: [], improvements: [] });
  const slightlyWorse: Metrics = {
    ...BASELINE,
    coverage: { lines: 7.1, functions: 7.11, branches: 5.48 },
    duplication: { percentage: 2.25, fragments: 95 },
  };
  assert.deepEqual(compare(BASELINE, slightlyWorse, SKIPPED, DEFAULT_CONFIG).regressions, []);
});

test('compare flags drops, new oversized files and totals, but not violations in new files', () => {
  const worse: Metrics = {
    coverage: { lines: 7.0, functions: 7.11, branches: 5.48 },
    duplication: { percentage: 2.5, fragments: 96 },
    violations: { qualityRules: 484, oversizedFiles: 20 },
    oversized: { ...BASELINE.oversized, 'src/new.js': { lines: 500, bytes: 1000 } },
    ruleViolations: { [LLM]: { 'max-depth': 2 }, 'src/new.js': { complexity: 3 } },
  };
  assert.deepEqual(compare(BASELINE, worse, SKIPPED, DEFAULT_CONFIG).regressions, [
    'Lines coverage dropped from 7.16% to 7%',
    'Duplication rose from 2.2% to 2.5%',
    'Duplicated fragments increased from 95 to 96',
    'Quality rule violations increased from 483 to 484',
    'Oversized files increased from 19 to 20',
    'src/new.js crossed the limit with 500 lines and 1000 bytes',
  ]);
});

test('patch coverage below the threshold warns by default and blocks when configured', () => {
  const low: PatchCoverage = { status: 'measured', coverable: 50, covered: 36, percentage: 72 };
  const message = 'Patch coverage 72% is below the minimum of 80% (36 of 50 changed lines covered)';
  assert.deepEqual(compare(null, CURRENT, low, DEFAULT_CONFIG).warnings, [message]);
  const blocking: Config = { ...DEFAULT_CONFIG, patchCoverage: { ...DEFAULT_CONFIG.patchCoverage, mode: 'block' } };
  assert.deepEqual(compare(null, CURRENT, low, blocking).regressions, [message]);
  const disabled: Config = { ...DEFAULT_CONFIG, patchCoverage: { ...DEFAULT_CONFIG.patchCoverage, enabled: false } };
  assert.deepEqual(compare(null, CURRENT, low, disabled).warnings, []);
  const fine: PatchCoverage = { status: 'measured', coverable: 50, covered: 40, percentage: 80 };
  assert.deepEqual(compare(null, CURRENT, fine, DEFAULT_CONFIG).warnings, []);
});

test('toBaseline and parseBaseline round-trip, and the schema version is enforced', () => {
  const baseline = toBaseline(CURRENT, 'abc1234', 'node-quality-gate 0.1.0', new Date('2026-10-03T12:00:00Z'));
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.generatedAt, '2026-10-03T12:00:00.000Z');
  assert.deepEqual(parseBaseline(JSON.parse(JSON.stringify(baseline)), 'baseline'), baseline);
  assert.throws(() => parseBaseline({ ...baseline, schemaVersion: 2 }, 'baseline'), /schemaVersion 2/);
  assert.throws(() => parseBaseline({ ...baseline, coverage: { lines: 'x' } }, 'baseline'), /coverage.lines is not a number/);
});
