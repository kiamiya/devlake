import { FakeGitHub } from 'github';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './db/database.js';
import { createRepositories } from './db/repositories.js';
import { seedFakeProjects } from './e2e-fixtures.js';
import { NotAProjectError, ProjectsService, UnknownProjectError } from './projects-service.js';

async function setup(projects: string[] = ['jeu', 'site', 'outil']) {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  await seedFakeProjects(github, projects);
  const repos = createRepositories(openDatabase(':memory:').db);
  const service = new ProjectsService(repos, () => Promise.resolve(github));
  return { github, repos, service };
}

describe('ProjectsService', () => {
  it('découvre les projets du compte, les ouvre et compte questions et agents actifs', async () => {
    const { service, github } = await setup();
    github.seedRepository({ owner: 'kiamiya', repo: 'pas-un-projet' });

    expect(await service.discover()).toEqual([
      { owner: 'kiamiya', repo: 'jeu' },
      { owner: 'kiamiya', repo: 'outil' },
      { owner: 'kiamiya', repo: 'site' },
    ]);
    const summary = await service.open({ owner: 'kiamiya', repo: 'jeu' });
    expect(summary).toMatchObject({ id: 'kiamiya/jeu', pendingQuestions: 1, activeAgents: 1 });
    expect((await service.discover()).map((r) => r.repo)).toEqual(['outil', 'site']);
    expect(service.list().map((p) => p.id)).toEqual(['kiamiya/jeu']);
  });

  it('projet ajouté : devlake-config republié une fois, et un échec n’empêche pas l’ouverture', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    await seedFakeProjects(github, ['jeu']);
    const repos = createRepositories(openDatabase(':memory:').db);
    let added = 0;
    const service = new ProjectsService(
      repos,
      () => Promise.resolve(github),
      () => {
        added += 1;
        return Promise.reject(new Error('réseau coupé'));
      },
    );
    await service.open({ owner: 'kiamiya', repo: 'jeu' });
    await service.open({ owner: 'kiamiya', repo: 'jeu' });
    expect(added).toBe(1);
    expect(service.list().map((p) => p.id)).toEqual(['kiamiya/jeu']);
  });

  it('refuse un dépôt qui n’est pas un projet AgentLake', async () => {
    const { service, github } = await setup([]);
    github.seedRepository({ owner: 'kiamiya', repo: 'quelconque' });
    await expect(service.open({ owner: 'kiamiya', repo: 'quelconque' })).rejects.toBeInstanceOf(
      NotAProjectError,
    );
  });

  it('resynchronise un projet et refuse un projet inconnu', async () => {
    const { service, github } = await setup(['jeu']);
    await service.open({ owner: 'kiamiya', repo: 'jeu' });
    await github.updateIssue({ owner: 'kiamiya', repo: 'jeu' }, 1, { state: 'closed' });
    expect((await service.sync('kiamiya/jeu')).pendingQuestions).toBe(0);
    await expect(service.sync('kiamiya/absent')).rejects.toBeInstanceOf(UnknownProjectError);
  });

  it('enregistre les onglets dans l’ordre, avec l’actif, en ignorant les projets inconnus', async () => {
    const { service } = await setup();
    for (const repo of ['jeu', 'site', 'outil']) await service.open({ owner: 'kiamiya', repo });

    expect(service.getTabs()).toEqual({ tabs: [], active: null });
    expect(
      service.saveTabs({
        tabs: ['kiamiya/outil', 'kiamiya/jeu', 'kiamiya/absent', 'kiamiya/jeu'],
        active: 'kiamiya/jeu',
      }),
    ).toEqual({ tabs: ['kiamiya/outil', 'kiamiya/jeu'], active: 'kiamiya/jeu' });
    expect(service.saveTabs({ tabs: ['kiamiya/site'], active: 'kiamiya/jeu' })).toEqual({
      tabs: ['kiamiya/site'],
      active: null,
    });
  });

  it('agrège l’activité de tous les projets avec le plafond global', async () => {
    const { service, repos } = await setup();
    for (const repo of ['jeu', 'site']) await service.open({ owner: 'kiamiya', repo });
    repos.settings.update({ maxConcurrentAgents: 4 });
    expect(service.activity()).toEqual({ activeAgents: 2, maxAgents: 4, pendingQuestions: 2 });
  });
});
