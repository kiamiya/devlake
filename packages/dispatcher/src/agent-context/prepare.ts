import type { GitHubPort, RepoRef } from 'github';
import {
  ciChecksFor,
  needsEditor,
  parseTaskIssueBody,
  ProjectConfigSchema,
  type TaskIssue,
} from 'shared';
import { parse } from 'yaml';
import { appendDecision } from '../questions/decisions.js';
import { DECISIONS_PATH, readProjectContext, taskBranch, type ReadFile } from './context.js';
import { authHeader, checkoutTaskBranch, type Git } from './git.js';
import {
  buildMcpConfig,
  claudeArgs,
  parseProfile,
  profilePath,
  type McpConfig,
  type ProfileEnv,
} from './profile.js';
import { buildPrompt, type QualityGate } from './prompt.js';
import { gatherResume, setTaskState, type ResumeReason } from './resume.js';

export interface PrepareInput {
  ref: RepoRef;
  issueNumber: number;
  profileId: string;
  attempt: number;
  reason: ResumeReason;
  /** Variables injectées dans la configuration MCP du profil (pont Aura). */
  profileEnv?: ProfileEnv;
  /** Fichier, hors du dépôt, où le CLI écrira la configuration MCP. */
  mcpConfigPath?: string;
}

export interface PrepareDeps {
  github: GitHubPort;
  git: Git;
  readFile: ReadFile;
  /** Écrit un fichier du dépôt (chemin relatif) ; sert à ajouter une décision. */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** Jeton du job, pour les opérations git de lecture. */
  token: string;
  /** Dossier des gabarits qualité dans le runner (copie de devlake). */
  templatesDir?: string;
  /** Date du jour (AAAA-MM-JJ) inscrite avec une décision. */
  today?: () => string;
}

export interface Prepared {
  task: TaskIssue;
  branch: string;
  branchState: 'created' | 'resumed';
  prompt: string;
  claudeArgs: string;
  /** Configuration MCP à écrire dans `mcpConfigPath`, si le profil déclare des serveurs. */
  mcpConfig: McpConfig | null;
}

export class TaskIssueError extends Error {
  constructor(issueNumber: number, detail: string) {
    super(`L’issue #${String(issueNumber)} n’est pas une tâche AgentLake valide : ${detail}`);
    this.name = 'TaskIssueError';
  }
}

/**
 * Préparation d'un agent : lit la tâche et le profil, passe l'issue en « running »,
 * extrait la branche de la tâche et construit le prompt.
 */
export async function prepareAgent(input: PrepareInput, deps: PrepareDeps): Promise<Prepared> {
  const issue = await deps.github.getIssue(input.ref, input.issueNumber);
  const parsed = parseTaskIssueBody(issue.body);
  if (!parsed.ok) throw new TaskIssueError(input.issueNumber, parsed.error);
  const task = parsed.value;
  const profile = parseProfile(await deps.readFile(profilePath(input.profileId)), input.profileId);
  // Avant tout changement d'état : un pont non configuré ne doit pas laisser la tâche « running ».
  // Code pur C#/C++ (needsEditor = false) : ni pont Aura, ni identifiants de push en session.
  const usesEditor =
    needsEditor({ profile: profile.id, needsEditor: task.needsEditor }) &&
    Object.keys(profile.mcpServers).length > 0;
  const mcpConfig = usesEditor ? buildMcpConfig(profile, input.profileEnv ?? {}) : null;

  await setTaskState(deps.github, input.ref, input.issueNumber, 'running');
  const branch = taskBranch(task.id, task.title);
  const branchState = await checkoutTaskBranch(deps.git, branch, deps.token);
  // Agent de jeu : il pousse son code avant editor_checkout et récupère ensuite ce que
  // l'éditeur a poussé, en cours de session. Le jeton du job est configuré pour ce seul dépôt
  // du runner (éphémère), jamais commité.
  if (usesEditor) {
    const setting = authHeader(deps.token)[1] ?? '';
    const split = setting.indexOf('=');
    await deps.git.run(['config', '--local', setting.slice(0, split), setting.slice(split + 1)]);
  }

  const resume = await gatherResume(deps.github, input.ref, {
    issueNumber: input.issueNumber,
    reason: input.reason,
    branch,
    attempt: input.attempt,
  });
  // Réponse promue en décision : ajoutée à decisions.md sur la branche de la tâche,
  // avant la lecture du contexte (l'agent la voit) ; elle arrive sur main avec la PR.
  if (resume.kind === 'answer' && resume.answer.decision && resume.answer.ignored !== true) {
    const updated = appendDecision(await deps.readFile(DECISIONS_PATH), {
      issueNumber: input.issueNumber,
      taskId: task.id,
      question: resume.question,
      answer: resume.answer,
      date: (deps.today ?? (() => new Date().toISOString().slice(0, 10)))(),
    });
    if (updated !== null && deps.writeFile) {
      await deps.writeFile(DECISIONS_PATH, updated);
      await deps.git.run(['add', DECISIONS_PATH]);
      await deps.git.run([
        'commit',
        '-m',
        `docs(decisions): ${task.id}, réponse à ${resume.question.id}`,
      ]);
    }
  }
  const context = await readProjectContext(deps.readFile);
  const quality =
    profile.id === 'architect' ? await qualityGate(deps.readFile, deps.templatesDir) : undefined;
  return {
    task,
    branch,
    branchState,
    prompt: buildPrompt({
      task,
      issueNumber: input.issueNumber,
      profile,
      branch,
      context,
      resume,
      ...(quality ? { quality } : {}),
      ...(Object.keys(profile.mcpServers).length > 0 && !usesEditor ? { withoutEditor: true } : {}),
    }),
    claudeArgs: claudeArgs(
      profile,
      mcpConfig === null ? null : (input.mcpConfigPath ?? 'agentlake-mcp.json'),
    ),
    mcpConfig,
  };
}

/** Porte qualité du projet, lue dans `.agentlake/project.yml` (null si illisible). */
async function qualityGate(
  readFile: ReadFile,
  templatesRoot = '.agentlake-runtime/templates/quality',
): Promise<QualityGate | undefined> {
  const text = await readFile('.agentlake/project.yml');
  if (text === null) return undefined;
  const parsed = ProjectConfigSchema.safeParse(parse(text));
  if (!parsed.success) return undefined;
  const profile = parsed.data.qualityProfile;
  return { profile, checks: ciChecksFor(profile), templatesDir: `${templatesRoot}/${profile}/` };
}
