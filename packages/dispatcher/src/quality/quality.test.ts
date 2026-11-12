import { FakeGitHub, type PullRequestFile } from 'github';
import {
  parseQuestionComment,
  renderAnswerComment,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
} from 'shared';
import { makeAgentProfile, makeProjectConfig, makeTask } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { runQualityCli } from './cli.js';
import {
  formatGuardResult,
  guardDecision,
  guardQuestionId,
  isGuardQuestion,
  linkedIssue,
  runTestsGuard,
} from './guard.js';
import { cleanLogLine, extractRelevantLogs } from './logs.js';
import { finalizeReview, parseReviewOutcome, prepareReview } from './review.js';
import { analyzeTestChanges, isApplicationCode, isTestFile } from './test-files.js';

const file = (
  filename: string,
  status: PullRequestFile['status'],
  additions = 1,
  deletions = 0,
  previousFilename?: string,
): PullRequestFile => ({
  filename,
  status,
  additions,
  deletions,
  ...(previousFilename ? { previousFilename } : {}),
});

describe('fichiers de test', () => {
  it.each([
    'src/a.test.ts',
    'src/a.spec.tsx',
    'tests/api.ts',
    'src/__tests__/x.js',
    'e2e/login.e2e.ts',
    'src/__snapshots__/a.test.ts.snap',
    'app/test_models.py',
    'pkg/server_test.go',
    'Assets/Tests/EditMode/PlayerTests.cs',
    'Source/Game/Private/InventorySpec.cpp',
    'android/app/src/test/java/AppTest.java',
    '.maestro/login.yaml',
  ])('%s est un test', (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each([
    ['src/login.tsx', true],
    ['Assets/Scripts/Player.cs', true],
    ['vite.config.ts', false],
    ['src/types.d.ts', false],
    ['README.md', false],
    ['.github/workflows/ci.yml', false],
    ['scripts/release.ts', false],
    ['src/login.test.tsx', false],
  ])('%s est du code applicatif : %s', (path, expected) => {
    expect(isApplicationCode(path)).toBe(expected);
  });

  it('distingue tests complétés, modifiés, supprimés et renommés', () => {
    const analysis = analyzeTestChanges([
      file('src/a.ts', 'modified', 3, 1),
      file('src/old.ts', 'removed', 0, 5),
      file('src/new.test.ts', 'added', 10),
      file('src/a.test.ts', 'modified', 4, 0),
      file('src/b.test.ts', 'modified', 2, 1),
      file('src/c.test.ts', 'removed', 0, 8),
      file('src/d.spec.ts', 'renamed', 0, 0, 'src/d.test.ts'),
      file('src/e.test.ts', 'modified', 0, 0),
      file('docs/guide.md', 'modified', 5, 5),
    ]);
    expect(analysis).toEqual({
      alteredTests: [
        { file: 'src/b.test.ts', kind: 'modifié' },
        { file: 'src/c.test.ts', kind: 'supprimé' },
        { file: 'src/d.test.ts → src/d.spec.ts', kind: 'renommé' },
      ],
      addedTests: ['src/new.test.ts', 'src/a.test.ts'],
      applicationCode: ['src/a.ts'],
    });
  });
});

describe('extraits de journaux', () => {
  const ESC = String.fromCharCode(27);

  it('garde les lignes d’erreur avec leur contexte, sans horodatage ni couleurs', () => {
    const logs = [
      '2026-11-05T10:00:00.0000000Z installation',
      ...Array.from({ length: 30 }, (_, i) => `étape ${String(i)}`),
      `2026-11-05T10:01:00.0000000Z ${ESC}[31mFAIL${ESC}[0m src/a.test.ts > somme`,
      'AssertionError: expected 3 to be 4',
      ...Array.from({ length: 30 }, (_, i) => `suite ${String(i)}`),
    ].join('\n');
    const out = extractRelevantLogs(logs, 10_000);
    expect(out).toContain('FAIL src/a.test.ts > somme');
    expect(out).toContain('AssertionError: expected 3 to be 4');
    expect(out).toContain('étape 29');
    expect(out).not.toContain('installation');
    expect(out).not.toContain('suite 20');
    expect(out).not.toContain(ESC);
  });

  it('respecte le budget en gardant les extraits les plus récents', () => {
    const logs = Array.from({ length: 50 }, (_, i) =>
      i % 10 === 0 ? `error numéro ${String(i)}` : `ligne ${String(i)}`,
    ).join('\n');
    const out = extractRelevantLogs(logs, 60, { before: 0, after: 0 });
    expect(out).toContain('error numéro 40');
    expect(out).not.toContain('error numéro 0');
    expect(out).toMatch(/extrait\(s\) plus ancien\(s\) omis/);
    expect(extractRelevantLogs('x'.repeat(100) + ' error', 10)).toHaveLength(10);
  });

  it('sans ligne d’erreur : la fin du journal', () => {
    expect(extractRelevantLogs('a\nb\nc', 100)).toBe('a\nb\nc');
    expect(extractRelevantLogs('a'.repeat(50), 10)).toBe(`[… début coupé …]\n${'a'.repeat(10)}`);
    expect(cleanLogLine('2026-11-05T10:00:00Z ok')).toBe('ok');
  });
});

const ref = { owner: 'kiamiya', repo: 'site' };

async function withPullRequest(
  changes: { path: string; content?: string; delete?: true }[],
  scope?: { paths: string[] },
  scopeRules?: Record<string, { paths: string[] }>,
) {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(ref);
  await github.commitFiles(ref, {
    branch: 'main',
    message: 'base',
    changes: [
      { path: 'src/somme.ts', content: 'export const somme = 1;\n' },
      { path: 'src/somme.test.ts', content: 'test 1\ntest 2\n' },
      {
        path: '.agentlake/profiles/reviewer.yml',
        content: stringify(makeAgentProfile({ id: 'reviewer', model: 'opus' })),
      },
      ...(scopeRules !== undefined
        ? [
            {
              path: '.agentlake/project.yml',
              content: stringify(makeProjectConfig({ scopeRules })),
            },
          ]
        : []),
    ],
  });
  const issue = await github.createIssue(ref, {
    title: 'T04',
    body: renderTaskIssueBody(
      makeTask({ id: 'T04', title: 'Somme', ...(scope !== undefined ? { scope } : {}) }),
    ),
    labels: [TASK_LABEL, stateLabel('running')],
  });
  await github.commitFiles(ref, {
    branch: 'task/T04-somme',
    baseBranch: 'main',
    message: 'travail',
    changes: changes.map((c) =>
      c.delete
        ? { path: c.path, delete: true as const }
        : { path: c.path, content: c.content ?? '' },
    ),
  });
  const pr = await github.createPullRequest(ref, {
    title: 'T04 — Somme',
    body: `Ajout.\n\nCloses #${String(issue.number)}\n\n<!-- agentlake:pr task=T04 attempt=1 -->`,
    head: 'task/T04-somme',
    base: 'main',
  });
  return { github, issue, pr };
}

describe('périmètre de la tâche', () => {
  it('fichiers de la zone, tests liés et décisions : réussi, sans question', async () => {
    const { github, issue, pr } = await withPullRequest(
      [
        { path: 'src/somme.ts', content: 'export const somme = 2;\n' },
        { path: 'src/somme.test.ts', content: 'test 1\ntest 2\ntest 3\n' },
        { path: '.agentlake/decisions.md', content: '# Décisions\n' },
      ],
      { paths: ['src/somme.ts'] },
    );
    expect((await runTestsGuard(github, ref, pr.number)).ok).toBe(true);
    expect(await github.listComments(ref, issue.number)).toEqual([]);
  });

  it('hors zone : question bloquante, puis refus (correction) ou accord (réussi)', async () => {
    const { github, issue, pr } = await withPullRequest(
      [
        { path: 'src/somme.ts', content: 'export const somme = 2;\n' },
        { path: 'src/somme.test.ts', content: 'test 1\ntest 2\ntest 3\n' },
        { path: 'README.md', content: '# Doc modifiée par le développeur\n' },
      ],
      { paths: ['src/**'] },
    );
    const first = await runTestsGuard(github, ref, pr.number);
    expect(first.reasons).toEqual([
      `Fichiers hors du périmètre de la tâche : README.md. Accord de Kia demandé sur l’issue #${String(issue.number)}.`,
    ]);
    const question = parseQuestionComment(
      (await github.listComments(ref, issue.number))[0]?.body ?? '',
    );
    expect(question.ok && question.value).toMatchObject({
      id: `scope-pr${String(pr.number)}`,
      options: ['Autoriser', 'Refuser'],
    });
    expect(isGuardQuestion(`scope-pr${String(pr.number)}`)).toBe(true);
    expect((await github.getIssue(ref, issue.number)).labels).toContain(
      stateLabel('awaiting-answer'),
    );
    await runTestsGuard(github, ref, pr.number);
    expect(await github.listComments(ref, issue.number)).toHaveLength(1);

    await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: `scope-pr${String(pr.number)}`, decision: false, text: 'Refuser' }),
    );
    expect((await runTestsGuard(github, ref, pr.number)).reasons[0]).toContain(
      'Kia a refusé les modifications hors du périmètre : README.md.',
    );
    expect((await github.getIssue(ref, issue.number)).labels).toContain(stateLabel('fixing'));

    await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({
        id: `scope-pr${String(pr.number)}`,
        decision: false,
        text: 'Autoriser',
      }),
    );
    expect((await runTestsGuard(github, ref, pr.number)).ok).toBe(true);
  });

  it('règles du profil ajoutées ; tâche sans périmètre ni règle : non contrôlée', async () => {
    const withRule = await withPullRequest(
      [
        { path: 'src/somme.ts', content: 'export const somme = 2;\n' },
        { path: 'src/somme.test.ts', content: 'test 1\ntest 2\ntest 3\n' },
        { path: 'docs/somme.md', content: '# Somme\n' },
      ],
      { paths: ['src/somme.ts'] },
      { frontend: { paths: ['docs/**'] } },
    );
    expect((await runTestsGuard(withRule.github, ref, withRule.pr.number)).ok).toBe(true);
    const free = await withPullRequest([
      { path: 'src/somme.ts', content: 'export const somme = 2;\n' },
      { path: 'src/somme.test.ts', content: 'test 1\ntest 2\ntest 3\n' },
      { path: 'ailleurs.txt', content: 'x\n' },
    ]);
    expect((await runTestsGuard(free.github, ref, free.pr.number)).ok).toBe(true);
  });
});

