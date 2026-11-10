import { FakeGitHub } from 'github';
import { ContextIndexSchema, INVENTORY_PATH } from 'shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { createRepositories } from '../../db/repositories.js';
import { InventoryError, InventoryService } from './inventory.js';

const ref = { owner: 'studio', repo: 'jeu' };

async function setup(adopted: boolean) {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(ref, { admin: true });
  await github.commitFiles(ref, {
    branch: 'main',
    message: 'p',
    changes: [
      {
        path: '.agentlake/project.yml',
        content: `type: unity\nqualityProfile: unity\nlimits:\n  maxAttempts: 3\nprofiles: [architect]\nexclusiveResources: []\nbridgeRequired: true\n${adopted ? 'adopted: true\n' : ''}`,
      },
      {
        path: '.agentlake/context/context.json',
        content: JSON.stringify({
          version: 1,
          files: [
            {
              path: '.agentlake/context/brief.md',
              role: 'brief',
              source: 'brief.docx',
              sha256: 'a'.repeat(64),
              size: 10,
              importedAt: '2026-11-09T08:00:00.000Z',
            },
          ],
        }),
      },
    ],
  });
  const repos = createRepositories(openDatabase(':memory:').db);
  repos.projects.upsert('studio', 'jeu', '2026-11-10T08:00:00.000Z');
  const service = new InventoryService(
    repos,
    () => Promise.resolve(github),
    () => '2026-11-10T09:00:00.000Z',
  );
  return { github, service };
}

describe('état des lieux d’un projet repris', () => {
  it('versions proposées, relecture de la dernière, validation versée dans le contexte', async () => {
    const { github, service } = await setup(true);
    expect(await service.get('studio/jeu')).toEqual({
      adopted: true,
      versions: [],
      latest: null,
      validated: false,
    });
    for (const version of [1, 2])
      await github.commitFiles(ref, {
        branch: `etat-des-lieux/v${String(version)}`,
        baseBranch: 'main',
        message: 'e',
        changes: [{ path: INVENTORY_PATH, content: `# État des lieux v${String(version)}\n` }],
      });
    const state = await service.get('studio/jeu');
    expect(state.versions.map((v) => v.branch)).toEqual(['etat-des-lieux/v1', 'etat-des-lieux/v2']);
    expect(state.latest).toEqual({ version: 2, content: '# État des lieux v2\n' });

    await service.validate('studio/jeu', 1);
    await service.validate('studio/jeu', 2);
    expect((await github.getFile(ref, INVENTORY_PATH, 'main'))?.content).toBe(
      '# État des lieux v2\n',
    );
    const index = ContextIndexSchema.parse(
      JSON.parse((await github.getFile(ref, '.agentlake/context/context.json'))?.content ?? ''),
    );
    expect(index.files.map((f) => f.role)).toEqual(['brief', 'inventory']);
    expect(index.files[1]).toMatchObject({
      source: 'etat-des-lieux/v2 (planificateur)',
      importedAt: '2026-11-10T09:00:00.000Z',
    });
    expect((await service.get('studio/jeu')).validated).toBe(true);
    await expect(service.validate('studio/jeu', 9)).rejects.toThrow(InventoryError);
  });

  it('projet créé par AgentLake : pas d’état des lieux', async () => {
    const { service } = await setup(false);
    expect((await service.get('studio/jeu')).adopted).toBe(false);
  });
});
