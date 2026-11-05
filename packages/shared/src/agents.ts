import type { PlanTask } from './plan.js';

/** Jobs simultanés permis par GitHub Actions sur un compte gratuit (C_runners). */
export const DEFAULT_RUNNER_CAP = 20;

export interface AgentCaps {
  /** C_runners : jobs simultanés permis par GitHub. */
  runners: number;
  /** C_global : plafond des réglages du cockpit, tous projets confondus. */
  global: number;
  /** C_projet : plafond facultatif du projet (project.yml). */
  project?: number;
}

export interface AgentProposal {
  /** N = min(L_DAG, C_runners, C_global, C_projet). */
  agents: number;
  /** L_DAG : tâches exécutables en même temps, ressources exclusives comprises. */
  width: number;
  /** Une plus grande famille de tâches indépendantes (plus grande antichaîne). */
  antichain: string[];
}

type Task = Pick<PlanTask, 'id' | 'dependencies' | 'exclusiveResources'>;

/** Fermeture transitive : before[i][j] vrai si la tâche i doit finir avant la tâche j. */
function transitiveOrder(tasks: readonly Task[]): boolean[][] {
  const index = new Map(tasks.map((t, i) => [t.id, i]));
  const n = tasks.length;
  const before = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  tasks.forEach((task, j) => {
    for (const dep of task.dependencies) {
      const i = index.get(dep);
      if (i !== undefined && i !== j) (before[i] ?? [])[j] = true;
    }
  });
  for (let k = 0; k < n; k += 1) {
    for (let i = 0; i < n; i += 1) {
      if (!before[i]?.[k]) continue;
      for (let j = 0; j < n; j += 1) if (before[k]?.[j]) (before[i] ?? [])[j] = true;
    }
  }
  return before;
}

/**
 * Plus grande antichaîne (Dilworth / König) : couplage maximum dans le graphe biparti
 * de l'ordre, puis couverture minimale ; les sommets hors couverture forment l'antichaîne.
 */
export function maximumAntichain(tasks: readonly Task[]): string[] {
  const n = tasks.length;
  const before = transitiveOrder(tasks);
  const matchOfRight = new Array<number>(n).fill(-1);
  const matchOfLeft = new Array<number>(n).fill(-1);

  const augment = (left: number, seen: boolean[]): boolean => {
    for (let right = 0; right < n; right += 1) {
      if (!before[left]?.[right] || seen[right]) continue;
      seen[right] = true;
      const current = matchOfRight[right] ?? -1;
      if (current === -1 || augment(current, seen)) {
        matchOfRight[right] = left;
        matchOfLeft[left] = right;
        return true;
      }
    }
    return false;
  };
  for (let left = 0; left < n; left += 1) augment(left, new Array<boolean>(n).fill(false));

  // König : sommets atteignables depuis les gauches non couplés par chemins alternés.
  const reachedLeft = new Array<boolean>(n).fill(false);
  const reachedRight = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  for (let left = 0; left < n; left += 1) {
    if (matchOfLeft[left] === -1) {
      reachedLeft[left] = true;
      stack.push(left);
    }
  }
  while (stack.length > 0) {
    const left = stack.pop() ?? 0;
    for (let right = 0; right < n; right += 1) {
      if (!before[left]?.[right] || reachedRight[right]) continue;
      reachedRight[right] = true;
      const next = matchOfRight[right] ?? -1;
      if (next !== -1 && !reachedLeft[next]) {
        reachedLeft[next] = true;
        stack.push(next);
      }
    }
  }
  // Couverture = (gauches non atteints) ∪ (droites atteintes) ; antichaîne = hors couverture des deux côtés.
  return tasks.filter((_, i) => reachedLeft[i] && !reachedRight[i]).map((t) => t.id);
}

/** Les tâches qui partagent une ressource exclusive ne tournent jamais ensemble : elles comptent pour une. */
function collapseExclusive(tasks: readonly Task[]): number {
  const parent = new Map(tasks.map((t) => [t.id, t.id]));
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const owner = new Map<string, string>();
  for (const task of tasks) {
    for (const resource of task.exclusiveResources) {
      const other = owner.get(resource);
      if (other === undefined) owner.set(resource, task.id);
      else parent.set(find(task.id), find(other));
    }
  }
  return new Set(tasks.map((t) => find(t.id))).size;
}

/** Nombre d'agents proposé, calculé de façon déterministe (jamais par le modèle). */
export function proposeAgents(tasks: readonly Task[], caps: AgentCaps): AgentProposal {
  const antichain = maximumAntichain(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const width = Math.max(
    1,
    collapseExclusive(
      antichain.map((id) => byId.get(id)).filter((t): t is Task => t !== undefined),
    ),
  );
  const agents = Math.max(
    1,
    Math.min(width, caps.runners, caps.global, caps.project ?? Number.POSITIVE_INFINITY),
  );
  return { agents, width, antichain };
}
