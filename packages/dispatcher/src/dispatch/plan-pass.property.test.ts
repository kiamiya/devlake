import fc from 'fast-check';
import { makeTask } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import { planPass, type TaskView } from './plan-pass.js';

const RESOURCES = ['migrations', 'unity-editor', 'repository'];

/** Graphe aléatoire : chaque tâche ne dépend que de tâches de numéro inférieur (acyclique). */
const graph = fc.integer({ min: 1, max: 14 }).chain((n) =>
  fc.record({
    deps: fc.tuple(
      ...Array.from({ length: n }, (_, i) => fc.subarray(Array.from({ length: i }, (_, j) => j))),
    ),
    resources: fc.tuple(
      ...Array.from({ length: n }, () => fc.subarray(RESOURCES, { maxLength: 2 })),
    ),
    cap: fc.integer({ min: 1, max: 4 }),
    seed: fc.integer(),
  }),
);

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const id = (i: number) => `T${String(i + 1).padStart(2, '0')}`;

describe('propriétés du dispatcher sur graphes aléatoires', () => {
  it('ni dépendance violée, ni ressource partagée, ni plafond dépassé ; tout finit par être mergé', () => {
    fc.assert(
      fc.property(graph, ({ deps, resources, cap, seed }) => {
        const rand = random(seed);
        const now = new Date('2026-11-05T12:00:00Z');
        let tasks: TaskView[] = deps.map((d, i) => ({
          number: i + 1,
          task: makeTask({
            id: id(i),
            dependencies: d.map(id),
            exclusiveResources: resources[i] ?? [],
          }),
          open: true,
          state: 'queued',
          meta: { attempts: 0, launchedAt: null },
        }));
        const merged = new Set<string>();

        for (let pass = 0; pass < 200 && merged.size < tasks.length; pass++) {
          const plan = planPass({
            tasks,
            mergedTaskIds: merged,
            runs: [],
            now,
            limits: { projectCap: cap, globalCap: 3, runnerCap: 20, maxAttempts: 3 },
            bridgeHealthy: true,
            minutesRemaining: null,
            estimateMinutes: () => 10,
          });
          for (const action of plan.actions) {
            const view = tasks.find((t) => t.number === action.issue);
            if (!view) throw new Error('issue inconnue');
            if (action.kind === 'promote') view.state = 'ready';
            if (action.kind === 'launch') {
              // Une tâche ne part que si toutes ses dépendances sont mergées.
              for (const dep of view.task.dependencies) expect(merged.has(dep)).toBe(true);
              view.state = 'running';
              view.meta = { attempts: action.attempt, launchedAt: now.toISOString() };
            }
          }
          const running = tasks.filter((t) => t.open && t.state === 'running');
          expect(running.length).toBeLessThanOrEqual(Math.min(cap, 3));
          const held = running.flatMap((t) => t.task.exclusiveResources);
          expect(new Set(held).size).toBe(held.length);

          // Des agents terminent : leur PR est mergée et l'issue fermée.
          tasks = tasks.map((t) => {
            if (t.state !== 'running' || rand() < 0.4) return t;
            merged.add(t.task.id);
            return { ...t, open: false, state: null };
          });
        }
        expect(merged.size).toBe(tasks.length);
      }),
      { numRuns: 200 },
    );
  });

  it('une passe rejouée sur l’état qu’elle a produit ne lance rien de plus', () => {
    fc.assert(
      fc.property(graph, ({ deps, resources, cap }) => {
        const now = new Date('2026-11-05T12:00:00Z');
        const tasks: TaskView[] = deps.map((d, i) => ({
          number: i + 1,
          task: makeTask({
            id: id(i),
            dependencies: d.map(id),
            exclusiveResources: resources[i] ?? [],
          }),
          open: true,
          state: 'ready',
          meta: { attempts: 0, launchedAt: null },
        }));
        const input = {
          mergedTaskIds: new Set<string>(),
          runs: [],
          now,
          limits: { projectCap: cap, globalCap: 3, runnerCap: 20, maxAttempts: 3 },
          bridgeHealthy: true,
          minutesRemaining: null,
          estimateMinutes: () => 10,
        };
        const first = planPass({ ...input, tasks });
        const launched = new Set(
          first.actions.filter((a) => a.kind === 'launch').map((a) => a.issue),
        );
        const after = tasks.map((t) =>
          launched.has(t.number)
            ? {
                ...t,
                state: 'running' as const,
                meta: { attempts: 1, launchedAt: now.toISOString() },
              }
            : t,
        );
        expect(
          planPass({ ...input, tasks: after }).actions.filter((a) => a.kind === 'launch'),
        ).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});
