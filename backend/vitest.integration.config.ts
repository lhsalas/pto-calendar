import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'coverage', 'tests/unit/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['./tests/setup.ts'],
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
        'src/lib/lifecycle.ts',
        'src/middleware/**',
        'src/services/authorization/**',
        'src/services/users/**',
        'src/services/auth/**',
        'src/services/pto/**',
        'src/services/audit/**',
        'src/services/calendar/**',
      ],
      thresholds: {
        'src/routes/auth.ts': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/routes/pto.ts': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/routes/users.ts': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/routes/health.ts': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/routes/holidays.ts': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
      },
    },
  },
});
