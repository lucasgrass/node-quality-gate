# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

Adopters copy files from `template/`; the version in the header of
`scripts/quality-gate/cli.mts` tells you which release your copy came from.

## [Unreleased]

## [0.2.0] - 2026-11-27

Copies of 0.1.x do not have `upgrade` yet: copy the new
`scripts/quality-gate/` over yours once, by hand. The config and the baseline
need no change; the two new checks are warnings unless you say otherwise.

### Added

- `upgrade` command: replaces `scripts/quality-gate/` with the latest release
  (or `--to <version>`), prints the changelog between the two versions and
  says whether the workflow templates changed. `upgrade --check` only reports
  whether another version is available.
- New files without tests: a source file the pull request creates that the
  coverage report lists with no line hit is reported
  (`untestedFiles`: `enabled`, `mode`).
- New dependencies: names the pull request adds to `dependencies`,
  `optionalDependencies` or `peerDependencies` of `package.json` are reported
  (`newDependencies`: `enabled`, `mode`, `sections`).
- `reports/quality-gate.json` has `untestedFiles` and `newDependencies`.

## [0.1.1] - 2026-11-26

No change in behaviour; a copy of 0.1.0 does not need to be updated.

### Changed

- Development dependencies updated (ESLint, typescript-eslint, Vitest).
- Dependabot no longer proposes a new major of `@types/node`: the types
  follow the oldest Node the gate supports.

## [0.1.0] - 2026-11-26

### Added

- First version of the ratchet quality gate: coverage, patch coverage,
  quality-rule violations, oversized files and duplication, compared
  against a committed baseline.
- One ready-to-copy GitHub Actions workflow per package manager
  (npm, pnpm, Yarn, Bun).
- `check` compares the baseline in the pull request with the one on the base
  branch: loosened values are reported (`baseline.loosening`: `warn` or
  `block`), and a deleted baseline no longer resets the gate.
- A warning when a changed source file is missing from the coverage report.
- `QG_INCLUDE_SELF=1` makes the gate measure its own folder; this repository
  now runs the gate on itself in CI.

### Changed

- The baseline file no longer has `generatedAt` and `commit`, so it only
  changes when a metric does. Files that still have them are read fine.
- `baseline` keeps the previous value of a number that got worse by less than
  its tolerance.
- Patch coverage uses paths relative to the folder where the gate runs, so it
  works from a package inside a monorepo.
