const tseslint = require('@typescript-eslint/eslint-plugin');

/** @type {import('eslint').Linter.FlatConfig[]} */
module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs['flat/recommended-type-checked'],
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Only console.error is permitted in config.ts (before the pino logger is
      // initialised). All other production logging must go through pino.
      'no-console': ['error', { allow: ['error'] }],
    },
  },
];
