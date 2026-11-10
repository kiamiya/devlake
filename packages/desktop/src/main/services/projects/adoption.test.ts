import { FakeGitHub } from 'github';
import { ProjectConfigSchema, requiredChecksFor } from 'shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { openDatabase } from '../../db/database.js';
import { createRepositories, type Repositories } from '../../db/repositories.js';
import { ProjectsService } from '../../projects-service.js';
import { MemoryVault } from '../../vault.js';
import { AdoptionError, AdoptionService, findEngines, heavyOutsideLfs } from './adoption.js';
import { ProjectCreationService } from './creation-service.js';

/** Faux jeton de test, sans valeur réelle. */
const CLAUDE_TOKEN = 'sk-ant-oat01-jeton-de-test'; // gitleaks:allow

const studio = { owner: 'studio', repo: 'jeu' };

describe('reprise d’un projet existant', () => {
  let github: FakeGitHub;
  let repos: Repositories;
  let service: AdoptionService;

  beforeEach(async () => {
    github = new FakeGitHub({ actor: 'kiamiya' });
    repos = createRepositories(openDatabase(':memory:').db);
    const vault = new MemoryVault();
    await vault.set('claude-oauth-token', CLAUDE_TOKEN);
    const projects = new ProjectsService(repos, () => Promise.resolve(github));
    const creation = new ProjectCreationService({
      repos,
      vault,
      github: () => Promise.resolve(github),
      projects,
      callerTemplates: { 'agentlake-x.yml': 'uses: __DEVLAKE_REPOSITORY__@__DEVLAKE_REF__' },
      profileTemplates: { 'architect.yml': 'id: architect\n' },
    });
    service = new AdoptionService({
      repos,
      github: () => Promise.resolve(github),
      creation,
      projects,
    });
  });

  const seedUnity = async (options: { defaultBranch?: string; dir?: string } = {}) => {
    github.seedRepository(studio, {
      admin: true,
      private: true,
      defaultBranch: options.defaultBranch ?? 'main',
    });
    const dir = options.dir === undefined ? '' : `${options.dir}/`;
    await github.commitFiles(studio, {
      branch: options.defaultBranch ?? 'main',
      message: 'jeu existant',
      changes: [
        {
          path: `${dir}ProjectSettings/ProjectVersion.txt`,
          content: 'm_EditorVersion: 6000.0.1f1\n',
        },
        { path: `${dir}Assets/Scenes/Main.unity`, content: '%YAML 1.1\n' },
        { path: 'Art/caisse/caisse.blend', content: 'B'.repeat(5000) },
        { path: 'Assets/Textures/sol.png', content: 'P'.repeat(3000) },
        { path: '.github/workflows/build.yml', content: 'name: build\n' },
      ],
    });
  };

  it('liste les dépôts administrés, organisations comprises, sauf ceux déjà ouverts', async () => {
    github.seedRepository({ owner: 'kiamiya', repo: 'site' });
    github.seedRepository(studio, { admin: true });
    github.seedRepository({ owner: 'studio', repo: 'lecture' }, { admin: false });
    repos.projects.upsert('kiamiya', 'site', '2026-11-10T08:00:00.000Z');
    expect(await service.candidates()).toEqual([
      { owner: 'studio', repo: 'jeu', private: false, defaultBranch: 'main' },
    ]);
  });

  it('détecte un projet Unity à la racine, les .blend, les binaires hors LFS, ce qui reste', async () => {
    await seedUnity();
    github.seedBranchProtection(studio, 'main', {
      requiredChecks: ['build'],
      requiredApprovals: 1,
    });
    await github.createIssue(studio, { title: 'Bug du saut', body: '', labels: ['bug'] });
    const report = await service.detect(studio);
    expect(report).toMatchObject({
      detectedType: 'unity',
      type: 'unity',
      qualityProfile: 'unity',
      alreadyAgentLake: false,
      blockers: [],
      blendFiles: 1,
      heavyOutsideLfsCount: 2,
      workflows: ['.github/workflows/build.yml'],
      requiredChecks: ['build'],
      openIssues: 1,
      openPullRequests: 0,
      engineConfigured: false,
      blenderConfigured: false,
    });
    expect(report.heavyOutsideLfs[0]).toEqual({ path: 'Art/caisse/caisse.blend', size: 5000 });
    expect(report.changes).toEqual(
      expect.arrayContaining([
        'Auto-merge activé.',
        expect.stringContaining('Relectures humaines exigées sur main : 1 → 0') as unknown,
      ]),
    );
    expect(report.warnings.join(' ')).toContain('hors Git LFS');
  });

  it('projet Unity en sous-dossier : reprise refusée avec l’explication', async () => {
    await seedUnity({ dir: 'Game' });
    const report = await service.detect(studio);
    expect(report.blockers.join(' ')).toContain('sous-dossier « Game »');
    await expect(
      service.adopt({ ...studio, type: 'unity', qualityProfile: 'unity', acceptChanges: true }),
    ).rejects.toThrow(AdoptionError);
  });

  it('branche master : renommage annoncé ; refusé si une branche main existe déjà', async () => {
    await seedUnity({ defaultBranch: 'master' });
    expect((await service.detect(studio)).changes[0]).toContain('« master » renommée en « main »');
    await github.commitFiles(studio, {
      branch: 'main',
      baseBranch: 'master',
      message: 'autre',
      changes: [{ path: 'x.txt', content: 'x' }],
    });
    expect((await service.detect(studio)).blockers[0]).toContain('« main » existe déjà');
  });

  it('reprise : refusée sans accord, puis branche renommée, bootstrap et projet ouvert', async () => {
    await seedUnity({ defaultBranch: 'master' });
    const input = { ...studio, type: 'unity' as const, qualityProfile: 'unity' as const };
    await expect(service.adopt({ ...input, acceptChanges: false })).rejects.toThrow(
      'les confirmer avant la reprise',
    );
    expect(await github.branchExists(studio, 'master')).toBe(true);

    const result = await service.adopt({ ...input, acceptChanges: true });
    expect(result.renamedBranch).toBe('master');
    expect(result.project.id).toBe('studio/jeu');
    expect((await github.getRepository(studio)).defaultBranch).toBe('main');
    const config = ProjectConfigSchema.parse(
      parse((await github.getFile(studio, '.agentlake/project.yml'))?.content ?? ''),
    );
    expect(config).toMatchObject({ type: 'unity', adopted: true });
    expect((await github.getFile(studio, '.github/workflows/build.yml'))?.content).toBe(
      'name: build\n',
    );
    expect((await github.getBranchProtection(studio, 'main'))?.requiredChecks).toEqual(
      requiredChecksFor('unity'),
    );
    expect(repos.projects.list().map((p) => p.id)).toEqual(['studio/jeu']);

    // Déjà un projet AgentLake : la reprise l'ouvre simplement.
    const again = await service.adopt({ ...input, acceptChanges: false });
    expect(again.report).toBeNull();
  });

  it('type choisi à la main : signalé, et le profil qualité suit', async () => {
    github.seedRepository(studio, { admin: true });
    await github.commitFiles(studio, {
      branch: 'main',
      message: 'web',
      changes: [{ path: 'package.json', content: '{"dependencies":{"react":"19"}}' }],
    });
    expect((await service.detect(studio)).detectedType).toBe('web');
    const forced = await service.detect(studio, 'backend');
    expect(forced).toMatchObject({ type: 'backend', qualityProfile: 'backend' });
    expect(forced.warnings[0]).toContain('différent du type détecté');
  });
});

describe('détection : fonctions pures', () => {
  it('moteurs à la racine ou en sous-dossier', () => {
    expect(
      findEngines([
        { path: 'ProjectSettings/ProjectVersion.txt', size: 1 },
        { path: 'Client/Jeu.uproject', size: 1 },
      ]),
    ).toEqual([
      { type: 'unity', dir: '' },
      { type: 'unreal', dir: 'Client' },
    ]);
  });

  it('pointeurs Git LFS ignorés, binaires lourds triés par taille', () => {
    expect(
      heavyOutsideLfs(
        [
          { path: 'a.png', size: 130 },
          { path: 'b.png', size: 4000 },
          { path: 'c.uasset', size: 9000 },
          { path: 'd.fbx', size: 2000 },
          { path: 'README.md', size: 9000 },
        ],
        'unreal',
      ).map((e) => e.path),
    ).toEqual(['c.uasset', 'b.png', 'd.fbx']);
  });
});
