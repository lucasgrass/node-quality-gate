# node-quality-gate

[![CI](https://github.com/lucasgrass/node-quality-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/lucasgrass/node-quality-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A quality gate for Node repositories that works like a **ratchet**: every pull
request is compared with a committed baseline and fails only when something
gets worse. Coverage, coverage of the changed lines, lint quality rules,
oversized files and duplicated code. No service to sign up for, no dependency
to install: copy a folder and a workflow into your repository.

Works with **npm, pnpm, Yarn and Bun**, with **Jest, Vitest, c8, `node --test`
and `bun test`**, on **Node 22.18+** (TypeScript, run natively, zero
dependencies).

## What a pull request sees

> ## Quality gate ❌ 7 regressions
>
> Baseline: quality-gate.baseline.json (commit 8678bbd, 2026-10-03)
>
> ### Coverage
>
> | Metric | Baseline | Current | Δ |
> |---|---:|---:|---:|
> | Lines | 9.09% | 3.64% | -5.45% |
> | Functions | 25% | 16.67% | -8.33% |
> | Branches | 0% | 0% | — |
>
> Patch coverage: **3.64%** of 55 changed lines (minimum 80%, warning only).
>
> ### Duplication
>
> | Metric | Baseline | Current | Δ |
> |---|---:|---:|---:|
> | Percentage | 0% | 54.79% | +54.79% |
> | Fragments | 0 | 2 | +2 |
>
> ### Violations
>
> | Metric | Baseline | Current | Δ |
> |---|---:|---:|---:|
> | Quality rule violations | 3 | 12 | +9 |
> | Oversized files | 0 | 0 | — |
>
> ### Regressions
>
> - Lines coverage dropped from 9.09% to 3.64%
> - Functions coverage dropped from 25% to 16.67%
> - Duplication rose from 0% to 54.79%
> - Duplicated fragments increased from 0 to 2
> - Quality rule violations increased from 3 to 12
> - max-depth violations increased in src/legacy.ts (2 -> 4)
> - max-params violations increased in src/legacy.ts (1 -> 2)
>
> ### Warnings
>
> - Patch coverage 3.64% is below the minimum of 80% (2 of 55 changed lines covered)

The same report goes to the job summary, to a sticky comment on the pull
request (updated in place) and to an artifact, with annotations in the Actions
log. Improvements are listed too, with a reminder to lock them in.

## Why a ratchet

Fixed thresholds ("80% coverage or the build fails") cannot be adopted by a
codebase that is at 7%, and once they are met nobody raises them. A ratchet
starts from where you are and only moves in one direction. The baseline is a
JSON file in your repository, so moving the bar, up or down, is a reviewable
diff in a pull request.

## Quick start

1. Copy from [`template/`](template/) into your project:
   `scripts/quality-gate/`, `quality-gate.config.json`, the workflow for
   your package manager (`.github/workflows/quality-gate.<pm>.yml`, saved as
   `quality-gate.yml`) and `.github/dependabot.yml`.
2. Make sure `package.json` has a `lint` script and a `test:coverage` script
   that writes `coverage/lcov.info` (Vitest: `vitest run --coverage` with
   `reporter: ['text', 'lcov']`; Jest: `jest --coverage` with
   `coverageReporters: ['text', 'lcov']`; Bun: `bun test --coverage --coverage-reporter=lcov`).
3. Check the environment and write the first baseline:

   ```sh
   node scripts/quality-gate/cli.mts doctor
   npm run lint && npm run test:coverage
   node scripts/quality-gate/cli.mts baseline
   ```

4. Commit everything, including `quality-gate.baseline.json`, and open a pull
   request. Make the "Quality gate" check required in your branch protection.
5. When a pull request improves a metric, run `baseline` again in that pull
   request. The bar moves up with the code.

The [manual](docs/manual.md) covers every option, the per-package-manager
details, legacy repositories, monorepos and troubleshooting.

## What it measures

| Metric | Source | Fails when |
|---|---|---|
| Lines, functions and branches coverage | `coverage/lcov.info` | a value drops more than the tolerance (0.1 pt) |
| Patch coverage of the changed lines | lcov + `git diff` against the base branch | below 80%, as a warning by default; skipped under 20 coverable lines, like SonarQube |
| Quality rule violations | ESLint with `complexity`, `max-depth`, `max-lines`, `max-lines-per-function`, `max-params`, `max-nested-callbacks` injected as warnings (ESLint's own defaults) | the total grows, or a file/rule pair grows |
| Oversized files | over 400 lines or 40 KB | a new file crosses the limit, or an oversized file grows |
| Duplication | built-in detector calibrated on SonarQube (10 lines / 100 tokens, strings anonymized, imports and comments ignored) | the percentage or the number of fragments grows |

Every number is configurable in `quality-gate.config.json`; unknown keys are
rejected so a typo cannot silently disable a check.

## The pipeline

```
install (frozen lockfile) ─► audit critical ─► audit high ─► lint ─► test:coverage ─► quality-gate check ─► PR comment ─► artifacts
                             blocks            warns         blocks  lcov.info        the ratchet           + job summary
```

One workflow file per package manager, about 100 lines each, linear and
readable. Actions are pinned to full commit SHAs (Dependabot keeps them
current), permissions are the minimum, superseded runs are cancelled.

## Design choices

- **Nothing to install.** The gate is nine small TypeScript files that Node
  22.18+ runs directly (Bun too). No build step, no runtime dependency.
- **Reads standard reports.** lcov for coverage and ESLint's JSON for
  violations, so any test runner and any ESLint setup works.
- **Calibrated on tools people trust.** Duplication parameters and the
  patch-coverage rules follow SonarQube; the per-file lint counts follow
  ESLint's bulk suppressions; the tolerance follows Codecov's `threshold`.
- **Honest defaults.** Quality rules use ESLint's own default thresholds.
  Patch coverage warns before it blocks.
- **Readable state.** JSON config and baseline, deterministic and sorted, so
  diffs are small and reviewable.

## Repository layout

```
template/                 what you copy: workflows, scripts/quality-gate/, config
docs/manual.md            the manual
example/                  tiny Vitest + ESLint project used by the end-to-end test
test/                     unit tests (node:test) and the end-to-end run
```

## Inspired by

The pipeline shape (install → audit → lint → coverage → ratchet → sticky
comment → artifacts) comes from Lucas Montano's video
"Por que NÃO faço mais Review de AI" <!-- TODO: add the video URL -->.
This project is an independent, from-scratch implementation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome;
keep the gate small.

## License

[MIT](LICENSE)
