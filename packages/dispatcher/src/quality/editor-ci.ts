#!/usr/bin/env node
/**
 * Check de CI Unreal (`unit-tests`, `integration-tests`) : demande au pont Aura du poste de
 * lancer les tests d'automatisation au commit de la PR (UnrealEditor-Cmd sur le clone dédié),
 * attend le résultat signé et le publie dans le résumé du job.
 *
 *   node editor-ci.js   (variables : AURA_BRIDGE_URL, AURA_BRIDGE_SECRET, BRANCH, SHA,
 *                        AUTOMATION_FILTER, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_JOB)
 */
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { formatZodError } from 'shared';
import {
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_TOKEN_TTL_SECONDS,
  signBridgeToken,
  verifyBridgeResponse,
} from 'shared/bridge-token';
import { z } from 'zod';
import type { Fetch } from '../dispatch/adapters.js';

export const EditorCiEnvSchema = z.object({
  AURA_BRIDGE_URL: z.url({
    error: 'Variable AURA_BRIDGE_URL absente ou invalide : tunnel du cockpit fermé ?',
  }),
  AURA_BRIDGE_SECRET: z
    .string({ error: 'Secret AURA_BRIDGE_SECRET absent.' })
    .min(1, 'Secret AURA_BRIDGE_SECRET absent.'),
  GITHUB_REPOSITORY: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'GITHUB_REPOSITORY invalide.'),
  GITHUB_RUN_ID: z.string().min(1, 'GITHUB_RUN_ID manquant.'),
  GITHUB_JOB: z.string().default('tests'),
  BRANCH: z.string().min(1, 'BRANCH manquante.'),
  SHA: z.string().regex(/^[0-9a-f]{40}$/, 'SHA invalide.'),
  AUTOMATION_FILTER: z.string().trim().min(1, 'AUTOMATION_FILTER manquant.'),
  GITHUB_STEP_SUMMARY: z.string().default(''),
  /** Attente maximale, éditeur occupé compris. */
  WAIT_MINUTES: z.coerce.number().int().min(1).default(110),
});
export type EditorCiEnv = z.infer<typeof EditorCiEnvSchema>;

interface AutomationTest {
  name: string;
  state: 'passed' | 'failed' | 'skipped';
  errors: string[];
}
interface AutomationJob {
  id: string;
  repo: string;
  sha: string;
  state: 'running' | 'passed' | 'failed' | 'error';
  summary: { passed: number; failed: number; skipped: number };
  tests: AutomationTest[];
  error: string | null;
  logTail: string[];
}

export interface EditorCiDeps {
  fetch: Fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  appendText: (path: string, text: string) => Promise<void>;
}

/** Intervalle entre deux essais quand l'éditeur est occupé, et entre deux lectures. */
export const BUSY_RETRY_MS = 30_000;
export const POLL_MS = 15_000;
/** Erreurs réseau tolérées d'affilée pendant l'attente (tunnel qui se reconnecte). */
const MAX_NETWORK_ERRORS = 5;

class EditorCiError extends Error {}

/** Résumé Markdown du job : compteurs, tests en échec et leurs erreurs. */
export function renderAutomationSummary(job: AutomationJob, filter: string): string {
  const icon = job.state === 'passed' ? '✅' : '❌';
  const lines = [
    `## ${icon} Tests d’automatisation Unreal (${filter})`,
    '',
    `Commit \`${job.sha.slice(0, 7)}\` — ${String(job.summary.passed)} réussi(s), ${String(
      job.summary.failed,
    )} en échec, ${String(job.summary.skipped)} non lancé(s).`,
  ];
  if (job.error !== null) lines.push('', `**${job.error}**`);
  const failed = job.tests.filter((t) => t.state === 'failed');
  if (failed.length > 0) {
    lines.push('', '| Test | Erreurs |', '| --- | --- |');
    for (const t of failed)
      lines.push(
        `| \`${t.name}\` | ${t.errors.map((e) => e.replace(/\|/g, '\\|')).join('<br>') || '—'} |`,
      );
  }
  if (job.state === 'error' && job.logTail.length > 0)
    lines.push(
      '',
      '<details><summary>Fin du journal</summary>',
      '',
      '```',
      ...job.logTail,
      '```',
      '</details>',
    );
  return `${lines.join('\n')}\n`;
}

