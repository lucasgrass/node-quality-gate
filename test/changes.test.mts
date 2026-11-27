import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedDependencies } from '../template/scripts/quality-gate/changes.mts';

const SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

test('addedDependencies lists new names per section, sorted, and ignores version bumps', () => {
  const before = { dependencies: { express: '^4.0.0' }, devDependencies: { vitest: '^3.0.0', zod: '^3.0.0' } };
  const after = {
    dependencies: { zod: '^3.0.0', express: '^5.0.0', 'left-pad': '^1.3.0' },
    devDependencies: { vitest: '^3.0.0', eslint: '^10.0.0' },
    peerDependencies: { react: '>=18' },
  };
  assert.deepEqual(addedDependencies(before, after, SECTIONS), [
    { name: 'left-pad', version: '^1.3.0', section: 'dependencies' },
    { name: 'zod', version: '^3.0.0', section: 'dependencies' }, // moved out of devDependencies
    { name: 'react', version: '>=18', section: 'peerDependencies' },
  ]);
  assert.deepEqual(addedDependencies(before, after, ['devDependencies']), [
    { name: 'eslint', version: '^10.0.0', section: 'devDependencies' },
  ]);
});

test('addedDependencies copes with removals and with manifests that are not what they should be', () => {
  assert.deepEqual(addedDependencies({ dependencies: { a: '1' } }, { dependencies: {} }, SECTIONS), []);
  assert.deepEqual(addedDependencies(null, { dependencies: ['a'] }, SECTIONS), []);
  assert.deepEqual(addedDependencies('x', { dependencies: { a: '1' } }, SECTIONS), [
    { name: 'a', version: '1', section: 'dependencies' },
  ]);
});
