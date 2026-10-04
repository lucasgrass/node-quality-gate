import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectDuplication, normalizeSource } from '../template/scripts/quality-gate/duplication.mts';

test('normalizeSource drops comments, blanks, imports and punctuation, and anonymizes strings', () => {
  const source = [
    "import { a } from './a';",
    '// comment',
    'const url = "http://example.com"; // trailing',
    '/* block',
    "   comment */ const y = 'z';",
    '}',
    'const t = `multi',
    'line`;',
    '',
  ].join('\n');
  const lines = normalizeSource(source);
  assert.deepEqual(
    lines.map(({ line, text }) => [line, text]),
    [
      [3, 'const url = L;'],
      [5, 'const y = L;'],
      [7, 'const t = L'],
      [8, 'L;'],
    ],
  );
  assert.equal(lines[0]?.tokens, 5);
});

test('normalizeSource collapses identical consecutive lines and ignores indentation', () => {
  const lines = normalizeSource('  a();\na();\n\ta();\n  b();\n');
  assert.deepEqual(
    lines.map(({ text }) => text),
    ['a();', 'b();'],
  );
});

const block = (prefix: string): string =>
  Array.from({ length: 12 }, (_, i) => `const ${prefix}${i} = compute(alpha${i}, beta${i}) + ${i};`).join('\n');

test('detectDuplication finds a block copied between files and merges overlapping windows', () => {
  const sources = new Map([
    ['src/a.ts', `export const a = 1;\n${block('v')}\n`],
    ['src/b.ts', `export const b = 2;\n  ${block('v').split('\n').join('\n  // note\n  ')}\nexport const end = 3;\n`],
  ]);
  const result = detectDuplication(sources, { minLines: 5, minTokens: 10 });
  assert.equal(result.fragments, 2);
  assert.deepEqual(result.blocks, [
    { file: 'src/a.ts', startLine: 2, endLine: 13 },
    { file: 'src/b.ts', startLine: 2, endLine: 24 },
  ]);
  assert.equal(result.duplicatedLines, 12 + 23);
  assert.equal(result.totalLines, 13 + 25);
  assert.equal(result.percentage, Math.round(((12 + 23) / (13 + 25)) * 10000) / 100);
});

test('detectDuplication respects the token threshold and reports nothing for distinct code', () => {
  const sources = new Map([
    ['src/a.ts', block('v')],
    ['src/b.ts', block('v')],
    ['src/c.ts', block('w')],
  ]);
  assert.equal(detectDuplication(sources, { minLines: 5, minTokens: 1000 }).fragments, 0);
  assert.equal(detectDuplication(new Map([['src/c.ts', block('w')]]), { minLines: 5, minTokens: 10 }).fragments, 0);
  assert.equal(detectDuplication(sources, { minLines: 5, minTokens: 10 }).fragments, 2);
});

test('detectDuplication handles empty input', () => {
  assert.deepEqual(detectDuplication(new Map(), { minLines: 10, minTokens: 100 }), {
    percentage: 0,
    fragments: 0,
    duplicatedLines: 0,
    totalLines: 0,
    blocks: [],
  });
});
