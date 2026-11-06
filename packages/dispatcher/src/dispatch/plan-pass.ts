import {
  needsEditor,
  type DispatchMeta,
  type ProfileId,
  type TaskIssue,
  type TaskState,
} from 'shared';

/** Profils qui ont besoin de l'éditeur, donc du pont Aura. */
export const GAME_PROFILES: readonly ProfileId[] = ['unity', 'unreal'];

/** Délai au-delà duquel une tâche « running » sans run d'agent visible est jugée morte. */
export const DEAD_JOB_GRACE_MS = 15 * 60_000;

/** Une issue de tâche, telle que lue sur GitHub. */
export interface TaskView {
  number: number;
  task: TaskIssue;
  open: boolean;
  /** Label d'état ; null si aucun (issue fermée, ou label retiré à la main). */
  state: TaskState | null;
  meta: Pick<DispatchMeta, 'attempts' | 'launchedAt'> & Partial<DispatchMeta>;
  /** En attente de réponse (ou escaladée) et une réponse valide est arrivée. */
  answered?: boolean;
  /** PR d'agent ouverte pour la tâche, avec les checks en échec de son dernier commit. */
  pr?: OpenPullRequest;
}

export interface OpenPullRequest {
  number: number;
  head: string;
  headSha: string;
  failedChecks: readonly string[];
}

/** Un run du workflow d'agent, relié à son issue par son titre. */
export interface AgentRun {
  issueNumber: number;
  attempt: number;
  completed: boolean;
}

export interface PassLimits {
  /** C_projet (`.agentlake/project.yml`), null si absent. */
  projectCap: number | null;
  /** C_global (dépôt devlake-config). */
  globalCap: number;
  /** C_runners : jobs simultanés permis par GitHub. */
  runnerCap: number;
  maxAttempts: number;
}

export interface PassInput {
  tasks: readonly TaskView[];
  /** Tâches dont une PR d'agent a été mergée. */
  mergedTaskIds: ReadonlySet<string>;
  /** Numéro de la PR mergée de chaque tâche (résumé après merge). */
  mergedPrs?: ReadonlyMap<string, number>;
  runs: readonly AgentRun[];
  now: Date;
  limits: PassLimits;
  /** Santé du pont : null si elle n'a pas été vérifiée (aucune tâche de jeu en attente). */
  bridgeHealthy: boolean | null;
  /** Minutes Actions restantes ; null = non limité (dépôt public ou inconnu). */
  minutesRemaining: number | null;
  /** Coût estimé d'une tâche, en minutes (profil). */
  estimateMinutes: (task: TaskIssue) => number;
  /**
   * Checks obligatoires de la CI vus verts sur `main` : tant que ce n'est pas le cas, seule
   * la tâche bootstrap peut partir. Absent = non vérifié (aucun blocage).
   */
  mainChecks?: { ready: boolean; missing: readonly string[] };
  /** Projet en pause (variable AGENTLAKE_PAUSED) : aucun lancement. */
  paused?: boolean;
}

export type ResumeKind = 'none' | 'ci-failure' | 'answer';

export type PassAction =
  | { kind: 'promote'; issue: number; taskId: string; from: TaskState }
  | { kind: 'wait-editor'; issue: number; taskId: string }
  | { kind: 'dead'; issue: number; taskId: string; attempt: number; reason: string }
  | { kind: 'escalate'; issue: number; taskId: string; attempts: number }
  | {
      kind: 'ci-failed';
      issue: number;
      taskId: string;
      prNumber: number;
      sha: string;
      checks: readonly string[];
    }
  | {
      kind: 'launch';
      issue: number;
      taskId: string;
      profile: ProfileId;
      attempt: number;
      resume: ResumeKind;
      from: TaskState;
      /** Commit de la PR dont l'échec est corrigé par ce lancement (pas de seconde détection). */
      failedSha: string | null;
      /** La tâche passe par l'éditeur : verrou d'éditeur côté workflow. */
      needsEditor: boolean;
    }
  | { kind: 'summarize'; issue: number; taskId: string; prNumber: number };

export interface PassPlan {
  actions: PassAction[];
  /** Explications pour le journal du run. */
  log: string[];
  capacity: number;
}

/** Tâche qui passe par l'éditeur (pont Aura) ; le code pur C#/C++ n'en fait pas partie. */
export function isGameTask(task: TaskIssue): boolean {
  return needsEditor(task);
}

/** Tâche bootstrap du plan : l'architecte, sans dépendance ; elle pose la CI. */
export function isBootstrapTask(task: TaskIssue): boolean {
  return task.profile === 'architect' && task.dependencies.length === 0;
}

