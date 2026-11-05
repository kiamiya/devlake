import type { GitHubPort, RepoRef } from 'github';
import { z } from 'zod';
import { authHeader, type Git } from './git.js';
import { setTaskState } from './resume.js';

export const OutcomeSchema = z.object({
  outcome: z.enum(['completed', 'blocked']),
  pr_title: z.string().trim().min(1),
  pr_summary: z.string().trim().min(1),
  blocked_reason: z.string().optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

export interface FinalizeInput {
  ref: RepoRef;
  issueNumber: number;
  taskId: string;
  taskTitle: string;
  branch: string;
  attempt: number;
  /** Conclusion de claude-code-action : success ou failure. */
  conclusion: string;
  /** Sortie structurée JSON de Claude (peut être vide). */
  structuredOutput: string;
  runUrl: string;
}

export interface FinalizeDeps {
  /** Port authentifié avec le jeton du job (labels, commentaires). */
  github: GitHubPort;
  /** Port authentifié avec le jeton de l'app Claude : la PR déclenche alors la CI. */
  appGithub: GitHubPort;
  git: Git;
  appToken: string;
}

export type FinalizeResult =
  | { status: 'delivered'; prNumber: number; created: boolean; autoMerge: boolean }
  | { status: 'failed'; reason: string };

const MARKER = (taskId: string, attempt: number) =>
  `<!-- agentlake:pr task=${taskId} attempt=${String(attempt)} -->`;

function parseOutcome(raw: string): Outcome | null {
  if (raw.trim() === '') return null;
  try {
    const parsed = OutcomeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function fail(
  input: FinalizeInput,
  deps: FinalizeDeps,
  reason: string,
): Promise<FinalizeResult> {
  await setTaskState(deps.github, input.ref, input.issueNumber, 'fixing');
  await deps.github.createComment(
    input.ref,
    input.issueNumber,
    [
      `**Agent en échec** (tentative ${String(input.attempt)}) : ${reason}`,
      '',
      `Journal et transcription : ${input.runUrl}`,
    ].join('\n'),
  );
  return { status: 'failed', reason };
}

/**
 * Fin de job : pousse la branche avec le jeton de l'app, ouvre ou met à jour la PR,
 * demande l'auto-merge. En cas d'échec : label « fixing » et commentaire de diagnostic.
 */
export async function finalizeAgent(
  input: FinalizeInput,
  deps: FinalizeDeps,
): Promise<FinalizeResult> {
  if (input.conclusion !== 'success') {
    return fail(input, deps, 'l’exécution de Claude Code n’a pas abouti.');
  }
  const outcome = parseOutcome(input.structuredOutput);
  if (outcome?.outcome === 'blocked') {
    return fail(input, deps, `l’agent est bloqué. ${outcome.blocked_reason ?? ''}`.trim());
  }

  // Ce que Claude n'aurait pas commité est commité ici.
  if ((await deps.git.run(['status', '--porcelain'])).trim() !== '') {
    await deps.git.run(['add', '--all']);
    await deps.git.run(['commit', '-m', `chore(${input.taskId}): travail de l’agent`]);
  }
  const ahead = Number((await deps.git.run(['rev-list', '--count', 'origin/main..HEAD'])).trim());
  if (!Number.isFinite(ahead) || ahead === 0) {
    return fail(input, deps, 'aucun changement n’a été produit sur la branche.');
  }
  await deps.git.run([
    ...authHeader(deps.appToken),
    'push',
    'origin',
    `HEAD:refs/heads/${input.branch}`,
  ]);

  const title = `${input.taskId} — ${outcome?.pr_title ?? input.taskTitle}`;
  const body = [
    outcome?.pr_summary ?? '_Résumé non fourni par l’agent._',
    '',
    `Closes #${String(input.issueNumber)}`,
    '',
    MARKER(input.taskId, input.attempt),
  ].join('\n');
  const [existing] = await deps.appGithub.listPullRequests(input.ref, {
    head: input.branch,
    state: 'open',
  });
  const pr = existing
    ? await deps.appGithub.updatePullRequest(input.ref, existing.number, { title, body })
    : await deps.appGithub.createPullRequest(input.ref, {
        title,
        body,
        head: input.branch,
        base: 'main',
      });

  let autoMerge = true;
  try {
    await deps.appGithub.enableAutoMerge(input.ref, pr.number);
  } catch (error) {
    autoMerge = false;
    await deps.github.createComment(
      input.ref,
      input.issueNumber,
      `Auto-merge non activé sur #${String(pr.number)} : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { status: 'delivered', prNumber: pr.number, created: !existing, autoMerge };
}
