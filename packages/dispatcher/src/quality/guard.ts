import { checkBlenderExports } from './assets.js';
import type { GitHubPort, RepoRef } from 'github';
import {
  effectiveScope,
  filesOutsideScope,
  parseAnswerComment,
  parseQuestionComment,
  parseTaskIssueBody,
  ProjectConfigSchema,
  renderQuestionComment,
} from 'shared';
import { parse } from 'yaml';
import { setTaskState } from '../agent-context/resume.js';
import { analyzeTestChanges, type TestAnalysis } from './test-files.js';

export const AUTHORIZE = 'Autoriser';
export const REFUSE = 'Refuser';

/** Identifiant de la question posée quand une PR modifie des tests existants. */
export function guardQuestionId(prNumber: number): string {
  return `tests-pr${String(prNumber)}`;
}

/** Identifiant de la question posée quand une PR modifie des fichiers hors du périmètre. */
export function scopeQuestionId(prNumber: number): string {
  return `scope-pr${String(prNumber)}`;
}

/** Question de la garde : tests existants modifiés, ou fichiers hors du périmètre. */
export function isGuardQuestion(id: string): boolean {
  return /^(tests|scope)-pr\d+$/.test(id);
}

export function isScopeQuestion(id: string): boolean {
  return /^scope-pr\d+$/.test(id);
}

/** Fichiers de la PR hors du périmètre de sa tâche (périmètre + règles du profil) ; [] sinon. */
export async function scopeViolations(
  github: GitHubPort,
  ref: RepoRef,
  issue: number,
  files: readonly string[],
): Promise<string[]> {
  const task = parseTaskIssueBody((await github.getIssue(ref, issue)).body);
  if (!task.ok) return [];
  const file = await github.getFile(ref, '.agentlake/project.yml', 'main');
  const config =
    file === null ? undefined : ProjectConfigSchema.safeParse(parse(file.content)).data;
  const scope = effectiveScope(task.value, config?.scopeRules);
  // Tâche sans périmètre (anciens plans) : non contrôlée.
  return scope === null ? [] : filesOutsideScope(files, scope);
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
  /** Compte de Kia, seul à pouvoir autoriser ; absent = propriétaire du dépôt. */
  account: string = ref.owner,
): Promise<GuardResult> {
  const pr = await github.getPullRequest(ref, prNumber);
  const files = await github.listPullRequestFiles(ref, prNumber);
  const analysis = analyzeTestChanges(files);
  const reasons: string[] = [];
  // PR de fork : jamais reliée à une tâche (aucune reprise, aucun changement d'état).
  const issue = pr.fromFork ? null : linkedIssue(pr.body);

  if (analysis.alteredTests.length > 0) {
    const list = analysis.alteredTests.map((t) => `${t.file} (${t.kind})`);
    if (issue === null) {
      reasons.push(`Tests existants modifiés sans tâche liée : ${list.join(', ')}.`);
    } else {
      const decision = await guardAnswer(github, ref, issue, prNumber, account);
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
  // Périmètre de la tâche : fichiers hors zone soumis à l'accord de Kia.
  if (issue !== null) {
    const outside = await scopeViolations(
      github,
      ref,
      issue,
      files.map((f) => f.filename),
    );
    if (outside.length > 0) {
      const id = scopeQuestionId(prNumber);
      const decision = await guardAnswer(github, ref, issue, prNumber, account, id);
      if (decision === 'refused') {
        reasons.push(`Kia a refusé les modifications hors du périmètre : ${outside.join(', ')}.`);
        await refuseScope(github, ref, issue, pr.number, pr.headSha, outside);
      } else if (decision !== 'authorized') {
        reasons.push(
          `Fichiers hors du périmètre de la tâche : ${outside.join(', ')}. Accord de Kia demandé sur l’issue #${String(issue)}.`,
        );
        if (decision === null) await askScope(github, ref, issue, prNumber, outside);
      }
    }
  }
  // Livrables Blender : chaque .blend avec son export valide.
  reasons.push(...(await checkBlenderExports(github, ref, pr.head, files)));
  return { ok: reasons.length === 0, reasons, analysis };
}

/** Réponse de Kia (propriétaire) à la question de la garde pour cette PR, la plus récente. */
async function guardAnswer(
  github: GitHubPort,
  ref: RepoRef,
  issue: number,
  prNumber: number,
  account: string,
  id: string = guardQuestionId(prNumber),
): Promise<'authorized' | 'refused' | 'pending' | null> {
  const comments = await github.listComments(ref, issue);
  const asked = comments.findIndex((c) => {
    const q = parseQuestionComment(c.body);
    return q.ok && q.value.id === id;
  });
  if (asked === -1) return null;
  const answers = comments
    .slice(asked + 1)
    .filter((c) => c.author.toLowerCase() === account.toLowerCase())
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

async function askScope(
  github: GitHubPort,
  ref: RepoRef,
  issue: number,
  prNumber: number,
  outside: string[],
): Promise<void> {
  await github.createComment(
    ref,
    issue,
    renderQuestionComment({
      id: scopeQuestionId(prNumber),
      blocking: true,
      text: `La PR #${String(prNumber)} modifie des fichiers hors du périmètre de la tâche. Autoriser ces modifications ?`,
      context: `Fichiers hors périmètre :\n${outside.map((f) => `- ${f}`).join('\n')}\n\nChaque tâche est confiée à un agent pour une partie du projet. « Autoriser » relance le check ; « Refuser » renvoie la tâche en correction pour retirer ces modifications (le travail hors périmètre revient à l’agent du bon profil).`,
      options: [AUTHORIZE, REFUSE],
    }),
  );
  await setTaskState(github, ref, issue, 'awaiting-answer');
}

async function refuseScope(
  github: GitHubPort,
  ref: RepoRef,
  issue: number,
  prNumber: number,
  sha: string,
  outside: string[],
): Promise<void> {
  const marker = `<!-- agentlake:scope-refused pr=${String(prNumber)} sha=${sha} -->`;
  const comments = await github.listComments(ref, issue);
  if (comments.some((c) => c.body.includes(marker))) return;
  await github.createComment(
    ref,
    issue,
    `${marker}\n**Hors périmètre** : Kia a refusé les modifications de la PR #${String(prNumber)} hors du périmètre de la tâche (${outside.join(', ')}). Rétablis ces fichiers tels qu’ils sont sur \`main\` et reste dans ton périmètre.`,
  );
  await setTaskState(github, ref, issue, 'fixing');
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