/**
 * Hauteur de chaque tâche ouverte dans le graphe : longueur du plus long chemin de tâches
 * ouvertes qui en dépendent. Le chemin critique passe par les plus hautes.
 */
export function criticalHeights(tasks: readonly TaskView[]): Map<string, number> {
  const open = tasks.filter((t) => t.open);
  const dependents = new Map<string, string[]>();
  for (const t of open)
    for (const dep of t.task.dependencies)
      dependents.set(dep, [...(dependents.get(dep) ?? []), t.task.id]);
  const heights = new Map<string, number>();
  const visiting = new Set<string>();
  const height = (id: string): number => {
    const known = heights.get(id);
    if (known !== undefined) return known;
    // Un cycle (plan corrompu) ne doit pas faire boucler la passe.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const h = 1 + Math.max(0, ...(dependents.get(id) ?? []).map(height));
    visiting.delete(id);
    heights.set(id, h);
    return h;
  };
  for (const t of open) height(t.task.id);
  return heights;
}

/** Dépendances satisfaites : chaque dépendance est fermée par une PR mergée. */
export function dependenciesMerged(
  view: TaskView,
  byId: ReadonlyMap<string, TaskView>,
  merged: ReadonlySet<string>,
): boolean {
  return view.task.dependencies.every((dep) => {
    const other = byId.get(dep);
    return other !== undefined && !other.open && merged.has(dep);
  });
}

function deadReason(view: TaskView, input: PassInput): string | null {
  const attempt = view.meta.attempts;
  const run = input.runs.find((r) => r.issueNumber === view.number && r.attempt === attempt);
  if (run?.completed)
    return `run d’agent de la tentative ${String(attempt)} terminé sans mise à jour de l’issue`;
  if (run) return null;
  const launched = view.meta.launchedAt === null ? Number.NaN : Date.parse(view.meta.launchedAt);
  if (Number.isNaN(launched)) return null;
  return input.now.getTime() - launched > DEAD_JOB_GRACE_MS
    ? `aucun run d’agent ${String(DEAD_JOB_GRACE_MS / 60_000)} minutes après le lancement`
    : null;
}

/**
 * Passe du dispatcher, sans effet de bord : décide quelles tâches promouvoir, lancer,
 * mettre en attente de l'éditeur, remettre en file ou escalader.
 */
