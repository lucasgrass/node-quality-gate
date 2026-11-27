/**
 * The ratchet: `compare` lists every way the current metrics are worse (or better) than the
 * baseline; `parseBaseline`/`toBaseline` read and write quality-gate.baseline.json.
 * Pure functions only.
 */
import type { Config, Mode } from './config.mts';
import type {
  Baseline,
  CoverageKey,
  CoverageMetrics,
  DuplicationMetrics,
  FileSize,
  Metrics,
  NewDependency,
  PatchCoverage,
  RuleCounts,
  Verdict,
} from './types.mts';
import { COVERAGE_KEYS } from './types.mts';
import { isRecord, pct, sortRecord } from './util.mts';

export const SCHEMA_VERSION = 1;
const LIST_SHOWN = 5;

export function compare(baseline: Metrics | null, current: Metrics, patch: PatchCoverage, config: Config): Verdict {
  const verdict: Verdict = { regressions: [], warnings: [], improvements: [] };
  comparePatch(patch, config.patchCoverage, verdict);
  if (!baseline) return verdict;
  compareCoverage(baseline.coverage, current.coverage, config.coverage.tolerance, verdict);
  compareDuplication(baseline.duplication, current.duplication, config.duplication.tolerance, verdict);
  compareCount('Quality rule violations', baseline.violations.qualityRules, current.violations.qualityRules, verdict);
  compareCount('Oversized files', baseline.violations.oversizedFiles, current.violations.oversizedFiles, verdict);
  compareOversized(baseline.oversized, current.oversized, verdict);
  compareRules(baseline.ruleViolations, current.ruleViolations, verdict);
  return verdict;
}

export type Evidence = {
  /** The baseline in the working tree, the one this change is held to. */
  committed: Metrics | null;
  /** The baseline on the base branch, when git can reach it. */
  base: Metrics | null;
  current: Metrics;
  patch: PatchCoverage;
  unmeasured: string[];
  untested: string[];
  dependencies: NewDependency[];
};

/** The full verdict of `check`: the ratchet itself plus what the change did to the baseline and to coverage reporting. */
export function judge(evidence: Evidence, config: Config): Verdict {
  const { committed, base, current, patch } = evidence;
  const verdict = compare(committed ?? base, current, patch, config);
  note(verdict, 'warn', unmeasuredWarning(evidence.unmeasured));
  note(verdict, config.untestedFiles.mode, untestedWarning(evidence.untested));
  note(verdict, config.newDependencies.mode, dependenciesWarning(evidence.dependencies));
  if (base && committed) {
    for (const item of baselineLoosening(base, committed, config)) note(verdict, config.baseline.loosening, item);
  } else if (base) {
    verdict.regressions.push('The baseline file was removed in this change; compared with the one on the base branch');
  }
  return verdict;
}

/**
 * What the baseline of this change allows that the one on the base branch did not. The gate
 * compares with the baseline committed in the branch, so without this a change could loosen
 * its own bar unnoticed.
 */
export function baselineLoosening(base: Metrics, branch: Metrics, config: Config): string[] {
  const patch: PatchCoverage = { status: 'skipped', reason: 'baseline comparison' };
  return compare(base, branch, patch, config).regressions.map((item) => `Baseline loosened: ${item}`);
}

/**
 * Values that got worse by less than the tolerance keep their baseline value, so rewriting
 * the baseline cannot walk the bar down one tolerance at a time.
 */
export function holdTolerated(previous: Metrics, current: Metrics): Metrics {
  const coverage = { ...current.coverage };
  for (const key of COVERAGE_KEYS) coverage[key] = Math.max(previous.coverage[key], current.coverage[key]);
  const percentage = Math.min(previous.duplication.percentage, current.duplication.percentage);
  return { ...current, coverage, duplication: { ...current.duplication, percentage } };
}

/** Changed source files missing from the coverage report: their lines count for nothing in patch coverage. */
export function unmeasuredWarning(files: string[]): string | null {
  if (files.length === 0) return null;
  const subject = files.length === 1 ? '1 changed file is' : `${files.length} changed files are`;
  return `${subject} missing from the coverage report, so the new lines were not measured: ${shortList(files)}. Add them to your test runner's coverage "include" if they contain code`;
}

/** New source files the coverage report lists without a single line hit. */
export function untestedWarning(files: string[]): string | null {
  if (files.length === 0) return null;
  const subject = files.length === 1 ? '1 new file has' : `${files.length} new files have`;
  return `${subject} no line covered by a test: ${shortList(files)}`;
}

/** Dependencies the change adds to package.json: each one is code nobody in the repository wrote or reviewed. */
export function dependenciesWarning(added: NewDependency[]): string | null {
  if (added.length === 0) return null;
  const subject = added.length === 1 ? '1 new dependency' : `${added.length} new dependencies`;
  const names = added.map(({ name, version, section }) => `${name}@${version} (${section})`);
  return `${subject} in package.json: ${shortList(names)}. Confirm each one is needed and is the package you meant`;
}

function shortList(items: string[]): string {
  const hidden = items.length > LIST_SHOWN ? ` and ${items.length - LIST_SHOWN} more` : '';
  return `${items.slice(0, LIST_SHOWN).join(', ')}${hidden}`;
}

/** Files a finding where its mode says: a warning, or a regression that fails the gate. */
function note(verdict: Verdict, mode: Mode, message: string | null): void {
  if (message !== null) (mode === 'block' ? verdict.regressions : verdict.warnings).push(message);
}

