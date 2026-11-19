import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Flat config for the shared API client package.
//
// The package is a runtime-neutral Node ESM library: it must never depend on
// Vite, browser globals or a database driver, so only the Node language
// options are enabled here. The rule set mirrors `backend/eslint.config.js`
// so a reviewer sees one convention across the workspaces.
export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // A credential-bound client must never write to stdout/stderr, so the
      // library sources keep the console closed. Tests may report freely.
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
