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
      ],
      thresholds: {
        'src/context/AuthContext.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/pages/LoginPage.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/pages/CalendarPage.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
        },
        'src/routes/RequireAuth.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/components/pto/PTOFormModal.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/components/pto/PTOViewModal.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/components/pto/PTOChip.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/hooks/usePtoList.ts': {
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
        'src/components/calendar/MonthGrid.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/components/calendar/CalendarHeader.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/components/common/Toast.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/components/common/ToastViewport.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
        'src/context/ToastProvider.tsx': {
          lines: 80,
          statements: 80,
          branches: 80,
          functions: 80,
        },
      },
    },
  },
});
