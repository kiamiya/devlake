import type { GitHubPort, PullRequest, RepoRef, WorkflowRun } from 'github';
import {
  ciChecksFor,
  DEFAULT_RUNNER_CAP,
  loadAgentProfile,
  parseStateLabel,
  parseTaskIssueBody,
  profilePath,
  ProjectConfigSchema,
  readDispatchMeta,
  renderQuestionComment,
  stateLabel,
  TASK_LABEL,
  writeDispatchMeta,
  type DispatchMeta,
  type ProfileId,
  type ProjectConfig,
  type TaskState,
} from 'shared';
import { parse } from 'yaml';
import { setTaskState } from '../agent-context/resume.js';
import { guardDecision, isGuardQuestion, REFUSE } from '../quality/guard.js';
import { analyzeTestChanges } from '../quality/test-files.js';
import {
  readThread,
  reminderComment,
  reminderDue,
  type PostedQuestion,
} from '../questions/thread.js';
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
/** Workflow d'appel de la porte qualité (relecture, garde des tests). */
export const REVIEW_WORKFLOW = 'agentlake-review.yml';
export const PROJECT_CONFIG = '.agentlake/project.yml';
const MAIN = 'main';
/** Coût par défaut d'une tâche dont le profil est illisible. */
export const DEFAULT_ESTIMATE_MINUTES = 30;
/** Conclusions de check qui comptent comme un échec. */
const FAILED_CONCLUSIONS = [
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
];

/** Titre des runs d'agent (`run-name` du workflow d'appel) : relie un run à son issue. */
export function agentRunTitle(issueNumber: number, attempt: number): string {
  return `AgentLake — agent, issue #${String(issueNumber)}, tentative ${String(attempt)}`;
}

export function parseAgentRunTitle(title: string): { issueNumber: number; attempt: number } | null {
  const match = /issue #(\d+), tentative (\d+)/.exec(title);
  return match ? { issueNumber: Number(match[1]), attempt: Number(match[2]) } : null;
}

const PR_MARKER = /<!-- agentlake:pr task=(T\d+) /;
const prTask = (pr: PullRequest) => PR_MARKER.exec(pr.body)?.[1];

export interface GlobalCap {
  cap: number;
  /** Explication si la valeur par défaut a été appliquée. */
  note?: string;
}

export interface DispatcherDeps {
  github: GitHubPort;
  globalCap: () => Promise<GlobalCap>;
  /** Santé du pont Aura (GET /health). */
  bridgeHealthy: (editor: 'unity' | 'unreal') => Promise<boolean>;
  /** Minutes Actions restantes ; null = non limité. */
  minutesRemaining: () => Promise<{ minutes: number | null; note?: string }>;
  now: () => Date;
  log: (line: string) => void;
  /** Projet en pause (variable AGENTLAKE_PAUSED du dépôt). */
  paused?: boolean;
}

export class NotAProjectError extends Error {
  constructor(detail: string) {
    super(`Ce dépôt n’est pas un projet AgentLake : ${detail}`);
    this.name = 'NotAProjectError';
  }
}

