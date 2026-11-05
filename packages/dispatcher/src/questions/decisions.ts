import type { Answer, Question } from 'shared';

const MARKER = (issue: number, id: string) =>
  `<!-- agentlake:decision issue=${String(issue)} id=${id} -->`;

const HEADER =
  '# Décisions du projet\n\nRéponses de Kia promues en décisions ; tous les agents les lisent.\n';

/**
 * Ajoute une décision à `.agentlake/decisions.md`. Idempotent : une décision déjà
 * présente (même issue, même question) n'est pas ajoutée deux fois ; null si rien ne change.
 */
export function appendDecision(
  current: string | null,
  entry: { issueNumber: number; taskId: string; question: Question; answer: Answer; date: string },
): string | null {
  const marker = MARKER(entry.issueNumber, entry.question.id);
  const base = current ?? HEADER;
  if (base.includes(marker)) return null;
  const block = [
    marker,
    `## ${entry.taskId} — \`${entry.question.id}\` (${entry.date})`,
    '',
    `**Question** : ${entry.question.text}`,
    '',
    `**Décision** : ${entry.answer.text}`,
    '',
    `_Issue #${String(entry.issueNumber)}._`,
  ].join('\n');
  return `${base.trimEnd()}\n\n${block}\n`;
}
