import { defineConfig } from 'vitest/config';

// Vitest configuration for the shared API client package.
//
// The suite is service-free: it uses in-process loopback fixtures only and
// never touches PostgreSQL, Redis or any hosted endpoint. Coverage is gated
// here (the real merge gate) because the package is the shared contract
// between the future CLI and MCP adapters.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'coverage'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // Only the test files themselves are excluded. No source file is
      // excluded from the coverage gate.
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
      thresholds: {
        // Package-wide totals.
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 80,
        // Security-sensitive surfaces (origin binding, error envelope,
        // transport/retry policy, wire parsing and input validation) must be
        // fully covered on every metric.
        'src/{errors,error,origin,security,transport,validation,validate,input,wire}.ts': {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
      },
    },
  },
});
