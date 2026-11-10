import { FakeGitHub, parseLfsPointer } from 'github';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetLibrarySchema, parseTaskIssueBody, TASK_LABEL } from 'shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { createRepositories, type Repositories } from '../../db/repositories.js';
import { AdhocTaskService } from '../tasks/adhoc-service.js';
import { AssetError, AssetLicenseError, AssetService, assetSlug } from './asset-service.js';
import type { Fetch } from './free.js';
import { ownedKey } from './local.js';
import { unityPackage } from './testing.js';

const jeu = { owner: 'kiamiya', repo: 'jeu' };
const NOW = '2026-11-10T10:00:00.000Z';

const projectYml = (type: string) =>
  `type: ${type}\nqualityProfile: ${type === 'web' ? 'web' : type}\nlimits:\n  maxAttempts: 3\nprofiles: [architect]\nexclusiveResources: []\nbridgeRequired: ${String(type !== 'web')}\n`;

describe('bibliothèque d’assets d’un projet de jeu', () => {
  let github: FakeGitHub;
  let repos: Repositories;
  let root: string;
  let service: AssetService;
  let fetchFn: ReturnType<typeof vi.fn<Fetch>>;

  const seed = async (type: string, options: { private?: boolean } = {}) => {
    github.seedRepository(jeu, { private: options.private ?? true });
    await github.commitFiles(jeu, {
      branch: 'main',
      message: 'p',
      changes: [{ path: '.agentlake/project.yml', content: projectYml(type) }],
    });
    repos.projects.upsert('kiamiya', 'jeu', NOW);
  };

  const file = (path: string, content: string | Uint8Array) => {
    const full = join(root, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    return full;
  };

  const library = async () =>
    AssetLibrarySchema.parse(
      JSON.parse((await github.getFile(jeu, '.agentlake/assets.json'))?.content ?? ''),
    );

  beforeEach(() => {
    github = new FakeGitHub({ actor: 'kiamiya' });
    repos = createRepositories(openDatabase(':memory:').db);
    root = mkdtempSync(join(tmpdir(), 'agentlake-assets-'));
    repos.settings.update({
      assets: {
        unityStoreCache: join(root, 'unity'),
        epicVaultCache: join(root, 'vault'),
        folders: [join(root, 'mes-assets')],
      },
    });
    fetchFn = vi.fn<Fetch>(() => Promise.resolve(new Response('absent', { status: 404 })));
    service = new AssetService({
      repos,
      github: () => Promise.resolve(github),
      adhoc: new AdhocTaskService(repos, () => Promise.resolve(github)),
      fetch: fetchFn,
      now: () => NOW,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('package de l’Asset Store versé : .meta en clair, binaires en LFS, tâche d’intégration', async () => {
    await seed('unity');
    const pkg = file(
      'unity/Studio/3D/Caisses.unitypackage',
      unityPackage({
        'Assets/Caisses': null,
        'Assets/Caisses/caisse.fbx': new Uint8Array([0, 1, 2, 3]),
        'Assets/Caisses/caisse.mat': 'Material: {}\n',
      }),
    );
    const result = await service.import({
      projectId: 'kiamiya/jeu',
      from: { kind: 'owned', key: ownedKey('unity-store-cache', pkg) },
      name: 'Caisses',
      license: 'store',
      acknowledgePublicLicense: false,
    });
    expect(result.entry).toMatchObject({
      id: 'caisses',
      origin: 'unity-store-cache',
      status: 'imported',
      path: 'Assets/Caisses',
      files: 5,
      integrationIssue: result.task?.issueNumber,
    });
    const fbx = await github.getFile(jeu, 'Assets/Caisses/caisse.fbx');
    expect(parseLfsPointer(fbx?.content ?? '')).not.toBeNull();
    expect((await github.getFile(jeu, 'Assets/Caisses/caisse.mat'))?.content).toBe(
      'Material: {}\n',
    );
    expect((await github.getFile(jeu, 'Assets/Caisses/caisse.fbx.meta'))?.content).toContain(
      'guid:',
    );
    expect((await library()).assets[0]?.integrationIssue).toBe(result.task?.issueNumber);

    const [issue] = await github.listIssues(jeu, { labels: [TASK_LABEL] });
    const task = parseTaskIssueBody(issue?.body ?? '');
    expect(task.ok && task.value).toMatchObject({
      id: 'T500',
      profile: 'unity',
      kind: 'config',
      title: 'Intégrer l’asset « Caisses »',
      adhoc: true,
    });
    expect(github.state(jeu).dispatches).toHaveLength(1);
  });

  it('dépôt public et licence restreinte : refus sans confirmation, avertissement sinon', async () => {
    await seed('unity', { private: false });
    const fbx = file('mes-assets/roche.fbx', new Uint8Array([0, 9]));
    const input = {
      projectId: 'kiamiya/jeu',
      from: { kind: 'owned' as const, key: ownedKey('folder', fbx) },
      name: 'Roche',
      license: 'store' as const,
      acknowledgePublicLicense: false,
    };
    await expect(service.import(input)).rejects.toBeInstanceOf(AssetLicenseError);
    const result = await service.import({ ...input, acknowledgePublicLicense: true });
    expect(result.warnings[0]).toContain('dépôt public, confirmé par Kia');
    expect(result.entry.path).toBe('Assets/ThirdParty/roche');
    expect(await github.getFile(jeu, 'Assets/ThirdParty/roche/roche.fbx')).not.toBeNull();
    // Licence libre : aucun avertissement.
    const cc0 = await service.import({ ...input, name: 'Roche', license: 'cc0' });
    expect(cc0.entry.id).toBe('roche-2');
    expect(cc0.warnings.some((w) => w.includes('dépôt public'))).toBe(false);
  });

  it('contenu Unreal du VaultCache : chemins sous Content/ gardés ; refusé dans un projet Unity', async () => {
    await seed('unreal');
    file('vault/Ruines/data/Content/Ruines/Mur.uasset', new Uint8Array([0, 1]));
    file('vault/Ruines/data/Content/Ruines/Mur.umap', new Uint8Array([0, 2]));
    const key = ownedKey('epic-vault', join(root, 'vault', 'Ruines'));
    const result = await service.import({
      projectId: 'kiamiya/jeu',
      from: { kind: 'owned', key },
      name: 'Ruines',
      license: 'store',
      acknowledgePublicLicense: false,
    });
    expect(result.entry.path).toBe('Content/Ruines');
    expect(await github.getFile(jeu, 'Content/Ruines/Mur.uasset')).not.toBeNull();
    expect(result.task).not.toBeNull();

    const pkg = file('unity/P/x.unitypackage', unityPackage({ 'Assets/x.txt': 'x' }));
    await expect(
      service.import({
        projectId: 'kiamiya/jeu',
        from: { kind: 'owned', key: ownedKey('unity-store-cache', pkg) },
        name: 'X',
        license: 'store',
        acknowledgePublicLicense: false,
      }),
    ).rejects.toThrow('Package Unity : il ne peut être versé que dans un projet Unity.');
  });

  it('dossier : sources Unreal hors Content ; binaire d’extension inconnue ajouté à LFS', async () => {
    await seed('unreal');
    file('mes-assets/Sons/pas.wav', new Uint8Array([0, 1]));
    file('mes-assets/Sons/pas.xyz', new Uint8Array([0, 7]));
    file('mes-assets/Sons/LISEZMOI.txt', 'Sons de pas\n');
    const result = await service.import({
      projectId: 'kiamiya/jeu',
      from: { kind: 'owned', key: ownedKey('folder', join(root, 'mes-assets', 'Sons')) },
      name: 'Sons',
      license: 'cc-by',
      attribution: 'Studio Son',
      acknowledgePublicLicense: false,
    });
    expect(result.entry).toMatchObject({ path: 'SourceArt/ThirdParty/sons', files: 3 });
    expect((await github.getFile(jeu, '.gitattributes'))?.content).toContain(
      '*.xyz filter=lfs diff=lfs merge=lfs -text',
    );
    expect(
      parseLfsPointer(
        (await github.getFile(jeu, 'SourceArt/ThirdParty/sons/pas.xyz'))?.content ?? '',
      ),
    ).not.toBeNull();
    const [issue] = await github.listIssues(jeu, { labels: [TASK_LABEL] });
    expect(issue?.body).toContain('CREDITS.md');
  });

  it('lien de boutique à acquérir, puis rempli par l’asset possédé ; retrait', async () => {
    await seed('unity');
    const wanted = await service.addLink({
      projectId: 'kiamiya/jeu',
      url: 'https://assetstore.unity.com/packages/3d/foret-123',
      name: 'Forêt stylisée',
      license: 'store',
      note: 'Décor du niveau 2',
    });
    expect(wanted).toMatchObject({ id: 'foret-stylisee', status: 'wanted', origin: 'store-link' });
    expect((await service.library('kiamiya/jeu')).library.assets).toHaveLength(1);

    const pkg = file(
      'unity/P/Foret.unitypackage',
      unityPackage({ 'Assets/Foret/arbre.fbx': new Uint8Array([0]) }),
    );
    const result = await service.import({
      projectId: 'kiamiya/jeu',
      from: { kind: 'owned', key: ownedKey('unity-store-cache', pkg) },
      name: 'Forêt stylisée',
      license: 'store',
      replaces: 'foret-stylisee',
      acknowledgePublicLicense: false,
    });
    expect(result.entry).toMatchObject({
      id: 'foret-stylisee',
      status: 'imported',
      origin: 'store-link',
      url: 'https://assetstore.unity.com/packages/3d/foret-123',
      note: 'Décor du niveau 2',
    });
    expect((await library()).assets).toHaveLength(1);
    await service.remove('kiamiya/jeu', 'foret-stylisee');
    expect((await library()).assets).toEqual([]);
    await expect(service.remove('kiamiya/jeu', 'inconnu')).rejects.toThrow(AssetError);
  });

  it('bibliothèque gratuite : téléchargé puis versé ; vignettes en data: URL', async () => {
    await seed('unity');
    fetchFn.mockImplementation((url) => {
      if (url === 'https://api.polyhaven.com/files/crate')
        return Promise.resolve(
          Response.json({ fbx: { '2k': { fbx: { url: 'https://dl.polyhaven.org/crate.fbx' } } } }),
        );
      if (url === 'https://dl.polyhaven.org/crate.fbx')
        return Promise.resolve(new Response(new Uint8Array([0, 1, 2])));
      if (url === 'https://api.polyhaven.com/assets?type=models')
        return Promise.resolve(
          Response.json({ crate: { name: 'Crate', categories: [], tags: [] } }),
        );
      if (url.startsWith('https://cdn.polyhaven.com/'))
        return Promise.resolve(
          new Response(new Uint8Array([137, 80]), { headers: { 'content-type': 'image/png' } }),
        );
      return Promise.resolve(new Response('absent', { status: 404 }));
    });
    const [found] = await service.search('polyhaven', 'crate', 'model');
    expect(found?.thumbnail).toBe('data:image/png;base64,iVA=');
    const result = await service.import({
      projectId: 'kiamiya/jeu',
      from: { kind: 'free', source: 'polyhaven', id: 'crate', type: 'model', resolution: '2k' },
      name: 'Crate',
      license: 'cc0',
      url: 'https://polyhaven.com/a/crate',
      acknowledgePublicLicense: false,
    });
    expect(result.entry).toMatchObject({
      origin: 'polyhaven',
      path: 'Assets/ThirdParty/crate',
      url: 'https://polyhaven.com/a/crate',
    });
    expect(await github.getFile(jeu, 'Assets/ThirdParty/crate/crate.fbx')).not.toBeNull();
  });

  it('projet non jeu, asset hors des dossiers réglés', async () => {
    await seed('web');
    expect((await service.library('kiamiya/jeu')).game).toBe(false);
    await expect(
      service.addLink({
        projectId: 'kiamiya/jeu',
        url: 'https://x.dev/a',
        name: 'A',
        license: 'store',
      }),
    ).rejects.toThrow('réservée aux projets de jeu');
    await expect(service.measure(ownedKey('folder', '/ailleurs'))).rejects.toThrow(
      'introuvable dans les dossiers d’assets réglés',
    );
    expect(assetSlug('Forêt « Été » 2 !')).toBe('foret-ete-2');
  });
});
