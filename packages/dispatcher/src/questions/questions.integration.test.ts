import { FakeGitHub } from 'github';
import { renderAnswerComment, renderTaskIssueBody, stateLabel, TASK_LABEL } from 'shared';
import { makeAgentProfile, makeProjectConfig, makeTask } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { finalizeAgent } from '../agent-context/finalize.js';
import type { Git } from '../agent-context/git.js';
import { prepareAgent } from '../agent-context/prepare.js';
import { runDispatchCli } from '../dispatch/cli.js';
import { PROJECT_CONFIG } from '../dispatch/dispatcher.js';

const OWNER = 'kiamiya';
const ref = { owner: OWNER, repo: 'site' };
const BRANCH = 'task/T01-ecran-de-connexion';

/** Faux git du runner : la branche de la tâche existe sur le dépôt dès qu'elle a été poussée. */
class RunnerGit implements Git {
  readonly calls: string[][] = [];
  constructor(private readonly remote: { pushed: boolean }) {}
  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args.includes('ls-remote'))
      return Promise.resolve(this.remote.pushed ? `abc\trefs/heads/${BRANCH}` : '');
    if (args[0] === 'status') return Promise.resolve(' M src/login.ts\n');
    if (args[0] === 'rev-list') return Promise.resolve('1\n');
    if (args.includes('push')) this.remote.pushed = true;
    return Promise.resolve('');
  }
  get text(): string {
    return this.calls
      .map((c) => c.filter((a) => !a.includes('extraheader') && a !== '-c').join(' '))
      .join('\n');
  }
}

async function dispatch(github: FakeGitHub, event: string, payload: unknown, log: string[]) {
  return runDispatchCli(
    {
      GITHUB_REPOSITORY: `${OWNER}/site`,
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: 'evenement.json',
      GH_TOKEN: 'jeton',
      AGENTLAKE_CONFIG_TOKEN: '',
    },
    {
      github: () => github,
      readText: () => Promise.resolve(JSON.stringify(payload)),
      fetch: () => Promise.reject(new Error('pas de réseau')),
      now: () => new Date(),
      log: (l) => log.push(l),
    },
  );
}

const commentEvent = (issue: number, comment: { id: number; body: string; author: string }) => ({
  sender: { login: comment.author },
  issue: { number: issue },
  comment: { id: comment.id, body: comment.body, user: { login: comment.author } },
});

