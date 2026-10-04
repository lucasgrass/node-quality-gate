import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, DEFAULT_CONFIG, loadConfig, resolveConfig } from '../template/scripts/quality-gate/config.mts';

test('resolveConfig returns the defaults for an empty object and ignores $schema', () => {
  assert.deepEqual(resolveConfig({ $schema: 'x' }), DEFAULT_CONFIG);
});

test('resolveConfig merges partial sections over the defaults', () => {
  const config = resolveConfig({
    coverage: { tolerance: 0.5 },
    patchCoverage: { mode: 'block' },
    eslint: { qualityRules: { complexity: 10 } },
    exclude: ['generated/**'],
  });
  assert.equal(config.coverage.tolerance, 0.5);
  assert.equal(config.coverage.lcov, 'coverage/lcov.info');
  assert.equal(config.patchCoverage.mode, 'block');
  assert.equal(config.patchCoverage.threshold, 80);
  assert.deepEqual(config.eslint.qualityRules, { complexity: 10 });
  assert.deepEqual(config.exclude, ['generated/**']);
});

test('resolveConfig rejects unknown keys and wrong types', () => {
  const bad: Array<[unknown, RegExp]> = [
    [[], /must be a JSON object/],
    [{ covrage: {} }, /unknown key "covrage"/],
    [{ coverage: { lcovPath: 'x' } }, /unknown key "coverage.lcovPath"/],
    [{ coverage: { tolerance: '0.1' } }, /"coverage.tolerance" must be a number/],
    [{ coverage: { tolerance: Infinity } }, /finite number/],
    [{ patchCoverage: { mode: 'maybe' } }, /must be "warn" or "block"/],
    [{ eslint: { args: 'src' } }, /"eslint.args" must be an array of strings/],
    [{ eslint: { qualityRules: { complexity: 'high' } } }, /must be a number or true/],
    [{ exclude: [1] }, /array of strings/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => resolveConfig(input), (error: unknown) => error instanceof ConfigError && message.test(error.message), JSON.stringify(input));
  }
});

test('loadConfig falls back to defaults when the file is missing and honours QG_ESLINT_COMMAND', () => {
  const previous = process.env.QG_ESLINT_COMMAND;
  process.env.QG_ESLINT_COMMAND = 'bunx eslint';
  try {
    const config = loadConfig('does-not-exist.json', process.cwd());
    assert.equal(config.eslint.command, 'bunx eslint');
    assert.equal(config.size.maxLines, 400);
  } finally {
    if (previous === undefined) delete process.env.QG_ESLINT_COMMAND;
    else process.env.QG_ESLINT_COMMAND = previous;
  }
});
