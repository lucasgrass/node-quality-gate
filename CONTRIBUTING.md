# Contributing

Thanks for taking the time. This project is deliberately small; the goal is
a gate anyone can read in one sitting, so simplicity wins over features.

## Ground rules

- The script in `template/scripts/quality-gate.mts` must keep **zero runtime
  dependencies** and run on Node 22.18+ without a build step. That means
  erasable TypeScript only: no `enum`, no `namespace`, no parameter
  properties, `import type` for types.
- Workflows in `template/.github/workflows/` pin every action to a full
  commit SHA with a `# vX.Y.Z` comment. Dependabot keeps them current.
- Behaviour changes need a test in `test/` and a line in `CHANGELOG.md`.

## Setup

```sh
npm ci
npm run check      # typecheck + unit tests
npm run test:e2e   # runs the template against example/ end to end
```

## Commits and pull requests

- Conventional Commits in English: `feat:`, `fix:`, `docs:`, `test:`,
  `chore:`, `ci:`; scope when it helps (`feat(duplication): ...`).
- Keep pull requests focused. Describe what changes for someone who copied
  an earlier version of the template.

## Reporting problems

Open an issue with the output of `node scripts/quality-gate.mts doctor`,
your `quality-gate.config.json` and, when relevant, the generated
`reports/quality-gate.md`.