describe('protocole de questions, de bout en bout', () => {
  it('question bloquante → attente → réponse → reprise sur la même branche, avec la réponse ; une ancienne réponse ne relance rien', async () => {
    const github = new FakeGitHub({ actor: OWNER });
    github.seedRepository(ref);
    await github.configureMergeSettings(ref);
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'projet',
      changes: [
        { path: PROJECT_CONFIG, content: stringify(makeProjectConfig()) },
        {
          path: '.agentlake/profiles/frontend.yml',
          content: stringify(makeAgentProfile({ id: 'frontend' })),
        },
      ],
    });
    const issue = await github.createIssue(ref, {
      title: 'T01',
      body: renderTaskIssueBody(makeTask({ id: 'T01', title: 'Écran de connexion' })),
      labels: [TASK_LABEL, stateLabel('ready')],
    });
    const log: string[] = [];
    const remote = { pushed: false };
    const files: Record<string, string> = {
      '.agentlake/profiles/frontend.yml': stringify(makeAgentProfile({ id: 'frontend' })),
    };
    const agentDeps = (git: RunnerGit) => ({
      github,
      git,
      readFile: (path: string) => Promise.resolve(files[path] ?? null),
      writeFile: (path: string, content: string) => {
        files[path] = content;
        return Promise.resolve();
      },
      token: 'jeton',
      today: () => '2026-11-05',
    });

    // 1. Passe planifiée : l'agent part.
    await dispatch(github, 'schedule', {}, log);
    expect(github.state(ref).dispatches).toHaveLength(1);

    // 2. L'agent pose une question bloquante : travail poussé, attente, aucune PR.
    const first = new RunnerGit(remote);
    const prepared = await prepareAgent(
      { ref, issueNumber: issue.number, profileId: 'frontend', attempt: 1, reason: 'none' },
      agentDeps(first),
    );
    expect(prepared.branch).toBe(BRANCH);
    const suspended = await finalizeAgent(
      {
        ref,
        issueNumber: issue.number,
        taskId: 'T01',
        taskTitle: 'Écran de connexion',
        branch: BRANCH,
        attempt: 1,
        conclusion: 'success',
        structuredOutput: JSON.stringify({
          outcome: 'blocked',
          pr_title: 'x',
          pr_summary: 'x',
          questions: [
            {
              id: 'sso',
              blocking: true,
              text: 'Faut-il la connexion Google ?',
              options: ['Oui', 'Non'],
            },
          ],
        }),
        runUrl: 'https://github.com/kiamiya/site/actions/runs/1',
      },
      { github, appGithub: github, git: first, appToken: 'app' },
    );
    expect(suspended).toEqual({ status: 'awaiting-answer', questionId: 'sso', pushed: true });
    expect((await github.getIssue(ref, issue.number)).labels).toContain(
      stateLabel('awaiting-answer'),
    );
    expect(await github.listPullRequests(ref)).toEqual([]);

    // Une passe sans réponse ne relance rien.
    await dispatch(github, 'schedule', {}, log);
    expect(github.state(ref).dispatches).toHaveLength(1);

    // 3. Kia répond : reprise avec resume_reason=answer.
    const reply = await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'sso', decision: true, text: 'Non, e-mail seulement.' }),
    );
    await dispatch(github, 'issue_comment', commentEvent(issue.number, reply), log);
    expect(github.state(ref).dispatches).toHaveLength(2);
    expect(github.state(ref).dispatches[1]?.inputs).toMatchObject({
      resume_reason: 'answer',
      attempt: '2',
    });
    // L'événement rejoué (ou la passe planifiée) ne relance pas une seconde fois.
    await dispatch(github, 'issue_comment', commentEvent(issue.number, reply), log);
    expect(github.state(ref).dispatches).toHaveLength(2);

    // 4. Le job repris repart de la même branche, avec la réponse et la décision.
    const second = new RunnerGit(remote);
    const resumed = await prepareAgent(
      { ref, issueNumber: issue.number, profileId: 'frontend', attempt: 2, reason: 'answer' },
      agentDeps(second),
    );
    expect(resumed.branchState).toBe('resumed');
    expect(second.text).toContain(`checkout -B ${BRANCH} origin/${BRANCH}`);
    expect(resumed.prompt).toContain('## Reprise après une réponse');
    expect(resumed.prompt).toContain('**Réponse** : Non, e-mail seulement.');
    expect(files['.agentlake/decisions.md']).toContain('**Décision** : Non, e-mail seulement.');

    // 5. L'agent repose une question ; une réponse à l'ancienne ne relance rien, et elle est tracée.
    await finalizeAgent(
      {
        ref,
        issueNumber: issue.number,
        taskId: 'T01',
        taskTitle: 'Écran de connexion',
        branch: BRANCH,
        attempt: 2,
        conclusion: 'success',
        structuredOutput: JSON.stringify({
          outcome: 'blocked',
          pr_title: 'x',
          pr_summary: 'x',
          questions: [{ id: 'mdp', blocking: true, text: 'Longueur minimale du mot de passe ?' }],
        }),
        runUrl: 'https://github.com/kiamiya/site/actions/runs/2',
      },
      { github, appGithub: github, git: second, appToken: 'app' },
    );
    const stale = await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'sso', decision: false, text: 'Finalement oui.' }),
    );
    await dispatch(github, 'issue_comment', commentEvent(issue.number, stale), log);
    expect(github.state(ref).dispatches).toHaveLength(2);
    expect((await github.getIssue(ref, issue.number)).labels).toContain(
      stateLabel('awaiting-answer'),
    );
    const last = (await github.listComments(ref, issue.number)).at(-1)?.body ?? '';
    expect(last).toContain('_Réponse à `sso` ignorée : la tâche attend la question `mdp`._');

    // Un autre compte ne peut pas débloquer la tâche.
    const intruder = await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'mdp', decision: false, text: '4' }),
    );
    const forged = { ...intruder, author: 'pirate' };
    github.state(ref).comments.get(issue.number)?.splice(-1, 1, forged);
    await dispatch(github, 'issue_comment', commentEvent(issue.number, forged), log);
    expect(github.state(ref).dispatches).toHaveLength(2);
    expect(log).toContain(
      `Réponse ignorée sur #${String(issue.number)} : seul kiamiya peut répondre aux questions des agents.`,
    );
  });
});
