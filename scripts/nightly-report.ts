/**
 * Rapport du workflow nocturne @live (T22) : lit la sortie JSON de Vitest et écrit un résumé
 * Markdown (résumé du job, et issue d'échec). Code de sortie : 0 si au moins un test a tourné
 * et qu'aucun n'a échoué, 1 sinon (des tests tous sautés trahissent une configuration absente).
 *
 *   node scripts/nightly-report.ts live-report.json > report.md
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface AssertionResult {
  fullName: string;
  status: string;
  failureMessages?: string[];
}
interface FileResult {
  name: string;
  assertionResults: AssertionResult[];
}
export interface VitestJsonReport {
  testResults: FileResult[];
}

export interface NightlyReport {
  ok: boolean;
  markdown: string;
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? '';
const cell = (text: string) => text.replace(/\|/g, '\\|').slice(0, 300);

/** Résumé du rapport Vitest ; `null` quand le fichier est absent (exécution interrompue). */
export function renderNightlyReport(report: VitestJsonReport | null, date: string): NightlyReport {
  const title = (ok: boolean) => `## ${ok ? '✅' : '❌'} Tests @live nocturnes — ${date}`;
  if (report === null)
    return {
      ok: false,
      markdown: `${title(false)}\n\n**Rapport absent** : les tests @live se sont interrompus avant la fin (voir le journal du run).\n`,
    };
  const tests = report.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({ ...test, file: file.name })),
  );
  const passed = tests.filter((t) => t.status === 'passed');
  const failed = tests.filter((t) => t.status === 'failed');
  const skipped = tests.filter((t) => t.status !== 'passed' && t.status !== 'failed');
  const ok = failed.length === 0 && passed.length > 0;
  const lines = [
    title(ok),
    '',
    `${String(passed.length)} réussi(s), ${String(failed.length)} en échec, ${String(skipped.length)} sauté(s).`,
  ];
  if (passed.length === 0 && failed.length === 0)
    lines.push(
      '',
      '**Aucun test lancé** : secrets ou variables du bac à sable absents (GITHUB_TOKEN, AGENTLAKE_SANDBOX_REPO, AGENTLAKE_UNITY_SANDBOX_REPO, AGENTLAKE_LIVE_MODEL, CLAUDE_CODE_OAUTH_TOKEN).',
    );
  if (failed.length > 0) {
    lines.push('', '| Test | Fichier | Erreur |', '| --- | --- | --- |');
    for (const test of failed)
      lines.push(
        `| ${cell(test.fullName)} | \`${cell(test.file.replace(/^.*?packages\//, 'packages/'))}\` | ${cell(firstLine(test.failureMessages?.[0] ?? ''))} |`,
      );
  }
  if (skipped.length > 0 && passed.length + failed.length > 0)
    lines.push('', `Sautés : ${skipped.map((t) => t.fullName).join(' ; ')}.`);
  return { ok, markdown: `${lines.join('\n')}\n` };
}

/* c8 ignore start -- amorçage : exécuté dans le runner GitHub Actions */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] ?? 'live-report.json';
  const report = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as VitestJsonReport)
    : null;
  const result = renderNightlyReport(report, new Date().toISOString().slice(0, 10));
  process.stdout.write(result.markdown);
  process.exitCode = result.ok ? 0 : 1;
}
/* c8 ignore stop */