/** Lance les tests d'automatisation via le pont et attend le résultat ; vrai si tout passe. */
export async function runEditorCi(env: EditorCiEnv, deps: EditorCiDeps): Promise<boolean> {
  const base = env.AURA_BRIDGE_URL.replace(/\/+$/, '');
  const deadline = deps.now().getTime() + env.WAIT_MINUTES * 60_000;
  const runId = `${env.GITHUB_RUN_ID}/${env.GITHUB_JOB}`;
  const token = () => {
    const iat = Math.floor(deps.now().getTime() / 1000);
    return signBridgeToken(
      {
        repo: env.GITHUB_REPOSITORY,
        runId,
        profile: 'unreal',
        scope: 'ci',
        iat,
        exp: iat + BRIDGE_TOKEN_TTL_SECONDS,
      },
      env.AURA_BRIDGE_SECRET,
    );
  };
  const timeLeft = () => deadline - deps.now().getTime();

  /** Corps d'une réponse signée par le pont ; refusé sinon. */
  const signedJob = async (response: Response): Promise<AutomationJob> => {
    const body = await response.text();
    if (
      !verifyBridgeResponse(
        body,
        response.headers.get(BRIDGE_SIGNATURE_HEADER) ?? '',
        env.AURA_BRIDGE_SECRET,
      )
    )
      throw new EditorCiError('Réponse non signée par le pont : ignorée.');
    const job = JSON.parse(body) as AutomationJob;
    if (job.repo !== env.GITHUB_REPOSITORY || job.sha !== env.SHA)
      throw new EditorCiError('Réponse du pont destinée à un autre dépôt ou commit.');
    return job;
  };
  const errorOf = async (response: Response) => {
    const text = await response.text();
    try {
      const data = JSON.parse(text) as { error?: { message?: string } | string };
      const message = typeof data.error === 'string' ? data.error : data.error?.message;
      return message ?? text;
    } catch {
      return text;
    }
  };

  // 1. Lancement ; éditeur occupé → nouvel essai jusqu'à l'échéance.
  let job: AutomationJob;
  for (;;) {
    let response: Response;
    try {
      response = await deps.fetch(`${base}/automation`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ branch: env.BRANCH, sha: env.SHA, filter: env.AUTOMATION_FILTER }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new EditorCiError(
        `Pont Aura injoignable (${error instanceof Error ? error.message : String(error)}) : cockpit et tunnel ouverts sur le poste ?`,
      );
    }
    if (response.status === 202) {
      job = await signedJob(response);
      break;
    }
    const message = await errorOf(response);
    if (response.status !== 409) throw new EditorCiError(`Pont Aura : ${message}`);
    if (timeLeft() <= BUSY_RETRY_MS)
      throw new EditorCiError(`Éditeur toujours occupé à l’échéance : ${message}`);
    deps.log(`${message} Nouvel essai dans ${String(BUSY_RETRY_MS / 1000)} s.`);
    await deps.sleep(BUSY_RETRY_MS);
  }
  deps.log(
    `Tests d’automatisation lancés sur le poste (${env.AUTOMATION_FILTER}, ${env.SHA.slice(0, 7)}).`,
  );

  // 2. Attente du résultat.
  let networkErrors = 0;
  while (job.state === 'running') {
    if (timeLeft() <= 0)
      throw new EditorCiError('Tests d’automatisation toujours en cours à l’échéance.');
    await deps.sleep(POLL_MS);
    try {
      const response = await deps.fetch(`${base}/automation/${job.id}`, {
        headers: { authorization: `Bearer ${token()}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 200)
        throw new EditorCiError(`Pont Aura : ${await errorOf(response)}`);
      job = await signedJob(response);
      networkErrors = 0;
    } catch (error) {
      if (error instanceof EditorCiError) throw error;
      networkErrors += 1;
      if (networkErrors >= MAX_NETWORK_ERRORS)
        throw new EditorCiError(
          `Pont Aura injoignable pendant les tests (${error instanceof Error ? error.message : String(error)}).`,
        );
    }
  }

  const summary = renderAutomationSummary(job, env.AUTOMATION_FILTER);
  deps.log(summary);
  if (env.GITHUB_STEP_SUMMARY !== '') await deps.appendText(env.GITHUB_STEP_SUMMARY, summary);
  return job.state === 'passed';
}

/** Point d'entrée : variables lues, erreurs écrites lisiblement ; code de sortie du check. */
export async function editorCiMain(env: NodeJS.ProcessEnv, deps: EditorCiDeps): Promise<number> {
  const parsed = EditorCiEnvSchema.safeParse(env);
  if (!parsed.success) {
    deps.log(`Variables d’environnement invalides :\n${formatZodError(parsed.error)}`);
    return 1;
  }
  try {
    return (await runEditorCi(parsed.data, deps)) ? 0 : 1;
  } catch (error) {
    if (!(error instanceof EditorCiError)) throw error;
    deps.log(error.message);
    if (parsed.data.GITHUB_STEP_SUMMARY !== '')
      await deps.appendText(
        parsed.data.GITHUB_STEP_SUMMARY,
        `## ❌ Tests d’automatisation Unreal (${parsed.data.AUTOMATION_FILTER})\n\n**${error.message}**\n`,
      );
    return 1;
  }
}

/* c8 ignore start -- amorçage : exécuté dans le runner GitHub Actions */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  editorCiMain(process.env, {
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => {
      console.log(line);
    },
    appendText: (path, text) => appendFile(path, text, 'utf8'),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
/* c8 ignore stop */
