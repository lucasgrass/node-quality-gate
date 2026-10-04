# Example project

A tiny TypeScript library (Vitest + ESLint) used by the end-to-end test in
`test/e2e/run.mts`. The test copies `template/` into this folder, runs lint
and coverage, writes a baseline, checks it passes, then injects regressions
and checks the gate fails with the expected messages.

The copied files (`scripts/quality-gate/`, `quality-gate.config.json`,
`quality-gate.baseline.json`) are ignored by git here so they never drift
from the template.
