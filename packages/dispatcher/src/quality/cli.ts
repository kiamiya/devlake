#!/usr/bin/env node
/**
 * Point d'entrée du workflow review.yml :
 *   node cli.js tests-guard      → check « tests-guard » (tests modifiés, tests ajoutés)
 *   node cli.js review-prepare   → prompt et arguments du relecteur
 *   node cli.js review-finalize  → verdict publié ; changements demandés → tâche en correction
 */
import { OctokitGitHub, type GitHubPort } from 'github';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { formatZodError } from 'shared';
import { z } from 'zod';
import { formatOutputs } from '../agent-context/cli.js';
import { formatGuardResult, runTestsGuard } from './guard.js';
import { finalizeReview, prepareReview } from './review.js';

export const QualityEnvSchema = z.object({
  GITHUB_REPOSITORY: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'GITHUB_REPOSITORY attendu au format owner/repo.')
    .transform((s) => {
      const [owner = '', repo = ''] = s.split('/');
      return { owner, repo };
    }),
  GH_TOKEN: z.string().min(1, 'GH_TOKEN manquant.'),
  PR_NUMBER: z.coerce
    .number({ error: 'PR_NUMBER doit être un nombre.' })
    .int()
    .min(1, 'PR_NUMBER doit être au moins 1.'),
  GITHUB_OUTPUT: z.string().default(''),
  CONCLUSION: z.string().default('failure'),
  STRUCTURED_OUTPUT: z.string().default(''),
});

export interface QualityCliDeps {
  github: (token: string) => GitHubPort;
  appendText: (path: string, text: string) => Promise<void>;
  log: (line: string) => void;
}

/** Exécute une commande ; renvoie le code de sortie du check. */
export async function runQualityCli(
  command: string | undefined,
  env: NodeJS.ProcessEnv,
  deps: QualityCliDeps,
): Promise<number> {
  const parsed = QualityEnvSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(`Variables d’environnement invalides :\n${formatZodError(parsed.error)}`);
  const e = parsed.data;
  const github = deps.github(e.GH_TOKEN);
  switch (command) {
    case 'tests-guard': {
      const result = await runTestsGuard(github, e.GITHUB_REPOSITORY, e.PR_NUMBER);
      deps.log(formatGuardResult(result));
      return result.ok ? 0 : 1;
    }
    case 'review-prepare': {
      const prepared = await prepareReview(github, e.GITHUB_REPOSITORY, e.PR_NUMBER);
      await deps.appendText(
        e.GITHUB_OUTPUT,
        formatOutputs({ prompt: prepared.prompt, claude_args: prepared.claudeArgs }),
      );
      deps.log(`Relecture de la PR #${String(e.PR_NUMBER)} préparée.`);
      return 0;
    }
    case 'review-finalize': {
      const result = await finalizeReview(github, e.GITHUB_REPOSITORY, {
        prNumber: e.PR_NUMBER,
        conclusion: e.CONCLUSION,
        structuredOutput: e.STRUCTURED_OUTPUT,
      });
      deps.log(result.log);
      return result.passed ? 0 : 1;
    }
    default:
      throw new Error('Commande attendue : tests-guard, review-prepare ou review-finalize.');
  }
}

/* c8 ignore start -- amorçage : exécuté dans le runner GitHub Actions */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runQualityCli(process.argv[2], process.env, {
    github: (token) => new OctokitGitHub({ token }),
    appendText: (path, text) => appendFile(path, text, 'utf8'),
    log: (line) => {
      console.log(line);
    },
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
