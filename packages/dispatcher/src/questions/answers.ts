import type { GitHubPort, RepoRef } from 'github';
import { parseAnswerComment, stateLabel, TASK_LABEL } from 'shared';
import { alreadyTraced, ignoredAnswerComment, ignoredAnswerReason, readThread } from './thread.js';

/** Commentaire reçu par l'événement `issue_comment`. */
export interface AnswerEvent {
  issueNumber: number;
  commentId: number;
  author: string;
  body: string;
}

/** Extrait le commentaire d'un événement `issue_comment`, s'il y en a un. */
export function answerEventFrom(payload: unknown): AnswerEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as {
    issue?: { number?: unknown };
    comment?: { id?: unknown; body?: unknown; user?: { login?: unknown } };
  };
  const issueNumber = p.issue?.number;
  const commentId = p.comment?.id;
  const body = p.comment?.body;
  const author = p.comment?.user?.login;
  if (
    typeof issueNumber !== 'number' ||
    typeof commentId !== 'number' ||
    typeof body !== 'string' ||
    typeof author !== 'string'
  )
    return null;
  return { issueNumber, commentId, author, body };
}

/**
 * Une réponse qui ne relance rien (autre auteur, tâche qui n'attend pas, autre question)
 * est tracée par un commentaire discret, une seule fois. Renvoie la raison, ou null si la
 * réponse est valide ou si le commentaire n'est pas une réponse sur une tâche.
 */
export async function traceIgnoredAnswer(
  github: GitHubPort,
  ref: RepoRef,
  event: AnswerEvent,
  /** Compte de Kia, seul à pouvoir répondre. */
  account: string = ref.owner,
): Promise<string | null> {
  const parsed = parseAnswerComment(event.body);
  if (!parsed.ok) return null;
  const issue = await github.getIssue(ref, event.issueNumber);
  // L'issue « Cadrage » a son propre circuit (planificateur).
  if (!issue.labels.includes(TASK_LABEL)) return null;
  const comments = await github.listComments(ref, event.issueNumber);
  const thread = readThread(comments, account);
  // Réponse valide, déjà prise en compte ou en passe de l'être : rien à tracer.
  if (thread.answer?.commentId === event.commentId) return null;
  const reason =
    ignoredAnswerReason({
      answer: parsed.value,
      author: event.author,
      owner: account,
      awaiting: issue.state === 'open' && issue.labels.includes(stateLabel('awaiting-answer')),
      pending: thread.pending?.question ?? null,
    }) ?? 'une réponse plus récente a déjà été donnée';
  if (!alreadyTraced(comments, event.commentId))
    await github.createComment(
      ref,
      event.issueNumber,
      ignoredAnswerComment(event.commentId, parsed.value.id, reason),
    );
  return reason;
}
