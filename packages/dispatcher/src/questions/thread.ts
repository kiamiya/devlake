import type { Comment } from 'github';
import { parseAnswerComment, parseQuestionComment, type Answer, type Question } from 'shared';

/** Une question publiée sur l'issue, avec son commentaire. */
export interface PostedQuestion {
  question: Question;
  commentId: number;
  createdAt: string;
}

export interface ThreadState {
  /** Dernière question bloquante publiée : celle que la tâche attend. */
  pending: PostedQuestion | null;
  /** Réponse valide à `pending` : du propriétaire, même identifiant, postérieure à la question. */
  answer: (Answer & { commentId: number }) | null;
  /** Un rappel a déjà été posté pour `pending`. */
  reminded: boolean;
}

const REMINDER_MARKER = (id: string) => `<!-- agentlake:reminder id=${id} -->`;
const IGNORED_MARKER = (commentId: number) =>
  `<!-- agentlake:answer-ignored comment=${String(commentId)} -->`;

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Lit le fil d'une issue de tâche (commentaires dans l'ordre chronologique). */
export function readThread(comments: readonly Comment[], owner: string): ThreadState {
  let pendingIndex = -1;
  let waiting: PostedQuestion | undefined;
  for (const [index, comment] of comments.entries()) {
    const parsed = parseQuestionComment(comment.body);
    if (parsed.ok && parsed.value.blocking) {
      waiting = { question: parsed.value, commentId: comment.id, createdAt: comment.createdAt };
      pendingIndex = index;
    }
  }
  if (waiting === undefined) return { pending: null, answer: null, reminded: false };
  const question = waiting.question;
  const after = comments.slice(pendingIndex + 1);
  const answer =
    after
      .filter((c) => sameLogin(c.author, owner))
      .map((c) => ({ parsed: parseAnswerComment(c.body), commentId: c.id }))
      .flatMap(({ parsed, commentId }) =>
        parsed.ok && parsed.value.id === question.id ? [{ ...parsed.value, commentId }] : [],
      )
      .at(-1) ?? null;
  const reminded = after.some((c) => c.body.includes(REMINDER_MARKER(question.id)));
  return { pending: waiting, answer, reminded };
}

/** Rappel unique d'une question restée sans réponse ; mentionne le propriétaire (notification GitHub). */
export function reminderComment(owner: string, question: Question, hours: number): string {
  return [
    REMINDER_MARKER(question.id),
    `@${owner} rappel : la question bloquante \`${question.id}\` attend une réponse depuis plus de ${String(hours)} h. La tâche reste suspendue, sans action automatique.`,
  ].join('\n');
}

export function reminderDue(
  state: ThreadState,
  now: Date,
  hours: number,
): state is ThreadState & { pending: PostedQuestion } {
  if (state.pending === null || state.answer !== null || state.reminded) return false;
  return now.getTime() - Date.parse(state.pending.createdAt) >= hours * 3_600_000;
}

/**
 * Raison pour laquelle une réponse ne relance rien, ou null si elle est valide :
 * auteur propriétaire, issue en attente, identifiant de la question attendue.
 */
export function ignoredAnswerReason(input: {
  answer: Answer;
  author: string;
  owner: string;
  awaiting: boolean;
  pending: Question | null;
}): string | null {
  if (!sameLogin(input.author, input.owner))
    return `seul ${input.owner} peut répondre aux questions des agents`;
  if (!input.awaiting || input.pending === null) return 'la tâche n’attend aucune réponse';
  if (input.pending.id !== input.answer.id)
    return `la tâche attend la question \`${input.pending.id}\``;
  return null;
}

/** Trace discrète d'une réponse ignorée ; une seule par commentaire de réponse. */
export function ignoredAnswerComment(commentId: number, answerId: string, reason: string): string {
  return `${IGNORED_MARKER(commentId)}\n_Réponse à \`${answerId}\` ignorée : ${reason}._`;
}

export function alreadyTraced(comments: readonly Comment[], commentId: number): boolean {
  return comments.some((c) => c.body.includes(IGNORED_MARKER(commentId)));
}
