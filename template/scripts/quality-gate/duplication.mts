/**
 * Duplicated code, measured the way SonarQube does for JS/TS: lines are normalized (no
 * whitespace, comments, imports or string contents), then every window of `minLines`
 * lines with at least `minTokens` tokens is hashed; a hash seen twice is a clone.
 * Overlapping clone windows merge into one block. Formatting-only changes are ignored,
 * but a copy that was split across more lines is not detected; that is the trade-off
 * for having no parser.
 */
import { createHash } from 'node:crypto';
import type { DuplicatedBlock, DuplicationMetrics } from './types.mts';
import { round2 } from './util.mts';

export type CodeLine = { line: number; text: string; tokens: number };
export type DuplicationOptions = { minLines: number; minTokens: number };
export type DuplicationResult = DuplicationMetrics & {
  duplicatedLines: number;
  totalLines: number;
  blocks: DuplicatedBlock[];
};

const IMPORT_LINE = /^(import[\s{(*L]|export\s+(\*|\{[^}]*\})\s+from\b|(const|let|var)\s[^=]*=\s*require\s*\()/;
const PUNCTUATION_ONLY = /^[{}()[\];,.:]*$/;
const TOKEN = /\w+|[^\s\w]/g;

type ScanState = { inBlockComment: boolean; inTemplate: boolean };

/** Code lines worth comparing, with their original line number and token count. */
export function normalizeSource(source: string): CodeLine[] {
  const result: CodeLine[] = [];
  const state: ScanState = { inBlockComment: false, inTemplate: false };
  let previous = '';
  source.split('\n').forEach((raw, index) => {
    const text = stripLine(raw, state).replace(/\s+/g, ' ').trim();
    if (text === '' || text === previous || IMPORT_LINE.test(text) || PUNCTUATION_ONLY.test(text)) return;
    previous = text;
    result.push({ line: index + 1, text, tokens: (text.match(TOKEN) ?? []).length });
  });
  return result;
}

/** One line without comments, with every string literal replaced by `L`. */
function stripLine(raw: string, state: ScanState): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charAt(i);
    const next = raw.charAt(i + 1);
    if (state.inBlockComment) {
      if (char === '*' && next === '/') {
        state.inBlockComment = false;
        i++;
      }
    } else if (state.inTemplate) {
      const end = closingQuote(raw, i, '`');
      if (end === -1) return out;
      state.inTemplate = false;
      out += 'L';
      i = end;
    } else if (char === '/' && next === '*') {
      state.inBlockComment = true;
      i++;
    } else if (char === '/' && next === '/') {
      return out;
    } else if (char === '"' || char === "'" || char === '`') {
      const end = closingQuote(raw, i + 1, char);
      if (end === -1) {
        state.inTemplate = char === '`';
        return `${out}L`;
      }
      out += 'L';
      i = end;
    } else {
      out += char;
    }
  }
  return out;
}

/** Index of the closing quote, honouring backslash escapes; -1 when the line ends first. */
function closingQuote(raw: string, from: number, quote: string): number {
  for (let i = from; i < raw.length; i++) {
    if (raw.charAt(i) === '\\') i++;
    else if (raw.charAt(i) === quote) return i;
  }
  return -1;
}

export function detectDuplication(
  sources: ReadonlyMap<string, string>,
  options: DuplicationOptions,
): DuplicationResult {
  const normalized = new Map<string, CodeLine[]>();
  let totalLines = 0;
  for (const [file, source] of sources) {
    normalized.set(file, normalizeSource(source));
    totalLines += source === '' ? 0 : source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  }
  const blocks: DuplicatedBlock[] = [];
  let duplicatedLines = 0;
  for (const [file, starts] of duplicatedWindows(normalized, options)) {
    for (const block of mergeWindows(file, starts, normalized.get(file) ?? [], options.minLines)) {
      blocks.push(block);
      duplicatedLines += block.endLine - block.startLine + 1;
    }
  }
  blocks.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine));
  const percentage = totalLines === 0 ? 0 : round2((duplicatedLines / totalLines) * 100);
  return { percentage, fragments: blocks.length, duplicatedLines, totalLines, blocks };
}

/** Start index (into the normalized lines) of every window whose hash appears more than once. */
function duplicatedWindows(
  normalized: Map<string, CodeLine[]>,
  { minLines, minTokens }: DuplicationOptions,
): Map<string, number[]> {
  const occurrences = new Map<string, Array<[string, number]>>();
  for (const [file, lines] of normalized) {
    for (let start = 0; start + minLines <= lines.length; start++) {
      const window = lines.slice(start, start + minLines);
      if (window.reduce((sum, line) => sum + line.tokens, 0) < minTokens) continue;
      const key = createHash('sha1').update(window.map((line) => line.text).join('\n')).digest('base64');
      const seen = occurrences.get(key) ?? [];
      seen.push([file, start]);
      occurrences.set(key, seen);
    }
  }
  const starts = new Map<string, number[]>();
  for (const seen of occurrences.values()) {
    if (seen.length < 2) continue;
    for (const [file, start] of seen) {
      const list = starts.get(file) ?? [];
      list.push(start);
      starts.set(file, list);
    }
  }
  return starts;
}

/** Overlapping or adjacent windows become one block with physical line numbers. */
function mergeWindows(file: string, starts: number[], lines: CodeLine[], minLines: number): DuplicatedBlock[] {
  const [first, ...rest] = [...new Set(starts)].sort((a, b) => a - b);
  if (first === undefined) return [];
  const blocks: DuplicatedBlock[] = [];
  let blockStart = first;
  let last = first;
  const flush = (): void => {
    blocks.push({
      file,
      startLine: lines[blockStart]?.line ?? 0,
      endLine: lines[last + minLines - 1]?.line ?? 0,
    });
  };
  for (const start of rest) {
    if (start > last + minLines) {
      flush();
      blockStart = start;
    }
    last = start;
  }
  flush();
  return blocks;
}
