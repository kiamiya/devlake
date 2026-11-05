import type { FakeGitHub } from 'github';
import { stateLabel, TASK_LABEL } from 'shared';
import { PROJECT_CONFIG_PATH } from './db/rebuild.js';

/**
 * Projets de démonstration pour les tests E2E (AGENTLAKE_FAKE_PROJECTS=jeu,site,…).
 * Chaque projet a une question en attente et une tâche en cours.
 */
export async function seedFakeProjects(fake: FakeGitHub, names: readonly string[]): Promise<void> {
  for (const repo of names) {
    const ref = { owner: fake.actor, repo };
    fake.seedRepository(ref);
    await fake.commitFiles(ref, {
      branch: 'main',
      message: 'chore: projet AgentLake',
      changes: [{ path: PROJECT_CONFIG_PATH, content: 'type: web\n' }],
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
