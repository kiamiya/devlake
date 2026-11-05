import type { GitHubPort, RepoRef } from 'github';
import { parseTaskIssueBody, type TaskIssue } from 'shared';
import { appendDecision } from '../questions/decisions.js';
import { DECISIONS_PATH, readProjectContext, taskBranch, type ReadFile } from './context.js';
import { checkoutTaskBranch, type Git } from './git.js';
import {
  buildMcpConfig,
  claudeArgs,
  parseProfile,
  profilePath,
  type McpConfig,
  type ProfileEnv,
} from './profile.js';
import { buildPrompt } from './prompt.js';
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
  const mcpConfig = buildMcpConfig(profile, input.profileEnv ?? {});

  await setTaskState(deps.github, input.ref, input.issueNumber, 'running');
  const branch = taskBranch(task.id, task.title);
  const branchState = await checkoutTaskBranch(deps.git, branch, deps.token);

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
  return {
    task,
    branch,
    branchState,
    prompt: buildPrompt({ task, issueNumber: input.issueNumber, profile, branch, context, resume }),
    claudeArgs: claudeArgs(
      profile,
      mcpConfig === null ? null : (input.mcpConfigPath ?? 'agentlake-mcp.json'),
    ),
    mcpConfig,
  };
}
