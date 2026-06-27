import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'coverage', 'tests/unit/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/index.ts',
        'src/server.ts',
        'src/config/**',
        'src/types/**',
        'src/lib/prisma.ts',
        'src/lib/logger.ts',
        'src/middleware/**',
        'src/services/authorization/**',
        'src/services/users/**',
        'src/services/auth/**',
      ],
      thresholds: {
        'src/routes/auth.ts': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
      },
    },
  },
});
