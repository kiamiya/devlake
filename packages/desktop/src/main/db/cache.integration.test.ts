import Database from 'better-sqlite3';
import { FakeGitHub } from 'github';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings.js';
import { bundledMigrations, openDatabase, runMigrations } from './database.js';
import { rebuildAll, rebuildFromGitHub, PROJECT_CONFIG_PATH } from './rebuild.js';
import { createRepositories } from './repositories.js';

const run = {
  id: 7,
  name: 'Agent',
  workflow: 'agent-task.yml',
  status: 'completed',
  conclusion: 'success',
  headBranch: 'task/T01',
  event: 'workflow_dispatch',
  createdAt: '2026-11-05T10:00:00Z',
  url: 'https://github.com/kiamiya/jeu/actions/runs/7',
};

async function seedProject(github: FakeGitHub, repo: string) {
  const ref = { owner: 'kiamiya', repo };
  github.seedRepository(ref);
  await github.commitFiles(ref, {
    branch: 'main',
    message: 'chore: projet',
    changes: [{ path: PROJECT_CONFIG_PATH, content: 'type: web\n' }],
  });
  await github.createIssue(ref, {
    title: 'T00 — Bootstrap',
    body: 'corps',
    labels: ['agentlake:task'],
  });
  const closed = await github.createIssue(ref, { title: 'T01', body: '' });
  await github.updateIssue(ref, closed.number, { state: 'closed' });
  github.seedWorkflowRun(ref, run);
  return ref;
}

describe('base du cockpit', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('crée la base par migrations, en WAL, et ne rejoue pas les migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlake-db-'));
    dirs.push(dir);
    const file = join(dir, 'cockpit.sqlite');

    const first = openDatabase(file);
    expect(first.created).toBe(true);
    expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    const tables = first.sqlite
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((t) => t.name);
    expect(tables).toEqual([
      '__agentlake_migrations',
      'issues',
      'projects',
      'questions',
      'runs',
      'settings',
      'tabs',
    ]);
    first.sqlite.close();

    const second = openDatabase(file);
    expect(second.created).toBe(false);
    expect(runMigrations(second.sqlite, bundledMigrations())).toBe(0);
    second.sqlite.close();
  });

  it('applique une nouvelle migration sans toucher aux précédentes', () => {
    const sqlite = new Database(':memory:');
    expect(runMigrations(sqlite, bundledMigrations())).toBe(bundledMigrations().length);
    expect(
      runMigrations(sqlite, [
        ...bundledMigrations(),
        {
          name: '9999_test.sql',
          sql: 'CREATE TABLE t (a INTEGER);--> statement-breakpoint\nCREATE TABLE u (b INTEGER);',
        },
      ]),
    ).toBe(1);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('t','u')").get(),
    ).toEqual({ n: 2 });
  });
});

describe('repositories Drizzle (base en mémoire)', () => {
  it('projets, onglets et réglages', () => {
    const repos = createRepositories(openDatabase(':memory:').db);
    repos.projects.upsert('kiamiya', 'jeu', '2026-11-05T10:00:00Z');
    repos.projects.upsert('kiamiya', 'jeu', '2026-11-06T10:00:00Z');
    repos.projects.upsert('kiamiya', 'site', '2026-11-05T10:00:00Z');
    repos.projects.markSynced('kiamiya/jeu', '2026-11-05T11:00:00Z');
    expect(repos.projects.list()).toEqual([
      {
        id: 'kiamiya/jeu',
        owner: 'kiamiya',
        repo: 'jeu',
        addedAt: '2026-11-05T10:00:00Z',
        lastSyncedAt: '2026-11-05T11:00:00Z',
      },
      {
        id: 'kiamiya/site',
        owner: 'kiamiya',
        repo: 'site',
        addedAt: '2026-11-05T10:00:00Z',
        lastSyncedAt: null,
      },
    ]);

    repos.tabs.save([
      { projectId: 'kiamiya/site', position: 0, active: false },
      { projectId: 'kiamiya/jeu', position: 1, active: true },
    ]);
    expect(repos.tabs.list().map((t) => t.projectId)).toEqual(['kiamiya/site', 'kiamiya/jeu']);
    repos.projects.remove('kiamiya/site');
    expect(repos.tabs.list()).toEqual([{ projectId: 'kiamiya/jeu', position: 1, active: true }]);
    repos.tabs.save([]);
    expect(repos.tabs.list()).toEqual([]);

    expect(repos.settings.get()).toEqual(DEFAULT_SETTINGS);
    repos.settings.update({ maxConcurrentAgents: 6 });
    repos.settings.update({ auraMcp: { unity: '{"mcpServers":{}}', unreal: null, blender: null } });
    expect(repos.settings.get()).toEqual({
      ...DEFAULT_SETTINGS,
      maxConcurrentAgents: 6,
      auraMcp: { unity: '{"mcpServers":{}}', unreal: null, blender: null },
    });
    expect(() => repos.settings.update({ maxAttempts: 0 })).toThrow();
  });

  it('retombe sur les valeurs par défaut si un réglage stocké est devenu invalide', () => {
    const opened = openDatabase(':memory:');
    opened.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('maxAttempts', '0')").run();
    expect(createRepositories(opened.db).settings.get()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('reconstruction depuis GitHub (FakeGitHub)', () => {
  it('recopie issues et runs d’un projet et remplace le miroir', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    const ref = await seedProject(github, 'jeu');
    const repos = createRepositories(openDatabase(':memory:').db);
    const now = () => '2026-11-05T12:00:00Z';

    expect(await rebuildFromGitHub(ref, github, repos, now)).toEqual({ issues: 2, runs: 1 });
    expect(repos.mirror.listIssues('kiamiya/jeu')).toEqual([
      {
        number: 1,
        title: 'T00 — Bootstrap',
        body: 'corps',
        state: 'open',
        labels: ['agentlake:task'],
        author: 'kiamiya',
      },
      { number: 2, title: 'T01', body: '', state: 'closed', labels: [], author: 'kiamiya' },
    ]);
    expect(repos.mirror.listRuns('kiamiya/jeu')).toEqual([{ ...run, title: run.name }]);
    expect(repos.projects.list()[0]?.lastSyncedAt).toBe('2026-11-05T12:00:00Z');

    await github.updateIssue(ref, 1, { title: 'T00 — renommée' });
    await rebuildFromGitHub(ref, github, repos, now);
    expect(repos.mirror.listIssues('kiamiya/jeu').map((i) => i.title)).toEqual([
      'T00 — renommée',
      'T01',
    ]);
  });

  it('cache supprimé : retrouve les projets du compte et reconstruit tout', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    await seedProject(github, 'jeu');
    await seedProject(github, 'site');
    github.seedRepository({ owner: 'kiamiya', repo: 'pas-un-projet' });

    const repos = createRepositories(openDatabase(':memory:').db);
    expect(await rebuildAll(github, repos)).toEqual({ projects: 2, issues: 4, runs: 2 });
    expect(repos.projects.list().map((p) => p.id)).toEqual(['kiamiya/jeu', 'kiamiya/site']);
    expect(repos.mirror.listIssues('kiamiya/site')).toHaveLength(2);
  });
});
