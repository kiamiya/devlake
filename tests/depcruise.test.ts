import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cruise, type IConfiguration, type ICruiseResult } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../.dependency-cruiser.cjs') as IConfiguration;
const fixtureDir = fileURLToPath(new URL('./fixtures/depcruise', import.meta.url));

async function violationsOf(): Promise<string[]> {
  const { output } = await cruise(['packages'], {
    validate: true,
    ruleSet: { forbidden: config.forbidden ?? [] },
    baseDir: fixtureDir,
  });
  const result = output as ICruiseResult;
  return result.summary.violations.map((v) => `${v.rule.name}: ${v.from} → ${v.to}`);
}

describe('règles de dependency-cruiser', () => {
  it('signale les imports interdits et laisse passer les autorisés', async () => {
    const violations = await violationsOf();

    expect(violations).toEqual(
      expect.arrayContaining([
        'shared-dependances: packages/shared/src/index.js → packages/planner/src/index.js',
        'electron-reserve-a-desktop: packages/github/src/index.js → electron',
        'renderer-sans-main: packages/desktop/src/renderer/view.js → packages/desktop/src/main/app.js',
      ]),
    );
    expect(violations.filter((v) => v.startsWith('planner-'))).toEqual([]);
    expect(violations.filter((v) => v.startsWith('dispatcher-'))).toEqual([]);
  });
});
