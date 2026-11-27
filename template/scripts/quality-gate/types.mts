/** Types shared by the quality gate modules. */

export type CoverageMetrics = { lines: number; functions: number; branches: number };
export const COVERAGE_KEYS = ['lines', 'functions', 'branches'] as const;
export type CoverageKey = (typeof COVERAGE_KEYS)[number];

export type DuplicationMetrics = { percentage: number; fragments: number };
export type ViolationMetrics = { qualityRules: number; oversizedFiles: number };
export type FileSize = { lines: number; bytes: number };
export type RuleCounts = Record<string, number>;

export type Metrics = {
  coverage: CoverageMetrics;
  duplication: DuplicationMetrics;
  violations: ViolationMetrics;
  /** Files over the size limits, keyed by repository-relative path. */
  oversized: Record<string, FileSize>;
  /** Quality-rule violations per file and rule. */
  ruleViolations: Record<string, RuleCounts>;
};

/** No timestamp or commit on purpose: the file only changes when a number does, so merges stay quiet. */
export type Baseline = Metrics & {
  schemaVersion: 1;
  tool: string;
};

export type PatchCoverage =
  | { status: 'measured'; coverable: number; covered: number; percentage: number }
  | { status: 'skipped'; reason: string };

/** A dependency the change adds to a section of package.json. */
export type NewDependency = { name: string; version: string; section: string };

export type DuplicatedBlock = { file: string; startLine: number; endLine: number };

export type Verdict = { regressions: string[]; warnings: string[]; improvements: string[] };

export type Report = Verdict & {
  tool: string;
  status: 'pass' | 'fail';
  generatedAt: string;
  baselineSource: string;
  baseline: Metrics | null;
  current: Metrics;
  patchCoverage: PatchCoverage;
  /** Changed source files the coverage report does not mention. */
  unmeasuredFiles: string[];
  /** New source files the coverage report lists without a single line hit. */
  untestedFiles: string[];
  newDependencies: NewDependency[];
  duplicatedBlocks: DuplicatedBlock[];
};
