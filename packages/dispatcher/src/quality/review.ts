import type { GitHubPort, RepoRef } from 'github';
import {
  parseTaskIssueBody,
  profilePath,
  TEST_CATEGORIES,
  TEST_CATEGORY_LABELS,
  type TaskIssue,
} from 'shared';
import { z } from 'zod';
import { claudeArgs, parseProfile } from '../agent-context/profile.js';
import { setTaskState } from '../agent-context/resume.js';
import { linkedIssue } from './guard.js';
import { analyzeTestChanges } from './test-files.js';

/** Sortie structurée demandée au relecteur. */
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['approve', 'request_changes'],
      description: 'approve si la PR peut être mergée telle quelle, sinon request_changes.',
    },
    summary: { type: 'string', description: 'Synthèse de la relecture, en français.' },
    findings: {
      type: 'array',
      description: 'Problèmes à corriger (vide si approve).',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          problem: { type: 'string' },
          fix: { type: 'string', description: 'Correction attendue.' },
        },
        required: ['file', 'problem', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
} as const;

export const ReviewOutcomeSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  summary: z.string().trim().min(1),
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().optional(),
      problem: z.string(),
      fix: z.string(),
    }),
  ),
});
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

export interface PreparedReview {
  prompt: string;
  claudeArgs: string;
  issueNumber: number | null;
}

function bullets(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : `_${empty}_`;
}

function taskSection(task: TaskIssue | null, issue: number | null): string {
  if (task === null)
    return `## Tâche\n\n_Aucune tâche AgentLake liée${issue === null ? '' : ` (issue #${String(issue)} illisible)`} : relis la PR sur ses propres mérites._`;
  const tests = TEST_CATEGORIES.flatMap((c) =>
    (task.requiredTests[c] ?? []).map((t) => `${TEST_CATEGORY_LABELS[c]} : ${t}`),
  );
  return [
    `## Tâche ${task.id} — ${task.title} (issue #${String(issue)})`,
    task.description,
    `### Critères d’acceptation\n\n${bullets(task.acceptanceCriteria, 'Aucun.')}`,
    `### Tests exigés\n\n${bullets(tests, 'Aucun.')}`,
  ].join('\n\n');
}

/**
 * Prépare la relecture d'une PR : le profil Relecteur est lu sur `main` (une PR ne peut
 * pas assouplir son propre relecteur), le prompt rappelle la tâche et les fichiers touchés.
 */
export async function prepareReview(
  github: GitHubPort,
  ref: RepoRef,
  prNumber: number,
): Promise<PreparedReview> {
  const pr = await github.getPullRequest(ref, prNumber);
  const profile = parseProfile(
    (await github.getFile(ref, profilePath('reviewer'), 'main'))?.content ?? null,
    'reviewer',
  );
  const files = await github.listPullRequestFiles(ref, prNumber);
  const analysis = analyzeTestChanges(files);
  const issue = linkedIssue(pr.body);
  let task: TaskIssue | null = null;
  if (issue !== null) {
    const parsed = parseTaskIssueBody((await github.getIssue(ref, issue)).body);
    task = parsed.ok ? parsed.value : null;
  }
  const prompt = [
    `# Relecture de la PR #${String(prNumber)} — ${pr.title}`,
    `Branche \`${pr.head}\` vers \`${pr.base}\`. Lis le diff avec \`git diff origin/${pr.base}...HEAD\` ou \`gh pr diff ${String(prNumber)}\`.`,
    taskSection(task, issue),
    `## Fichiers modifiés\n\n${bullets(
      files.map(
        (f) => `\`${f.filename}\` (${f.status}, +${String(f.additions)} −${String(f.deletions)})`,
      ),
      'Aucun.',
    )}`,
    `## Tests\n\n- Ajoutés ou complétés : ${analysis.addedTests.length > 0 ? analysis.addedTests.join(', ') : 'aucun'}.\n- Tests existants modifiés ou supprimés : ${analysis.alteredTests.length > 0 ? analysis.alteredTests.map((t) => `${t.file} (${t.kind})`).join(', ') : 'aucun'}.`,
    [
      '## Verdict',
      '',
      '- `approve` seulement si la PR réalise la tâche, respecte chaque critère d’acceptation et contient les tests exigés, qui couvrent vraiment le code ajouté.',
      '- Sinon `request_changes`, avec chaque problème dans `findings` : fichier, ligne si possible, problème, correction attendue. L’agent corrigera à partir de ta liste.',
      '- Ne modifie aucun fichier.',
    ].join('\n'),
  ].join('\n\n');
  return { prompt, claudeArgs: claudeArgs(profile, null, REVIEW_SCHEMA), issueNumber: issue };
}

const REVIEW_MARKER = (sha: string) => `<!-- agentlake:review sha=${sha} -->`;

export function parseReviewOutcome(raw: string): ReviewOutcome | null {
  if (raw.trim() === '') return null;
  try {
    const parsed = ReviewOutcomeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function formatFindings(outcome: ReviewOutcome): string {
  return outcome.findings
    .map(
      (f) =>
        `- \`${f.file}${f.line === undefined ? '' : `:${String(f.line)}`}\` : ${f.problem} → ${f.fix}`,
    )
    .join('\n');
}

export interface ReviewResult {
  passed: boolean;
  /** Texte écrit dans le journal du check (relu par l'agent en cas d'échec). */
  log: string;
}

/**
 * Publie le verdict : commentaire sur la PR ; changements demandés → la tâche passe en
 * correction avec la liste des problèmes, et le check « review » échoue.
 */
export async function finalizeReview(
  github: GitHubPort,
  ref: RepoRef,
  input: { prNumber: number; conclusion: string; structuredOutput: string },
): Promise<ReviewResult> {
  const pr = await github.getPullRequest(ref, input.prNumber);
  const outcome =
    input.conclusion === 'success' ? parseReviewOutcome(input.structuredOutput) : null;
  if (outcome === null) {
    const log = 'Relecture impossible : la session du relecteur n’a pas produit de verdict.';
    await github.createComment(
      ref,
      input.prNumber,
      `${REVIEW_MARKER(pr.headSha)}\n**Relecture** : ${log}`,
    );
    return { passed: false, log };
  }
  const approved = outcome.verdict === 'approve';
  const findings = formatFindings(outcome);
  const body = [
    REVIEW_MARKER(pr.headSha),
    `**Relecture : ${approved ? 'approuvée' : 'changements demandés'}**`,
    '',
    outcome.summary,
    ...(findings === '' ? [] : ['', findings]),
  ].join('\n');
  await github.createComment(ref, input.prNumber, body);
  const issue = linkedIssue(pr.body);
  if (!approved && issue !== null) {
    await github.createComment(
      ref,
      issue,
      `**Changements demandés par le relecteur** sur la PR #${String(input.prNumber)} :\n\n${findings || outcome.summary}`,
    );
    await setTaskState(github, ref, issue, 'fixing');
  }
  return {
    passed: approved,
    log: `Verdict : ${outcome.verdict}\n${outcome.summary}${findings === '' ? '' : `\n${findings}`}`,
  };
}
