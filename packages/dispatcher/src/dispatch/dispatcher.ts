import type { GitHubPort, RepoRef } from 'github';
import {
  DEFAULT_RUNNER_CAP,
  loadAgentProfile,
  parseStateLabel,
  parseTaskIssueBody,
  profilePath,
  ProjectConfigSchema,
  readDispatchMeta,
  stateLabel,
  TASK_LABEL,
  writeDispatchMeta,
  type ProfileId,
  type TaskState,
} from 'shared';
import { parse } from 'yaml';
import { setTaskState } from '../agent-context/resume.js';
import { readThread, reminderComment, reminderDue } from '../questions/thread.js';
import {
  GAME_PROFILES,
  planPass,
  type AgentRun,
  type PassAction,
  type PassPlan,
  type TaskView,
} from './plan-pass.js';

/** Workflow d'appel de l'agent, posé dans chaque projet au bootstrap. */
export const AGENT_WORKFLOW = 'agentlake-agent-task.yml';
export const PROJECT_CONFIG = '.agentlake/project.yml';
const MAIN = 'main';
/** Coût par défaut d'une tâche dont le profil est illisible. */
export const DEFAULT_ESTIMATE_MINUTES = 30;

/** Titre des runs d'agent (`run-name` du workflow d'appel) : relie un run à son issue. */
export function agentRunTitle(issueNumber: number, attempt: number): string {
  return `AgentLake — agent, issue #${String(issueNumber)}, tentative ${String(attempt)}`;
}

export function parseAgentRunTitle(title: string): { issueNumber: number; attempt: number } | null {
  const match = /issue #(\d+), tentative (\d+)/.exec(title);
  return match ? { issueNumber: Number(match[1]), attempt: Number(match[2]) } : null;
}

const PR_MARKER = /<!-- agentlake:pr task=(T\d+) /;

export interface GlobalCap {
  cap: number;
  /** Explication si la valeur par défaut a été appliquée. */
  note?: string;
}

export interface DispatcherDeps {
  github: GitHubPort;
  globalCap: () => Promise<GlobalCap>;
  /** Santé du pont Aura (GET /health). */
  bridgeHealthy: () => Promise<boolean>;
  /** Minutes Actions restantes ; null = non limité. */
  minutesRemaining: () => Promise<{ minutes: number | null; note?: string }>;
  now: () => Date;
  log: (line: string) => void;
}

export class NotAProjectError extends Error {
  constructor(detail: string) {
    super(`Ce dépôt n’est pas un projet AgentLake : ${detail}`);
    this.name = 'NotAProjectError';
  }
}

async function readProjectLimits(github: GitHubPort, ref: RepoRef) {
  const file = await github.getFile(ref, PROJECT_CONFIG, MAIN);
  if (!file) throw new NotAProjectError(`${PROJECT_CONFIG} absent de ${MAIN}.`);
  const parsed = ProjectConfigSchema.safeParse(parse(file.content));
  if (!parsed.success) throw new NotAProjectError(`${PROJECT_CONFIG} est invalide.`);
  return parsed.data.limits;
}

async function readTasks(github: GitHubPort, ref: RepoRef, log: (l: string) => void) {
  const issues = await github.listIssues(ref, { labels: [TASK_LABEL], state: 'all' });
  const views: TaskView[] = [];
  for (const issue of issues) {
    const parsed = parseTaskIssueBody(issue.body);
    if (!parsed.ok) {
      log(`#${String(issue.number)} ignorée : ${parsed.error}`);
      continue;
    }
    const state = issue.labels.map(parseStateLabel).find((s) => s !== undefined) ?? null;
    views.push({
      number: issue.number,
      task: parsed.value,
      open: issue.state === 'open',
      state,
      meta: readDispatchMeta(issue.body),
    });
  }
  return { views, bodies: new Map(issues.map((i) => [i.number, i.body])) };
}

async function readMergedTaskIds(github: GitHubPort, ref: RepoRef): Promise<Set<string>> {
  const prs = await github.listPullRequests(ref, { state: 'closed' });
  return new Set(
    prs
      .filter((pr) => pr.state === 'merged')
      .map((pr) => PR_MARKER.exec(pr.body)?.[1])
      .filter((id): id is string => id !== undefined),
  );
}

async function readAgentRuns(github: GitHubPort, ref: RepoRef): Promise<AgentRun[]> {
  const runs = await github.listWorkflowRuns(ref, { workflow: AGENT_WORKFLOW });
  return runs.flatMap((run) => {
    const parsed = parseAgentRunTitle(run.title ?? '');
    return parsed ? [{ ...parsed, completed: run.status === 'completed' }] : [];
  });
}

async function estimates(github: GitHubPort, ref: RepoRef, profiles: Iterable<ProfileId>) {
  const result = new Map<ProfileId, number>();
  for (const id of new Set(profiles)) {
    const file = await github.getFile(ref, profilePath(id), MAIN);
    const loaded = file ? loadAgentProfile(file.content, id) : null;
    result.set(id, loaded?.ok ? loaded.value.estimatedMinutes : DEFAULT_ESTIMATE_MINUTES);
  }
  return result;
}

const WAITING_STATES: readonly (TaskState | null)[] = [
  'queued',
  'ready',
  'waiting-editor',
  'fixing',
];

export interface DispatchResult {
  plan: PassPlan;
  /** Actions effectivement appliquées (un lancement en échec n'y figure pas). */
  applied: PassAction[];
}

/**
 * Tâches en attente de réponse : marque celles dont la question a reçu une réponse valide
 * (propriétaire, bon identifiant) et poste un rappel unique passé le délai, sans autre action.
 */
