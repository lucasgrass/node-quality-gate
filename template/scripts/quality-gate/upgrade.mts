/**
 * `upgrade`: replaces this folder with the one from a release of the template, read from
 * GitHub. Everything is downloaded before the first file is written, and the result is a
 * diff to review and commit like any other change.
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRecord } from './util.mts';

const REPOSITORY = 'lucasgrass/node-quality-gate';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const RAW = `https://raw.githubusercontent.com/${REPOSITORY}`;
const SCRIPTS = 'template/scripts/quality-gate/';
const WORKFLOWS = 'template/.github/workflows/';
const TIMEOUT_MS = 15_000;

/** Returns the body of a URL as text and throws when the answer is not a success. */
export type Fetcher = (url: string) => Promise<string>;

export type UpgradeOptions = {
  /** The folder to replace: the one this script runs from. */
  dir: string;
  current: string;
  /** A version to install instead of the latest release. */
  to: string | undefined;
  /** Only say whether another version is available. */
  checkOnly: boolean;
  fetcher?: Fetcher;
  log?: (line: string) => void;
};

/** Blob SHA per path, as the git tree of a release lists them. */
type Tree = Map<string, string>;

export async function upgrade(options: UpgradeOptions): Promise<number> {
  const { dir, current, fetcher = fetchText, log = console.log } = options;
  const target = options.to === undefined ? await latestVersion(fetcher) : parseVersion(options.to);
  const order = compareVersions(target, current);
  if (order === 0) return done(log, `Already on v${current}; nothing to do.`);
  if (order < 0 && options.to === undefined) return done(log, `This copy (v${current}) is newer than the latest release (v${target}).`);
  if (options.checkOnly) return done(log, `v${target} is available (this copy is v${current}). Run "upgrade" to install it.`);

  const tree = await readTree(fetcher, target);
  const names = scriptNames(tree);
  if (!names.includes('cli.mts')) throw new Error(`v${target} has no ${SCRIPTS}cli.mts; nothing was changed`);
  const [contents, changelog, workflows] = await Promise.all([
    Promise.all(names.map((name) => fetcher(`${RAW}/v${target}/${SCRIPTS}${name}`))),
    fetcher(`${RAW}/v${target}/CHANGELOG.md`).catch(() => ''),
    changedWorkflows(fetcher, { from: current, to: target }, tree).catch(() => null),
  ]);
  names.forEach((name, index) => writeFileSync(resolve(dir, name), contents[index] ?? ''));

  log(`Upgraded from v${current} to v${target}: ${names.length} files written.`);
  const stale = readdirSync(dir).filter((name) => name.endsWith('.mts') && !names.includes(name));
  if (stale.length > 0) log(`No longer part of the template, delete if you did not add them: ${stale.join(', ')}`);
  const notes = changelogBetween(changelog, current, target);
  if (notes !== '') log(`\n${notes}\n`);
  log(workflowAdvice(workflows, current, target));
  log('Review the diff, run "check" and commit.');
  return 0;
}

function done(log: (line: string) => void, message: string): number {
  log(message);
  return 0;
}

/** "v0.2.0" or "0.2.0" -> "0.2.0". Anything else is refused: the value goes into URLs. */
export function parseVersion(text: string): string {
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(text.trim())?.[1];
  if (version === undefined) throw new Error(`"${text}" is not a version (expected something like 0.2.0)`);
  return version;
}

/** Negative when `a` is older than `b`, positive when newer, zero when equal. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The sections of a Keep a Changelog file for versions after `from`, up to and including `to`. */
export function changelogBetween(changelog: string, from: string, to: string): string {
  const sections = changelog.split(/^(?=## \[)/m).filter((section) => {
    const version = /^## \[(\d+\.\d+\.\d+)\]/.exec(section)?.[1];
    return version !== undefined && compareVersions(version, from) > 0 && compareVersions(version, to) <= 0;
  });
  return sections.join('').trim();
}

async function latestVersion(fetcher: Fetcher): Promise<string> {
  const release: unknown = JSON.parse(await fetcher(`${API}/releases/latest`));
  if (!isRecord(release) || typeof release.tag_name !== 'string') throw new Error('GitHub did not name the latest release');
  return parseVersion(release.tag_name);
}

async function readTree(fetcher: Fetcher, version: string): Promise<Tree> {
  const body: unknown = JSON.parse(await fetcher(`${API}/git/trees/v${version}?recursive=1`));
  const entries: unknown[] = isRecord(body) && Array.isArray(body.tree) ? body.tree : [];
  const tree: Tree = new Map();
  for (const entry of entries) {
    if (isRecord(entry) && entry.type === 'blob' && typeof entry.path === 'string' && typeof entry.sha === 'string') {
      tree.set(entry.path, entry.sha);
    }
  }
  return tree;
}

/** The files directly inside the scripts folder; plain names only, so nothing is written elsewhere. */
function scriptNames(tree: Tree): string[] {
  const names = [...tree.keys()].filter((path) => path.startsWith(SCRIPTS)).map((path) => path.slice(SCRIPTS.length));
  return names.filter((name) => /^[\w-]+(\.[\w-]+)*$/.test(name)).sort();
}

/**
 * Workflow templates that differ between the two releases in more than the version stamp
 * on their first line, which every release rewrites.
 */
async function changedWorkflows(fetcher: Fetcher, versions: { from: string; to: string }, target: Tree): Promise<string[]> {
  const previous = await readTree(fetcher, versions.from);
  const candidates = [...target].filter(([path, sha]) => path.startsWith(WORKFLOWS) && previous.get(path) !== sha);
  const body = async (version: string, path: string): Promise<string> =>
    (await fetcher(`${RAW}/v${version}/${path}`)).split('\n').slice(1).join('\n');
  const differs = await Promise.all(
    candidates.map(async ([path]) => !previous.has(path) || (await body(versions.from, path)) !== (await body(versions.to, path))),
  );
  return candidates.filter((_, index) => differs[index]).map(([path]) => path.slice(WORKFLOWS.length)).sort();
}

/** What to do about the workflow, which the adopter edited and `upgrade` therefore leaves alone. */
function workflowAdvice(changed: string[] | null, current: string, target: string): string {
  const compare = `https://github.com/${REPOSITORY}/compare/v${current}...v${target}`;
  if (changed === null) return `Could not compare the workflow templates; see ${compare}`;
  if (changed.length === 0) return 'The workflow templates did not change; your workflow needs no edit.';
  return `The workflow templates changed (${changed.join(', ')}); your workflow is not touched, apply what applies to it from ${compare}`;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'node-quality-gate' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const hint = response.status === 403 || response.status === 429 ? ' (GitHub rate limit; try again later)' : '';
    throw new Error(`GET ${url} answered ${response.status}${hint}`);
  }
  return response.text();
}
