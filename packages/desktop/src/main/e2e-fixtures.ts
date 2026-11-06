import { strToU8, zipSync } from 'fflate';
import type { FakeGitHub, RepoRef } from 'github';
import {
  parseAnswerComment,
  parseQuestionComment,
  renderQuestionComment,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
  writeDispatchMeta,
} from 'shared';
import { makePlan, makeTask } from 'shared/test-utils';
import { PROJECT_CONFIG_PATH } from './db/rebuild.js';
import { PLAN_PATH } from './services/plan/plan-service.js';

const PROJECT_YML = [
  'type: web',
  'qualityProfile: web',
  'limits:',
  '  maxAttempts: 3',
  'profiles: [architect, frontend, docs]',
  'exclusiveResources: []',
  'bridgeRequired: false',
  '',
].join('\n');

/**
 * Projets de démonstration pour les tests E2E (AGENTLAKE_FAKE_PROJECTS=jeu,site,…).
 * Chaque projet a une question bloquante en attente, une tâche en cours et un plan
 * proposé sur plan/v1.
 */
export async function seedFakeProjects(fake: FakeGitHub, names: readonly string[]): Promise<void> {
  for (const repo of names) {
    const ref = { owner: fake.actor, repo };
    fake.seedRepository(ref);
    await fake.commitFiles(ref, {
      branch: 'main',
      message: 'chore: projet AgentLake',
      changes: [{ path: PROJECT_CONFIG_PATH, content: PROJECT_YML }],
    });
    await fake.commitFiles(ref, {
      branch: 'plan/v1',
      baseBranch: 'main',
      message: 'docs(plan): plan v1',
      changes: [{ path: PLAN_PATH, content: `${JSON.stringify(makePlan(), null, 2)}\n` }],
    });
    const waiting = await fake.createIssue(ref, {
      title: 'T01 — En attente',
      body: '',
      labels: [TASK_LABEL, stateLabel('awaiting-answer')],
    });
    await fake.createComment(
      ref,
      waiting.number,
      renderQuestionComment({
        id: 'fuseau',
        blocking: true,
        text: `Quel fuseau horaire pour ${repo} ?`,
        context: 'Le brief ne précise pas le fuseau des rendez-vous.',
        options: ['Europe/Paris', 'UTC'],
      }),
    );
    await fake.createIssue(ref, {
      title: 'T02 — En cours',
      body: '',
      labels: [TASK_LABEL, stateLabel('running')],
    });
    if (repo === 'outil') await seedDashboard(fake, ref);
  }
}

/**
 * Tableau de bord du projet « outil » : une tâche terminée (M), une tâche escaladée (S)
 * avec sa question, et le run de sa dernière tentative (journal de 10 000 lignes, transcription).
 */
async function seedDashboard(fake: FakeGitHub, ref: RepoRef): Promise<void> {
  const done = await fake.createIssue(ref, {
    title: 'T50 — Socle',
    body: renderTaskIssueBody(makeTask({ id: 'T50', title: 'Socle', complexity: 'M' })),
    labels: [TASK_LABEL],
  });
  await fake.updateIssue(ref, done.number, { state: 'closed' });
  const escalated = await fake.createIssue(ref, {
    title: 'T51 — Export',
    body: writeDispatchMeta(
      renderTaskIssueBody(
        makeTask({ id: 'T51', title: 'Export', complexity: 'S', dependencies: ['T50'] }),
      ),
      { attempts: 3, launchedAt: '2026-11-20T09:00:00.000Z' },
    ),
    labels: [TASK_LABEL, stateLabel('escalated')],
  });
  await fake.createComment(
    ref,
    escalated.number,
    renderQuestionComment({
      id: 'escalade-T51-3',
      blocking: true,
      text: 'La tâche T51 a échoué 3 fois. Comment continuer ?',
      options: [],
    }),
  );
  const logs = Array.from({ length: 10_000 }, (_, i) => `ligne ${String(i + 1)}`).join('\n');
  fake.seedWorkflowRun(
    ref,
    {
      id: 501,
      name: 'AgentLake — agent',
      title: `AgentLake — agent, issue #${String(escalated.number)}, tentative 3`,
      workflow: 'agentlake-agent-task.yml',
      status: 'completed',
      conclusion: 'failure',
      headBranch: 'main',
      event: 'workflow_dispatch',
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-20T09:12:00.000Z',
      url: `https://github.com/${ref.owner}/${ref.repo}/actions/runs/501`,
    },
    [
      {
        job: { id: 5010, runId: 501, name: 'agent', status: 'completed', conclusion: 'failure' },
        logs,
      },
    ],
  );
  fake.seedArtifact(ref, 501, {
    id: 5011,
    name: 'agent-issue-tentative-3',
    data: zipSync({ 'execution.json': strToU8('{"type":"result","subtype":"error_max_turns"}') }),
  });
}

/**
 * Simule le dispatcher (T13) sur le faux GitHub : une réponse du propriétaire à la question
 * attendue d'une issue « en attente » la fait repartir (label « running »).
 */
export function simulateDispatcher(fake: FakeGitHub): void {
  const createComment = fake.createComment.bind(fake);
  fake.createComment = async (ref, issueNumber, body) => {
    const comment = await createComment(ref, issueNumber, body);
    const answer = parseAnswerComment(body);
    if (!answer.ok) return comment;
    const issue = await fake.getIssue(ref, issueNumber);
    const waiting = stateLabel('awaiting-answer');
    const pending = (await fake.listComments(ref, issueNumber))
      .map((c) => parseQuestionComment(c.body))
      .filter((q) => q.ok && q.value.blocking)
      .at(-1);
    if (issue.labels.includes(waiting) && pending?.ok && pending.value.id === answer.value.id) {
      await fake.removeLabel(ref, issueNumber, waiting);
      await fake.addLabels(ref, issueNumber, [stateLabel('running')]);
    }
    return comment;
  };
}
