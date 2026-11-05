#!/usr/bin/env node
/** Point d'entrée du workflow planner.yml : `node cli.js run`. */
import { OctokitGitHub, type GitHubPort } from 'github';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatZodError } from 'shared';
import { z } from 'zod';
import { ClaudeCliPort } from './claude/cli-port.js';
import type { ClaudePort } from './claude/port.js';
import { runPlanner, type PlannerOutcome } from './planner.js';
import { loadPrompts, type Prompts } from './prompts.js';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const PlannerEnvSchema = z.object({
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
  MODE: z.enum(['auto', 'regenerate']).default('auto'),
  MODEL: optional(z.string()),
  MAX_AGENTS: optional(z.coerce.number().int().min(1, 'MAX_AGENTS doit être au moins 1.')),
  INSTRUCTION: optional(z.string()),
});

export interface PlannerCliDeps {
  github: (token: string) => GitHubPort;
  claude: (oauthToken: string) => ClaudePort;
  prompts: () => Promise<Prompts>;
  readText: (path: string) => Promise<string | null>;
}

/** Message lisible dans le journal du job, pour chaque issue. */
export function describeOutcome(outcome: PlannerOutcome): string {
  switch (outcome.phase) {
    case 'clarification':
      return `Questions publiées dans l’issue #${String(outcome.issueNumber)} : ${outcome.questions.join(', ')}.`;
    case 'waiting':
      return `En attente de réponses dans l’issue #${String(outcome.issueNumber)} : ${outcome.pending.join(', ')}.`;
    case 'plan':
      return `Plan v${String(outcome.version)} sur ${outcome.branch} : ${String(outcome.tasks)} tâches, ${String(outcome.agents)} agent(s).`;
    case 'failed':
      return `Planification en échec (issue #${String(outcome.issueNumber)}) :\n${outcome.errors}`;
  }
}

export async function runCli(
  env: NodeJS.ProcessEnv,
  deps: PlannerCliDeps,
): Promise<PlannerOutcome> {
  const parsed = PlannerEnvSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(`Variables d’environnement invalides :\n${formatZodError(parsed.error)}`);
  const e = parsed.data;
  return runPlanner(
    {
      ref: e.GITHUB_REPOSITORY,
      mode: e.MODE,
      model: e.MODEL,
      maxAgents: e.MAX_AGENTS,
      instruction: e.INSTRUCTION,
    },
    {
      github: deps.github(e.GH_TOKEN),
      claude: deps.claude(e.CLAUDE_CODE_OAUTH_TOKEN),
      prompts: await deps.prompts(),
      readFile: (path) => deps.readText(join(e.GITHUB_WORKSPACE, path)),
      workspace: e.GITHUB_WORKSPACE,
    },
  );
}

/* c8 ignore start -- amorçage : exécuté dans le runner GitHub Actions */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.env, {
    github: (token) => new OctokitGitHub({ token }),
    claude: (oauthToken) => new ClaudeCliPort({ oauthToken }),
    prompts: () => loadPrompts(),
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
      console.log(describeOutcome(outcome));
      if (outcome.phase === 'failed') process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
/* c8 ignore stop */
