import type { FakeGitHub } from 'github';
import { stateLabel, TASK_LABEL } from 'shared';
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
 * Chaque projet a une question en attente, une tâche en cours et un plan proposé sur plan/v1.
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
    await fake.createIssue(ref, {
      title: 'T01 — En attente',
      body: '',
      labels: [TASK_LABEL, stateLabel('awaiting-answer')],
    });
    await fake.createIssue(ref, {
      title: 'T02 — En cours',
      body: '',
      labels: [TASK_LABEL, stateLabel('running')],
    });
  }
}
