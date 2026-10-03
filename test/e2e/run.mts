/**
 * End-to-end check of the template against example/:
 * copy → lint → coverage → doctor → check (no baseline) → baseline → check (pass)
 * → inject regressions → check (fail, with the expected messages) → baseline refuses → restore.
 *
 *   npm run test:e2e
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const example = resolve(root, 'example');
const template = resolve(root, 'template');
const gate = ['scripts/quality-gate/cli.mts'];
const copies = ['scripts', 'quality-gate.config.json', 'quality-gate.baseline.json', 'reports', 'coverage'];

type Run = { status: number | null; stdout: string; stderr: string };

function run(command: string, args: string[], expect = 0, env: Record<string, string> = {}): Run {
  const result = spawnSync(command, args, {
    cwd: example,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== expect) {
    console.error(result.stdout, result.stderr);
    throw new Error(`"${command} ${args.join(' ')}" exited with ${result.status}, expected ${expect}`);
  }
  return result;
}

function step(name: string, body: () => void): void {
  body();
  console.log(`ok  ${name}`);
}

const legacyPath = join(example, 'src/legacy.ts');
const legacyOriginal = readFileSync(legacyPath, 'utf8');
const injected = [join(example, 'src/generated.ts'), join(example, 'src/legacy-copy.ts')];

function restore(): void {
  writeFileSync(legacyPath, legacyOriginal);
  for (const file of injected) rmSync(file, { force: true });
  for (const copy of copies) rmSync(join(example, copy), { recursive: true, force: true });
}

try {
  step('copy the template into example/', () => {
    for (const copy of copies) rmSync(join(example, copy), { recursive: true, force: true });
    cpSync(join(template, 'scripts'), join(example, 'scripts'), { recursive: true });
    cpSync(join(template, 'quality-gate.config.json'), join(example, 'quality-gate.config.json'));
  });

  step('install, lint and test with coverage', () => {
    if (!existsSync(join(example, 'node_modules'))) run('npm', ['ci']);
    run('npm', ['run', 'lint']);
    run('npm', ['run', 'test:coverage']);
    assert.ok(existsSync(join(example, 'coverage/lcov.info')), 'coverage/lcov.info was not written');
  });

  step('doctor passes', () => {
    const { stdout } = run('node', [...gate, 'doctor', '--base', 'HEAD']);
    assert.ok(!stdout.includes('FAIL'), stdout);
  });

  step('check without a baseline passes and says so', () => {
    const { stdout } = run('node', [...gate, 'check', '--base', 'HEAD']);
    assert.match(stdout, /Quality gate ✅ passed/);
    assert.match(stdout, /Baseline: none \(first run\)/);
    assert.match(stdout, /No quality-gate\.baseline\.json yet/);
  });

  let baselineViolations = 0;
  step('baseline records the current state', () => {
    run('node', [...gate, 'baseline', '--base', 'HEAD']);
    const baseline = JSON.parse(readFileSync(join(example, 'quality-gate.baseline.json'), 'utf8'));
    assert.equal(baseline.schemaVersion, 1);
    assert.ok(baseline.coverage.lines > 0 && baseline.coverage.lines < 100, `lines ${baseline.coverage.lines}`);
    baselineViolations = baseline.violations.qualityRules;
    assert.ok(baselineViolations >= 2, `expected legacy.ts violations, got ${baselineViolations}`);
    assert.ok(baseline.ruleViolations['src/legacy.ts']?.['max-depth'] >= 1);
    assert.equal(baseline.violations.oversizedFiles, 0);
    assert.equal(baseline.duplication.fragments, 0);
  });

  step('check against the fresh baseline passes', () => {
    const { stdout } = run('node', [...gate, 'check', '--base', 'HEAD']);
    assert.match(stdout, /Quality gate ✅ passed/);
    assert.match(stdout, /\| Quality rule violations \| \d+ \| \d+ \| — \|/);
  });

  step('inject regressions: oversized file, deeper nesting, a copied module', () => {
    const rows = Array.from({ length: 450 }, (_, i) => `export const row${i} = ${i};`).join('\n');
    writeFileSync(injected[0] as string, `${rows}\n`);
    writeFileSync(injected[1] as string, legacyOriginal); // a verbatim copy in a second module
    writeFileSync(
      legacyPath,
      `${legacyOriginal}
export function deeper(flags: boolean[]): number {
  let count = 0;
  for (const a of flags) {
    if (a) {
      if (flags.length > 1) {
        if (flags.length > 2) {
          if (flags.length > 3) {
            if (flags.length > 4) {
              count++;
            }
          }
        }
      }
    }
  }
  return count;
}
`,
    );
    run('npm', ['run', 'test:coverage']);
  });

  step('check fails with the expected regressions and GitHub output', () => {
    const summary = join(mkdtempSync(join(tmpdir(), 'qg-')), 'summary.md');
    const { stdout } = run('node', [...gate, 'check', '--base', 'HEAD'], 1, {
      GITHUB_ACTIONS: 'true',
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.match(stdout, /Quality gate ❌ \d+ regressions/);
    assert.match(stdout, /- src\/generated\.ts crossed the limit with 450 lines and \d+ bytes/);
    assert.match(stdout, /- max-depth violations increased in src\/legacy\.ts \(\d+ -> \d+\)/);
    assert.match(stdout, /- Quality rule violations increased from \d+ to \d+/);
    assert.match(stdout, /- Lines coverage dropped from [\d.]+% to [\d.]+%/);
    assert.match(stdout, /- Duplication rose from 0% to [\d.]+%/);
    assert.match(stdout, /- Duplicated fragments increased from 0 to 2/);
    assert.match(stdout, /- Patch coverage [\d.]+% is below the minimum of 80%/);
    assert.match(stdout, /^::error title=Quality gate::src\/generated\.ts crossed the limit/m);
    assert.match(stdout, /^::warning title=Quality gate::Patch coverage/m);
    assert.match(readFileSync(summary, 'utf8'), /## Quality gate ❌/);
    const report = JSON.parse(readFileSync(join(example, 'reports/quality-gate.json'), 'utf8'));
    assert.equal(report.status, 'fail');
    assert.ok(report.duplicatedBlocks.length >= 2);
  });

  step('baseline refuses to loosen unless asked to', () => {
    const { stderr } = run('node', [...gate, 'baseline', '--base', 'HEAD'], 1);
    assert.match(stderr, /Refusing to loosen quality-gate\.baseline\.json/);
    run('node', [...gate, 'baseline', '--base', 'HEAD', '--allow-regression']);
    const { stdout } = run('node', [...gate, 'check', '--base', 'HEAD']);
    assert.match(stdout, /Quality gate ✅ passed/);
  });

  console.log('\nEnd-to-end run passed.');
} finally {
  restore();
}
