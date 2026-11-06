import type { GitHubPort, RepoRef } from 'github';
import { parseAnswerComment, parseQuestionComment, renderQuestionComment } from 'shared';
import { setTaskState } from '../agent-context/resume.js';
import { analyzeTestChanges, type TestAnalysis } from './test-files.js';

export const AUTHORIZE = 'Autoriser';
export const REFUSE = 'Refuser';

/** Identifiant de la question posée quand une PR modifie des tests existants. */
export function guardQuestionId(prNumber: number): string {
  return `tests-pr${String(prNumber)}`;
}

export function isGuardQuestion(id: string): boolean {
  return /^tests-pr\d+$/.test(id);
}

/** Décision de Kia sur une question de la garde : la réponse commence par l'option choisie. */
export function guardDecision(answerText: string): 'authorized' | 'refused' | null {
  const text = answerText.trim().toLowerCase();
  if (text.startsWith(AUTHORIZE.toLowerCase())) return 'authorized';
  if (text.startsWith(REFUSE.toLowerCase())) return 'refused';
  return null;
}

/** Issue de tâche liée à une PR d'agent (« Closes #N »). */
export function linkedIssue(body: string): number | null {
  const match = /\bCloses #(\d+)/i.exec(body);
  return match ? Number(match[1]) : null;
}

export interface GuardResult {
  ok: boolean;
  /** Raisons d'échec, en français, écrites dans le journal du check. */
  reasons: string[];
  analysis: TestAnalysis;
}

const REFUSED_MARKER = (pr: number, sha: string) =>
  `<!-- agentlake:tests-refused pr=${String(pr)} sha=${sha} -->`;

/**
 * Check « tests-guard » d'une PR :
 * - un test existant modifié, supprimé ou renommé exige l'accord de Kia : question bloquante
 *   sur l'issue (« Autoriser » / « Refuser »), tâche en attente, check en échec ;
 * - du code applicatif sans aucun test ajouté ou complété fait échouer le check.
 */
export async function runTestsGuard(
  github: GitHubPort,
  ref: RepoRef,
  prNumber: number,
): Promise<GuardResult> {
  const pr = await github.getPullRequest(ref, prNumber);
  const analysis = analyzeTestChanges(await github.listPullRequestFiles(ref, prNumber));
  const reasons: string[] = [];
  // PR de fork : jamais reliée à une tâche (aucune reprise, aucun changement d'état).
  const issue = pr.fromFork ? null : linkedIssue(pr.body);

  if (analysis.alteredTests.length > 0) {
    const list = analysis.alteredTests.map((t) => `${t.file} (${t.kind})`);
    if (issue === null) {
      reasons.push(`Tests existants modifiés sans tâche liée : ${list.join(', ')}.`);
    } else {
      const decision = await guardAnswer(github, ref, issue, prNumber);
      if (decision === 'refused') {
        reasons.push(`Kia a refusé la modification des tests existants : ${list.join(', ')}.`);
        await refuse(github, ref, issue, pr.number, pr.headSha, list);
      } else if (decision !== 'authorized') {
        reasons.push(
          `Tests existants modifiés : ${list.join(', ')}. Accord de Kia demandé sur l’issue #${String(issue)}.`,
        );
        // Question posée une seule fois par PR ; la réponse relance le check.
        if (decision === null) await ask(github, ref, issue, prNumber, list);
      }
    }
  }

  if (
    analysis.applicationCode.length > 0 &&
    analysis.addedTests.length === 0 &&
    analysis.alteredTests.length === 0
  ) {
    reasons.push(
      `Du code applicatif est modifié sans aucun test ajouté ni complété : ${analysis.applicationCode.join(', ')}.`,
    );
  }
  return { ok: reasons.length === 0, reasons, analysis };
}

/** Réponse de Kia (propriétaire) à la question de la garde pour cette PR, la plus récente. */
async function guardAnswer(
  github: GitHubPort,
  ref: RepoRef,
  issue: number,
  prNumber: number,
): Promise<'authorized' | 'refused' | 'pending' | null> {
  const id = guardQuestionId(prNumber);
  const comments = await github.listComments(ref, issue);
  const asked = comments.findIndex((c) => {
    const q = parseQuestionComment(c.body);
    return q.ok && q.value.id === id;
  });
  if (asked === -1) return null;
  const answers = comments
    .slice(asked + 1)
    .filter((c) => c.author.toLowerCase() === ref.owner.toLowerCase())
    .map((c) => parseAnswerComment(c.body))
    .flatMap((a) => (a.ok && a.value.id === id ? [guardDecision(a.value.text)] : []))
    .filter((d) => d !== null);
  return answers.at(-1) ?? 'pending';
}

async function ask(
  github: GitHubPort,
  ref: RepoRef,
  issue: number,
  prNumber: number,
  list: string[],
): Promise<void> {
  await github.createComment(
    ref,
    issue,
    renderQuestionComment({
      id: guardQuestionId(prNumber),
      blocking: true,
      text: `La PR #${String(prNumber)} modifie des tests existants. Autoriser ces modifications ?`,
      context: `Fichiers concernés :\n${list.map((f) => `- ${f}`).join('\n')}\n\nUn test existant ne peut être modifié, désactivé ou supprimé qu’avec ton accord. « Autoriser » relance le check ; « Refuser » renvoie la tâche en correction pour restaurer les tests.`,
      options: [AUTHORIZE, REFUSE],
    }),
  );
  await setTaskState(github, ref, issue, 'awaiting-answer');
}

async function refuse(
  github: GitHubPort,
  ref: RepoRef,
  issue: number,
  prNumber: number,
  sha: string,
  list: string[],
): Promise<void> {
  const marker = REFUSED_MARKER(prNumber, sha);
  const comments = await github.listComments(ref, issue);
  if (comments.some((c) => c.body.includes(marker))) return;
  await github.createComment(
    ref,
    issue,
    `${marker}\n**Tests à restaurer** : Kia a refusé la modification des tests existants de la PR #${String(prNumber)} (${list.join(', ')}). Restaure-les tels qu’ils sont sur \`main\`, puis corrige le code pour qu’ils passent.`,
  );
  await setTaskState(github, ref, issue, 'fixing');
}

/** Résumé écrit dans le journal du check. */
export function formatGuardResult(result: GuardResult): string {
  const { analysis } = result;
  const lines = [
    result.ok ? 'tests-guard : réussi.' : 'tests-guard : en échec.',
    ...result.reasons.map((r) => `- ${r}`),
    `Tests ajoutés ou complétés : ${analysis.addedTests.length > 0 ? analysis.addedTests.join(', ') : 'aucun'}.`,
  ];
  return lines.join('\n');
}