describe('garde des tests', () => {
  it('identifiants, décisions et issue liée', () => {
    expect(guardQuestionId(12)).toBe('tests-pr12');
    expect(isGuardQuestion('tests-pr12')).toBe(true);
    expect(isGuardQuestion('sso')).toBe(false);
    expect(guardDecision(' Autoriser, c’est voulu')).toBe('authorized');
    expect(guardDecision('refuser')).toBe('refused');
    expect(guardDecision('peut-être')).toBeNull();
    expect(linkedIssue('x\nCloses #42')).toBe(42);
    expect(linkedIssue('rien')).toBeNull();
  });

  it('code et tests complétés : réussi', async () => {
    const { github, pr } = await withPullRequest([
      { path: 'src/somme.ts', content: 'export const somme = 2;\n' },
      { path: 'src/somme.test.ts', content: 'test 1\ntest 2\ntest 3\n' },
    ]);
    const result = await runTestsGuard(github, ref, pr.number);
    expect(result.ok).toBe(true);
    expect(formatGuardResult(result)).toContain('tests-guard : réussi.');
  });

  it('code sans test : en échec, sans question', async () => {
    const { github, issue, pr } = await withPullRequest([
      { path: 'src/somme.ts', content: 'export const somme = 2;\n' },
    ]);
    const result = await runTestsGuard(github, ref, pr.number);
    expect(result.reasons).toEqual([
      'Du code applicatif est modifié sans aucun test ajouté ni complété : src/somme.ts.',
    ]);
    expect(await github.listComments(ref, issue.number)).toEqual([]);
  });

  it('test supprimé : question bloquante unique, tâche en attente, puis décision de Kia', async () => {
    const { github, issue, pr } = await withPullRequest([
      { path: 'src/somme.ts', content: 'export const somme = 2;\n' },
      { path: 'src/somme.test.ts', delete: true },
    ]);
    const first = await runTestsGuard(github, ref, pr.number);
    expect(first.ok).toBe(false);
    expect(first.reasons[0]).toContain('src/somme.test.ts (supprimé)');
    expect((await github.getIssue(ref, issue.number)).labels).toContain(
      stateLabel('awaiting-answer'),
    );
    const question = parseQuestionComment(
      (await github.listComments(ref, issue.number))[0]?.body ?? '',
    );
    expect(question.ok && question.value).toMatchObject({
      id: `tests-pr${String(pr.number)}`,
      blocking: true,
      options: ['Autoriser', 'Refuser'],
    });
    // Relancé sans réponse : pas de seconde question.
    await runTestsGuard(github, ref, pr.number);
    expect(await github.listComments(ref, issue.number)).toHaveLength(1);

    // Un autre compte ne peut pas autoriser.
    const forged = await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({
        id: `tests-pr${String(pr.number)}`,
        decision: false,
        text: 'Autoriser',
      }),
    );
    github
      .state(ref)
      .comments.get(issue.number)
      ?.splice(-1, 1, { ...forged, author: 'pirate' });
    expect((await runTestsGuard(github, ref, pr.number)).ok).toBe(false);

    await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: `tests-pr${String(pr.number)}`, decision: false, text: 'Refuser' }),
    );
    const refused = await runTestsGuard(github, ref, pr.number);
    expect(refused.reasons[0]).toContain('Kia a refusé');
    expect((await github.getIssue(ref, issue.number)).labels).toContain(stateLabel('fixing'));
    await runTestsGuard(github, ref, pr.number);
    const restore = (await github.listComments(ref, issue.number)).filter((c) =>
      c.body.includes('Tests à restaurer'),
    );
    expect(restore).toHaveLength(1);

    await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({
        id: `tests-pr${String(pr.number)}`,
        decision: false,
        text: 'Autoriser',
      }),
    );
    expect((await runTestsGuard(github, ref, pr.number)).ok).toBe(true);
  });

  it('PR sans tâche liée qui modifie un test : en échec', async () => {
    const { github, pr } = await withPullRequest([
      { path: 'src/somme.test.ts', content: 'test 1\n' },
    ]);
    await github.updatePullRequest(ref, pr.number, { body: 'PR manuelle' });
    expect((await runTestsGuard(github, ref, pr.number)).reasons[0]).toContain('sans tâche liée');
  });
});

