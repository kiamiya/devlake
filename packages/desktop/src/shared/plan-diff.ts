import type { PlanTask, ProjectPlan } from 'shared';

export interface PlanDiff {
  added: string[];
  removed: string[];
  changed: { id: string; fields: (keyof PlanTask)[] }[];
  /** Nombre d'agents proposé avant → après, s'il change. */
  agents: { before: number; after: number } | null;
}

const FIELDS: (keyof PlanTask)[] = [
  'title',
  'description',
  'kind',
  'profile',
  'complexity',
  'acceptanceCriteria',
  'requiredTests',
  'codeZones',
  'exclusiveResources',
  'dependencies',
  'epic',
  'milestone',
];

/** Différences entre deux versions d'un plan, tâche par tâche. */
export function planDiff(before: ProjectPlan, after: ProjectPlan): PlanDiff {
  const old = new Map(before.tasks.map((t) => [t.id, t]));
  const next = new Map(after.tasks.map((t) => [t.id, t]));
  const changed: PlanDiff['changed'] = [];
  for (const [id, task] of next) {
    const previous = old.get(id);
    if (!previous) continue;
    const fields = FIELDS.filter((f) => JSON.stringify(previous[f]) !== JSON.stringify(task[f]));
    if (fields.length > 0) changed.push({ id, fields });
  }
  return {
    added: [...next.keys()].filter((id) => !old.has(id)),
    removed: [...old.keys()].filter((id) => !next.has(id)),
    changed,
    agents:
      before.proposedAgents === after.proposedAgents
        ? null
        : { before: before.proposedAgents, after: after.proposedAgents },
  };
}
