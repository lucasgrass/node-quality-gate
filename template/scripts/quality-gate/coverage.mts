/** Coverage from lcov (project totals) and coverage of the lines changed since the base ref. */
import type { CoverageMetrics, PatchCoverage } from './types.mts';
import { COVERAGE_KEYS } from './types.mts';
import { git, round2, toRepoPath } from './util.mts';

export type FileCoverage = {
  found: CoverageMetrics;
  hit: CoverageMetrics;
  /** Execution count per instrumented line (`DA:` records). */
  lineHits: Map<number, number>;
};

const SUMMARY_KEYS: Record<string, [keyof FileCoverage & ('found' | 'hit'), keyof CoverageMetrics]> = {
  LF: ['found', 'lines'],
  LH: ['hit', 'lines'],
  FNF: ['found', 'functions'],
  FNH: ['hit', 'functions'],
  BRF: ['found', 'branches'],
  BRH: ['hit', 'branches'],
};

/** Parses an lcov file into one record per source file, keyed by repository-relative path. */
export function parseLcov(text: string, cwd: string): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  let path = '';
  let current: FileCoverage | null = null;
  let hasLineSummary = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const separator = line.indexOf(':');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);
    if (key === 'SF') {
      path = toRepoPath(value, cwd);
      current = emptyCoverage();
      hasLineSummary = false;
    } else if (!current) {
      continue;
    } else if (key === 'DA') {
      recordLine(current, value);
    } else if (key in SUMMARY_KEYS) {
      const [group, metric] = SUMMARY_KEYS[key] as [('found' | 'hit'), keyof CoverageMetrics];
      current[group][metric] = Number(value);
      if (key === 'LF') hasLineSummary = true;
    } else if (key === 'end_of_record') {
      if (!hasLineSummary) summarizeLines(current);
      files.set(path, current);
      current = null;
    }
  }
  return files;
}

function emptyCoverage(): FileCoverage {
  return {
    found: { lines: 0, functions: 0, branches: 0 },
    hit: { lines: 0, functions: 0, branches: 0 },
    lineHits: new Map(),
  };
}

/** `DA:<line>,<hits>[,<checksum>]` */
function recordLine(coverage: FileCoverage, value: string): void {
  const [line, hits] = value.split(',');
  const lineNumber = Number(line);
  const hitCount = Number(hits);
  if (Number.isInteger(lineNumber) && Number.isFinite(hitCount)) {
    coverage.lineHits.set(lineNumber, hitCount);
  }
}

/** Some reporters omit LF/LH; derive them from the DA records. */
function summarizeLines(coverage: FileCoverage): void {
  coverage.found.lines = coverage.lineHits.size;
  let hit = 0;
  for (const count of coverage.lineHits.values()) if (count > 0) hit++;
  coverage.hit.lines = hit;
}

/** Project totals in percent. A category with nothing to cover counts as 100%. */
export function coverageTotals(files: Iterable<FileCoverage>): CoverageMetrics {
  const found: CoverageMetrics = { lines: 0, functions: 0, branches: 0 };
  const hit: CoverageMetrics = { lines: 0, functions: 0, branches: 0 };
  for (const file of files) {
    for (const key of COVERAGE_KEYS) {
      found[key] += file.found[key];
      hit[key] += file.hit[key];
    }
  }
  return {
    lines: ratio(hit.lines, found.lines),
    functions: ratio(hit.functions, found.functions),
    branches: ratio(hit.branches, found.branches),
  };
}

function ratio(hit: number, found: number): number {
  return found === 0 ? 100 : round2((hit / found) * 100);
}

/** Unified diff (`-U0`) of the working tree against the merge base with `baseRef`, or null when the ref is unknown. */
export function diffSinceBase(baseRef: string, cwd: string): string | null {
  const mergeBase = git(['merge-base', baseRef, 'HEAD'], cwd)?.trim();
  if (!mergeBase) return null;
  return git(['diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=AMR', mergeBase], cwd);
}

/** Added line numbers per file, read from the hunk headers of a `-U0` unified diff. */
export function parseAddedLines(diff: string): Map<string, number[]> {
  const added = new Map<string, number[]>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!file || !hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = added.get(file) ?? [];
    for (let offset = 0; offset < count; offset++) lines.push(start + offset);
    added.set(file, lines);
  }
  return added;
}

/** Files git does not track yet (local runs before a commit) count as entirely new. */
export function untrackedFiles(cwd: string): string[] {
  const output = git(['ls-files', '--others', '--exclude-standard'], cwd) ?? '';
  return output.split('\n').filter((line) => line !== '');
}

export function addUntracked(
  added: Map<string, number[]>,
  untracked: string[],
  coverage: Map<string, FileCoverage>,
): Map<string, number[]> {
  for (const file of untracked) {
    const hits = coverage.get(file)?.lineHits;
    if (hits && !added.has(file)) added.set(file, [...hits.keys()]);
  }
  return added;
}

/** Coverage of the added lines that the coverage report knows about (Sonar skips small changes). */
export function measurePatchCoverage(
  added: Map<string, number[]>,
  coverage: Map<string, FileCoverage>,
  minLines: number,
): PatchCoverage {
  let coverable = 0;
  let covered = 0;
  for (const [file, lines] of added) {
    const hits = coverage.get(file)?.lineHits;
    if (!hits) continue;
    for (const line of lines) {
      const count = hits.get(line);
      if (count === undefined) continue;
      coverable++;
      if (count > 0) covered++;
    }
  }
  if (coverable < minLines) {
    return { status: 'skipped', reason: `only ${coverable} changed lines to cover, minimum ${minLines}` };
  }
  return { status: 'measured', coverable, covered, percentage: round2((covered / coverable) * 100) };
}
