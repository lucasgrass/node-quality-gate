/**
 * The ratchet: `compare` lists every way the current metrics are worse (or better) than the
 * baseline; `parseBaseline`/`toBaseline` read and write quality-gate.baseline.json.
 * Pure functions only.
 */
import type { Config } from './config.mts';
import type {
  Baseline,
  CoverageKey,
  CoverageMetrics,
  DuplicationMetrics,
  FileSize,
  Metrics,
  PatchCoverage,
  RuleCounts,
  Verdict,
} from './types.mts';
import { COVERAGE_KEYS } from './types.mts';
import { isRecord, pct, sortRecord } from './util.mts';

export const SCHEMA_VERSION = 1;

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

function comparePatch(patch: PatchCoverage, options: Config['patchCoverage'], verdict: Verdict): void {
  if (!options.enabled || patch.status === 'skipped' || patch.percentage >= options.threshold) return;
  const message =
    `Patch coverage ${pct(patch.percentage)} is below the minimum of ${pct(options.threshold)} ` +
    `(${patch.covered} of ${patch.coverable} changed lines covered)`;
  (options.mode === 'block' ? verdict.regressions : verdict.warnings).push(message);
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

export function toBaseline(metrics: Metrics, commit: string, tool: string, generatedAt: Date): Baseline {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    commit,
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
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    commit: typeof value.commit === 'string' ? value.commit : 'unknown',
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
