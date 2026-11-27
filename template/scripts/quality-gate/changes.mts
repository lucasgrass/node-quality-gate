/**
 * What the change itself did, measured against the merge base with the base branch:
 * patch coverage, new files without coverage and dependencies added to package.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config.mts';
import {
  addUntracked,
  diffSinceBase,
  measurePatchCoverage,
  parseAddedLines,
  parseNewFiles,
  unmeasuredFiles,
  untestedFiles,
  untrackedFiles,
  type FileCoverage,
} from './coverage.mts';
import type { NewDependency, PatchCoverage } from './types.mts';
import { git, isRecord } from './util.mts';

const MANIFEST = 'package.json';

export type Changes = {
  patch: PatchCoverage;
  /** Changed source files the coverage report does not mention. */
  unmeasured: string[];
  /** New source files the coverage report lists without a single line hit. */
  untested: string[];
  dependencies: NewDependency[];
};

export type ChangeInputs = {
  config: Config;
  /** The base ref, already resolved from `--base`, GITHUB_BASE_REF or the config. */
  base: string;
  coverage: Map<string, FileCoverage>;
  /** The linted files that are not excluded. */
  sources: ReadonlySet<string>;
  cwd: string;
};

export function measureChanges({ config, base, coverage, sources, cwd }: ChangeInputs): Changes {
  const { patchCoverage, untestedFiles: untestedOptions, newDependencies: dependencyOptions } = config;
  const dependencies = dependencyOptions.enabled ? newDependencies(base, dependencyOptions.sections, cwd) : [];
  const skipped = (reason: string): PatchCoverage => ({ status: 'skipped', reason });
  const diff = diffSinceBase(base, cwd);
  if (diff === null) {
    const patch = skipped(patchCoverage.enabled ? `base ref ${base} not found; fetch it or set patchCoverage.baseRef` : 'disabled in the config');
    return { patch, unmeasured: [], untested: [], dependencies };
  }
  const added = parseAddedLines(diff);
  const untracked = untrackedFiles(cwd);
  const untested = untestedOptions.enabled ? untestedFiles([...parseNewFiles(diff), ...untracked], coverage, sources) : [];
  if (!patchCoverage.enabled) return { patch: skipped('disabled in the config'), unmeasured: [], untested, dependencies };
  const changed = [...added].filter(([, lines]) => lines.length > 0).map(([file]) => file);
  return {
    unmeasured: unmeasuredFiles([...changed, ...untracked], coverage, sources),
    patch: measurePatchCoverage(addUntracked(added, untracked, coverage), coverage, patchCoverage.minLines),
    untested,
    dependencies,
  };
}

/**
 * package.json in the working tree against the one at the merge base with `base`. Empty when
 * either cannot be read: a package that is new in the change has nothing to be compared with.
 */
export function newDependencies(base: string, sections: string[], cwd: string): NewDependency[] {
  const mergeBase = git(['merge-base', base, 'HEAD'], cwd)?.trim();
  const before = mergeBase ? git(['show', `${mergeBase}:./${MANIFEST}`], cwd) : null;
  const file = resolve(cwd, MANIFEST);
  if (!before || !existsSync(file)) return [];
  try {
    return addedDependencies(JSON.parse(before), JSON.parse(readFileSync(file, 'utf8')), sections);
  } catch {
    return []; // not JSON on one of the sides: the install step is the one to complain
  }
}

/**
 * Names in a section of `after` that the same section of `before` does not have. A new
 * version of a known dependency is not reported; one moved to another section is.
 */
export function addedDependencies(before: unknown, after: unknown, sections: string[]): NewDependency[] {
  const added: NewDependency[] = [];
  for (const section of sections) {
    const previous = dependencySection(before, section);
    const names = Object.keys(dependencySection(after, section)).sort();
    for (const name of names) {
      if (!Object.hasOwn(previous, name)) added.push({ name, version: String(dependencySection(after, section)[name]), section });
    }
  }
  return added;
}

function dependencySection(manifest: unknown, section: string): Record<string, unknown> {
  const value = isRecord(manifest) ? manifest[section] : undefined;
  return isRecord(value) ? value : {};
}
