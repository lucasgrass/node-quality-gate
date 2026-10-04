# node-quality-gate manual

A ratchet-style quality gate for Node repositories. It measures a few things
on every pull request, compares them with a committed baseline and fails only
when something gets **worse**. Nothing has to be perfect to adopt it; it just
cannot regress.

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Commands](#commands)
- [What counts as a regression](#what-counts-as-a-regression)
- [Configuration reference](#configuration-reference)
- [The baseline file](#the-baseline-file)
- [The workflow, step by step](#the-workflow-step-by-step)
- [Patch coverage](#patch-coverage)
- [Duplication](#duplication)
- [ESLint notes](#eslint-notes)
- [Package manager notes](#package-manager-notes)
- [Adopting in a legacy repository](#adopting-in-a-legacy-repository)
- [Monorepos](#monorepos)
- [Updating your copy](#updating-your-copy)
- [Troubleshooting](#troubleshooting)

## How it works

```
npm ci ──► audit critical ──► audit high ──► lint ──► test:coverage ──► quality-gate check ──► PR comment ──► artifacts
            (blocks)          (warns)        (blocks)  (lcov.info)       (the ratchet)          + job summary
```

`quality-gate check` reads the reports the previous steps produced, measures
the repository and compares it with `quality-gate.baseline.json`:

| Metric | Source | Regression when |
|---|---|---|
| Lines, functions, branches coverage | `coverage/lcov.info` | a value drops more than the tolerance |
| Patch coverage (changed lines) | lcov + `git diff` | below the threshold (warning by default) |
| Quality rule violations | ESLint, rules injected as warnings | the total grows, or a file/rule pair grows |
| Oversized files | file sizes | a new file crosses the limit, or an oversized file grows |
| Duplication | built-in detector | the percentage or the number of fragments grows |

Improvements never fail the gate; they are listed so you can lock them in by
updating the baseline. The baseline lives in your repository, so every change
to the bar is visible in a pull request diff.

## Requirements

- **Node.js 22.18 or newer** (24 LTS recommended). The gate is TypeScript that
  Node runs directly, without a build step. On older Node, run it with
  `npx tsx scripts/quality-gate/cli.mts ...` instead. Bun 1.2+ also runs it.
- **ESLint 9 or newer** with a flat config (`eslint.config.js`). The gate runs
  ESLint itself to count quality-rule violations.
- A test runner that writes **lcov**: Jest, Vitest, c8, `node --test`, Bun.
- `git` and the base branch available when the gate runs (the workflows use
  `fetch-depth: 0` for that). Without it, patch coverage is skipped with a
  notice; everything else still works.

## Installation

### 1. Copy the files

From the `template/` folder of this repository into the root of your project:

| From `template/` | To your project | Purpose |
|---|---|---|
| `scripts/quality-gate/` | `scripts/quality-gate/` | the gate (9 small files, no dependencies) |
| `quality-gate.config.json` | `quality-gate.config.json` | limits and tolerances; every key is optional |
| `.github/workflows/quality-gate.<pm>.yml` | `.github/workflows/quality-gate.yml` | pick `npm`, `pnpm`, `yarn` or `bun` |
| `.github/dependabot.yml` | `.github/dependabot.yml` | keeps the pinned actions current (merge with yours if you have one) |

One-liner alternatives: clone this repository and `cp -R`, or
`npx degit lucasgrass/node-quality-gate/template /tmp/qg && cp -R /tmp/qg/. .`
(then delete the workflows you do not use).

If your `tsc` or ESLint picks up `scripts/`, that is fine: the files are
strict TypeScript with no `any`. Exclude the folder if you prefer; the gate
always excludes itself from its own measurements.

### 2. Add the scripts the workflow calls

The workflow runs `lint` and `test:coverage`. Name them exactly like that or
edit the workflow.

```jsonc
{
  "scripts": {
    "lint": "eslint .",
    "test:coverage": "vitest run --coverage"
  }
}
```

`test:coverage` must write `coverage/lcov.info` (or set `coverage.lcov` in the
config). Per runner:

| Runner | Setting |
|---|---|
| Vitest | `coverage: { provider: 'v8', reporter: ['text', 'lcov'] }` in `vitest.config.ts`; script `vitest run --coverage` |
| Jest | `coverageReporters: ['text', 'lcov']` in the Jest config; script `jest --coverage` |
| c8 | `c8 --reporter=text --reporter=lcov <your test command>` |
| `node --test` | `node --test --experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=coverage/lcov.info` |
| Bun | `bun test --coverage --coverage-reporter=lcov` (Bun writes `coverage/lcov.info`; it cannot emit `json-summary`, which is why the gate reads lcov) |

### 3. Check the environment

```sh
node scripts/quality-gate/cli.mts doctor
```

It verifies the Node version, the config, the coverage report, that ESLint
runs, that the base branch is reachable and the baseline schema. Fix anything
marked `FAIL`.

### 4. Write the first baseline and commit it

```sh
npm run lint
npm run test:coverage
node scripts/quality-gate/cli.mts baseline
git add quality-gate.baseline.json
```

Commit the baseline together with the copied files and open a pull request.
From then on every pull request runs the gate.

### 5. Make the check required

In the repository settings, add the "Quality gate" check to the branch
protection (or ruleset) of `main`. Without that the gate is advisory: it turns
red but a merge is still possible.

## Commands

```
node scripts/quality-gate/cli.mts <command> [options]
```

| Command | What it does | Exit code |
|---|---|---|
| `check` | Measures, compares with the baseline, writes `reports/quality-gate.md` and `.json`, appends the job summary and prints annotations in GitHub Actions | 0 pass, 1 regressions |
| `baseline` | Measures and writes `quality-gate.baseline.json`. Refuses if the result would be worse than the current baseline | 0 written, 1 refused |
| `doctor` | Checks the environment before the first run | 0 ok, 2 problems |

| Option | Meaning |
|---|---|
| `--config <path>` | Config file (default `quality-gate.config.json`; defaults apply when it is missing) |
| `--base <ref>` | Git ref to diff against for patch coverage (default: `origin/<GITHUB_BASE_REF>` on pull requests, else `patchCoverage.baseRef`) |
| `--allow-regression` | Let `baseline` record values worse than the current baseline, on purpose |
| `--version`, `--help` | |

Exit code 2 means a usage or environment problem (missing coverage report,
invalid config, ESLint could not run), never a quality verdict.

Environment variables: `QG_ESLINT_COMMAND` overrides `eslint.command` (the
pnpm, Yarn and Bun workflows use it); `GITHUB_BASE_REF`, `GITHUB_ACTIONS` and
`GITHUB_STEP_SUMMARY` are read when present.

## What counts as a regression

| Metric | Rule | Message |
|---|---|---|
| Coverage (lines, functions, branches) | current < baseline − `coverage.tolerance` | `Lines coverage dropped from 80.5% to 79.1%` |
| Patch coverage | below `patchCoverage.threshold`; warning in `warn` mode, regression in `block` mode; skipped under `minLines` coverable lines | `Patch coverage 72% is below the minimum of 80% (36 of 50 changed lines covered)` |
| Duplication percentage | current > baseline + `duplication.tolerance` | `Duplication rose from 2.2% to 2.5%` |
| Duplicated fragments | current > baseline | `Duplicated fragments increased from 95 to 96` |
| Quality rule violations (total) | current > baseline | `Quality rule violations increased from 483 to 484` |
| Quality rule violations (per file and rule) | current > baseline, for files the baseline knows | `max-depth violations increased in src/api.ts (2 -> 9)` |
| Oversized files (count) | current > baseline | `Oversized files increased from 19 to 20` |
| New oversized file | file not in the baseline is over `size.maxLines` or `size.maxBytes` | `src/big.ts crossed the limit with 500 lines and 21000 bytes` |
| Oversized file grew | lines or bytes above the baseline entry | `src/big.ts grew from 1008 to 1140 lines while already over the limit` |

Files that are new (or renamed) are not compared per file, only through the
totals, so moving a file with existing violations does not fail the gate.
After such a move, run `baseline` in the same pull request so the new path is
tracked from then on.

## Configuration reference

`quality-gate.config.json`, every key optional. Unknown keys are an error, so
typos cannot silently disable a check.

```json
{
  "coverage": { "lcov": "coverage/lcov.info", "tolerance": 0.1 },
  "patchCoverage": { "enabled": true, "mode": "warn", "threshold": 80, "minLines": 20, "baseRef": "origin/main" },
  "eslint": {
    "command": "npx eslint",
    "args": ["."],
    "qualityRules": {
      "complexity": 20, "max-depth": 4, "max-lines": 300,
      "max-lines-per-function": 50, "max-params": 3, "max-nested-callbacks": 10
    }
  },
  "size": { "maxLines": 400, "maxBytes": 40000 },
  "duplication": { "minLines": 10, "minTokens": 100, "tolerance": 0.1 },
  "exclude": ["**/*.test.*", "**/*.spec.*", "**/*.d.ts", "**/__snapshots__/**"]
}
```

| Key | Default | Meaning |
|---|---|---|
| `coverage.lcov` | `coverage/lcov.info` | Path of the lcov report |
| `coverage.tolerance` | `0.1` | Percentage points a coverage value may drop before it is a regression (absorbs rounding noise) |
| `patchCoverage.enabled` | `true` | Measure coverage of the changed lines |
| `patchCoverage.mode` | `"warn"` | `"warn"` lists it under Warnings; `"block"` makes it a regression |
| `patchCoverage.threshold` | `80` | Minimum percentage of changed, instrumented lines that must be covered (SonarQube's default) |
| `patchCoverage.minLines` | `20` | Skip the check when fewer changed lines are coverable (SonarQube's rule for small changes) |
| `patchCoverage.baseRef` | `"origin/main"` | Ref to diff against outside pull requests |
| `eslint.command` | `"npx eslint"` | How to start ESLint; `pnpm exec eslint`, `yarn eslint`, `bunx eslint` |
| `eslint.args` | `["."]` | What to lint; the gate appends `--format json --output-file reports/eslint.json` and the rules |
| `eslint.qualityRules` | ESLint's defaults | Rules counted as quality violations, each with its option (`true` for rules without options). They run at warning level on top of your config |
| `size.maxLines` / `size.maxBytes` | `400` / `40000` | A file over either limit is oversized |
| `duplication.minLines` | `10` | Window size in normalized code lines (SonarQube uses 10) |
| `duplication.minTokens` | `100` | Minimum tokens in a window for it to count (SonarQube uses 100) |
| `duplication.tolerance` | `0.1` | Percentage points the duplication may rise before it is a regression |
| `exclude` | tests, `.d.ts`, snapshots | Globs (`**`, `*`, `?`) of files ignored by the violation, size and duplication checks. Coverage is whatever your runner reports |

## The baseline file

`quality-gate.baseline.json` is generated; do not edit it by hand.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-03T21:40:12.511Z",
  "commit": "8678bbd",
  "tool": "node-quality-gate 0.1.0",
  "coverage": { "lines": 9.09, "functions": 25, "branches": 0 },
  "duplication": { "percentage": 0, "fragments": 0 },
  "violations": { "qualityRules": 3, "oversizedFiles": 0 },
  "oversized": {},
  "ruleViolations": { "src/legacy.ts": { "max-depth": 2, "max-params": 1 } }
}
```

When to update it:

- **Your pull request improves a metric.** The report lists the improvements
  and the job prints a notice. Run `baseline` and commit the file in the same
  pull request; the bar moves up with the code.
- **You moved or renamed files** that had violations or were oversized. Run
  `baseline` so the new paths are tracked.
- **You need to loosen it on purpose** (a vendored file, a generated module).
  `baseline` refuses and lists what would get worse; rerun it with
  `--allow-regression`. The diff of the baseline shows reviewers exactly what
  was accepted. Prefer `exclude` for generated code.

If a pull request does not update the baseline after improving things, nothing
breaks; the next pull request simply has some slack. The gate compares against
the baseline **committed in the branch**, so a reviewer should look at any
baseline change the same way they look at code.

## The workflow, step by step

The four workflows in `template/.github/workflows/` have the same shape:

1. **Install** with the lockfile frozen (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `bun install --frozen-lockfile`).
2. **Audit, critical** with the package manager's own `--audit-level`/`--severity` flag. Fails the job.
3. **Audit, high**. Prints a warning annotation, never fails.
4. **Lint** with your own `lint` script. Lint errors fail here, before the gate.
5. **Tests with coverage**, writing `coverage/lcov.info`.
6. **Quality gate**: `check`. Writes the reports, the job summary and the annotations.
7. **Sticky pull request comment** via `actions/github-script`: one comment per pull request, updated in place (it is found by the hidden `<!-- node-quality-gate -->` marker). Runs even when the gate failed. Skipped on pull requests from forks, where the token is read-only; the job summary still shows everything.
8. **Artifacts**: `coverage/` and `reports/` (the Markdown and JSON reports plus the raw ESLint JSON), uploaded even on failure.

Hygiene baked in: every action is pinned to a full commit SHA with the version
in a comment (Dependabot keeps them current), `permissions` are the minimum
(`contents: read`, `pull-requests: write`), `concurrency` cancels superseded
runs, and `timeout-minutes` stops runaway jobs.

Limits the gate respects: at most 10 error and 10 warning annotations per
step (the rest are in the summary), a 1 MiB job summary and a 65,536-character
comment, truncated with a note when needed.

## Patch coverage

Project-wide coverage can be gamed: adding a lot of trivially tested code
raises the percentage while the risky change stays untested. Patch coverage
looks only at the lines the pull request added or changed, the way Codecov's
`patch` status and SonarQube's "new code" conditions do.

How it is computed: `git diff -U0 <merge-base>` gives the added line ranges
per file; the `DA:` records of the lcov report say which of those lines are
instrumented and executed. Files git does not track yet (local runs before a
commit) count as entirely new. Lines the coverage report does not know
(comments, types, files outside the coverage `include`) are not counted.

Following SonarQube, the check is skipped when fewer than `minLines` (20)
changed lines are coverable, so a small fix is not failed over one line.

It starts as a **warning** so legacy repositories can adopt the gate without
rewriting their tests first. When the team is ready, set
`"patchCoverage": { "mode": "block" }`.

## Duplication

The detector is built in, so there is nothing to install, and it follows the
parameters SonarQube uses for JavaScript and TypeScript:

1. Each file is normalized line by line: comments, blank lines, `import`/
   `require` lines and lines made only of punctuation (`}`, `]);`) are
   dropped; whitespace is collapsed; the contents of string and template
   literals are replaced by a placeholder; identical consecutive lines are
   collapsed.
2. Every window of `minLines` (10) consecutive normalized lines that contains
   at least `minTokens` (100) tokens is hashed.
3. A hash that occurs in two places is a clone. Overlapping and adjacent clone
   windows merge into one block.
4. **Fragments** is the number of duplicated blocks; **Percentage** is the
   share of physical lines inside a duplicated block.

What it catches: copy-pasted blocks, including ones that were re-indented,
re-commented or had their strings edited. What it does not catch: a copy that
was reformatted onto a different number of lines, or one where identifiers
were renamed. That is the trade-off for having no parser; for a ratchet the
number only has to be stable, and it is.

Tuning: lower `minTokens` (50) to be closer to jscpd's defaults and catch
smaller blocks; raise `minLines` for a quieter signal. If you need token-level
detection, install [jscpd](https://github.com/kucherenko/jscpd) and run it in
your `lint` script with its own `--threshold`; the gate's duplication check can
stay as a second opinion or be ignored.

## ESLint notes

- The gate runs ESLint with **your** configuration and appends
  `--rule "<rule>: [1, <option>]"` for every entry of `qualityRules`, so the
  rules are measured at warning level even if your config does not enable
  them. Your own `lint` step is unaffected.
- Only messages with a rule id are counted. Parsing errors are not quality
  violations; they fail your `lint` step.
- **Bulk suppressions** (`eslint-suppressions.json`, ESLint 9.24+): suppressed
  messages are not counted. If you ratchet a rule through suppressions, keep
  it out of `qualityRules` to avoid tracking it twice. The two mechanisms
  differ: suppressions only work for rules configured as `error` and exit
  with code 2 when an entry becomes unused; the gate works with warnings and
  reports a table with deltas.
- The gate needs the flat config (`eslint.config.js`). It passes
  `--no-warn-ignored`, which the legacy `.eslintrc` mode rejects.
- oxlint and Biome are not supported in this version; their JSON formats
  differ and their quality rules do not take the same options.

## Package manager notes

| | npm | pnpm | Yarn 2+ | Bun |
|---|---|---|---|---|
| Install | `npm ci` | `pnpm install --frozen-lockfile` | `yarn install --immutable` | `bun install --frozen-lockfile` |
| Audit | `npm audit --audit-level=<level>` | `pnpm audit --audit-level=<level>` | `yarn npm audit --severity <level>` | `bun audit --audit-level=<level>` (Bun 1.2.21+) |
| ESLint command | `npx eslint` | `pnpm exec eslint` | `yarn eslint` | `bunx eslint` |
| Runs the gate with | `node` | `node` | `node` | `bun` |

- **npm**: `npm audit signatures` (commented out in the workflow) verifies
  registry signatures and provenance attestations of the installed packages.
- **pnpm**: `pnpm/action-setup` reads the version from `packageManager` in
  `package.json`; add `with: version: 10` if you do not pin one.
- **Yarn 2+** needs Corepack; the workflow enables it. Node 25+ no longer
  bundles Corepack, add `npm i -g corepack` before `corepack enable` there.
- **Yarn 1 (classic)**: `yarn audit --level` filters the output but the exit
  code is always a bitmask of every severity found (1 info, 2 low, 4 moderate,
  8 high, 16 critical). Use `yarn audit || [ $(( $? & 16 )) -eq 0 ]` to fail
  only on critical, and `& 24` for high and critical.
- **Bun**: `bun test --coverage --coverage-reporter=lcov` writes
  `coverage/lcov.info`. Bun's own `coverageThreshold` does not fail the run
  when only the lcov reporter is enabled; the gate's coverage rules cover that.

## Adopting in a legacy repository

1. Copy the files and run `doctor`; fix the environment, not the code.
2. Run `baseline`. It records today's numbers, however bad: 7% coverage and
   483 violations are a valid starting point (that is where the original
   pipeline started).
3. Open the pull request with the files and the baseline. Make the check
   required.
4. From now on every pull request must not make things worse. Improvements
   are locked in by updating the baseline in the pull request that made them.
5. When the team wants more, tighten one knob at a time: `patchCoverage.mode`
   to `block`, a lower `complexity`, a smaller `maxLines`.

## Monorepos

This version measures one package at a time: the config, baseline and
reports live in the folder where the command runs. Copy `scripts/quality-gate/`
once at the root and run `node ../../scripts/quality-gate/cli.mts check` from
each package (one job per package in the workflow, with `working-directory`).
A single aggregated gate is on the roadmap.

## Updating your copy

The first line of `scripts/quality-gate/cli.mts` and of each workflow states
the template version; `node scripts/quality-gate/cli.mts --version` prints it.
To update, copy the new `scripts/quality-gate/` over yours, read the
[CHANGELOG](../CHANGELOG.md) for config or baseline changes, and diff the
workflow against the template (your edits are usually the script names and
the Node version). A baseline with an old `schemaVersion` is rejected with a
message asking you to run `baseline` again.

## Troubleshooting

**`coverage report not found at coverage/lcov.info`** — the `test:coverage`
script did not run or writes elsewhere. Check the reporter settings above or
set `coverage.lcov`.

**`ESLint exited with code 2`** — ESLint could not run: configuration error,
no files matched `eslint.args`, or `--no-warn-ignored` with the legacy config
mode. Run the printed command by hand.

**Patch coverage is always skipped with "base ref not found"** — the base
branch is not fetched. In the workflow, keep `fetch-depth: 0`; locally, run
`git fetch origin main` or pass `--base`.

**Everything is 100% / 0 files measured** — `eslint.args` points at a folder
with no files, or `exclude` is too broad. The violation, size and duplication
checks measure the files ESLint linted.

**`SyntaxError` or `Unknown file extension ".mts"`** — Node is older than
22.18. Upgrade, or run `npx tsx scripts/quality-gate/cli.mts`.

**The comment never appears on pull requests from forks** — expected; the
token is read-only there. The job summary and the artifacts have the report.

**A rename failed the gate** — it should not, per-file checks skip unknown
paths; but the total may have grown if the moved code was also changed. Run
`baseline` in the pull request and review its diff.