describe('relecteur', () => {
  it('prépare le prompt avec la tâche, les fichiers et le profil lu sur main', async () => {
    const { github, pr } = await withPullRequest([
      { path: 'src/somme.ts', content: 'export const somme = 2;\n' },
      { path: 'src/somme.test.ts', content: 'test 1\ntest 2\ntest 3\n' },
    ]);
    const prepared = await prepareReview(github, ref, pr.number);
    expect(prepared.prompt).toContain('# Relecture de la PR');
    expect(prepared.prompt).toContain('## Tâche T04 — Somme');
    expect(prepared.prompt).toContain('`src/somme.ts` (modified, +1 −1)');
    expect(prepared.prompt).toContain('Ajoutés ou complétés : src/somme.test.ts');
    expect(prepared.claudeArgs).toContain("--model 'opus'");
    expect(prepared.claudeArgs).toContain('"verdict"');
    expect(prepared.issueNumber).toBe(1);
  });

  it('PR sans tâche : relue sur ses propres mérites', async () => {
    const { github, pr } = await withPullRequest([{ path: 'README.md', content: 'x' }]);
    await github.updatePullRequest(ref, pr.number, { body: 'PR manuelle' });
    expect((await prepareReview(github, ref, pr.number)).prompt).toContain(
      'Aucune tâche AgentLake liée',
    );
  });

  it('approuvée : commentaire sur la PR, check vert', async () => {
    const { github, pr } = await withPullRequest([{ path: 'src/x.ts', content: 'x' }]);
    const result = await finalizeReview(github, ref, {
      prNumber: pr.number,
      conclusion: 'success',
      structuredOutput: JSON.stringify({ verdict: 'approve', summary: 'Conforme.', findings: [] }),
    });
    expect(result.passed).toBe(true);
    expect((await github.listComments(ref, pr.number))[0]?.body).toContain(
      '**Relecture : approuvée**',
    );
  });

  it('changements demandés : tâche en correction avec la liste, check rouge', async () => {
    const { github, issue, pr } = await withPullRequest([{ path: 'src/x.ts', content: 'x' }]);
    const result = await finalizeReview(github, ref, {
      prNumber: pr.number,
      conclusion: 'success',
      structuredOutput: JSON.stringify({
        verdict: 'request_changes',
        summary: 'Il manque un cas.',
        findings: [
          { file: 'src/x.ts', line: 3, problem: 'division par zéro', fix: 'tester b = 0' },
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.log).toContain('`src/x.ts:3` : division par zéro → tester b = 0');
    expect((await github.getIssue(ref, issue.number)).labels).toContain(stateLabel('fixing'));
    expect((await github.listComments(ref, issue.number))[0]?.body).toContain(
      '**Changements demandés par le relecteur**',
    );
  });

  it('sans verdict : check rouge', async () => {
    const { github, pr } = await withPullRequest([{ path: 'src/x.ts', content: 'x' }]);
    const cases: [string, string][] = [
      ['failure', ''],
      ['success', '{pas du json'],
      ['success', JSON.stringify({ verdict: 'peut-être' })],
    ];
    for (const [conclusion, output] of cases)
      expect(
        (
          await finalizeReview(github, ref, {
            prNumber: pr.number,
            conclusion,
            structuredOutput: output,
          })
        ).passed,
      ).toBe(false);
    expect(parseReviewOutcome('')).toBeNull();
  });
});

describe('CLI qualité', () => {
  it('garde, préparation et verdict ; codes de sortie du check', async () => {
    const { github, pr } = await withPullRequest([{ path: 'src/somme.ts', content: 'y' }]);
    const outputs: string[] = [];
    const logs: string[] = [];
    const deps = {
      github: () => github,
      appendText: (_p: string, text: string) => {
        outputs.push(text);
        return Promise.resolve();
      },
      log: (l: string) => logs.push(l),
    };
    const env = { GITHUB_REPOSITORY: 'kiamiya/site', GH_TOKEN: 'j', PR_NUMBER: String(pr.number) };
    expect(await runQualityCli('tests-guard', env, deps)).toBe(1);
    expect(logs[0]).toContain('tests-guard : en échec.');
    expect(await runQualityCli('review-prepare', { ...env, GITHUB_OUTPUT: '/o' }, deps)).toBe(0);
    expect(outputs.join('')).toContain('claude_args<<');
    expect(
      await runQualityCli(
        'review-finalize',
        {
          ...env,
          CONCLUSION: 'success',
          STRUCTURED_OUTPUT: JSON.stringify({ verdict: 'approve', summary: 'ok', findings: [] }),
        },
        deps,
      ),
    ).toBe(0);
    await expect(runQualityCli('autre', env, deps)).rejects.toThrow('Commande attendue');
    await expect(runQualityCli('tests-guard', {}, deps)).rejects.toThrow('Variables');
  });
});
