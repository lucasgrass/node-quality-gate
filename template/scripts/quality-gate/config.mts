/** Configuration: defaults, validation of quality-gate.config.json and environment overrides. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRecord } from './util.mts';

export const CONFIG_PATH = 'quality-gate.config.json';
export const BASELINE_PATH = 'quality-gate.baseline.json';
export const REPORT_DIR = 'reports';

/** A rule option (`complexity: 20`) or `true` for rules without options. */
export type QualityRuleOption = number | true;
export type PatchCoverageMode = 'warn' | 'block';

export type Config = {
  coverage: { lcov: string; tolerance: number };
  patchCoverage: {
    enabled: boolean;
    mode: PatchCoverageMode;
    threshold: number;
    minLines: number;
    baseRef: string;
  };
  eslint: { command: string; args: string[]; qualityRules: Record<string, QualityRuleOption> };
  size: { maxLines: number; maxBytes: number };
  duplication: { minLines: number; minTokens: number; tolerance: number };
  exclude: string[];
};

export const DEFAULT_CONFIG: Config = {
  coverage: { lcov: 'coverage/lcov.info', tolerance: 0.1 },
  patchCoverage: { enabled: true, mode: 'warn', threshold: 80, minLines: 20, baseRef: 'origin/main' },
  eslint: {
    command: 'npx eslint',
    args: ['.'],
    // ESLint's own defaults for each rule.
    qualityRules: {
      complexity: 20,
      'max-depth': 4,
      'max-lines': 300,
      'max-lines-per-function': 50,
      'max-params': 3,
      'max-nested-callbacks': 10,
    },
  },
  size: { maxLines: 400, maxBytes: 40_000 },
  duplication: { minLines: 10, minTokens: 100, tolerance: 0.1 },
  exclude: ['**/*.test.*', '**/*.spec.*', '**/*.d.ts', '**/__snapshots__/**'],
};

export class ConfigError extends Error {}

/** Reads the config file when it exists (defaults otherwise), validates it and applies env overrides. */
export function loadConfig(path: string, cwd: string): Config {
  const file = resolve(cwd, path);
  const config = existsSync(file) ? resolveConfig(readJson(file, path)) : structuredClone(DEFAULT_CONFIG);
  const eslintCommand = process.env.QG_ESLINT_COMMAND;
  if (eslintCommand) config.eslint.command = eslintCommand;
  return config;
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new ConfigError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Merges user values over the defaults, rejecting unknown keys and wrong types. */
export function resolveConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new ConfigError('the config must be a JSON object');
  const config = structuredClone(DEFAULT_CONFIG);
  for (const [section, value] of Object.entries(raw)) {
    if (section === '$schema') continue;
    if (section === 'exclude') {
      config.exclude = stringList(value, section);
    } else if (isSection(section)) {
      mergeSection(config[section] as Record<string, unknown>, value, section);
    } else {
      throw new ConfigError(`unknown key "${section}"`);
    }
  }
  const { mode } = config.patchCoverage;
  if (mode !== 'warn' && mode !== 'block') {
    throw new ConfigError('"patchCoverage.mode" must be "warn" or "block"');
  }
  return config;
}

type Section = Exclude<keyof Config, 'exclude'>;

function isSection(key: string): key is Section {
  return key !== 'exclude' && Object.hasOwn(DEFAULT_CONFIG, key);
}

function mergeSection(target: Record<string, unknown>, value: unknown, section: string): void {
  if (!isRecord(value)) throw new ConfigError(`"${section}" must be an object`);
  for (const [key, next] of Object.entries(value)) {
    const path = `${section}.${key}`;
    if (!Object.hasOwn(target, key)) throw new ConfigError(`unknown key "${path}"`);
    target[key] = checkValue(path, target[key], next);
  }
}

function checkValue(path: string, current: unknown, next: unknown): unknown {
  if (Array.isArray(current)) return stringList(next, path);
  if (isRecord(current)) return qualityRules(next, path);
  if (typeof next !== typeof current) throw new ConfigError(`"${path}" must be a ${typeof current}`);
  if (typeof next === 'number' && !Number.isFinite(next)) {
    throw new ConfigError(`"${path}" must be a finite number`);
  }
  return next;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new ConfigError(`"${path}" must be an array of strings`);
  }
  return value;
}

function qualityRules(value: unknown, path: string): Record<string, QualityRuleOption> {
  if (!isRecord(value)) throw new ConfigError(`"${path}" must be an object of rule: option`);
  const rules: Record<string, QualityRuleOption> = {};
  for (const [rule, option] of Object.entries(value)) {
    if (option !== true && !(typeof option === 'number' && Number.isFinite(option))) {
      throw new ConfigError(`"${path}.${rule}" must be a number or true`);
    }
    rules[rule] = option;
  }
  return rules;
}
