#!/usr/bin/env node
/**
 * node-quality-gate v0.1.0 — https://github.com/lucasgrass/node-quality-gate
 *
 * A ratchet: compares the repository with a committed baseline and fails when anything
 * gets worse. Measures coverage (lcov), coverage of the changed lines, lint quality-rule
 * violations, oversized files and duplicated code.
 *
 *   node scripts/quality-gate/cli.mts check
 *   node scripts/quality-gate/cli.mts baseline
 *   node scripts/quality-gate/cli.mts doctor
 *
 * Runs on Node 22.18+ without a build step and without dependencies.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { BASELINE_PATH, CONFIG_PATH, REPORT_DIR, loadConfig, type Config } from './config.mts';
import {
  addUntracked,
  coverageTotals,
  diffSinceBase,
  measurePatchCoverage,
  parseAddedLines,
  parseLcov,
  untrackedFiles,
  type FileCoverage,
} from './coverage.mts';
import { detectDuplication } from './duplication.mts';
import { countViolations, excluder, oversizedFiles, readSources, runEslint } from './lint.mts';
import { compare, parseBaseline, toBaseline } from './ratchet.mts';
import { annotations, renderMarkdown, truncate } from './report.mts';
import type { Baseline, DuplicatedBlock, Metrics, PatchCoverage, Report } from './types.mts';
import { git, toRepoPath } from './util.mts';

export const VERSION = '0.1.0';
const TOOL = `node-quality-gate ${VERSION}`;
const MIN_NODE = [22, 18] as const;
const STEP_SUMMARY_LIMIT = 1_000_000;

const HELP = `${TOOL}

Usage: node scripts/quality-gate/cli.mts <command> [options]

Commands
  check      Measure, compare with ${BASELINE_PATH}, write ${REPORT_DIR}/ (exit 1 on regressions)
  baseline   Write ${BASELINE_PATH} from the current state (refuses to loosen it without --allow-regression)
  doctor     Check Node, config, coverage report, ESLint and git before the first run

Options
  --config <path>      Config file (default ${CONFIG_PATH}; defaults apply when it is missing)
  --base <ref>         Git ref for patch coverage (default: GITHUB_BASE_REF or patchCoverage.baseRef)
  --allow-regression   Let "baseline" record values worse than the current baseline
  --version, --help

Exit codes: 0 ok, 1 regressions, 2 usage or environment error`;

type Flags = { config: string; base: string | undefined; allowRegression: boolean };
type Measurement = { metrics: Metrics; patch: PatchCoverage; blocks: DuplicatedBlock[] };

export function main(argv: string[], cwd: string): number {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      base: { type: 'string' },
      'allow-regression': { type: 'boolean' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (values.version) return print(TOOL);
  const command = positionals[0];
  if (values.help || command === undefined) return print(HELP, command === undefined ? 2 : 0);
  const flags: Flags = { config: values.config ?? CONFIG_PATH, base: values.base, allowRegression: values['allow-regression'] ?? false };
  if (command === 'check') return check(flags, cwd);
  if (command === 'baseline') return baseline(flags, cwd);
  if (command === 'doctor') return doctor(flags, cwd);
  throw new Error(`unknown command "${command}" (use check, baseline or doctor)`);
}

function print(text: string, code = 0): number {
  console.log(text);
  return code;
}

// --- Commands ----------------------------------------------------------------

function check(flags: Flags, cwd: string): number {
  const config = loadConfig(flags.config, cwd);
  const { metrics, patch, blocks } = measure(config, flags.base, cwd);
  const { baseline: previous, source } = readBaseline(cwd);
  const verdict = compare(previous, metrics, patch, config);
  const report: Report = {
    ...verdict,
    tool: TOOL,
    status: verdict.regressions.length === 0 ? 'pass' : 'fail',
    generatedAt: new Date().toISOString(),
    baselineSource: source,
    baseline: previous,
    current: metrics,
    patchCoverage: patch,
    duplicatedBlocks: blocks,
  };
  const markdown = renderMarkdown(report, config);
  mkdirSync(resolve(cwd, REPORT_DIR), { recursive: true });
  writeFileSync(resolve(cwd, REPORT_DIR, 'quality-gate.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(cwd, REPORT_DIR, 'quality-gate.md'), markdown);
  console.log(markdown);
  publish(report, markdown);
  if (!previous) console.log(`No ${BASELINE_PATH} yet: nothing to compare. Run "baseline" and commit the file.`);
  return report.status === 'pass' ? 0 : 1;
}

function baseline(flags: Flags, cwd: string): number {
  const config = loadConfig(flags.config, cwd);
  const { metrics } = measure(config, flags.base, cwd);
  const { baseline: previous } = readBaseline(cwd);
  if (previous) {
    const verdict = compare(previous, metrics, { status: 'skipped', reason: 'baseline' }, config);
    if (verdict.regressions.length > 0 && !flags.allowRegression) {
      console.error(`Refusing to loosen ${BASELINE_PATH}:\n${verdict.regressions.map((item) => `  - ${item}`).join('\n')}`);
      console.error('Fix the regressions, or pass --allow-regression to record them on purpose.');
      return 1;
    }
    for (const item of verdict.improvements) console.log(`  + ${item}`);
  }
  const commit = git(['rev-parse', '--short', 'HEAD'], cwd)?.trim() ?? 'unknown';
  const next = toBaseline(metrics, commit, TOOL, new Date());
  writeFileSync(resolve(cwd, BASELINE_PATH), `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Baseline written to ${BASELINE_PATH} (commit ${commit}). Commit it with your change.`);
  return 0;
}

function doctor(flags: Flags, cwd: string): number {
  const checks: Array<[string, boolean, string]> = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push(['Node', nodeOk, `${process.versions.node} (needs ${MIN_NODE.join('.')}+ to run TypeScript natively)`]);
  let config: Config | null = null;
  try {
    config = loadConfig(flags.config, cwd);
    checks.push(['Config', true, existsSync(resolve(cwd, flags.config)) ? flags.config : `${flags.config} not found, using defaults`]);
  } catch (error) {
    checks.push(['Config', false, (error as Error).message]);
  }
  if (config) {
    checks.push(['Coverage report', existsSync(resolve(cwd, config.coverage.lcov)), `${config.coverage.lcov} (run the tests with the lcov reporter)`]);
    const eslint = runVersion(config.eslint.command, cwd);
    checks.push(['ESLint', eslint !== null, eslint ?? `"${config.eslint.command} --version" failed`]);
    const base = flags.base ?? baseRef(config);
    const mergeBase = git(['merge-base', base, 'HEAD'], cwd);
    checks.push(['Git base ref', !config.patchCoverage.enabled || mergeBase !== null, mergeBase ? `${base} (patch coverage)` : `${base} not found; fetch it or set patchCoverage.baseRef`]);
  }
  try {
    const { baseline: previous } = readBaseline(cwd);
    checks.push(['Baseline', true, previous ? `${BASELINE_PATH} from commit ${previous.commit}` : `none yet (run "baseline")`]);
  } catch (error) {
    checks.push(['Baseline', false, (error as Error).message]);
  }
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  return checks.every(([, ok]) => ok) ? 0 : 2;
}

function runVersion(command: string, cwd: string): string | null {
  const [binary, ...prefix] = command.trim().split(/\s+/);
  if (!binary) return null;
  const result = spawnSync(binary, [...prefix, '--version'], { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return result.status === 0 ? result.stdout.trim() : null;
}

// --- Measuring ---------------------------------------------------------------

function measure(config: Config, baseOverride: string | undefined, cwd: string): Measurement {
  const lcovPath = resolve(cwd, config.coverage.lcov);
  if (!existsSync(lcovPath)) {
    throw new Error(`coverage report not found at ${config.coverage.lcov}; run the tests with the lcov reporter first`);
  }
  const coverage = parseLcov(readFileSync(lcovPath, 'utf8'), cwd);
  const lint = runEslint(config.eslint, resolve(cwd, REPORT_DIR, 'eslint.json'), cwd);
  const excluded = excluder([...config.exclude, `${toRepoPath(dirname(fileURLToPath(import.meta.url)), cwd)}/**`]);
  const sources = readSources(lint.files.filter((file) => !excluded(file)), cwd);
  const violations = countViolations(lint.messages, Object.keys(config.eslint.qualityRules), excluded);
  const oversized = oversizedFiles(sources, config.size);
  const duplication = detectDuplication(sources, config.duplication);
  const metrics: Metrics = {
    coverage: coverageTotals(coverage.values()),
    duplication: { percentage: duplication.percentage, fragments: duplication.fragments },
    violations: { qualityRules: violations.total, oversizedFiles: Object.keys(oversized).length },
    oversized,
    ruleViolations: violations.perFile,
  };
  return { metrics, patch: patchCoverage(config, baseOverride, coverage, cwd), blocks: duplication.blocks };
}

function patchCoverage(config: Config, baseOverride: string | undefined, coverage: Map<string, FileCoverage>, cwd: string): PatchCoverage {
  if (!config.patchCoverage.enabled) return { status: 'skipped', reason: 'disabled in the config' };
  const base = baseOverride ?? baseRef(config);
  const diff = diffSinceBase(base, cwd);
  if (diff === null) return { status: 'skipped', reason: `base ref ${base} not found; fetch it or set patchCoverage.baseRef` };
  const added = addUntracked(parseAddedLines(diff), untrackedFiles(cwd), coverage);
  return measurePatchCoverage(added, coverage, config.patchCoverage.minLines);
}

function baseRef(config: Config): string {
  const pullRequestBase = process.env.GITHUB_BASE_REF;
  return pullRequestBase ? `origin/${pullRequestBase}` : config.patchCoverage.baseRef;
}

function readBaseline(cwd: string): { baseline: Baseline | null; source: string } {
  const file = resolve(cwd, BASELINE_PATH);
  if (!existsSync(file)) return { baseline: null, source: 'none (first run)' };
  const parsed = parseBaseline(JSON.parse(readFileSync(file, 'utf8')), BASELINE_PATH);
  const date = parsed.generatedAt.slice(0, 10);
  return { baseline: parsed, source: `${BASELINE_PATH} (commit ${parsed.commit}${date ? `, ${date}` : ''})` };
}

/** Job summary and annotations when running in GitHub Actions. */
function publish(report: Report, markdown: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, truncate(markdown, STEP_SUMMARY_LIMIT));
  if (process.env.GITHUB_ACTIONS) for (const line of annotations(report)) console.log(line);
}

// --- Entry point -------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.cwd());
  } catch (error) {
    console.error(`quality-gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
