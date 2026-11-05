import { beforeEach, describe, expect, it } from 'vitest';
import { isGitHubError } from '../errors.js';
import type { FakeGitHub } from '../fake-github.js';
import type { GitHubPort } from '../port.js';
import type { RepoRef } from '../types.js';

export interface ContractContext {
  /** Implémentation testée. */
  port: GitHubPort;
  /** État sous-jacent, pour préparer et vérifier. */
  fake: FakeGitHub;
}

const ref: RepoRef = { owner: 'kiamiya', repo: 'contrat' };

/**
 * Suite de contrat du port GitHub : elle doit passer à l'identique
 * sur `FakeGitHub` et sur l'adaptateur Octokit simulé par msw.
 */
export function describeGitHubContract(
  name: string,
  setup: (options: { issueDependencies: boolean }) => ContractContext,
): void {
  describe(`contrat GitHubPort — ${name}`, () => {
    let port: GitHubPort;
    let fake: FakeGitHub;

    beforeEach(() => {
      ({ port, fake } = setup({ issueDependencies: true }));
      fake.seedRepository(ref);
    });

    describe('compte', () => {
      it('donne le compte du jeton et liste ses dépôts', async () => {
        expect(await port.getAuthenticatedUser()).toEqual({ login: 'kiamiya' });
        fake.seedRepository({ owner: 'kiamiya', repo: 'autre' });
        fake.seedRepository({ owner: 'quelquun', repo: 'pas-a-moi' });
        expect((await port.listRepositories()).map((r) => r.name)).toEqual(['autre', 'contrat']);
      });
    });

    describe('dépôts', () => {
      it('crée un dépôt et le relit', async () => {
        const created = await port.createRepository({ name: 'nouveau', private: false });
        expect(created).toMatchObject({
          owner: 'kiamiya',
          name: 'nouveau',
          private: false,
          defaultBranch: 'main',
        });
        expect(await port.getRepository({ owner: 'kiamiya', repo: 'nouveau' })).toEqual(created);
      });

      it('configure auto-merge, squash seul et suppression des branches', async () => {
        const repository = await port.configureMergeSettings(ref);
        expect(repository).toMatchObject({
          allowAutoMerge: true,
          allowSquashMerge: true,
          allowMergeCommit: false,
          allowRebaseMerge: false,
          deleteBranchOnMerge: true,
        });
        expect((await port.getCapabilities(ref)).autoMerge).toBe(true);
      });

      it('protège main avec les checks obligatoires', async () => {
        expect(await port.getBranchProtection(ref, 'main')).toBeNull();
        await port.protectBranch(ref, 'main', {
          requiredChecks: ['lint', 'tests'],
          enforceAdmins: true,
        });
        expect(await port.getBranchProtection(ref, 'main')).toEqual({
          branch: 'main',
          requiredChecks: ['lint', 'tests'],
          enforceAdmins: true,
          requirePullRequest: true,
        });
      });

      it('met le GITHUB_TOKEN en lecture seule et exige l’approbation des forks', async () => {
        expect((await port.getActionsPermissions(ref)).defaultWorkflowPermissions).toBe('write');
        await port.configureActionsPermissions(ref);
        expect(await port.getActionsPermissions(ref)).toEqual({
          defaultWorkflowPermissions: 'read',
          canApprovePullRequestReviews: false,
          forkPrApproval: 'all_external_contributors',
        });
      });

      it('signale un dépôt introuvable par une erreur typée', async () => {
        await expect(port.getRepository({ owner: 'kiamiya', repo: 'absent' })).rejects.toSatisfy(
          (e: unknown) => isGitHubError(e, 'not-found'),
        );
      });
    });

    describe('fichiers', () => {
      it('commite plusieurs fichiers en un seul commit sur une nouvelle branche', async () => {
        const sha = await port.commitFiles(ref, {
          branch: 'contexte',
          baseBranch: 'main',
          message: 'docs: contexte',
          changes: [
            { path: '.agentlake/context/brief.md', content: '# Brief\nÉté ✓' },
            {
              path: '.agentlake/context/assets/a.bin',
              content: Buffer.from([0, 1, 2]).toString('base64'),
              encoding: 'base64',
            },
          ],
        });
        expect(fake.state(ref).branches.get('contexte')?.sha).toBe(sha);
        expect((await port.getFile(ref, '.agentlake/context/brief.md', 'contexte'))?.content).toBe(
          '# Brief\nÉté ✓',
        );
        expect(await port.getFile(ref, '.agentlake/context/brief.md')).toBeNull();
        expect((await port.getFile(ref, 'README.md', 'contexte'))?.content).toBe('# contrat\n');
      });

      it('modifie et supprime sur une branche existante', async () => {
        await port.commitFiles(ref, {
          branch: 'main',
          message: 'chore: maj',
          changes: [
            { path: 'README.md', delete: true },
            { path: 'a.txt', content: 'A' },
          ],
        });
        expect(await port.getFile(ref, 'README.md')).toBeNull();
        expect((await port.getFile(ref, 'a.txt'))?.content).toBe('A');
      });

      it('sait si une branche existe ; un fichier d’une branche absente est absent', async () => {
        expect(await port.branchExists(ref, 'main')).toBe(true);
        expect(await port.branchExists(ref, 'plan/v1')).toBe(false);
        expect(await port.getFile(ref, 'README.md', 'plan/v1')).toBeNull();
      });

      it('refuse une branche absente sans branche de départ', async () => {
        await expect(
          port.commitFiles(ref, {
            branch: 'absente',
            message: 'x',
            changes: [{ path: 'a', content: 'a' }],
          }),
        ).rejects.toSatisfy((e: unknown) => isGitHubError(e, 'not-found'));
      });
    });

    describe('Git LFS', () => {
      it('envoie les binaires une seule fois et renvoie leurs pointeurs', async () => {
        const image = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
        const other = new Uint8Array([9, 9, 9]);
        const pointers = await port.uploadLfsObjects(ref, [image, other, image]);
        expect(pointers.map((p) => p.size)).toEqual([7, 3, 7]);
        expect(pointers[0]).toEqual(pointers[2]);
        expect(fake.state(ref).lfsUploads).toBe(2);
        await port.uploadLfsObjects(ref, [image]);
        expect(fake.state(ref).lfsUploads).toBe(2);
        expect(await port.uploadLfsObjects(ref, [])).toEqual([]);
        expect(fake.state(ref).lfs.get(pointers[0]?.oid ?? '')).toEqual(image);
        expect(await port.downloadLfsObject(ref, pointers[1] ?? { oid: '', size: 0 })).toEqual(
          other,
        );
        await expect(
          port.downloadLfsObject(ref, { oid: 'f'.repeat(64), size: 1 }),
        ).rejects.toSatisfy((e: unknown) => isGitHubError(e, 'not-found'));
      });
    });

    describe('issues, labels et commentaires', () => {
      it('crée, relit, modifie et liste les issues', async () => {
        const issue = await port.createIssue(ref, {
          title: 'T01 — Schémas',
          body: 'Corps',
          labels: ['agentlake:task'],
        });
        expect(issue).toMatchObject({
          title: 'T01 — Schémas',
          body: 'Corps',
          state: 'open',
          labels: ['agentlake:task'],
          author: 'kiamiya',
        });
        expect(await port.getIssue(ref, issue.number)).toEqual(issue);

        const other = await port.createIssue(ref, { title: 'Autre', body: '' });
        await port.updateIssue(ref, other.number, { state: 'closed', title: 'Autre fermée' });

        expect((await port.listIssues(ref)).map((i) => i.number)).toEqual([issue.number]);
        expect((await port.listIssues(ref, { state: 'all' })).map((i) => i.number)).toEqual([
          other.number,
          issue.number,
        ]);
        expect(
          (await port.listIssues(ref, { state: 'all', labels: ['agentlake:task'] })).map(
            (i) => i.number,
          ),
        ).toEqual([issue.number]);
        expect((await port.getIssue(ref, other.number)).title).toBe('Autre fermée');
      });

      it('n’inclut pas les pull requests dans les issues', async () => {
        await port.commitFiles(ref, {
          branch: 'b',
          baseBranch: 'main',
          message: 'x',
          changes: [{ path: 'x', content: 'x' }],
        });
        await port.createPullRequest(ref, { title: 'PR', body: '', head: 'b', base: 'main' });
        expect(await port.listIssues(ref, { state: 'all' })).toEqual([]);
      });

      it('crée et met à jour les labels sans doublon', async () => {
        await port.ensureLabels(ref, [
          { name: 'agentlake:task', color: '0e8a16', description: 'Tâche' },
        ]);
        await port.ensureLabels(ref, [
          { name: 'agentlake:task', color: '5319e7', description: 'Tâche AgentLake' },
          { name: 'agentlake:state/ready', color: 'fbca04' },
        ]);
        const labels = await port.listLabels(ref);
        expect(labels).toHaveLength(2);
        expect(labels).toContainEqual({
          name: 'agentlake:task',
          color: '5319e7',
          description: 'Tâche AgentLake',
        });
        expect(labels).toContainEqual({ name: 'agentlake:state/ready', color: 'fbca04' });
      });

      it('ajoute et retire des labels, retrait idempotent', async () => {
        const issue = await port.createIssue(ref, { title: 'T', body: '' });
        await port.addLabels(ref, issue.number, ['agentlake:state/queued', 'agentlake:task']);
        await port.removeLabel(ref, issue.number, 'agentlake:state/queued');
        await port.removeLabel(ref, issue.number, 'agentlake:state/queued');
        expect((await port.getIssue(ref, issue.number)).labels).toEqual(['agentlake:task']);
      });

      it('publie et liste les commentaires', async () => {
        const issue = await port.createIssue(ref, { title: 'T', body: '' });
        const comment = await port.createComment(
          ref,
          issue.number,
          '<!-- agentlake:answer id=Q1 -->\nOui',
        );
        expect(comment).toMatchObject({
          body: '<!-- agentlake:answer id=Q1 -->\nOui',
          author: 'kiamiya',
        });
        expect(await port.listComments(ref, issue.number)).toEqual([comment]);
      });

      it('signale une issue introuvable', async () => {
        await expect(port.getIssue(ref, 999)).rejects.toSatisfy((e: unknown) =>
          isGitHubError(e, 'not-found'),
        );
      });
    });

    describe('relations de dépendance', () => {
      it('utilise les relations natives quand le compte les propose', async () => {
        const a = await port.createIssue(ref, { title: 'A', body: '' });
        const b = await port.createIssue(ref, { title: 'B', body: '' });
        const c = await port.createIssue(ref, { title: 'C', body: 'Corps de C' });
        expect((await port.getCapabilities(ref)).issueDependencies).toBe(true);
        await port.setDependencies(ref, c.number, [b.number, a.number]);
        expect(await port.getDependencies(ref, c.number)).toEqual([a.number, b.number]);
        await port.setDependencies(ref, c.number, [b.number]);
        expect(await port.getDependencies(ref, c.number)).toEqual([b.number]);
        expect((await port.getIssue(ref, c.number)).body).toBe('Corps de C');
      });

      it('se replie sur un bloc caché du corps sinon', async () => {
        ({ port, fake } = setup({ issueDependencies: false }));
        fake.seedRepository(ref);
        const a = await port.createIssue(ref, { title: 'A', body: '' });
        const c = await port.createIssue(ref, { title: 'C', body: 'Corps de C' });
        expect((await port.getCapabilities(ref)).issueDependencies).toBe(false);
        await port.setDependencies(ref, c.number, [a.number]);
        expect(await port.getDependencies(ref, c.number)).toEqual([a.number]);
        expect((await port.getIssue(ref, c.number)).body).toBe(
          `Corps de C\n\n<!-- agentlake:blocked-by ${String(a.number)} -->\n`,
        );
        await port.setDependencies(ref, c.number, []);
        expect((await port.getIssue(ref, c.number)).body).toBe('Corps de C');
      });
    });

    describe('pull requests et checks', () => {
      beforeEach(async () => {
        await port.commitFiles(ref, {
          branch: 'task/T01',
          baseBranch: 'main',
          message: 'feat: T01',
          changes: [{ path: 'src/a.ts', content: 'export {};' }],
        });
      });

      it('crée, relit et filtre les PR', async () => {
        const pr = await port.createPullRequest(ref, {
          title: 'T01',
          body: 'Closes #1',
          head: 'task/T01',
          base: 'main',
        });
        expect(pr).toMatchObject({
          title: 'T01',
          head: 'task/T01',
          base: 'main',
          state: 'open',
          autoMerge: false,
        });
        expect(pr.headSha).toBe(fake.state(ref).branches.get('task/T01')?.sha);
        expect(await port.getPullRequest(ref, pr.number)).toEqual(pr);
        expect(await port.listPullRequests(ref, { head: 'task/T01' })).toEqual([pr]);
        expect(await port.listPullRequests(ref, { head: 'autre' })).toEqual([]);
        const updated = await port.updatePullRequest(ref, pr.number, {
          title: 'T01 — v2',
          body: 'Corps v2',
        });
        expect(updated).toMatchObject({ title: 'T01 — v2', body: 'Corps v2', head: 'task/T01' });
        expect(await port.getPullRequest(ref, pr.number)).toEqual(updated);

        fake.mergePullRequest(ref, pr.number);
        expect((await port.getPullRequest(ref, pr.number)).state).toBe('merged');
        expect(await port.listPullRequests(ref)).toEqual([]);
        expect(await port.listPullRequests(ref, { state: 'closed' })).toHaveLength(1);
      });

      it('active l’auto-merge seulement si le dépôt l’autorise', async () => {
        const pr = await port.createPullRequest(ref, {
          title: 'T01',
          body: '',
          head: 'task/T01',
          base: 'main',
        });
        await expect(port.enableAutoMerge(ref, pr.number)).rejects.toSatisfy((e: unknown) =>
          isGitHubError(e, 'validation'),
        );
        await port.configureMergeSettings(ref);
        await port.enableAutoMerge(ref, pr.number);
        expect((await port.getPullRequest(ref, pr.number)).autoMerge).toBe(true);
      });

      it('liste les checks d’un commit', async () => {
        fake.seedCheckRuns(ref, 'abc', [
          { name: 'lint', status: 'completed', conclusion: 'success' },
          { name: 'tests', status: 'in_progress', conclusion: null },
        ]);
        expect(await port.listCheckRuns(ref, 'abc')).toEqual([
          { name: 'lint', status: 'completed', conclusion: 'success' },
          { name: 'tests', status: 'in_progress', conclusion: null },
        ]);
        expect(await port.listCheckRuns(ref, 'inconnu')).toEqual([]);
      });

      it('liste les fichiers d’une PR avec lignes ajoutées et supprimées', async () => {
        await fake.commitFiles(ref, {
          branch: 'main',
          message: 'base',
          changes: [
            { path: 'src/a.ts', content: 'un\ndeux\n' },
            { path: 'src/a.test.ts', content: 'test 1\n' },
          ],
        });
        await fake.commitFiles(ref, {
          branch: 'task/T09',
          baseBranch: 'main',
          message: 'travail',
          changes: [
            { path: 'src/a.ts', content: 'un\ntrois\nquatre\n' },
            { path: 'src/b.ts', content: 'b\n' },
            { path: 'src/a.test.ts', delete: true },
          ],
        });
        const pr = await port.createPullRequest(ref, {
          title: 'T09',
          body: '',
          head: 'task/T09',
          base: 'main',
        });
        expect(await port.listPullRequestFiles(ref, pr.number)).toEqual([
          { filename: 'src/a.test.ts', status: 'removed', additions: 0, deletions: 1 },
          { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
          { filename: 'src/b.ts', status: 'added', additions: 1, deletions: 0 },
        ]);
        fake.seedPullRequestFiles(ref, pr.number, [
          {
            filename: 'b.ts',
            status: 'renamed',
            additions: 0,
            deletions: 0,
            previousFilename: 'a.ts',
          },
        ]);
        expect(await port.listPullRequestFiles(ref, pr.number)).toEqual([
          {
            filename: 'b.ts',
            status: 'renamed',
            additions: 0,
            deletions: 0,
            previousFilename: 'a.ts',
          },
        ]);
      });
    });

    describe('Actions', () => {
      it('déclenche un workflow_dispatch', async () => {
        await port.dispatchWorkflow(ref, {
          workflow: 'agent-task.yml',
          ref: 'main',
          inputs: { issue: '12' },
        });
        expect(fake.state(ref).dispatches).toEqual([
          { workflow: 'agent-task.yml', ref: 'main', inputs: { issue: '12' } },
        ]);
      });

      it('liste les runs, leurs jobs et lit les journaux', async () => {
        const run = {
          id: 7,
          name: 'Agent',
          title: 'Agent, issue #1',
          workflow: 'agent-task.yml',
          status: 'completed',
          conclusion: 'failure',
          headBranch: 'task/T01',
          event: 'workflow_dispatch',
          createdAt: '2026-11-05T10:00:00Z',
          updatedAt: '2026-11-05T10:12:00Z',
          url: 'https://github.com/kiamiya/contrat/actions/runs/7',
        };
        fake.seedWorkflowRun(ref, run, [
          {
            job: { id: 70, runId: 7, name: 'agent', status: 'completed', conclusion: 'failure' },
            logs: 'Erreur : test cassé\n',
          },
        ]);
        expect(await port.listWorkflowRuns(ref)).toEqual([run]);
        expect(
          await port.listWorkflowRuns(ref, { workflow: 'agent-task.yml', branch: 'task/T01' }),
        ).toEqual([run]);
        expect(await port.listWorkflowRuns(ref, { workflow: 'planner.yml' })).toEqual([]);
        expect(await port.getWorkflowRun(ref, 7)).toEqual(run);
        expect(await port.listRunJobs(ref, 7)).toEqual([
          { id: 70, runId: 7, name: 'agent', status: 'completed', conclusion: 'failure' },
        ]);
        expect(await port.getJobLogs(ref, 70)).toBe('Erreur : test cassé\n');
        await port.rerunFailedJobs(ref, 7);
        expect(fake.state(ref).reruns).toEqual([7]);
        await expect(port.rerunFailedJobs(ref, 99)).rejects.toThrow();
      });
    });

    describe('secrets', () => {
      it('enregistre un secret et le liste sans exposer sa valeur', async () => {
        await port.setRepositorySecret(ref, 'CLAUDE_CODE_OAUTH_TOKEN', 'jeton-très-secret');
        expect(fake.secretValue(ref, 'CLAUDE_CODE_OAUTH_TOKEN')).toBe('jeton-très-secret');
        expect(await port.listRepositorySecrets(ref)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
      });
    });
  });
}
