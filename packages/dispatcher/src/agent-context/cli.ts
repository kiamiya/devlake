#!/usr/bin/env node
/**
 * Point d'entrée du workflow agent-task.yml :
 *   node cli.js prepare   → passe l'issue en running, extrait la branche, écrit le prompt
 *   node cli.js finalize  → pousse, ouvre ou met à jour la PR, auto-merge ; ou fixing + diagnostic
 */
import { OctokitGitHub, type GitHubPort } from 'github';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatZodError } from 'shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { finalizeAgent, type FinalizeResult } from './finalize.js';
import { systemGit, type Git } from './git.js';
import { prepareAgent, type Prepared } from './prepare.js';
import { profileEnvFrom } from './profile.js';
import { RESUME_REASONS } from './resume.js';
import { BRIDGE_TOKEN_TTL_SECONDS, signBridgeToken } from 'shared/bridge-token';

const repository = z
  .string()
  .regex(/^[^/]+\/[^/]+$/, 'GITHUB_REPOSITORY attendu au format owner/repo.')
  .transform((s) => {
    const [owner = '', repo = ''] = s.split('/');
    return { owner, repo };
  });

const positive = (name: string) =>
  z.coerce
    .number({ error: `${name} doit être un nombre.` })
    .int()
    .min(1, `${name} doit être au moins 1.`);

export const PrepareEnvSchema = z.object({
  GITHUB_REPOSITORY: repository,
  GITHUB_WORKSPACE: z.string().min(1),
  GITHUB_OUTPUT: z.string().min(1),
  RUNNER_TEMP: z.string().min(1, 'RUNNER_TEMP manquant.'),
  GH_TOKEN: z.string().min(1, 'GH_TOKEN manquant.'),
  ISSUE_NUMBER: positive('ISSUE_NUMBER'),
  PROFILE: z.string().min(1, 'PROFILE manquant.'),
  ATTEMPT: positive('ATTEMPT').default(1),
  RESUME_REASON: z.enum(RESUME_REASONS).default('none'),
});

export const FinalizeEnvSchema = z.object({
  GITHUB_REPOSITORY: repository,
  GITHUB_WORKSPACE: z.string().min(1),
  GH_TOKEN: z.string().min(1, 'GH_TOKEN manquant.'),
  APP_TOKEN: z.string().optional(),
  ISSUE_NUMBER: positive('ISSUE_NUMBER'),
  ATTEMPT: positive('ATTEMPT').default(1),
  TASK_ID: z.string().min(1, 'TASK_ID manquant (étape de préparation en échec ?).'),
  TASK_TITLE: z.string().min(1),
  BRANCH: z.string().min(1),
  CONCLUSION: z.string().default('failure'),
  STRUCTURED_OUTPUT: z.string().default(''),
  RUN_URL: z.string().default(''),
});

export function parseEnv<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(`Variables d’environnement invalides :\n${formatZodError(parsed.error)}`);
  return parsed.data;
}

/** Sorties d'étape GitHub Actions, multi-lignes comprises. */
export function formatOutputs(
  outputs: Record<string, string>,
  delimiter = `AGENTLAKE_${randomUUID()}`,
): string {
  return Object.entries(outputs)
    .map(([key, value]) => `${key}<<${delimiter}\n${value}\n${delimiter}\n`)
    .join('');
}

export interface CliDeps {
  github: (token: string) => GitHubPort;
  git: (cwd: string) => Git;
  readText: (path: string) => Promise<string | null>;
  appendText: (path: string, text: string) => Promise<void>;
  writeText: (path: string, text: string) => Promise<void>;
  /** Horloge (expiration du jeton du pont). */
  now?: () => Date;
  /** Journal du job (commandes `::add-mask::`). */
  log: (line: string) => void;
}

/**
 * Jeton du pont Aura pour un agent Unity ou Unreal : signé ici avec `AURA_BRIDGE_SECRET`
 * (dépôt, run, profil, expiration à 2 h), jamais écrit dans le dépôt.
 */
