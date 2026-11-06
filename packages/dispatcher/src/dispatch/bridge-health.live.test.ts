import { describe, expect, it } from 'vitest';
import { checkBridgeHealth } from './adapters.js';

/**
 * @live (jamais en CI) : contrôle de santé du pont Aura depuis un runner GitHub, à travers le
 * tunnel. Lancé par le workflow `bridge-health-live.yml` (appelé depuis le bac à sable), ou à
 * la main :
 *
 * AURA_BRIDGE_URL=https://<poste>.<tailnet>.ts.net/unity AURA_BRIDGE_SECRET=… \
 * AGENTLAKE_SANDBOX_REPO=kiamiya/devlake-sandbox AGENTLAKE_EXPECT_EDITOR=open npm run test:live
 *
 * AGENTLAKE_EXPECT_EDITOR : « open » (éditeur ouvert sur le clone du bac à sable) ou « closed ».
 */
const url = process.env.AURA_BRIDGE_URL;
const secret = process.env.AURA_BRIDGE_SECRET;
const repo = process.env.AGENTLAKE_SANDBOX_REPO;
const expected = process.env.AGENTLAKE_EXPECT_EDITOR;
const enabled = Boolean(url && secret && repo && (expected === 'open' || expected === 'closed'));

describe.skipIf(!enabled)('@live santé du pont Aura depuis un runner', () => {
  it(`/health ${expected === 'open' ? 'répond, éditeur ouvert' : 'échoue proprement, éditeur fermé'}`, async () => {
    const log: string[] = [];
    const editor = (url ?? '').replace(/\/+$/, '').endsWith('/unreal') ? 'unreal' : 'unity';
    const healthy = await checkBridgeHealth(
      {
        url: url ?? null,
        secret: secret ?? null,
        repo: repo ?? '',
        runId: process.env.GITHUB_RUN_ID ?? 'live',
        editor,
      },
      (target, init) => fetch(target, init),
      () => new Date(),
      (line) => log.push(line),
    );
    console.log(log.join('\n'));
    expect(healthy).toBe(expected === 'open');
    if (expected === 'closed') expect(log.at(-1)).toMatch(/indisponible : /);
  });
});
