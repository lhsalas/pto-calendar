import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', 'prisma/migrations/'],
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
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**/*.ts', 'prisma/seed.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
