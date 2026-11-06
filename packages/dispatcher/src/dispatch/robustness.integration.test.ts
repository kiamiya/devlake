import { FakeGitHub } from 'github';
import {
  CADRAGE_LABEL,
  readDispatchMeta,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
  type PlanTask,
} from 'shared';
import { makeProjectConfig, makeTask } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { seedGreenMain } from '../testing/checks.js';
import {
  AGENT_WORKFLOW,
  agentRunTitle,
  PROJECT_CONFIG,
  PROTECTION_ALERT_MARKER,
  runDispatch,
  type DispatcherDeps,
} from './dispatcher.js';

const ref = { owner: 'kiamiya', repo: 'robuste' };

/** T01 → T02, T03 ; T02 → T04 ; T03, T04 → T05. */
const GRAPH: Record<string, string[]> = {
  T01: [],
  T02: ['T01'],
  T03: ['T01'],
  T04: ['T02'],
  T05: ['T03', 'T04'],
};

/**
 * Livraison des événements au dispatcher :
 *   - normal : une passe par événement ;
 *   - doublé : chaque événement livré deux fois ;
 *   - perdu : un événement sur deux perdu, et la fermeture automatique de l'issue au merge
 *     (« Closes #N ») perdue une fois sur deux ;
 *   - en retard : chaque passe arrive un tick après son événement (ordre bousculé).
 * Dans tous les cas, la passe planifiée tourne tous les 4 ticks.
 */
type Delivery = 'normal' | 'doublé' | 'perdu' | 'en retard';

class World {
  readonly github = new FakeGitHub({ actor: 'kiamiya' });
  now = new Date('2026-11-06T08:00:00Z');
  readonly issues = new Map<string, number>();
  private readonly active = new Map<number, { runId: number; attempt: number }>();
  private seen = 0;
  private nextRun = 1;
  private finished = 0;

  constructor(private readonly delivery: Delivery) {}

  async seed(): Promise<void> {
    this.github.seedRepository(ref);
    seedGreenMain(this.github, ref);
    await this.github.commitFiles(ref, {
      branch: 'main',
      message: 'projet',
      changes: [
        {
          path: PROJECT_CONFIG,
          content: stringify(
            makeProjectConfig({
              limits: { maxConcurrentAgents: 2, maxAttempts: 3, answerReminderHours: 24 },
            }),
          ),
        },
      ],
    });
    for (const [id, dependencies] of Object.entries(GRAPH)) {
      const task: PlanTask = makeTask({ id, title: `Tâche ${id}`, dependencies });
      const issue = await this.github.createIssue(ref, {
        title: id,
        body: renderTaskIssueBody(task),
        labels: [TASK_LABEL, stateLabel('queued')],
      });
      this.issues.set(id, issue.number);
    }
  }

  deps(): DispatcherDeps {
    return {
      github: this.github,
      globalCap: () => Promise.resolve({ cap: 5 }),
      bridgeHealthy: () => Promise.resolve(true),
      minutesRemaining: () => Promise.resolve({ minutes: null }),
      now: () => this.now,
      log: () => undefined,
    };
  }

  /** Le monde avance d'un tick ; renvoie le nombre d'événements produits. */
  async step(): Promise<number> {
    let events = 0;
    // Agents lancés au tick précédent : PR livrée, mergée par l'auto-merge, run terminé.
    for (const [issue, run] of [...this.active]) {
      const taskId = [...this.issues].find(([, n]) => n === issue)?.[0] ?? '?';
      const branch = `task/${taskId}`;
      await this.github.commitFiles(ref, {
        branch,
        baseBranch: 'main',
        message: taskId,
        changes: [{ path: `${taskId}.txt`, content: taskId }],
      });
      const pr = await this.github.createPullRequest(ref, {
        title: taskId,
        body: `<!-- agentlake:pr task=${taskId} attempt=${String(run.attempt)} -->\nCloses #${String(issue)}`,
        head: branch,
        base: 'main',
      });
      this.github.mergePullRequest(ref, pr.number);
      this.finished += 1;
      const closeLost = this.delivery === 'perdu' && this.finished % 2 === 0;
      if (!closeLost) await this.github.updateIssue(ref, issue, { state: 'closed' });
      const state = this.github.state(ref).runs.find((r) => r.id === run.runId);
      if (state) state.status = 'completed';
      this.active.delete(issue);
      events += 2;
    }
    // Nouveaux workflow_dispatch : runs démarrés.
    const dispatches = this.github.state(ref).dispatches.slice(this.seen);
    this.seen += dispatches.length;
    for (const d of dispatches) {
      const issue = Number(d.inputs?.issue_number);
      const attempt = Number(d.inputs?.attempt);
      const runId = this.nextRun++;
      this.github.seedWorkflowRun(ref, {
        id: runId,
        name: 'AgentLake — agent',
        title: agentRunTitle(issue, attempt),
        workflow: AGENT_WORKFLOW,
        status: 'in_progress',
        conclusion: null,
        headBranch: 'main',
        event: 'workflow_dispatch',
        createdAt: this.now.toISOString(),
        url: `https://github.com/kiamiya/robuste/actions/runs/${String(runId)}`,
      });
      this.active.set(issue, { runId, attempt });
      events += 1;
    }
    this.now = new Date(this.now.getTime() + 5 * 60_000);
    return events;
  }

