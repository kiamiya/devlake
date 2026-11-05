import type { TaskState } from 'shared';
import { makeTask } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import {
  criticalHeights,
  DEAD_JOB_GRACE_MS,
  planPass,
  type PassInput,
  type TaskView,
} from './plan-pass.js';

const NOW = new Date('2026-11-05T12:00:00Z');

function view(
  number: number,
  state: TaskState | null,
  overrides: Partial<TaskView['task']> = {},
  extra: Partial<Omit<TaskView, 'task'>> = {},
): TaskView {
  return {
    number,
    task: makeTask({ id: `T${String(number).padStart(2, '0')}`, dependencies: [], ...overrides }),
    open: true,
    state,
    meta: { attempts: 0, launchedAt: null },
    ...extra,
  };
}

function input(tasks: TaskView[], overrides: Partial<PassInput> = {}): PassInput {
  return {
    tasks,
    mergedTaskIds: new Set(tasks.filter((t) => !t.open).map((t) => t.task.id)),
    runs: [],
    now: NOW,
    limits: { projectCap: null, globalCap: 3, runnerCap: 20, maxAttempts: 3 },
    bridgeHealthy: null,
    minutesRemaining: null,
    estimateMinutes: () => 20,
    ...overrides,
  };
}

const kinds = (plan: ReturnType<typeof planPass>) =>
  plan.actions.map((a) => `${a.kind}:${a.taskId}`);

describe('tâches prêtes', () => {
  it('promeut une tâche dont les dépendances sont fermées par une PR mergée, puis la lance', () => {
    const done = view(1, null, {}, { open: false });
    const next = view(2, 'queued', { dependencies: ['T01'] });
    expect(kinds(planPass(input([done, next])))).toEqual(['promote:T02', 'launch:T02']);
  });

  it('attend une dépendance ouverte, fermée sans PR mergée, ou inconnue', () => {
    const open = view(1, 'running', {}, { meta: { attempts: 1, launchedAt: NOW.toISOString() } });
    const closedNotMerged = view(2, null, {}, { open: false });
    const tasks = [
      open,
      closedNotMerged,
      view(3, 'queued', { dependencies: ['T01'] }),
      view(4, 'queued', { dependencies: ['T02'] }),
      view(5, 'queued', { dependencies: ['T99'] }),
    ];
    const plan = planPass(input(tasks, { mergedTaskIds: new Set() }));
    expect(kinds(plan)).toEqual([]);
  });

  it('ne touche ni aux tâches en attente de réponse ni aux escaladées', () => {
    const plan = planPass(input([view(1, 'awaiting-answer'), view(2, 'escalated')]));
    expect(plan.actions).toEqual([]);
  });
});

describe('capacité', () => {
  it('min(projet, global, runners) moins les agents en cours', () => {
    const running = view(
      1,
      'running',
      {},
      { meta: { attempts: 1, launchedAt: NOW.toISOString() } },
    );
    const ready = [2, 3, 4, 5].map((n) => view(n, 'ready'));
    const plan = planPass(
      input([running, ...ready], {
        limits: { projectCap: 2, globalCap: 3, runnerCap: 20, maxAttempts: 3 },
      }),
    );
    expect(kinds(plan)).toEqual(['launch:T02']);
    expect(plan.log.join('\n')).toContain('min(projet 2, global 3, runners 20) − 1 en cours = 1');
    expect(plan.log.join('\n')).toContain('#3 T03 : en attente de capacité.');
  });

  it('le plafond global s’applique sans plafond de projet', () => {
    const plan = planPass(input([1, 2, 3, 4, 5].map((n) => view(n, 'ready'))));
    expect(plan.actions.filter((a) => a.kind === 'launch')).toHaveLength(3);
  });

  it('les minutes Actions restantes limitent les lancements', () => {
    const plan = planPass(
      input([view(1, 'ready'), view(2, 'ready')], {
        minutesRemaining: 30,
        estimateMinutes: () => 20,
      }),
    );
    expect(kinds(plan)).toEqual(['launch:T01']);
    expect(plan.log.join('\n')).toContain(
      'minutes Actions insuffisantes (10 restantes, 20 estimées)',
    );
  });
});

describe('priorité au chemin critique', () => {
  it('lance d’abord la tâche dont dépend la plus longue chaîne', () => {
    // T01 isolée ; T02 → T03 → T04 (chaîne de 3).
    const tasks = [
      view(1, 'ready'),
      view(2, 'ready'),
      view(3, 'queued', { dependencies: ['T02'] }),
      view(4, 'queued', { dependencies: ['T03'] }),
    ];
    expect(criticalHeights(tasks).get('T02')).toBe(3);
    const plan = planPass(
      input(tasks, { limits: { projectCap: 1, globalCap: 3, runnerCap: 20, maxAttempts: 3 } }),
    );
    expect(kinds(plan)).toEqual(['launch:T02']);
  });

  it('un cycle (plan corrompu) ne bloque pas le calcul', () => {
    const tasks = [
      view(1, 'queued', { dependencies: ['T02'] }),
      view(2, 'queued', { dependencies: ['T01'] }),
    ];
    expect([...criticalHeights(tasks).values()].every((h) => h >= 1)).toBe(true);
    expect(planPass(input(tasks)).actions).toEqual([]);
  });
});

