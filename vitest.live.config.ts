import { defineConfig } from 'vitest/config';

// Tests @live : vrais appels GitHub sur un dépôt bac à sable, jamais en CI.
// Lancer avec : GITHUB_TOKEN=… AGENTLAKE_SANDBOX_REPO=kiamiya/devlake-sandbox npm run test:live
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.live.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    passWithNoTests: true,
  },
});
