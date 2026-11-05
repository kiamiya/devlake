import type { GitHubPort, RepoRef } from 'github';
import {
  parseAnswerComment,
  parseQuestionComment,
  parseStateLabel,
  stateLabel,
  type TaskState,
} from 'shared';
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
const MAX_LOG_PER_JOB = 30_000;

/** Données de reprise : la dernière réponse à une question, ou les journaux du dernier échec de CI. */
export async function gatherResume(
  github: GitHubPort,
  ref: RepoRef,
  input: { issueNumber: number; reason: ResumeReason; branch: string; attempt: number },
): Promise<Resume> {
  if (input.reason === 'none') return { kind: 'none' };

  if (input.reason === 'answer') {
    const comments = await github.listComments(ref, input.issueNumber);
    const answers = comments.map((c) => parseAnswerComment(c.body)).filter((r) => r.ok);
    const answer = answers.at(-1)?.value;
    if (!answer)
      throw new ResumeError('Reprise après réponse demandée, mais aucune réponse sur l’issue.');
    const question = comments
      .map((c) => parseQuestionComment(c.body))
      .filter((r) => r.ok)
      .map((r) => r.value)
      .findLast((q) => q.id === answer.id);
    if (!question) throw new ResumeError(`Question ${answer.id} introuvable sur l’issue.`);
    return { kind: 'answer', question, answer };
  }

  const runs = (await github.listWorkflowRuns(ref, { branch: input.branch }))
    .filter((r) => r.conclusion === 'failure')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const run = runs[0];
  if (!run)
    return {
      kind: 'ci-failure',
      attempt: input.attempt,
      logs: 'Aucune exécution en échec trouvée sur la branche.',
      runUrl: null,
    };
  const jobs = (await github.listRunJobs(ref, run.id)).filter((j) => j.conclusion === 'failure');
  const parts: string[] = [];
  for (const job of jobs) {
    const logs = await github.getJobLogs(ref, job.id);
    parts.push(
      `=== ${job.name} ===\n${logs.length > MAX_LOG_PER_JOB ? logs.slice(-MAX_LOG_PER_JOB) : logs}`,
    );
  }
  return {
    kind: 'ci-failure',
    attempt: input.attempt,
    logs: parts.join('\n\n') || 'Aucun journal de job en échec.',
    runUrl: run.url,
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
