import type { FakeGitHub } from 'github';
import {
  parseAnswerComment,
  parseQuestionComment,
  renderQuestionComment,
  stateLabel,
  TASK_LABEL,
} from 'shared';
import { makePlan } from 'shared/test-utils';
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
  }
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