function comparePatch(patch: PatchCoverage, options: Config['patchCoverage'], verdict: Verdict): void {
  if (!options.enabled || patch.status === 'skipped' || patch.percentage >= options.threshold) return;
  const message =
    `Patch coverage ${pct(patch.percentage)} is below the minimum of ${pct(options.threshold)} ` +
    `(${patch.covered} of ${patch.coverable} changed lines covered)`;
  note(verdict, options.mode, message);
}

function compareCoverage(before: CoverageMetrics, after: CoverageMetrics, tolerance: number, verdict: Verdict): void {
  for (const key of COVERAGE_KEYS) {
    if (after[key] < before[key] - tolerance) {
      verdict.regressions.push(`${label(key)} coverage dropped from ${pct(before[key])} to ${pct(after[key])}`);
    } else if (after[key] > before[key] + tolerance) {
      verdict.improvements.push(`${label(key)} coverage improved from ${pct(before[key])} to ${pct(after[key])}`);
    }
  }
}

function compareDuplication(
  before: DuplicationMetrics,
  after: DuplicationMetrics,
  tolerance: number,
  verdict: Verdict,
): void {
  if (after.percentage > before.percentage + tolerance) {
    verdict.regressions.push(`Duplication rose from ${pct(before.percentage)} to ${pct(after.percentage)}`);
  } else if (after.percentage < before.percentage - tolerance) {
    verdict.improvements.push(`Duplication fell from ${pct(before.percentage)} to ${pct(after.percentage)}`);
  }
  compareCount('Duplicated fragments', before.fragments, after.fragments, verdict);
}

function compareCount(name: string, before: number, after: number, verdict: Verdict): void {
  if (after > before) verdict.regressions.push(`${name} increased from ${before} to ${after}`);
  else if (after < before) verdict.improvements.push(`${name} decreased from ${before} to ${after}`);
}

function compareOversized(before: Record<string, FileSize>, after: Record<string, FileSize>, verdict: Verdict): void {
  for (const [file, size] of Object.entries(after)) {
    const previous = before[file];
    if (!previous) {
      verdict.regressions.push(`${file} crossed the limit with ${size.lines} lines and ${size.bytes} bytes`);
      continue;
    }
    for (const unit of ['lines', 'bytes'] as const) {
      if (size[unit] > previous[unit]) {
        verdict.regressions.push(
          `${file} grew from ${previous[unit]} to ${size[unit]} ${unit} while already over the limit`,
        );
      }
    }
  }
}

/** Per file and rule, only for files the baseline knows: new or renamed files count through the total. */
function compareRules(before: Record<string, RuleCounts>, after: Record<string, RuleCounts>, verdict: Verdict): void {
  for (const [file, counts] of Object.entries(after)) {
    const previousCounts = before[file];
    if (!previousCounts) continue;
    for (const [rule, count] of Object.entries(counts)) {
      const previous = previousCounts[rule] ?? 0;
      if (count > previous) {
        verdict.regressions.push(`${rule} violations increased in ${file} (${previous} -> ${count})`);
      }
    }
  }
}

function label(key: CoverageKey): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// --- Baseline file -----------------------------------------------------------

export function toBaseline(metrics: Metrics, tool: string): Baseline {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool,
    coverage: metrics.coverage,
    duplication: metrics.duplication,
    violations: metrics.violations,
    oversized: sortRecord(metrics.oversized),
    ruleViolations: sortRecord(metrics.ruleViolations),
  };
}

/** Validates a baseline read from disk; a wrong schema version asks for a new baseline. */
export function parseBaseline(value: unknown, source: string): Baseline {
  if (!isRecord(value)) throw new Error(`${source} is not a JSON object`);
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`${source} has schemaVersion ${String(value.schemaVersion)}; this gate expects ${SCHEMA_VERSION}. Run the baseline command again.`);
  }
  const coverage = numbers(value.coverage, `${source}: coverage`, COVERAGE_KEYS);
  const duplication = numbers(value.duplication, `${source}: duplication`, ['percentage', 'fragments']);
  const violations = numbers(value.violations, `${source}: violations`, ['qualityRules', 'oversizedFiles']);
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: typeof value.tool === 'string' ? value.tool : 'unknown',
    coverage: { lines: coverage.lines ?? 0, functions: coverage.functions ?? 0, branches: coverage.branches ?? 0 },
    duplication: { percentage: duplication.percentage ?? 0, fragments: duplication.fragments ?? 0 },
    violations: { qualityRules: violations.qualityRules ?? 0, oversizedFiles: violations.oversizedFiles ?? 0 },
    oversized: parseSizes(value.oversized, source),
    ruleViolations: parseRules(value.ruleViolations, source),
  };
}

function numbers(value: unknown, path: string, keys: readonly string[]): Record<string, number> {
  if (!isRecord(value)) throw new Error(`${path} is missing`);
  const result: Record<string, number> = {};
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) throw new Error(`${path}.${key} is not a number`);
    result[key] = entry;
  }
  return result;
}

function parseSizes(value: unknown, source: string): Record<string, FileSize> {
  const sizes: Record<string, FileSize> = {};
  for (const [file, size] of Object.entries(isRecord(value) ? value : {})) {
    const parsed = numbers(size, `${source}: oversized.${file}`, ['lines', 'bytes']);
    sizes[file] = { lines: parsed.lines ?? 0, bytes: parsed.bytes ?? 0 };
  }
  return sortRecord(sizes);
}

function parseRules(value: unknown, source: string): Record<string, RuleCounts> {
  const rules: Record<string, RuleCounts> = {};
  for (const [file, counts] of Object.entries(isRecord(value) ? value : {})) {
    if (!isRecord(counts)) throw new Error(`${source}: ruleViolations.${file} is not an object`);
    rules[file] = sortRecord(numbers(counts, `${source}: ruleViolations.${file}`, Object.keys(counts)));
  }
  return sortRecord(rules);
}
