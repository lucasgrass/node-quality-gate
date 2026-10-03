/** Markdown report (PR comment and job summary) and GitHub Actions annotations. */
import type { Config } from './config.mts';
import type { PatchCoverage, Report } from './types.mts';
import { COVERAGE_KEYS } from './types.mts';
import { pct } from './util.mts';

export const MARKER = '<!-- node-quality-gate -->';
const ANNOTATION_LIMIT = 10;

type Formatter = (value: number) => string;
const count: Formatter = (value) => String(value);

export function renderMarkdown(report: Report, config: Config): string {
  const sections = [
    title(report),
    `Baseline: ${report.baselineSource}`,
    coverageSection(report, config),
    duplicationSection(report),
    violationsSection(report),
    list('Regressions', report.regressions),
    list('Warnings', report.warnings),
    improvements(report),
    `<sub>${report.tool}</sub>\n${MARKER}`,
  ];
  return `${sections.filter((section) => section !== '').join('\n\n')}\n`;
}

function title({ status, regressions }: Report): string {
  if (status === 'pass') return '## Quality gate ✅ passed';
  return `## Quality gate ❌ ${regressions.length} regression${regressions.length === 1 ? '' : 's'}`;
}

function coverageSection(report: Report, config: Config): string {
  const rows = COVERAGE_KEYS.map((key) =>
    row(key.charAt(0).toUpperCase() + key.slice(1), report.baseline?.coverage[key], report.current.coverage[key], pct),
  );
  return ['### Coverage', table(rows), patchLine(report.patchCoverage, config.patchCoverage)]
    .filter((part) => part !== '')
    .join('\n\n');
}

function patchLine(patch: PatchCoverage, options: Config['patchCoverage']): string {
  if (!options.enabled) return '';
  if (patch.status === 'skipped') return `Patch coverage: skipped (${patch.reason}).`;
  const mode = options.mode === 'block' ? 'blocking' : 'warning only';
  return `Patch coverage: **${pct(patch.percentage)}** of ${patch.coverable} changed lines (minimum ${pct(options.threshold)}, ${mode}).`;
}

function duplicationSection({ baseline, current }: Report): string {
  const rows = [
    row('Percentage', baseline?.duplication.percentage, current.duplication.percentage, pct),
    row('Fragments', baseline?.duplication.fragments, current.duplication.fragments, count),
  ];
  return `### Duplication\n\n${table(rows)}`;
}

function violationsSection({ baseline, current }: Report): string {
  const rows = [
    row('Quality rule violations', baseline?.violations.qualityRules, current.violations.qualityRules, count),
    row('Oversized files', baseline?.violations.oversizedFiles, current.violations.oversizedFiles, count),
  ];
  return `### Violations\n\n${table(rows)}`;
}

function list(heading: string, items: string[]): string {
  if (items.length === 0) return '';
  return `### ${heading}\n\n${items.map((item) => `- ${item}`).join('\n')}`;
}

function improvements(report: Report): string {
  if (report.improvements.length === 0) return '';
  return `${list('Improvements', report.improvements)}\n\nRun \`node scripts/quality-gate/cli.mts baseline\` to lock them in.`;
}

function table(rows: string[][]): string {
  return ['| Metric | Baseline | Current | Δ |', '|---|---:|---:|---:|', ...rows.map((cells) => `| ${cells.join(' | ')} |`)].join('\n');
}

function row(name: string, before: number | undefined, after: number, format: Formatter): string[] {
  if (before === undefined) return [name, '—', format(after), '—'];
  return [name, format(before), format(after), delta(after - before, format)];
}

function delta(difference: number, format: Formatter): string {
  if (Math.abs(difference) < 1e-9) return '—';
  return `${difference > 0 ? '+' : '-'}${format(Math.abs(difference))}`;
}

/** Workflow commands for the Actions log, within GitHub's limit of 10 per level and step. */
export function annotations(report: Report): string[] {
  const lines = [...limited('error', report.regressions), ...limited('warning', report.warnings)];
  if (report.improvements.length > 0) {
    const plural = report.improvements.length === 1 ? 'metric' : 'metrics';
    lines.push(command('notice', `${report.improvements.length} ${plural} improved; run the baseline command to lock them in.`));
  }
  return lines;
}

function limited(level: string, messages: string[]): string[] {
  const shown = messages.slice(0, ANNOTATION_LIMIT);
  const hidden = messages.length - shown.length;
  if (hidden > 0) shown[ANNOTATION_LIMIT - 1] = `${shown[ANNOTATION_LIMIT - 1]} (and ${hidden} more, see the job summary)`;
  return shown.map((message) => command(level, message));
}

function command(level: string, message: string): string {
  const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::${level} title=Quality gate::${escaped}`;
}

/** Cuts the text to `maxBytes`, keeping the marker so the sticky comment is still found. */
export function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const footer = `\n\n_Report truncated; the full report is in the reports artifact._\n${MARKER}\n`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(footer));
  const head = Buffer.from(text).subarray(0, budget).toString('utf8').replace(/�+$/, '');
  return `${head}${footer}`;
}
