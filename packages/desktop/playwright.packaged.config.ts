import { defineConfig } from '@playwright/test';

/** Test de fumée de l'application packagée (T23), lancé par release.yml sur l'exécutable installé. */
export default defineConfig({
  testDir: './e2e-packaged',
  testMatch: '**/*.e2e.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
});