async function readQuestionThreads(
  ref: RepoRef,
  views: TaskView[],
  reminderHours: number,
  deps: DispatcherDeps,
): Promise<void> {
  for (const view of views) {
    if (!view.open || view.state !== 'awaiting-answer') continue;
    const thread = readThread(await deps.github.listComments(ref, view.number), ref.owner);
    const label = `#${String(view.number)} ${view.task.id}`;
    if (thread.answer !== null) {
      view.answered = true;
      deps.log(`${label} : réponse à ${thread.answer.id} reçue, reprise.`);
    } else if (reminderDue(thread, deps.now(), reminderHours)) {
      await deps.github.createComment(
        ref,
        view.number,
        reminderComment(ref.owner, thread.pending.question, reminderHours),
      );
      deps.log(`${label} : rappel posté pour ${thread.pending.question.id}.`);
    }
  }
}

/** Une passe complète : lit l'état sur GitHub, décide, applique. */
export async function runDispatch(ref: RepoRef, deps: DispatcherDeps): Promise<DispatchResult> {
  const { github, log } = deps;
  const limits = await readProjectLimits(github, ref);
  const [{ views, bodies }, mergedTaskIds, runs, global, minutes] = await Promise.all([
    readTasks(github, ref, log),
    readMergedTaskIds(github, ref),
    readAgentRuns(github, ref),
    deps.globalCap(),
    deps.minutesRemaining(),
  ]);
  if (global.note) log(global.note);
  if (minutes.note) log(minutes.note);
  await readQuestionThreads(ref, views, limits.answerReminderHours, deps);

  const gameWaiting = views.some(
    (v) => v.open && GAME_PROFILES.includes(v.task.profile) && WAITING_STATES.includes(v.state),
  );
  const bridgeHealthy = gameWaiting ? await deps.bridgeHealthy() : null;
  const costs =
    minutes.minutes === null
      ? new Map<ProfileId, number>()
      : await estimates(
          github,
          ref,
          views.filter((v) => v.open).map((v) => v.task.profile),
        );

  const plan = planPass({
    tasks: views,
    mergedTaskIds,
    runs,
    now: deps.now(),
    limits: {
      projectCap: limits.maxConcurrentAgents ?? null,
      globalCap: global.cap,
      runnerCap: DEFAULT_RUNNER_CAP,
      maxAttempts: limits.maxAttempts,
    },
    bridgeHealthy,
    minutesRemaining: minutes.minutes,
    estimateMinutes: (task) => costs.get(task.profile) ?? DEFAULT_ESTIMATE_MINUTES,
  });
  for (const line of plan.log) log(line);

  const applied: PassAction[] = [];
  for (const action of plan.actions) {
    if (await applyAction(ref, action, deps, bodies)) applied.push(action);
  }
  return { plan, applied };
}

async function applyAction(
  ref: RepoRef,
  action: PassAction,
  deps: DispatcherDeps,
  bodies: Map<number, string>,
): Promise<boolean> {
  const { github } = deps;
  switch (action.kind) {
    case 'promote':
      await setTaskState(github, ref, action.issue, 'ready');
      return true;
    case 'wait-editor':
      await setTaskState(github, ref, action.issue, 'waiting-editor');
      await github.createComment(
        ref,
        action.issue,
        `**En attente de l’éditeur** : la tâche ${action.taskId} a besoin du pont Aura. Ouvre l’éditeur sur le projet ${ref.repo} et active le pont depuis le cockpit ; la tâche repartira à la passe suivante.`,
      );
      return true;
    case 'dead':
      await github.createComment(
        ref,
        action.issue,
        `**Job d’agent mort** (tentative ${String(action.attempt)}) : ${action.reason}. La tâche est remise en file ; la tentative est comptée.`,
      );
      await setTaskState(github, ref, action.issue, 'fixing');
      return true;
    case 'escalate':
      await setTaskState(github, ref, action.issue, 'escalated');
      await github.createComment(
        ref,
        action.issue,
        `**Escaladée** : ${String(action.attempts)} tentatives sans succès pour ${action.taskId}. Une intervention de Kia est nécessaire.`,
      );
      return true;
    case 'launch':
      return launch(ref, action, deps, bodies);
  }
}

/**
 * Lancement idempotent : l'état « running » et le compteur sont posés avant le
 * workflow_dispatch, pour qu'une passe concurrente ne relance pas la tâche.
 * Si le lancement échoue, l'état précédent est restauré.
 */
async function launch(
  ref: RepoRef,
  action: Extract<PassAction, { kind: 'launch' }>,
  deps: DispatcherDeps,
  bodies: Map<number, string>,
): Promise<boolean> {
  const { github, log } = deps;
  const body = bodies.get(action.issue) ?? (await github.getIssue(ref, action.issue)).body;
  const previous = readDispatchMeta(body);
  const meta = {
    attempts: action.attempt,
    launchedAt: deps.now().toISOString(),
    resumes: previous.resumes + (action.resume === 'answer' ? 1 : 0),
  };
  await setTaskState(github, ref, action.issue, 'running');
  await github.updateIssue(ref, action.issue, { body: writeDispatchMeta(body, meta) });
  try {
    await github.dispatchWorkflow(ref, {
      workflow: AGENT_WORKFLOW,
      ref: MAIN,
      inputs: {
        issue_number: String(action.issue),
        profile: action.profile,
        attempt: String(action.attempt),
        resume_reason: action.resume,
      },
    });
    return true;
  } catch (error) {
    await github.updateIssue(ref, action.issue, { body });
    await setTaskState(github, ref, action.issue, action.from);
    log(
      `#${String(action.issue)} ${action.taskId} : lancement en échec, état ${stateLabel(action.from)} restauré (${error instanceof Error ? error.message : String(error)}).`,
    );
    return false;
  }
}
