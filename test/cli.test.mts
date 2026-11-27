/**
 * The commands against a throwaway git repository, with a stub in place of ESLint:
 * what `check` and `baseline` do when a change touches the baseline itself.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const cli = resolve(import.meta.dirname, '../template/scripts/quality-gate/cli.mts');
const repo = mkdtempSync(join(tmpdir(), 'qg-cli-'));
const stub = join(mkdtempSync(join(tmpdir(), 'qg-stub-')), 'eslint.mjs');
const baselinePath = join(repo, 'quality-gate.baseline.json');
after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(resolve(stub, '..'), { recursive: true, force: true });
});

/** Reports every file under src/ as linted and clean, the way `eslint --format json --output-file` would. */
const STUB = `import { readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const output = process.argv[process.argv.indexOf('--output-file') + 1];
const files = readdirSync('src').map((name) => ({ filePath: resolve('src', name), messages: [] }));
writeFileSync(output, JSON.stringify(files));
`;

function git(...args: string[]): void {
  const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
  const result = spawnSync('git', [...identity, ...args], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function gate(...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [cli, ...args, '--base', 'main'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, QG_ESLINT_COMMAND: `${process.execPath} ${stub}`, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', GITHUB_BASE_REF: '' },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function writeCoverage(linesHit: number): void {
  writeFileSync(join(repo, 'coverage/lcov.info'), `SF:src/a.ts\nDA:1,1\nLF:10000\nLH:${linesHit}\nend_of_record\n`);
}

function baselineLines(): number {
  return (JSON.parse(readFileSync(baselinePath, 'utf8')) as { coverage: { lines: number } }).coverage.lines;
}

test('a repository at 80% coverage with a committed baseline passes', () => {
  writeFileSync(stub, STUB);
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'coverage'));
  writeFileSync(join(repo, '.gitignore'), 'coverage/\nreports/\n');
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeCoverage(8000);
  git('init', '--quiet', '--initial-branch=main');
  assert.equal(gate('baseline').status, 0);
  git('add', '.');
  git('commit', '--quiet', '--message', 'baseline');
  git('switch', '--quiet', '--create', 'change');
  const { status, output } = gate('check');
  assert.equal(status, 0, output);
  assert.match(output, /Baseline: quality-gate\.baseline\.json \(last changed in [0-9a-f]+, \d{4}-\d\d-\d\d\)/);
  assert.doesNotMatch(output, /### Warnings/);
});

test('baseline is byte-identical when nothing changed, and holds a drop inside the tolerance', () => {
  const before = readFileSync(baselinePath, 'utf8');
  assert.equal(gate('baseline').status, 0);
  assert.equal(readFileSync(baselinePath, 'utf8'), before);
  writeCoverage(7995); // 79.95%, inside the 0.1 tolerance
  assert.equal(gate('baseline').status, 0);
  assert.equal(baselineLines(), 80);
});

test('a baseline loosened in the change is reported by check', () => {
  writeCoverage(5000);
  const refused = gate('baseline');
  assert.equal(refused.status, 1);
  assert.match(refused.output, /Refusing to loosen/);
  assert.equal(gate('baseline', '--allow-regression').status, 0);
  assert.equal(baselineLines(), 50);

  const warned = gate('check');
  assert.equal(warned.status, 0, warned.output);
  assert.match(warned.output, /### Warnings\n\n- Baseline loosened: Lines coverage dropped from 80% to 50%/);

  writeFileSync(join(repo, 'quality-gate.config.json'), JSON.stringify({ baseline: { loosening: 'block' } }));
  const blocked = gate('check');
  assert.equal(blocked.status, 1, blocked.output);
  assert.match(blocked.output, /### Regressions\n\n- Baseline loosened: Lines coverage dropped from 80% to 50%/);
  rmSync(join(repo, 'quality-gate.config.json'));
});

test('deleting the baseline does not reset the gate', () => {
  rmSync(baselinePath);
  const { status, output } = gate('check');
  assert.equal(status, 1, output);
  assert.match(output, /Baseline: quality-gate\.baseline\.json from the base branch \(removed in this change\)/);
  assert.match(output, /- Lines coverage dropped from 80% to 50%/);
  assert.match(output, /- The baseline file was removed in this change/);
  git('checkout', '--quiet', 'main', '--', 'quality-gate.baseline.json');
  writeCoverage(8000);
});

test('a new source file the coverage report does not mention is called out', () => {
  writeFileSync(join(repo, 'src/untested.ts'), 'export const b = 2;\n');
  const untracked = gate('check');
  assert.equal(untracked.status, 0, untracked.output);
  assert.match(untracked.output, /- 1 changed file is missing from the coverage report, so the new lines were not measured: src\/untested\.ts\./);
  git('add', '.');
  git('commit', '--quiet', '--message', 'untested module');
  assert.match(gate('check').output, /1 changed file is missing from the coverage report.*src\/untested\.ts/);
});

test('a new file no test touches and a new dependency are warned about, or block when configured', () => {
  const manifest = join(repo, 'package.json');
  git('switch', '--quiet', 'main');
  writeFileSync(manifest, JSON.stringify({ dependencies: { express: '^5.0.0' }, devDependencies: { vitest: '^3.0.0' } }));
  git('add', '.');
  git('commit', '--quiet', '--message', 'manifest');
  git('switch', '--quiet', '--create', 'additions');
  assert.doesNotMatch(gate('check').output, /### Warnings/);

  writeFileSync(manifest, JSON.stringify({ dependencies: { express: '^5.1.0', 'left-pad': '^1.3.0' }, devDependencies: { vitest: '^3.0.0', tsx: '^4.0.0' } }));
  writeFileSync(join(repo, 'src/idle.ts'), 'export const idle = 3;\n');
  const lcov = 'SF:src/a.ts\nDA:1,1\nLF:10000\nLH:8000\nend_of_record\nSF:src/idle.ts\nDA:1,0\nLF:1\nLH:0\nend_of_record\n';
  writeFileSync(join(repo, 'coverage/lcov.info'), lcov);
  const untested = '1 new file has no line covered by a test: src/idle.ts';
  const dependency = '1 new dependency in package.json: left-pad@^1.3.0 (dependencies). Confirm each one is needed and is the package you meant';

  const warned = gate('check');
  assert.equal(warned.status, 0, warned.output);
  assert.ok(warned.output.includes(`### Warnings\n\n- ${untested}\n- ${dependency}`), warned.output);
  const report = JSON.parse(readFileSync(join(repo, 'reports/quality-gate.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(report.untestedFiles, ['src/idle.ts']);
  assert.deepEqual(report.newDependencies, [{ name: 'left-pad', version: '^1.3.0', section: 'dependencies' }]);

  git('add', '.');
  git('commit', '--quiet', '--message', 'additions');
  const config = join(repo, 'quality-gate.config.json');
  writeFileSync(config, JSON.stringify({ untestedFiles: { mode: 'block' }, newDependencies: { mode: 'block', sections: ['devDependencies'] } }));
  const blocked = gate('check');
  assert.equal(blocked.status, 1, blocked.output);
  assert.ok(blocked.output.includes(`### Regressions\n\n- ${untested}\n- 1 new dependency in package.json: tsx@^4.0.0 (devDependencies).`), blocked.output);

  writeFileSync(config, JSON.stringify({ patchCoverage: { enabled: false }, untestedFiles: { enabled: false }, newDependencies: { enabled: false } }));
  const disabled = gate('check');
  assert.equal(disabled.status, 0, disabled.output);
  assert.doesNotMatch(disabled.output, /### Warnings|Patch coverage/);
  rmSync(config);
});

test('an unknown command and a malformed --to are usage errors', () => {
  assert.match(gate('frobnicate').output, /unknown command "frobnicate" \(use check, baseline, doctor or upgrade\)/);
  const malformed = gate('upgrade', '--to', 'latest');
  assert.equal(malformed.status, 2);
  assert.match(malformed.output, /quality-gate: "latest" is not a version/);
});
