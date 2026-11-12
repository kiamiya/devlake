#!/usr/bin/env node
/** Point d'entrée du workflow architect.yml : réponse de l'architecte à la question d'un agent. */
import { OctokitGitHub, type GitHubPort } from 'github';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatZodError } from 'shared';
import { z } from 'zod';
import { runArchitect, type ArchitectOutcome } from './architect.js';
import { ClaudeCliPort } from './claude/cli-port.js';
import type { ClaudePort } from './claude/port.js';
import { DEFAULT_PROMPTS_DIR } from './prompts.js';

export const ArchitectEnvSchema = z.object({
  GITHUB_REPOSITORY: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'GITHUB_REPOSITORY attendu au format owner/repo.')
    .transform((s) => {
      const [owner = '', repo = ''] = s.split('/');
      return { owner, repo };
    }),
  GITHUB_WORKSPACE: z.string().min(1),
  GH_TOKEN: z.string().min(1, 'GH_TOKEN manquant.'),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1, 'Secret CLAUDE_CODE_OAUTH_TOKEN manquant.'),
  ISSUE_NUMBER: z.coerce.number().int().min(1, 'ISSUE_NUMBER doit être au moins 1.'),
  QUESTION_ID: z.string().regex(/^[A-Za-z0-9._-]+$/, 'QUESTION_ID invalide.'),
  MODEL: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
});

export interface ArchitectCliDeps {
  github: (token: string) => GitHubPort;
  claude: (oauthToken: string) => ClaudePort;
  template: () => Promise<string>;
  readText: (path: string) => Promise<string | null>;
}

export async function runArchitectCli(
  env: NodeJS.ProcessEnv,
  deps: ArchitectCliDeps,
): Promise<ArchitectOutcome> {
  const parsed = ArchitectEnvSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(`Variables d’environnement invalides :\n${formatZodError(parsed.error)}`);
  const e = parsed.data;
  return runArchitect(
    {
      ref: e.GITHUB_REPOSITORY,
      issueNumber: e.ISSUE_NUMBER,
      questionId: e.QUESTION_ID,
      model: e.MODEL,
    },
    {
      github: deps.github(e.GH_TOKEN),
      claude: deps.claude(e.CLAUDE_CODE_OAUTH_TOKEN),
      template: await deps.template(),
      readFile: (path) => deps.readText(join(e.GITHUB_WORKSPACE, path)),
      workspace: e.GITHUB_WORKSPACE,
    },
  );
}

/* c8 ignore start -- amorçage : exécuté dans le runner GitHub Actions */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runArchitectCli(process.env, {
    github: (token) => new OctokitGitHub({ token }),
    claude: (oauthToken) => new ClaudeCliPort({ oauthToken }),
    template: () => readFile(join(DEFAULT_PROMPTS_DIR, 'architecte.md'), 'utf8'),
    readText: async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  })
    .then((outcome) => {
      console.log(
        outcome.phase === 'answered'
          ? `Réponse de l’architecte publiée (${outcome.questionId}).`
          : outcome.phase === 'escalated'
            ? `Question ${outcome.questionId} transmise à Kia : ${outcome.reason}`
            : `Rien à faire : ${outcome.reason}.`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
/* c8 ignore stop */
