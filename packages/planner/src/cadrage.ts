import type { GitHubPort, Issue, RepoRef } from 'github';
import {
  CADRAGE_LABEL,
  parseAnswerComment,
  parseQuestionComment,
  type Answer,
  type Question,
} from 'shared';
import { z } from 'zod';

/** Réglages du planificateur gardés dans l'issue Cadrage, pour les relances déclenchées par une réponse. */
export const CadrageSettingsSchema = z.object({
  model: z.string().min(1),
  maxAgents: z.number().int().min(1),
});
export type CadrageSettings = z.infer<typeof CadrageSettingsSchema>;

const SETTINGS_BLOCK = /^\s*<!-- agentlake:cadrage ([^>]*) -->/;

export function renderCadrageBody(settings: CadrageSettings): string {
  return [
    `<!-- agentlake:cadrage ${JSON.stringify(settings)} -->`,
    '# Cadrage',
    '',
    'Questions de clarification du planificateur. Répondre depuis le cockpit, ou ici par un commentaire',
    '`<!-- agentlake:answer id=… -->` suivi de la réponse (`ignored=true` pour écarter une question).',
    'Quand toutes les questions bloquantes ont une réponse, le planificateur produit le plan.',
    '',
  ].join('\n');
}

export function readCadrageSettings(issue: Issue): CadrageSettings | null {
  const json = SETTINGS_BLOCK.exec(issue.body)?.[1];
  if (json === undefined) return null;
  try {
    const parsed = CadrageSettingsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function findCadrageIssue(github: GitHubPort, ref: RepoRef): Promise<Issue | null> {
  const [issue] = await github.listIssues(ref, { labels: [CADRAGE_LABEL], state: 'open' });
  return issue ?? null;
}

export interface QuestionStatus {
  question: Question;
  /** Dernière réponse à cette question, si elle existe. */
  answer: Answer | null;
}

/** Questions de l'issue Cadrage et leur dernière réponse. */
export async function readQuestions(
  github: GitHubPort,
  ref: RepoRef,
  issueNumber: number,
): Promise<QuestionStatus[]> {
  const comments = await github.listComments(ref, issueNumber);
  const questions = new Map<string, Question>();
  const answers = new Map<string, Answer>();
  for (const comment of comments) {
    const question = parseQuestionComment(comment.body);
    if (question.ok) questions.set(question.value.id, question.value);
    const answer = parseAnswerComment(comment.body);
    if (answer.ok) answers.set(answer.value.id, answer.value);
  }
  return [...questions.values()].map((question) => ({
    question,
    answer: answers.get(question.id) ?? null,
  }));
}

/** Questions bloquantes encore sans réponse (une question ignorée a une réponse). */
export function pendingBlocking(statuses: readonly QuestionStatus[]): string[] {
  return statuses.filter((s) => s.question.blocking && s.answer === null).map((s) => s.question.id);
}
