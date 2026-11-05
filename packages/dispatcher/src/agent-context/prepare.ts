import type { GitHubPort, RepoRef } from 'github';
import { parseTaskIssueBody, type TaskIssue } from 'shared';
import { readProjectContext, taskBranch, type ReadFile } from './context.js';
import { checkoutTaskBranch, type Git } from './git.js';
import { claudeArgs, parseProfile, profilePath } from './profile.js';
import { buildPrompt } from './prompt.js';
import { gatherResume, setTaskState, type ResumeReason } from './resume.js';

export interface PrepareInput {
  ref: RepoRef;
  issueNumber: number;
  profileId: string;
  attempt: number;
  reason: ResumeReason;
}

export interface PrepareDeps {
  github: GitHubPort;
  git: Git;
  readFile: ReadFile;
  /** Jeton du job, pour les opérations git de lecture. */
  token: string;
}

export interface Prepared {
  task: TaskIssue;
  branch: string;
  branchState: 'created' | 'resumed';
  prompt: string;
  claudeArgs: string;
}

export class TaskIssueError extends Error {
  constructor(issueNumber: number, detail: string) {
    super(`L’issue #${String(issueNumber)} n’est pas une tâche AgentLake valide : ${detail}`);
    this.name = 'TaskIssueError';
  }
}

/**
 * Préparation d'un agent : lit la tâche et le profil, passe l'issue en « running »,
 * extrait la branche de la tâche et construit le prompt.
 */
export async function prepareAgent(input: PrepareInput, deps: PrepareDeps): Promise<Prepared> {
  const issue = await deps.github.getIssue(input.ref, input.issueNumber);
  const parsed = parseTaskIssueBody(issue.body);
  if (!parsed.ok) throw new TaskIssueError(input.issueNumber, parsed.error);
  const task = parsed.value;
  const profile = parseProfile(await deps.readFile(profilePath(input.profileId)), input.profileId);

  await setTaskState(deps.github, input.ref, input.issueNumber, 'running');
  const branch = taskBranch(task.id, task.title);
  const branchState = await checkoutTaskBranch(deps.git, branch, deps.token);

  const [context, resume] = await Promise.all([
    readProjectContext(deps.readFile),
    gatherResume(deps.github, input.ref, {
      issueNumber: input.issueNumber,
      reason: input.reason,
      branch,
      attempt: input.attempt,
    }),
  ]);
  return {
    task,
    branch,
    branchState,
    prompt: buildPrompt({ task, issueNumber: input.issueNumber, profile, branch, context, resume }),
    claudeArgs: claudeArgs(profile),
  };
}
