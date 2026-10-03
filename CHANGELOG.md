# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

Adopters copy files from `template/`; the version in the header of
`scripts/quality-gate.mts` tells you which release your copy came from.

## [Unreleased]

### Added

- First version of the ratchet quality gate: coverage, patch coverage,
  quality-rule violations, oversized files and duplication, compared
  against a committed baseline.
- One ready-to-copy GitHub Actions workflow per package manager
  (npm, pnpm, Yarn, Bun).