export function withBridgeToken(env: NodeJS.ProcessEnv, now: Date): NodeJS.ProcessEnv {
  const secret = env.AURA_BRIDGE_SECRET ?? '';
  const profile = env.PROFILE;
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (
    secret === '' ||
    (env.AURA_BRIDGE_TOKEN ?? '') !== '' ||
    (profile !== 'unity' && profile !== 'unreal') ||
    repo === undefined ||
    runId === undefined
  )
    return env;
  const token = signBridgeToken(
    {
      repo,
      runId,
      profile,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + BRIDGE_TOKEN_TTL_SECONDS,
    },
    secret,
  );
  return { ...env, AURA_BRIDGE_TOKEN: token };
}

export async function runPrepare(env: NodeJS.ProcessEnv, deps: CliDeps): Promise<Prepared> {
  const e = parseEnv(PrepareEnvSchema, env);
  // Hors du dépôt : le jeton du pont ne doit jamais être commité.
  const mcpConfigPath = join(e.RUNNER_TEMP, 'agentlake-mcp.json');
  const prepared = await prepareAgent(
    {
      ref: e.GITHUB_REPOSITORY,
      issueNumber: e.ISSUE_NUMBER,
      profileId: e.PROFILE,
      attempt: e.ATTEMPT,
      reason: e.RESUME_REASON,
      profileEnv: profileEnvFrom(withBridgeToken(env, deps.now?.() ?? new Date())),
      mcpConfigPath,
    },
    {
      github: deps.github(e.GH_TOKEN),
      git: deps.git(e.GITHUB_WORKSPACE),
      readFile: (path) => deps.readText(join(e.GITHUB_WORKSPACE, path)),
      writeFile: (path, content) => deps.writeText(join(e.GITHUB_WORKSPACE, path), content),
      token: e.GH_TOKEN,
    },
  );
  if (prepared.mcpConfig !== null) {
    for (const secret of prepared.mcpConfig.secrets) deps.log(`::add-mask::${secret}`);
    await deps.writeText(mcpConfigPath, prepared.mcpConfig.json);
  }
  await deps.appendText(
    e.GITHUB_OUTPUT,
    formatOutputs({
      branch: prepared.branch,
      task_id: prepared.task.id,
      task_title: prepared.task.title,
      prompt: prepared.prompt,
      claude_args: prepared.claudeArgs,
    }),
  );
  return prepared;
}

export async function runFinalize(env: NodeJS.ProcessEnv, deps: CliDeps): Promise<FinalizeResult> {
  const e = parseEnv(FinalizeEnvSchema, env);
  // Sans jeton de l'app Claude, la PR serait ouverte avec le GITHUB_TOKEN et ne déclencherait pas la CI.
  const appToken = e.APP_TOKEN !== undefined && e.APP_TOKEN !== '' ? e.APP_TOKEN : e.GH_TOKEN;
  return finalizeAgent(
    {
      ref: e.GITHUB_REPOSITORY,
      issueNumber: e.ISSUE_NUMBER,
      taskId: e.TASK_ID,
      taskTitle: e.TASK_TITLE,
      branch: e.BRANCH,
      attempt: e.ATTEMPT,
      conclusion: e.CONCLUSION,
      structuredOutput: e.STRUCTURED_OUTPUT,
      runUrl: e.RUN_URL,
    },
    {
      github: deps.github(e.GH_TOKEN),
      appGithub: deps.github(appToken),
      git: deps.git(e.GITHUB_WORKSPACE),
      appToken,
    },
  );
}

/* c8 ignore start -- amorçage : exécuté dans le runner GitHub Actions */
const systemDeps: CliDeps = {
  github: (token) => new OctokitGitHub({ token }),
  git: (cwd) => systemGit(cwd),
  readText: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  appendText: (path, text) => appendFile(path, text, 'utf8'),
  writeText: (path, text) => writeFile(path, text, { encoding: 'utf8', mode: 0o600 }),
  log: (line) => {
    console.log(line);
  },
};

async function main(command: string | undefined): Promise<void> {
  if (command === 'prepare') {
    const prepared = await runPrepare(process.env, systemDeps);
    console.log(
      `Tâche ${prepared.task.id} prête sur ${prepared.branch} (${prepared.branchState}).`,
    );
  } else if (command === 'finalize') {
    const result = await runFinalize(process.env, systemDeps);
    console.log(JSON.stringify(result));
    if (result.status === 'failed') process.exitCode = 1;
  } else {
    throw new Error('Commande attendue : prepare ou finalize.');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
/* c8 ignore stop */