describe('ressources exclusives', () => {
  it('une ressource occupée par une tâche en cours bloque les autres', () => {
    const running = view(
      1,
      'running',
      { exclusiveResources: ['migrations'] },
      { meta: { attempts: 1, launchedAt: NOW.toISOString() } },
    );
    const plan = planPass(
      input([running, view(2, 'ready', { exclusiveResources: ['migrations'] })]),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.log.join('\n')).toContain('ressource exclusive occupée (migrations)');
  });

  it('deux tâches prêtes sur la même ressource : une seule part', () => {
    const plan = planPass(
      input([
        view(1, 'ready', { exclusiveResources: ['repository'] }),
        view(2, 'ready', { exclusiveResources: ['repository'] }),
      ]),
    );
    expect(kinds(plan)).toEqual(['launch:T01']);
  });
});

describe('idempotence', () => {
  it('rejouer la passe après les lancements ne lance rien de plus', () => {
    const tasks = [1, 2, 3, 4].map((n) => view(n, 'ready'));
    const first = planPass(input(tasks));
    const launched = new Set(first.actions.filter((a) => a.kind === 'launch').map((a) => a.issue));
    const after = tasks.map((t) =>
      launched.has(t.number)
        ? { ...t, state: 'running' as const, meta: { attempts: 1, launchedAt: NOW.toISOString() } }
        : t,
    );
    expect(planPass(input(after)).actions).toEqual([]);
  });

  it('une tâche « running » sans lancement du dispatcher est laissée telle quelle', () => {
    const plan = planPass(input([view(1, 'running')]));
    expect(plan.actions).toEqual([]);
    expect(plan.log[0]).toContain('running sans lancement du dispatcher');
  });
});

describe('jobs morts et tentatives', () => {
  const launchedAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();

  it('run terminé, issue toujours running : remise en file et relance (tentative comptée)', () => {
    const t = view(1, 'running', {}, { meta: { attempts: 1, launchedAt } });
    const plan = planPass(input([t], { runs: [{ issueNumber: 1, attempt: 1, completed: true }] }));
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'dead', attempt: 1 }),
      expect.objectContaining({ kind: 'launch', attempt: 2, resume: 'ci-failure', from: 'fixing' }),
    ]);
  });

  it('run en cours : rien à faire', () => {
    const t = view(1, 'running', {}, { meta: { attempts: 1, launchedAt } });
    expect(
      planPass(input([t], { runs: [{ issueNumber: 1, attempt: 1, completed: false }] })).actions,
    ).toEqual([]);
  });

  it('aucun run : mort seulement après le délai de grâce', () => {
    const recent = view(1, 'running', {}, { meta: { attempts: 1, launchedAt } });
    expect(planPass(input([recent])).actions).toEqual([]);
    const old = new Date(NOW.getTime() - DEAD_JOB_GRACE_MS - 1).toISOString();
    const stale = view(1, 'running', {}, { meta: { attempts: 1, launchedAt: old } });
    expect(planPass(input([stale])).actions[0]).toMatchObject({
      kind: 'dead',
      reason: 'aucun run d’agent 15 minutes après le lancement',
    });
  });

  it('un run d’une ancienne tentative ne compte pas', () => {
    const old = new Date(NOW.getTime() - DEAD_JOB_GRACE_MS - 1).toISOString();
    const t = view(1, 'running', {}, { meta: { attempts: 2, launchedAt: old } });
    const plan = planPass(input([t], { runs: [{ issueNumber: 1, attempt: 1, completed: false }] }));
    expect(plan.actions[0]?.kind).toBe('dead');
  });

  it('au-delà du maximum de tentatives : escalade', () => {
    const t = view(1, 'fixing', {}, { meta: { attempts: 3, launchedAt } });
    expect(kinds(planPass(input([t])))).toEqual(['escalate:T01']);
    const again = view(1, 'fixing', {}, { meta: { attempts: 2, launchedAt } });
    expect(planPass(input([again])).actions[0]).toMatchObject({ kind: 'launch', attempt: 3 });
  });
});

describe('pont Aura', () => {
  it('pont indisponible : tâche de jeu en attente de l’éditeur, les autres continuent', () => {
    const plan = planPass(
      input([view(1, 'ready', { profile: 'unity' }), view(2, 'ready')], { bridgeHealthy: false }),
    );
    expect(kinds(plan)).toEqual(['wait-editor:T01', 'launch:T02']);
  });

  it('déjà en attente de l’éditeur : pas de nouvelle action tant que le pont est absent', () => {
    expect(
      planPass(input([view(1, 'waiting-editor', { profile: 'unreal' })], { bridgeHealthy: false }))
        .actions,
    ).toEqual([]);
  });

  it('pont revenu : la tâche repasse prête et part', () => {
    const plan = planPass(
      input([view(1, 'waiting-editor', { profile: 'unity' })], { bridgeHealthy: true }),
    );
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'promote', from: 'waiting-editor' }),
      expect.objectContaining({ kind: 'launch', from: 'ready', resume: 'none' }),
    ]);
  });
});
