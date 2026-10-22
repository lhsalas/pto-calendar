import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';

// Vitest's default sequencer orders spec files by cached duration, and by
// file size when nothing is cached yet. The order therefore differs between a
// developer machine and CI. The integration suite shares one database, so a
// stable order keeps a failure reproducible instead of intermittent.
class AlphabeticalSequencer extends BaseSequencer {
  override async sort(files: Parameters<BaseSequencer['sort']>[0]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

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
    // Vitest 4 removed `poolOptions.forks.singleFork`. The integration suite
    // shares one database, so the spec files must run sequentially and each
    // file needs its own module registry: a file that disconnects the shared
    // Prisma client must not break the file that runs after it.
    fileParallelism: false,
    isolate: true,
    sequence: {
      sequencer: AlphabeticalSequencer,
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
