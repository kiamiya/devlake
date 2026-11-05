#!/usr/bin/env node
/**
 * Point d'entrée du workflow dispatcher.yml : une passe du dispatcher sur le dépôt courant.
 * Les événements d'autres comptes sont ignorés, avec une trace dans le journal.
 */
import { OctokitGitHub, type GitHubPort } from 'github';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { formatZodError } from 'shared';
import { z } from 'zod';
import {
  checkBridgeHealth,
  eventAllowed,
  readGlobalCap,
  readMinutesRemaining,
  type Fetch,
} from './adapters.js';
import { answerEventFrom, traceIgnoredAnswer } from '../questions/answers.js';
import { runDispatch, type DispatchResult } from './dispatcher.js';

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? null : v.trim()));

export const DispatchEnvSchema = z.object({
  GITHUB_REPOSITORY: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'GITHUB_REPOSITORY attendu au format owner/repo.')
    .transform((s) => {
      const [owner = '', repo = ''] = s.split('/');
      return { owner, repo };
    }),
  GITHUB_EVENT_NAME: z.string().min(1, 'GITHUB_EVENT_NAME manquant.'),
  GITHUB_EVENT_PATH: optional,
  GH_TOKEN: z.string().min(1, 'GH_TOKEN manquant.'),
  AGENTLAKE_CONFIG_TOKEN: optional,
  AGENTLAKE_BILLING_TOKEN: optional,
  AURA_BRIDGE_URL: optional,
});

export interface DispatchCliDeps {
  github: (token: string) => GitHubPort;
  readText: (path: string) => Promise<string>;
  fetch: Fetch;
  now: () => Date;
  log: (line: string) => void;
}

/** Une passe ; `null` si l'événement a été ignoré par le filtre d'auteur. */
export async function runDispatchCli(
  env: NodeJS.ProcessEnv,
  deps: DispatchCliDeps,
): Promise<DispatchResult | null> {
  const parsed = DispatchEnvSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(`Variables d’environnement invalides :\n${formatZodError(parsed.error)}`);
  const e = parsed.data;
  const ref = e.GITHUB_REPOSITORY;

  const payload: unknown =
    e.GITHUB_EVENT_PATH === null ? {} : JSON.parse(await deps.readText(e.GITHUB_EVENT_PATH));
  const github = deps.github(e.GH_TOKEN);
  // Toute réponse qui ne relance rien est tracée, y compris celle d'un autre compte.
  const answer = e.GITHUB_EVENT_NAME === 'issue_comment' ? answerEventFrom(payload) : null;
  if (answer !== null) {
    const ignored = await traceIgnoredAnswer(github, ref, answer);
    if (ignored !== null)
      deps.log(`Réponse ignorée sur #${String(answer.issueNumber)} : ${ignored}.`);
  }

  const filter = eventAllowed(e.GITHUB_EVENT_NAME, payload, ref.owner);
  if (!filter.allowed) {
    deps.log(`Passe annulée : ${filter.reason}`);
    return null;
  }

  const configToken = e.AGENTLAKE_CONFIG_TOKEN;
  const result = await runDispatch(ref, {
    github,
    globalCap: () =>
      readGlobalCap(configToken === null ? null : deps.github(configToken), ref.owner),
    minutesRemaining: () =>
      readMinutesRemaining(github, ref, e.AGENTLAKE_BILLING_TOKEN, deps.fetch),
    bridgeHealthy: () => checkBridgeHealth(e.AURA_BRIDGE_URL, deps.fetch),
    now: deps.now,
    log: deps.log,
  });
  const launched = result.applied.filter((a) => a.kind === 'launch').length;
  deps.log(
    `Passe terminée : ${String(launched)} agent(s) lancé(s), ${String(result.applied.length)} action(s).`,
  );
  return result;
}

/* c8 ignore start -- amorçage : exécuté dans le runner GitHub Actions */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDispatchCli(process.env, {
    github: (token) => new OctokitGitHub({ token }),
    readText: (path) => readFile(path, 'utf8'),
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    log: (line) => {
      console.log(line);
    },
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
/* c8 ignore stop */
