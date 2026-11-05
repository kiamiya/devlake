import type { PlanTask, ProfileId } from 'shared';

/** Couleur de chaque profil, dans l'arborescence comme dans le graphe. */
export const PROFILE_COLORS: Record<ProfileId, string> = {
  architect: '#6d28d9',
  frontend: '#2563eb',
  backend: '#0f766e',
  data: '#b45309',
  mobile: '#be185d',
  devops: '#475569',
  qa: '#15803d',
  unity: '#7c3aed',
  unreal: '#1d4ed8',
  reviewer: '#9f1239',
  docs: '#57534e',
};

/** Profondeur de chaque tâche (plus long chemin depuis une tâche sans dépendance), pour le graphe. */
export function depths(
  tasks: readonly Pick<PlanTask, 'id' | 'dependencies'>[],
): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const visit = (id: string, path: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (path.has(id)) return 0; // Cycle : la validation le refuse ailleurs.
    path.add(id);
    const deps = (byId.get(id)?.dependencies ?? []).filter((d) => byId.has(d));
    const depth = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => visit(d, path)));
    path.delete(id);
    memo.set(id, depth);
    return depth;
  };
  for (const task of tasks) visit(task.id, new Set());
  return memo;
}
