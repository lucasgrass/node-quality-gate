import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['coverage/', 'reports/', 'scripts/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
