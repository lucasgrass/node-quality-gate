import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  changelogBetween,
  compareVersions,
  parseVersion,
  upgrade,
  type Fetcher,
} from '../template/scripts/quality-gate/upgrade.mts';

const API = 'https://api.github.com/repos/lucasgrass/node-quality-gate';
const RAW = 'https://raw.githubusercontent.com/lucasgrass/node-quality-gate';
const SCRIPTS = 'template/scripts/quality-gate';
const WORKFLOWS = 'template/.github/workflows';

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.3.0] - 2027-01-10

### Added

- Something later.

## [0.2.0] - 2026-12-01

### Added

- The upgrade command.

## [0.1.1] - 2026-11-26

No change in behaviour.
`;

const dir = mkdtempSync(join(tmpdir(), 'qg-upgrade-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function blob(path: string, sha: string): { path: string; type: string; sha: string } {
  return { path, type: 'blob', sha };
}

/** A release v0.2.0 next to v0.1.1: one script changed, one added, the npm workflow edited, the pnpm one only restamped. */
function responses(): Record<string, string> {
  return {
    [`${API}/releases/latest`]: JSON.stringify({ tag_name: 'v0.2.0' }),
    [`${API}/git/trees/v0.2.0?recursive=1`]: JSON.stringify({
      tree: [
        { path: SCRIPTS, type: 'tree', sha: 't' },
        blob(`${SCRIPTS}/cli.mts`, 'c2'),
        blob(`${SCRIPTS}/upgrade.mts`, 'u2'),
        blob(`${SCRIPTS}/../../evil.mts`, 'e2'),
        blob(`${SCRIPTS}/nested/deep.mts`, 'n2'),
        blob(`${WORKFLOWS}/quality-gate.npm.yml`, 'n2'),
        blob(`${WORKFLOWS}/quality-gate.pnpm.yml`, 'p2'),
        blob(`${WORKFLOWS}/quality-gate.yarn.yml`, 'same'),
        blob('README.md', 'r2'),
      ],
    }),
    [`${API}/git/trees/v0.1.1?recursive=1`]: JSON.stringify({
      tree: [
        blob(`${WORKFLOWS}/quality-gate.npm.yml`, 'n1'),
        blob(`${WORKFLOWS}/quality-gate.pnpm.yml`, 'p1'),
        blob(`${WORKFLOWS}/quality-gate.yarn.yml`, 'same'),
      ],
    }),
    [`${RAW}/v0.2.0/${SCRIPTS}/cli.mts`]: '// cli 0.2.0\n',
    [`${RAW}/v0.2.0/${SCRIPTS}/upgrade.mts`]: '// upgrade 0.2.0\n',
    [`${RAW}/v0.2.0/CHANGELOG.md`]: CHANGELOG,
    [`${RAW}/v0.1.1/${WORKFLOWS}/quality-gate.npm.yml`]: '# v0.1.1\nsteps: old\n',
    [`${RAW}/v0.2.0/${WORKFLOWS}/quality-gate.npm.yml`]: '# v0.2.0\nsteps: new\n',
    [`${RAW}/v0.1.1/${WORKFLOWS}/quality-gate.pnpm.yml`]: '# v0.1.1\nsteps: same\n',
    [`${RAW}/v0.2.0/${WORKFLOWS}/quality-gate.pnpm.yml`]: '# v0.2.0\nsteps: same\n',
  };
}

function harness(overrides: Record<string, string | null> = {}): { fetcher: Fetcher; log: (line: string) => void; lines: string[]; urls: string[] } {
  const bodies: Record<string, string | null> = { ...responses(), ...overrides };
  const lines: string[] = [];
  const urls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    urls.push(url);
    const body = bodies[url];
    if (body === undefined || body === null) throw new Error(`GET ${url} answered 404`);
    return body;
  };
  return { fetcher, log: (line) => lines.push(line), lines, urls };
}

test('parseVersion, compareVersions and changelogBetween', () => {
  assert.equal(parseVersion('v0.2.0'), '0.2.0');
  assert.equal(parseVersion(' 1.10.3 '), '1.10.3');
  assert.throws(() => parseVersion('main'), /"main" is not a version/);
  assert.throws(() => parseVersion('0.2.0/../x'), /not a version/);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('0.1.1', '0.2.0') < 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(changelogBetween(CHANGELOG, '0.1.1', '0.2.0'), '## [0.2.0] - 2026-12-01\n\n### Added\n\n- The upgrade command.');
  assert.match(changelogBetween(CHANGELOG, '0.1.1', '0.3.0'), /^## \[0\.3\.0\][^]*## \[0\.2\.0\]/);
  assert.equal(changelogBetween(CHANGELOG, '0.3.0', '0.3.0'), '');
});

test('upgrade --check only reports, and an up-to-date copy is left alone', async () => {
  const check = harness();
  assert.equal(await upgrade({ dir, current: '0.1.1', to: undefined, checkOnly: true, ...check }), 0);
  assert.deepEqual(check.lines, ['v0.2.0 is available (this copy is v0.1.1). Run "upgrade" to install it.']);
  assert.deepEqual(check.urls, [`${API}/releases/latest`]);
  assert.deepEqual(readdirSync(dir), []);

  const same = harness();
  assert.equal(await upgrade({ dir, current: '0.2.0', to: undefined, checkOnly: false, ...same }), 0);
  assert.deepEqual(same.lines, ['Already on v0.2.0; nothing to do.']);

  const ahead = harness();
  assert.equal(await upgrade({ dir, current: '0.9.0', to: undefined, checkOnly: false, ...ahead }), 0);
  assert.deepEqual(ahead.lines, ['This copy (v0.9.0) is newer than the latest release (v0.2.0).']);
  assert.deepEqual(readdirSync(dir), []);
});

test('upgrade writes the scripts of the release, shows the changelog and says which workflows changed', async () => {
  writeFileSync(join(dir, 'cli.mts'), '// cli 0.1.1\n');
  writeFileSync(join(dir, 'gone.mts'), '// removed from the template\n');
  const { fetcher, log, lines } = harness();
  assert.equal(await upgrade({ dir, current: '0.1.1', to: undefined, checkOnly: false, fetcher, log }), 0);
  assert.deepEqual(readdirSync(dir).sort(), ['cli.mts', 'gone.mts', 'upgrade.mts']);
  assert.equal(readFileSync(join(dir, 'cli.mts'), 'utf8'), '// cli 0.2.0\n');
  assert.equal(readFileSync(join(dir, 'upgrade.mts'), 'utf8'), '// upgrade 0.2.0\n');
  const output = lines.join('\n');
  assert.match(output, /^Upgraded from v0\.1\.1 to v0\.2\.0: 2 files written\./);
  assert.match(output, /No longer part of the template, delete if you did not add them: gone\.mts/);
  assert.match(output, /## \[0\.2\.0\] - 2026-12-01/);
  assert.doesNotMatch(output, /0\.3\.0|0\.1\.1\] /);
  assert.match(output, /The workflow templates changed \(quality-gate\.npm\.yml\); your workflow is not touched, .*compare\/v0\.1\.1\.\.\.v0\.2\.0/);
});

test('upgrade --to installs that version, and survives a release it cannot compare with', async () => {
  rmSync(join(dir, 'gone.mts'));
  writeFileSync(join(dir, 'cli.mts'), '// cli 0.1.1\n');
  const { fetcher, log, lines, urls } = harness({ [`${API}/git/trees/v0.1.1?recursive=1`]: null, [`${RAW}/v0.2.0/CHANGELOG.md`]: null });
  assert.equal(await upgrade({ dir, current: '0.1.1', to: 'v0.2.0', checkOnly: false, fetcher, log }), 0);
  assert.ok(!urls.includes(`${API}/releases/latest`));
  assert.equal(readFileSync(join(dir, 'cli.mts'), 'utf8'), '// cli 0.2.0\n');
  assert.deepEqual(lines, [
    'Upgraded from v0.1.1 to v0.2.0: 2 files written.',
    'Could not compare the workflow templates; see https://github.com/lucasgrass/node-quality-gate/compare/v0.1.1...v0.2.0',
    'Review the diff, run "check" and commit.',
  ]);
});

test('upgrade says so when no workflow changed beyond its version stamp', async () => {
  const { fetcher, log, lines } = harness({ [`${RAW}/v0.2.0/${WORKFLOWS}/quality-gate.npm.yml`]: '# v0.2.0\nsteps: old\n' });
  assert.equal(await upgrade({ dir, current: '0.1.1', to: undefined, checkOnly: false, fetcher, log }), 0);
  assert.ok(lines.includes('The workflow templates did not change; your workflow needs no edit.'));
});

test('upgrade changes nothing when a download fails or the release has no scripts', async () => {
  writeFileSync(join(dir, 'cli.mts'), '// cli 0.1.1\n');
  const broken = harness({ [`${RAW}/v0.2.0/${SCRIPTS}/upgrade.mts`]: null });
  await assert.rejects(upgrade({ dir, current: '0.1.1', to: undefined, checkOnly: false, ...broken }), /upgrade\.mts answered 404/);
  assert.equal(readFileSync(join(dir, 'cli.mts'), 'utf8'), '// cli 0.1.1\n');

  const empty = harness({ [`${API}/git/trees/v0.2.0?recursive=1`]: JSON.stringify({ tree: [] }) });
  await assert.rejects(upgrade({ dir, current: '0.1.1', to: undefined, checkOnly: false, ...empty }), /v0\.2\.0 has no template\/scripts\/quality-gate\/cli\.mts; nothing was changed/);

  const unnamed = harness({ [`${API}/releases/latest`]: JSON.stringify({ message: 'Not Found' }) });
  await assert.rejects(upgrade({ dir, current: '0.1.1', to: undefined, checkOnly: false, ...unnamed }), /did not name the latest release/);
  assert.equal(readFileSync(join(dir, 'cli.mts'), 'utf8'), '// cli 0.1.1\n');
});
