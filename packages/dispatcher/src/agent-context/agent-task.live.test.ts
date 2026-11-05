import { OctokitGitHub, systemClock } from 'github';
import { renderTaskIssueBody, stateLabel, TASK_LABEL } from 'shared';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { taskBranch } from './context.js';

/**
 * @live (jamais en CI) : exécution réelle de l'agent sur un dépôt bac à sable.
 *
 * Prérequis sur le bac à sable : bootstrap AgentLake fait (workflow d'appel agentlake-agent-task.yml),
 * app GitHub Claude installée, secret CLAUDE_CODE_OAUTH_TOKEN, tag devlake épinglé existant.
 *
 * GITHUB_TOKEN=… AGENTLAKE_SANDBOX_REPO=kiamiya/devlake-sandbox AGENTLAKE_LIVE_MODEL=<modèle> npm run test:live
 */
const token = process.env.GITHUB_TOKEN;
const [owner, repo] = (process.env.AGENTLAKE_SANDBOX_REPO ?? '').split('/');
const model = process.env.AGENTLAKE_LIVE_MODEL;
const enabled = Boolean(token && owner && repo && model);

describe.skipIf(!enabled)('@live agent-task — bac à sable', () => {
  const ref = { owner: owner ?? '', repo: repo ?? '' };
  const github = new OctokitGitHub({ token: token ?? '' });
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);

  it(
    'une issue « ajouter une fonction et son test » aboutit à une PR avec code et test',
    async () => {
      await github.commitFiles(ref, {
        branch: 'main',
        message: 'chore: profil backend pour le test @live',
        changes: [
          {
            path: '.agentlake/profiles/backend.yml',
            content: stringify({
              id: 'backend',
              systemPrompt: 'Tu es l’agent Backend d’AgentLake. Tu écris du code TypeScript testé.',
              allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
              maxTurns: 40,
              model,
              exclusiveResources: [],
              estimatedMinutes: 15,
            }),
          },
        ],
      });

      const id = `T${stamp.slice(-4)}`;
      const title = `Ajouter une fonction somme ${stamp}`;
      const issue = await github.createIssue(ref, {
        title: `${id} — ${title}`,
        body: renderTaskIssueBody({
          id,
          title,
          description: 'Ajouter `src/somme.ts` qui exporte `somme(a, b)` et son test unitaire.',
          kind: 'code',
          profile: 'backend',
          complexity: 'S',
          acceptanceCriteria: ['somme(2, 3) renvoie 5'],
          requiredTests: { unit: ['somme additionne deux nombres'] },
          codeZones: ['src/'],
          exclusiveResources: [],
          dependencies: [],
        }),
        labels: [TASK_LABEL, stateLabel('ready')],
      });

      const started = new Date().toISOString();
      await github.dispatchWorkflow(ref, {
        workflow: 'agentlake-agent-task.yml',
        ref: 'main',
        inputs: { issue_number: String(issue.number), profile: 'backend' },
      });

      // Attente de la fin de l'exécution (au plus 40 minutes).
      const deadline = Date.now() + 40 * 60_000;
      let conclusion: string | null = null;
      while (Date.now() < deadline && conclusion === null) {
        await systemClock.sleep(30_000);
        const runs = await github.listWorkflowRuns(ref, { workflow: 'agentlake-agent-task.yml' });
        const run = runs.find((r) => r.createdAt >= started && r.status === 'completed');
        conclusion = run?.conclusion ?? null;
      }
      expect(conclusion).toBe('success');

      const [pr] = await github.listPullRequests(ref, {
        head: taskBranch(id, title),
        state: 'open',
      });
      expect(pr?.title.startsWith(`${id} — `)).toBe(true);
      expect(pr?.body).toContain(`Closes #${String(issue.number)}`);
      expect((await github.getFile(ref, 'src/somme.ts', pr?.head))?.content).toContain('somme');
    },
    45 * 60_000,
  );
});
