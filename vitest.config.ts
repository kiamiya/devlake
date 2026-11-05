import { defineConfig } from 'vitest/config';

// Tests unitaires : aucun accès réseau (voir tests/setup/no-network.ts).
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.ts',
      '**/*.live.test.ts',
      'tests/fixtures/**',
    ],
    setupFiles: ['tests/setup/no-network.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/src/testing/**', 'packages/desktop/src/renderer/**'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        lines: 80,
      },
    },
  },
});