export function planPass(input: PassInput): PassPlan {
  const actions: PassAction[] = [];
  const log: string[] = [];
  const byId = new Map(input.tasks.map((t) => [t.task.id, t]));
  const effective = new Map<number, TaskState | null>(input.tasks.map((t) => [t.number, t.state]));

  // 1. Tâches livrées (PR ouverte) : la CI de la PR décide. Un check en échec sur un
  //    commit pas encore traité renvoie la tâche en correction.
  for (const view of input.tasks) {
    const pr = view.pr;
    if (!view.open || view.state !== 'running' || pr === undefined) continue;
    if (pr.failedChecks.length === 0 || pr.headSha === view.meta.failedSha) continue;
    actions.push({
      kind: 'ci-failed',
      issue: view.number,
      taskId: view.task.id,
      prNumber: pr.number,
      sha: pr.headSha,
      checks: pr.failedChecks,
    });
    effective.set(view.number, 'fixing');
    log.push(
      `#${String(view.number)} ${view.task.id} : CI de la PR #${String(pr.number)} en échec (${pr.failedChecks.join(', ')}), correction.`,
    );
  }

  // 2. Jobs morts : run terminé (ou jamais apparu) alors que l'issue est toujours « running »,
  //    sans PR livrée.
  for (const view of input.tasks) {
    if (!view.open || view.state !== 'running' || view.pr !== undefined) continue;
    if (view.meta.attempts === 0) {
      log.push(
        `#${String(view.number)} ${view.task.id} : running sans lancement du dispatcher, ignorée.`,
      );
      continue;
    }
    const reason = deadReason(view, input);
    if (reason === null) continue;
    actions.push({
      kind: 'dead',
      issue: view.number,
      taskId: view.task.id,
      attempt: view.meta.attempts,
      reason,
    });
    effective.set(view.number, 'fixing');
    log.push(`#${String(view.number)} ${view.task.id} : job mort (${reason}), remise en file.`);
  }

  // Une tâche livrée garde ses ressources jusqu'au merge, mais n'occupe plus d'agent.
  const running = input.tasks.filter((t) => t.open && effective.get(t.number) === 'running');
  const occupied = new Set(running.flatMap((t) => t.task.exclusiveResources));
  const agents = running.filter((t) => t.pr === undefined).length;

  // 3. Après merge : résumé de la tâche, une fois.
  for (const view of input.tasks) {
    if (view.open || view.meta.attempts === 0 || view.meta.summarized === true) continue;
    const prNumber = input.mergedPrs?.get(view.task.id);
    if (prNumber === undefined) continue;
    actions.push({ kind: 'summarize', issue: view.number, taskId: view.task.id, prNumber });
  }

  // 4. Tâches en file dont les dépendances sont mergées.
  for (const view of input.tasks) {
    if (!view.open || effective.get(view.number) !== 'queued') continue;
    if (!dependenciesMerged(view, byId, input.mergedTaskIds)) continue;
    actions.push({ kind: 'promote', issue: view.number, taskId: view.task.id, from: 'queued' });
    effective.set(view.number, 'ready');
  }

  // 5. Candidates, par chemin critique puis numéro d'issue.
  const heights = criticalHeights(input.tasks);
  const candidates = input.tasks
    .filter((t) => {
      const state = effective.get(t.number);
      return (
        t.open &&
        (state === 'ready' ||
          state === 'waiting-editor' ||
          state === 'fixing' ||
          ((state === 'awaiting-answer' || state === 'escalated') && t.answered === true))
      );
    })
    .sort(
      (a, b) =>
        (heights.get(b.task.id) ?? 0) - (heights.get(a.task.id) ?? 0) || a.number - b.number,
    );

  const { projectCap, globalCap, runnerCap } = input.limits;
  const cap = Math.min(projectCap ?? Number.POSITIVE_INFINITY, globalCap, runnerCap);
  let capacity = Math.max(0, cap - agents);
  let minutes = input.minutesRemaining;
  log.push(
    `Capacité : min(projet ${projectCap === null ? '—' : String(projectCap)}, global ${String(globalCap)}, runners ${String(runnerCap)}) − ${String(agents)} en cours = ${String(capacity)}.`,
  );

  for (const view of candidates) {
    const state = effective.get(view.number) as TaskState;
    const label = `#${String(view.number)} ${view.task.id}`;
    // Les reprises après réponse ne sont pas des échecs : elles ne comptent pas.
    const failures = view.meta.attempts - (view.meta.resumes ?? 0);
    if (state === 'fixing' && failures >= input.limits.maxAttempts) {
      actions.push({
        kind: 'escalate',
        issue: view.number,
        taskId: view.task.id,
        attempts: view.meta.attempts,
      });
      log.push(`${label} : ${String(view.meta.attempts)} tentatives, escaladée.`);
      continue;
    }
    if (input.paused === true) {
      log.push(`${label} : projet en pause, pas de lancement.`);
      continue;
    }
    if (input.mainChecks?.ready === false && !isBootstrapTask(view.task)) {
      log.push(
        `${label} : checks obligatoires pas encore verts sur main (${input.mainChecks.missing.join(', ')}).`,
      );
      continue;
    }
    if (capacity === 0) {
      log.push(`${label} : en attente de capacité.`);
      continue;
    }
    const busy = view.task.exclusiveResources.filter((r) => occupied.has(r));
    if (busy.length > 0) {
      log.push(`${label} : ressource exclusive occupée (${busy.join(', ')}).`);
      continue;
    }
    if (isGameTask(view.task) && input.bridgeHealthy !== true) {
      if (state === 'ready')
        actions.push({ kind: 'wait-editor', issue: view.number, taskId: view.task.id });
      log.push(`${label} : pont Aura indisponible, en attente de l’éditeur.`);
      continue;
    }
    const estimate = input.estimateMinutes(view.task);
    if (minutes !== null && estimate > minutes) {
      log.push(
        `${label} : minutes Actions insuffisantes (${String(minutes)} restantes, ${String(estimate)} estimées).`,
      );
      continue;
    }
    let from = state;
    if (state === 'waiting-editor') {
      actions.push({
        kind: 'promote',
        issue: view.number,
        taskId: view.task.id,
        from: 'waiting-editor',
      });
      from = 'ready';
    }
    actions.push({
      kind: 'launch',
      issue: view.number,
      taskId: view.task.id,
      profile: view.task.profile,
      attempt: view.meta.attempts + 1,
      resume: state === 'fixing' ? 'ci-failure' : view.answered === true ? 'answer' : 'none',
      from,
      failedSha: state === 'fixing' ? (view.pr?.headSha ?? null) : null,
      needsEditor: isGameTask(view.task),
    });
    effective.set(view.number, 'running');
    for (const r of view.task.exclusiveResources) occupied.add(r);
    capacity -= 1;
    if (minutes !== null) minutes -= estimate;
    log.push(
      `${label} : lancée (profil ${view.task.profile}, tentative ${String(view.meta.attempts + 1)}).`,
    );
  }
  return { actions, log, capacity };
}
