import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
    ],
    exclude: ['node_modules', 'dist', 'coverage', 'e2e/**'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/main.tsx',
        'src/types/**',
        'src/lib/utils.ts',
        'src/api/client.ts',
      ],
      thresholds: {
        'src/components/pto/PTOFormModal.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/components/calendar/DayCell.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/components/calendar/CalendarPage.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
      },
    },
  },
});