  /** État final comparable : par tâche, issue ouverte, état, lancements, résumé. */
  async final() {
    const result: Record<string, unknown> = {};
    const dispatches = this.github.state(ref).dispatches;
    for (const [id, number] of this.issues) {
      const issue = await this.github.getIssue(ref, number);
      const comments = await this.github.listComments(ref, number);
      result[id] = {
        open: issue.state === 'open',
        labels: issue.labels.filter((l) => l !== TASK_LABEL).sort(),
        attempts: readDispatchMeta(issue.body).attempts,
        launches: dispatches.filter((d) => d.inputs?.issue_number === String(number)).length,
        summaries: comments.filter((c) => c.body.startsWith(`**Tâche ${id} mergée** (PR`)).length,
      };
    }
    return result;
  }
}

async function simulate(delivery: Delivery) {
  const world = new World(delivery);
  await world.seed();
  let late = 0;
  for (let tick = 0; tick < 60; tick++) {
    const events = await world.step();
    let passes = events > 0 ? 1 : 0;
    if (delivery === 'doublé') passes *= 2;
    if (delivery === 'perdu' && tick % 2 === 1) passes = 0;
    if (delivery === 'en retard') [passes, late] = [late, passes];
    if (tick % 4 === 3) passes += 1;
    for (let p = 0; p < passes; p++) await runDispatch(ref, world.deps());
  }
  return world.final();
}

describe('rejeu et désordre des événements (simulation FakeGitHub)', { timeout: 60_000 }, () => {
  it('événements doublés, perdus ou en retard : même état final, aucun agent en double', async () => {
    const reference = await simulate('normal');
    // Référence : tout est mergé, fermé, résumé une fois, chaque tâche lancée une fois.
    for (const id of Object.keys(GRAPH))
      expect(reference[id]).toEqual({
        open: false,
        labels: [stateLabel('running')],
        attempts: 1,
        launches: 1,
        summaries: 1,
      });
    for (const delivery of ['doublé', 'perdu', 'en retard'] as const)
      expect({ delivery, state: await simulate(delivery) }).toEqual({
        delivery,
        state: reference,
      });
  });
});

describe('garde-fou de la protection de main', () => {
  let now = new Date('2026-11-06T08:00:00Z');

  async function project() {
    now = new Date('2026-11-06T08:00:00Z');
    const github = new FakeGitHub({ actor: 'kiamiya', now: () => now });
    github.seedRepository(ref);
    seedGreenMain(github, ref);
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'projet',
      changes: [{ path: PROJECT_CONFIG, content: stringify(makeProjectConfig()) }],
    });
    await github.createIssue(ref, {
      title: 'T01',
      body: renderTaskIssueBody(makeTask({ id: 'T01', dependencies: [] })),
      labels: [TASK_LABEL, stateLabel('ready')],
    });
    const cadrage = await github.createIssue(ref, {
      title: 'Cadrage',
      body: 'Questions du planificateur',
      labels: [CADRAGE_LABEL],
    });
    return { github, cadrage: cadrage.number };
  }

  it('main déprotégée : aucun lancement, alerte sur Cadrage une fois par jour', async () => {
    const { github, cadrage } = await project();
    github.unprotectBranch(ref, 'main');
    const lines: string[] = [];
    const deps = (): DispatcherDeps => ({
      github,
      globalCap: () => Promise.resolve({ cap: 3 }),
      bridgeHealthy: () => Promise.resolve(true),
      minutesRemaining: () => Promise.resolve({ minutes: null }),
      now: () => now,
      log: (line) => lines.push(line),
    });
    const alerts = async () =>
      (await github.listComments(ref, cadrage)).filter((c) =>
        c.body.includes(PROTECTION_ALERT_MARKER),
      );

    expect((await runDispatch(ref, deps())).applied).toEqual([]);
    expect(lines).toContain(
      'Protection de main incomplète : main n’est plus protégée. Aucun agent ne sera lancé.',
    );
    expect(await alerts()).toHaveLength(1);
    expect((await alerts())[0]?.body).toContain('@kiamiya **Protection de `main` incomplète**');
    // Passes suivantes du même jour : pas de nouvelle alerte.
    await runDispatch(ref, deps());
    expect(await alerts()).toHaveLength(1);
    now = new Date('2026-11-07T09:00:00Z');
    await runDispatch(ref, deps());
    expect(await alerts()).toHaveLength(2);

    // Checks obligatoires retirés : toujours bloqué, raison précise.
    await github.protectBranch(ref, 'main', { requiredChecks: ['lint'], enforceAdmins: false });
    lines.length = 0;
    expect((await runDispatch(ref, deps())).applied).toEqual([]);
    expect(lines[0]).toContain('checks obligatoires retirés : typecheck');

    // Protection rétablie : la tâche part.
    seedGreenMain(github, ref);
    expect((await runDispatch(ref, deps())).applied.map((a) => a.kind)).toEqual(['launch']);
  });

  it('pause globale : aucun lancement', async () => {
    const { github } = await project();
    const result = await runDispatch(ref, {
      github,
      globalCap: () => Promise.resolve({ cap: 3, paused: true }),
      bridgeHealthy: () => Promise.resolve(true),
      minutesRemaining: () => Promise.resolve({ minutes: null }),
      now: () => new Date('2026-11-06T08:00:00Z'),
      log: () => undefined,
    });
    expect(result.applied).toEqual([]);
    expect(result.plan.log).toContainEqual(expect.stringContaining('pause globale'));
  });
});
