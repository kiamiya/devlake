import type { GitHubPort, RepoRef } from 'github';
import {
  ARCHITECT_ESCALATED_MARKER,
  formatZodError,
  parseAnswerComment,
  parseQuestionComment,
  parseTaskIssueBody,
  renderAnswerComment,
  type Question,
} from 'shared';
import { parse } from 'yaml';
import { z } from 'zod';
import type { ClaudePort } from './claude/port.js';
import { renderPrompt } from './prompts.js';

/** Outils de l'architecte : lecture seule du dépôt. */
const READ_ONLY = ['Read', 'Glob', 'Grep'];
const ARCHITECT_PROFILE = '.agentlake/profiles/architect.yml';
const DECISIONS = '.agentlake/decisions.md';

export const ArchitectOutputSchema = z.object({
  decision: z.enum(['answer', 'escalate']),
  answer: z.string().trim().optional(),
  reason: z.string().trim().min(1, 'Raison manquante.'),
});

export interface ArchitectInput {
  ref: RepoRef;
  issueNumber: number;
  questionId: string;
  /** Modèle ; absent : celui du profil architecte du projet. */
  model?: string | undefined;
}

export interface ArchitectDeps {
  github: GitHubPort;
  claude: ClaudePort;
  /** Gabarit `prompts/architecte.md`. */
  template: string;
  readFile: (path: string) => Promise<string | null>;
  workspace: string;
}

export type ArchitectOutcome =
  | { phase: 'answered'; questionId: string }
  | { phase: 'escalated'; questionId: string; reason: string }
  | { phase: 'skipped'; reason: string };

export class ArchitectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchitectError';
  }
}

function questionText(q: Question): string {
  return [
    `**${q.id}** : ${q.text}`,
    q.context ? `\nContexte donné par l'agent :\n${q.context}` : '',
    q.options.length > 0 ? `\nOptions proposées : ${q.options.join(' ; ')}` : '',
  ].join('\n');
}

/**
 * Réponse de l'architecte à la question bloquante d'un agent : réponse publiée (marquée
 * `by=architect`, elle relance la tâche) ou transmission à Kia. Rien si la question a déjà
 * une réponse ou n'est plus en attente.
 */
export async function runArchitect(
  input: ArchitectInput,
  deps: ArchitectDeps,
): Promise<ArchitectOutcome> {
  const { github, ref } = { github: deps.github, ref: input.ref };
  const issue = await github.getIssue(ref, input.issueNumber);
  const task = parseTaskIssueBody(issue.body);
  if (!task.ok) return { phase: 'skipped', reason: 'issue qui n’est pas une tâche' };
  const comments = await github.listComments(ref, input.issueNumber);
  const index = comments.findIndex((c) => {
    const q = parseQuestionComment(c.body);
    return q.ok && q.value.id === input.questionId && q.value.blocking;
  });
  const posted = index === -1 ? null : parseQuestionComment(comments[index]?.body ?? '');
  if (posted === null || !posted.ok) return { phase: 'skipped', reason: 'question introuvable' };
  const answered = comments.slice(index + 1).some((c) => {
    const a = parseAnswerComment(c.body);
    return (
      (a.ok && a.value.id === input.questionId) ||
      c.body.includes(ARCHITECT_ESCALATED_MARKER(input.questionId))
    );
  });
  if (answered) return { phase: 'skipped', reason: 'question déjà traitée' };

  const profile = await deps.readFile(ARCHITECT_PROFILE);
  const model =
    input.model ??
    (profile === null ? undefined : (parse(profile) as { model?: unknown } | null)?.model);
  if (typeof model !== 'string' || model.trim() === '')
    throw new ArchitectError(`Modèle de l’architecte introuvable (${ARCHITECT_PROFILE}).`);

  const t = task.value;
  const response = await deps.claude.run({
    prompt: renderPrompt(deps.template, {
      PROJECT: `${ref.owner}/${ref.repo}`,
      TASK: [
        `${t.id} — ${t.title} (profil ${t.profile})`,
        '',
        t.description,
        '',
        `Critères : ${t.acceptanceCriteria.join(' ; ')}`,
        ...(t.scope ? [`Périmètre : ${t.scope.paths.join(', ')}`] : []),
      ].join('\n'),
      QUESTION: questionText(posted.value),
      DECISIONS: (await deps.readFile(DECISIONS))?.trim() || '_Aucune décision._',
    }),
    model,
    jsonSchema: z.toJSONSchema(ArchitectOutputSchema, { io: 'input' }),
    allowedTools: READ_ONLY,
    cwd: deps.workspace,
  });
  const parsed = ArchitectOutputSchema.safeParse(response.structured);
  const escalate = async (reason: string): Promise<ArchitectOutcome> => {
    await github.createComment(
      ref,
      input.issueNumber,
      `${ARCHITECT_ESCALATED_MARKER(input.questionId)}\n**L’architecte transmet à Kia** la question \`${input.questionId}\` : ${reason}`,
    );
    return { phase: 'escalated', questionId: input.questionId, reason };
  };
  if (!parsed.success)
    return escalate(`réponse illisible de l’architecte (${formatZodError(parsed.error)}).`);
  if (parsed.data.decision === 'escalate' || !parsed.data.answer)
    return escalate(parsed.data.reason);
  await github.createComment(
    ref,
    input.issueNumber,
    renderAnswerComment({
      id: input.questionId,
      decision: false,
      by: 'architect',
      text: `${parsed.data.answer}\n\n_Réponse de l’architecte (${parsed.data.reason}). Kia peut la remplacer en répondant à nouveau._`,
    }),
  );
  return { phase: 'answered', questionId: input.questionId };
}
