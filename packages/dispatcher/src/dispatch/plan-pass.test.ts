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
  it('C_global au total : les agents des autres projets réduisent la capacité', () => {
    const ready = [1, 2, 3].map((n) => view(n, 'ready'));
    const limits = { projectCap: null, globalCap: 3, runnerCap: 20, maxAttempts: 3 };
    expect(planPass(input(ready, { limits: { ...limits, otherAgents: 2 } })).capacity).toBe(0);
    const plan = planPass(input(ready, { limits: { ...limits, otherAgents: 2 } }));
    expect(plan.actions.filter((a) => a.kind === 'launch')).toHaveLength(1);
    expect(plan.log[0]).toContain('global 3 − 2 ailleurs');
    // Plus d'agents ailleurs que le plafond : rien, sans capacité négative.
    expect(planPass(input(ready, { limits: { ...limits, otherAgents: 5 } })).actions).toEqual([]);
  });

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

  it('tâche prioritaire (ad hoc) : passe avant le chemin critique', () => {
    const tasks = [
      view(1, 'ready'),
      view(2, 'ready'),
      view(3, 'queued', { dependencies: ['T02'] }),
      view(500, 'ready', { priority: true, adhoc: true }),
    ];
    const plan = planPass(
      input(tasks, { limits: { projectCap: 1, globalCap: 3, runnerCap: 20, maxAttempts: 3 } }),
    );
    expect(kinds(plan)).toEqual(['launch:T500']);
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

  it('« running » lancée à la main, run en cours : laissée telle quelle', () => {
    const plan = planPass(
      input([view(1, 'running')], { runs: [{ issueNumber: 1, attempt: 1, completed: false }] }),
    );
    expect(plan.actions).toEqual([]);
  });
});

describe('rattrapage', () => {
  it('étiquette running sans run actif : remise en file, puis promue et relancée', () => {
    const plan = planPass(input([view(1, 'running')]));
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'repair', to: 'queued' }),
      expect.objectContaining({ kind: 'promote', from: 'queued' }),
      expect.objectContaining({ kind: 'launch', from: 'ready', attempt: 1 }),
    ]);
    expect(plan.log[0]).toContain('étiquette running sans run d’agent actif');
  });

  it('PR mergée, issue restée ouverte : fermée (le résumé suivra une fois fermée)', () => {
    const plan = planPass(
      input([view(1, 'running', {}, { meta: { attempts: 1, launchedAt: NOW.toISOString() } })], {
        mergedTaskIds: new Set(['T01']),
        mergedPrs: new Map([['T01', 7]]),
      }),
    );
    expect(plan.actions).toEqual([{ kind: 'close-merged', issue: 1, taskId: 'T01', prNumber: 7 }]);
  });

  it('en attente de réponse sans question : prête et relancée, une fois l’agent terminé', () => {
    const waiting = view(
      1,
      'awaiting-answer',
      {},
      { meta: { attempts: 1, launchedAt: NOW.toISOString() }, questionMissing: true },
    );
    // Agent encore en cours (il poste peut-être sa question) : rien.
    expect(
      planPass(input([waiting], { runs: [{ issueNumber: 1, attempt: 1, completed: false }] }))
        .actions,
    ).toEqual([]);
    expect(
      planPass(input([waiting], { runs: [{ issueNumber: 1, attempt: 1, completed: true }] }))
        .actions,
    ).toEqual([
      expect.objectContaining({ kind: 'repair', to: 'ready' }),
      expect.objectContaining({ kind: 'launch', from: 'ready', attempt: 2, resume: 'none' }),
    ]);
    // Une question posée : l'attente est normale.
    expect(planPass(input([{ ...waiting, questionMissing: false }])).actions).toEqual([]);
  });

  it('escaladée sans question : question d’escalade reposée, état inchangé', () => {
    const plan = planPass(
      input([
        view(
          1,
          'escalated',
          {},
          { meta: { attempts: 3, launchedAt: NOW.toISOString() }, questionMissing: true },
        ),
      ]),
    );
    expect(plan.actions).toEqual([{ kind: 'escalate', issue: 1, taskId: 'T01', attempts: 3 }]);
  });
});

describe('garde-fous', () => {
  it('pause globale, protection de main incomplète : aucun lancement, raisons au journal', () => {
    const ready = [view(1, 'ready')];
    expect(planPass(input(ready, { globalPaused: true })).actions).toEqual([]);
    expect(planPass(input(ready, { globalPaused: true })).log).toContainEqual(
      expect.stringContaining('pause globale'),
    );
    const unprotected = planPass(input(ready, { mainProtection: ['main n’est plus protégée'] }));
    expect(unprotected.actions).toEqual([]);
    expect(unprotected.log).toContainEqual(
      expect.stringContaining('protection de main incomplète (main n’est plus protégée)'),
    );
    expect(planPass(input(ready, { mainProtection: [] })).actions).toHaveLength(1);
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

  it('code pur C#/C++ (needsEditor false) : part sans le pont ni le verrou d’éditeur', () => {
    const plan = planPass(
      input(
        [
          view(1, 'ready', { profile: 'unity', needsEditor: false }),
          view(2, 'ready', { profile: 'unity' }),
        ],
        { bridgeHealthy: false },
      ),
    );
    expect(kinds(plan)).toEqual(['launch:T01', 'wait-editor:T02']);
    expect(plan.actions[0]).toMatchObject({ kind: 'launch', needsEditor: false });
  });

  it('tâche d’éditeur lancée : signalée au workflow (groupe de concurrence éditeur)', () => {
    const plan = planPass(input([view(1, 'ready', { profile: 'unity' })], { bridgeHealthy: true }));
    expect(plan.actions[0]).toMatchObject({ kind: 'launch', needsEditor: true });
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
