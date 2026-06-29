import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'coverage', 'tests/integration/**'],
    setupFiles: ['./tests/setup.ts'],
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
        'src/lib/rateLimit.ts',
        'src/routes/**',
      ],
      thresholds: {
        'src/services/authorization/**': {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        'src/services/auth/**': {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        'src/services/users/**': {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        'src/middleware/cookieSession.ts': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/middleware/errorHandler.ts': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/middleware/requireAuth.ts': {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        'src/services/pto/validation.ts': {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        'src/services/pto/schemas.ts': {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        'src/services/auth/schemas.ts': {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        'src/services/pto/PTOService.ts': {
          lines: 90,
          statements: 90,
          branches: 80,
          functions: 90,
        },
        'src/services/calendar/CalendarQuery.ts': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/services/audit/AuditLogService.ts': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
      },
    },
  },
});
