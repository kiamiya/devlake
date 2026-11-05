import { afterAll, describe, expect, it } from 'vitest';
import { OctokitGitHub } from './octokit-github.js';
import type { RepoRef } from './types.js';

/**
 * Parcours @live sur un vrai dépôt bac à sable (jamais en CI).
 * GITHUB_TOKEN=… AGENTLAKE_SANDBOX_REPO=kiamiya/devlake-sandbox npm run test:live
 */
const token = process.env.GITHUB_TOKEN;
const sandbox = process.env.AGENTLAKE_SANDBOX_REPO;
const [owner, repo] = (sandbox ?? '').split('/');
const enabled = Boolean(token && owner && repo);

describe.skipIf(!enabled)('@live GitHub — dépôt bac à sable', () => {
  const ref: RepoRef = { owner: owner ?? '', repo: repo ?? '' };
  const port = new OctokitGitHub({ token: token ?? '' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const branch = `agentlake-live/${stamp}`;
  const toClose: number[] = [];

  afterAll(async () => {
    for (const number of toClose) await port.updateIssue(ref, number, { state: 'closed' });
  });

  it('parcours complet : labels, issues, dépendances, commentaires, fichiers, PR, checks, secret', async () => {
    const repository = await port.getRepository(ref);
    expect(repository.name).toBe(ref.repo);
    await port.getCapabilities(ref);

    await port.ensureLabels(ref, [
      { name: 'agentlake:live', color: '5319e7', description: 'Test @live' },
    ]);

    const blocker = await port.createIssue(ref, {
      title: `@live bloquante ${stamp}`,
      body: 'Bloquante',
    });
    const task = await port.createIssue(ref, {
      title: `@live tâche ${stamp}`,
      body: 'Tâche',
      labels: ['agentlake:live'],
    });
    toClose.push(blocker.number, task.number);

    await port.addLabels(ref, task.number, ['agentlake:state/queued']);
    await port.removeLabel(ref, task.number, 'agentlake:state/queued');
    expect((await port.getIssue(ref, task.number)).labels).toEqual(['agentlake:live']);

    await port.setDependencies(ref, task.number, [blocker.number]);
    expect(await port.getDependencies(ref, task.number)).toEqual([blocker.number]);

    const comment = await port.createComment(
      ref,
      task.number,
      '<!-- agentlake:answer id=LIVE -->\nOui',
    );
    expect((await port.listComments(ref, task.number)).map((c) => c.id)).toContain(comment.id);

    const sha = await port.commitFiles(ref, {
      branch,
      baseBranch: repository.defaultBranch,
      message: 'test: parcours @live',
      changes: [
        { path: 'live/a.md', content: `# @live ${stamp}\n` },
        { path: 'live/b.txt', content: 'B' },
      ],
    });
    const [pointer] = await port.uploadLfsObjects(ref, [
      new TextEncoder().encode(`image @live ${stamp}`),
    ]);
    expect(pointer?.size).toBeGreaterThan(0);

    expect((await port.getFile(ref, 'live/a.md', branch))?.content).toBe(`# @live ${stamp}\n`);

    const pr = await port.createPullRequest(ref, {
      title: `@live ${stamp}`,
      body: 'PR de test @live',
      head: branch,
      base: repository.defaultBranch,
    });
    toClose.push(pr.number);
    expect(pr.headSha).toBe(sha);
    expect(Array.isArray(await port.listCheckRuns(ref, sha))).toBe(true);

    await port.setRepositorySecret(ref, 'AGENTLAKE_LIVE_SECRET', stamp);
    expect(await port.listRepositorySecrets(ref)).toContain('AGENTLAKE_LIVE_SECRET');
  });
});