async function readProject(github: GitHubPort, ref: RepoRef): Promise<ProjectConfig> {
  const file = await github.getFile(ref, PROJECT_CONFIG, MAIN);
  if (!file) throw new NotAProjectError(`${PROJECT_CONFIG} absent de ${MAIN}.`);
  const parsed = ProjectConfigSchema.safeParse(parse(file.content));
  if (!parsed.success) throw new NotAProjectError(`${PROJECT_CONFIG} est invalide.`);
  return parsed.data;
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

/** PR d'agent, ouvertes et mergées, par tâche. */
async function readAgentPullRequests(github: GitHubPort, ref: RepoRef) {
  const open = new Map<string, PullRequest>();
  const merged = new Map<string, number>();
  for (const pr of await github.listPullRequests(ref, { state: 'all' })) {
    const task = prTask(pr);
    if (task === undefined) continue;
    if (pr.state === 'open') open.set(task, pr);
    if (pr.state === 'merged') merged.set(task, pr.number);
  }
  return { open, merged };
}

async function readAgentRuns(github: GitHubPort, ref: RepoRef) {
  const runs = await github.listWorkflowRuns(ref, { workflow: AGENT_WORKFLOW });
  const agentRuns: (AgentRun & { minutes: number })[] = runs.flatMap((run) => {
    const parsed = parseAgentRunTitle(run.title ?? '');
    return parsed
      ? [{ ...parsed, completed: run.status === 'completed', minutes: runMinutes(run) }]
      : [];
  });
  return agentRuns;
}

function runMinutes(run: WorkflowRun): number {
  if (run.updatedAt === undefined) return 0;
  return Math.max(0, (Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 60_000);
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

/** Checks de la CI du profil vus verts sur le dernier commit de `main`. */
async function readMainChecks(github: GitHubPort, ref: RepoRef, project: ProjectConfig) {
  const runs = await github.listCheckRuns(ref, MAIN);
  const passed = new Set(
    runs.filter((r) => r.status === 'completed' && r.conclusion === 'success').map((r) => r.name),
  );
  const missing = ciChecksFor(project.qualityProfile).filter((name) => !passed.has(name));
  return { ready: missing.length === 0, missing };
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

interface PassContext {
  ref: RepoRef;
  deps: DispatcherDeps;
  bodies: Map<number, string>;
  openPrs: Map<string, PullRequest>;
  agentRuns: (AgentRun & { minutes: number })[];
}

/**
 * Tâches en attente de réponse ou escaladées : une réponse valide (propriétaire, bon
 * identifiant) relance l'agent ; une réponse à la garde des tests relance le check
 * (« Autoriser ») ou renvoie en correction (« Refuser ») ; sinon rappel unique passé le délai.
 */
async function readQuestionThreads(
  views: TaskView[],
  reminderHours: number,
  ctx: PassContext,
): Promise<void> {
  const { ref, deps } = ctx;
  for (const view of views) {
    if (!view.open || (view.state !== 'awaiting-answer' && view.state !== 'escalated')) continue;
    const thread = readThread(await deps.github.listComments(ref, view.number), ref.owner);
    const label = `#${String(view.number)} ${view.task.id}`;
    if (thread.answer !== null && thread.pending !== null) {
      if (isGuardQuestion(thread.pending.question.id)) {
        await answerGuard(view, thread.pending, thread.answer.text, ctx);
        continue;
      }
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

/** Réponse de Kia à la garde des tests : relance du check, ou correction pour restaurer les tests. */
async function answerGuard(
  view: TaskView,
  question: PostedQuestion,
  answer: string,
  ctx: PassContext,
): Promise<void> {
  const { ref, deps } = ctx;
  const label = `#${String(view.number)} ${view.task.id}`;
  const pr = ctx.openPrs.get(view.task.id);
  const decision = guardDecision(answer);
  if (decision === 'authorized' && pr) {
    const runs = await deps.github.listWorkflowRuns(ref, {
      workflow: REVIEW_WORKFLOW,
      branch: pr.head,
    });
    const latest = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    // Cet échec est traité : la tâche reste livrée, le check est rejoué.
    await updateMeta(ctx, view.number, { failedSha: pr.headSha });
    await setTaskState(deps.github, ref, view.number, 'running');
    view.state = 'running';
    view.meta = { ...view.meta, failedSha: pr.headSha };
    if (latest) await deps.github.rerunFailedJobs(ref, latest.id);
    deps.log(
      `${label} : modification des tests autorisée (${question.question.id}), check relancé.`,
    );
    return;
  }
  // Refus, réponse illisible ou PR disparue : l'agent reprend pour restaurer les tests.
  await deps.github.createComment(
    ref,
    view.number,
    decision === 'authorized'
      ? `**Garde des tests** : autorisation reçue, mais aucune PR ouverte pour ${view.task.id} ; la tâche repart en correction.`
      : `**Tests à restaurer** : ${decision === 'refused' ? 'Kia a refusé' : `réponse non reconnue (attendu « Autoriser » ou « ${REFUSE} »), considérée comme un refus de`} la modification des tests existants. Restaure-les tels qu’ils sont sur \`main\`, puis corrige le code pour qu’ils passent.`,
  );
  await setTaskState(deps.github, ref, view.number, 'fixing');
  view.state = 'fixing';
  deps.log(`${label} : modification des tests refusée, correction.`);
}

async function updateMeta(
  ctx: PassContext,
  issue: number,
  patch: Partial<DispatchMeta>,
): Promise<void> {
  const body = ctx.bodies.get(issue) ?? (await ctx.deps.github.getIssue(ctx.ref, issue)).body;
  const next = writeDispatchMeta(body, { ...readDispatchMeta(body), ...patch });
  await ctx.deps.github.updateIssue(ctx.ref, issue, { body: next });
  ctx.bodies.set(issue, next);
}

/** Une passe complète : lit l'état sur GitHub, décide, applique. */
export async function runDispatch(ref: RepoRef, deps: DispatcherDeps): Promise<DispatchResult> {
  const { github, log } = deps;
  const project = await readProject(github, ref);
  const limits = project.limits;
  const [{ views, bodies }, prs, agentRuns, global, minutes, mainChecks] = await Promise.all([
    readTasks(github, ref, log),
    readAgentPullRequests(github, ref),
    readAgentRuns(github, ref),
    deps.globalCap(),
    deps.minutesRemaining(),
    readMainChecks(github, ref, project),
  ]);
  if (global.note) log(global.note);
  if (minutes.note) log(minutes.note);
  const ctx: PassContext = { ref, deps, bodies, openPrs: prs.open, agentRuns };
  await readQuestionThreads(views, limits.answerReminderHours, ctx);

  // PR livrées des tâches en cours : checks du dernier commit.
  for (const view of views) {
    const pr = prs.open.get(view.task.id);
    if (!view.open || pr === undefined) continue;
    const checks = view.state === 'running' ? await github.listCheckRuns(ref, pr.headSha) : [];
    view.pr = {
      number: pr.number,
      head: pr.head,
      headSha: pr.headSha,
      failedChecks: checks
        .filter((c) => c.status === 'completed' && FAILED_CONCLUSIONS.includes(c.conclusion ?? ''))
        .map((c) => c.name),
    };
  }

  const gameWaiting = views.some(
    (v) => v.open && GAME_PROFILES.includes(v.task.profile) && WAITING_STATES.includes(v.state),
  );
  // Éditeur du projet : celui du type de projet, à défaut celui de la première tâche de jeu.
  const editor =
    project.type === 'unity' || project.type === 'unreal'
      ? project.type
      : (views.find((v) => v.task.profile === 'unity' || v.task.profile === 'unreal')?.task
          .profile ?? 'unity');
  const bridgeHealthy = gameWaiting
    ? await deps.bridgeHealthy(editor === 'unreal' ? 'unreal' : 'unity')
    : null;
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
    mergedTaskIds: new Set(prs.merged.keys()),
    mergedPrs: prs.merged,
    runs: agentRuns,
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
    mainChecks,
    paused: deps.paused === true,
  });
  if (deps.paused === true) log('Projet en pause (AGENTLAKE_PAUSED) : aucun agent ne sera lancé.');
  for (const line of plan.log) log(line);

  const applied: PassAction[] = [];
  for (const action of plan.actions) {
    if (await applyAction(action, ctx)) applied.push(action);
  }
  return { plan, applied };
}

async function applyAction(action: PassAction, ctx: PassContext): Promise<boolean> {
  const { ref, deps } = ctx;
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
    case 'ci-failed':
      await github.createComment(
        ref,
        action.issue,
        `**CI en échec** sur la PR #${String(action.prNumber)} (${action.checks.join(', ')}). L’agent reprend avec les extraits des journaux.`,
      );
      await setTaskState(github, ref, action.issue, 'fixing');
      return true;
    case 'escalate':
      await escalate(action, ctx);
      return true;
    case 'summarize':
      await summarize(action, ctx);
      return true;
    case 'launch':
      return launch(action, ctx);
  }
}

/** Escalade : état « escaladée » et question bloquante à Kia ; sa réponse relance l'agent. */
async function escalate(
  action: Extract<PassAction, { kind: 'escalate' }>,
  ctx: PassContext,
): Promise<void> {
  const { ref, deps } = ctx;
  await setTaskState(deps.github, ref, action.issue, 'escalated');
  await deps.github.createComment(
    ref,
    action.issue,
    renderQuestionComment({
      id: `escalade-${action.taskId}-${String(action.attempts)}`,
      blocking: true,
      text: `La tâche ${action.taskId} a échoué ${String(action.attempts)} fois. Comment continuer ?`,
      context:
        'Les commentaires « CI en échec » et « Agent en échec » ci-dessus donnent le détail. Ta réponse est transmise à l’agent, qui reprend sur la même branche.',
      options: [
        'Relancer avec cette consigne : …',
        'Simplifier la tâche : …',
        'Abandonner (fermer l’issue à la main)',
      ],
    }),
  );
}

/** Résumé après merge : fichiers, tests ajoutés, tentatives, durée, minutes d'agent. */
async function summarize(
  action: Extract<PassAction, { kind: 'summarize' }>,
  ctx: PassContext,
): Promise<void> {
  const { ref, deps } = ctx;
  const body = ctx.bodies.get(action.issue) ?? (await deps.github.getIssue(ref, action.issue)).body;
  const meta = readDispatchMeta(body);
  const files = await deps.github.listPullRequestFiles(ref, action.prNumber);
  const tests = analyzeTestChanges(files);
  const minutes = ctx.agentRuns
    .filter((r) => r.issueNumber === action.issue)
    .reduce((sum, r) => sum + r.minutes, 0);
  const started = meta.firstLaunchedAt ?? meta.launchedAt;
  const hours = started === null ? null : (deps.now().getTime() - Date.parse(started)) / 3_600_000;
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  await deps.github.createComment(
    ref,
    action.issue,
    [
      `**Tâche ${action.taskId} mergée** (PR #${String(action.prNumber)})`,
      '',
      `- Fichiers : ${String(files.length)} (+${String(additions)} −${String(deletions)})`,
      `- Tests ajoutés ou complétés : ${tests.addedTests.length > 0 ? tests.addedTests.map((t) => `\`${t}\``).join(', ') : 'aucun'}`,
      `- Tentatives : ${String(meta.attempts)}${meta.resumes > 0 ? ` (dont ${String(meta.resumes)} reprise(s) après réponse)` : ''}`,
      `- Durée : ${hours === null ? 'inconnue' : `${hours.toFixed(1)} h depuis le premier lancement`}`,
      `- Minutes d’agent : ${String(Math.round(minutes))}`,
    ].join('\n'),
  );
  await updateMeta(ctx, action.issue, { summarized: true });
}

/**
 * Lancement idempotent : l'état « running » et le compteur sont posés avant le
 * workflow_dispatch, pour qu'une passe concurrente ne relance pas la tâche.
 * Si le lancement échoue, l'état précédent est restauré.
 */
async function launch(
  action: Extract<PassAction, { kind: 'launch' }>,
  ctx: PassContext,
): Promise<boolean> {
  const { ref, deps } = ctx;
  const { github, log } = deps;
  const body = ctx.bodies.get(action.issue) ?? (await github.getIssue(ref, action.issue)).body;
  const previous = readDispatchMeta(body);
  const now = deps.now().toISOString();
  const meta: DispatchMeta = {
    ...previous,
    attempts: action.attempt,
    launchedAt: now,
    firstLaunchedAt: previous.firstLaunchedAt ?? now,
    resumes: previous.resumes + (action.resume === 'answer' ? 1 : 0),
    failedSha: action.failedSha ?? previous.failedSha,
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
