import type { GitHubPort, RepoRef, WorkflowRun } from 'github';
import { extractRelevantLogs } from '../quality/logs.js';
import { readThread } from '../questions/thread.js';
import { parseStateLabel, stateLabel, type TaskState } from 'shared';
import type { Resume } from './prompt.js';

export const RESUME_REASONS = ['none', 'answer', 'ci-failure'] as const;
export type ResumeReason = (typeof RESUME_REASONS)[number];

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeError';
  }
}

/** Taille maximale lue par journal de job (la fin est la plus utile). */
const MAX_LOG_PER_JOB = 8_000;

/** Données de reprise : la dernière réponse à une question, ou les journaux du dernier échec de CI. */
export async function gatherResume(
  github: GitHubPort,
  ref: RepoRef,
  input: { issueNumber: number; reason: ResumeReason; branch: string; attempt: number },
): Promise<Resume> {
  if (input.reason === 'none') return { kind: 'none' };

  if (input.reason === 'answer') {
    // Même règle que le dispatcher : réponse du propriétaire à la dernière question bloquante.
    const thread = readThread(await github.listComments(ref, input.issueNumber), ref.owner);
    if (!thread.pending)
      throw new ResumeError(
        'Reprise après réponse demandée, mais aucune question bloquante sur l’issue.',
      );
    if (!thread.answer)
      throw new ResumeError(
        `Reprise après réponse demandée, mais la question ${thread.pending.question.id} n’a pas de réponse de ${ref.owner}.`,
      );
    const { commentId: _comment, ...answer } = thread.answer;
    return { kind: 'answer', question: thread.pending.question, answer };
  }

  // Dernier run de chaque workflow de la branche (CI du projet, relecture, garde des tests) :
  // ceux en échec expliquent l'échec actuel de la PR.
  const latest = new Map<string, WorkflowRun>();
  for (const run of await github.listWorkflowRuns(ref, { branch: input.branch })) {
    const known = latest.get(run.workflow);
    if (!known || run.createdAt > known.createdAt) latest.set(run.workflow, run);
  }
  const failed = [...latest.values()]
    .filter((r) => r.conclusion === 'failure')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (failed.length === 0)
    return {
      kind: 'ci-failure',
      attempt: input.attempt,
      logs: 'Aucune exécution en échec trouvée sur la branche.',
      runUrl: null,
    };
  const parts: string[] = [];
  for (const run of failed) {
    const jobs = (await github.listRunJobs(ref, run.id)).filter((j) => j.conclusion === 'failure');
    for (const job of jobs) {
      const logs = await github.getJobLogs(ref, job.id);
      parts.push(
        `=== ${run.name} / ${job.name} ===\n${extractRelevantLogs(logs, MAX_LOG_PER_JOB)}`,
      );
    }
  }
  return {
    kind: 'ci-failure',
    attempt: input.attempt,
    logs: parts.join('\n\n') || 'Aucun journal de job en échec.',
    runUrl: failed[0]?.url ?? null,
  };
}

/** Pose l'état d'une tâche : retire les autres labels d'état, ajoute le nouveau. */
export async function setTaskState(
  github: GitHubPort,
  ref: RepoRef,
  issueNumber: number,
  state: TaskState,
): Promise<void> {
  const issue = await github.getIssue(ref, issueNumber);
  for (const label of issue.labels) {
    const current = parseStateLabel(label);
    if (current !== undefined && current !== state)
      await github.removeLabel(ref, issueNumber, label);
  }
  if (!issue.labels.includes(stateLabel(state)))
    await github.addLabels(ref, issueNumber, [stateLabel(state)]);
}
