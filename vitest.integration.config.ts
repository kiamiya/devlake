import { defineConfig } from 'vitest/config';

// Tests d'intégration : séparés des unitaires, réseau simulé ou réel selon la config.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.integration.test.ts', 'tests/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
  },
});
