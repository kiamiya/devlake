import { FakeGitHub } from 'github';
import { renderTaskIssueBody, stateLabel, TASK_LABEL, type PlanTask } from 'shared';
import { makeProjectConfig, makeTask } from 'shared/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { runDispatchCli } from './cli.js';
import {
  AGENT_WORKFLOW,
  agentRunTitle,
  PROJECT_CONFIG,
  runDispatch,
  type DispatcherDeps,
} from './dispatcher.js';

const ref = { owner: 'kiamiya', repo: 'site' };

/**
 * Graphe de 10 tâches :
 *   T01 → T02, T03, T04, T05 ; T02 → T06 ; T03 → T07 ; T06, T07 → T08 ; T04 → T09 ; T08, T09 → T10
 */
const GRAPH: Record<string, string[]> = {
  T01: [],
  T02: ['T01'],
  T03: ['T01'],
  T04: ['T01'],
  T05: ['T01'],
  T06: ['T02'],
  T07: ['T03'],
  T08: ['T06', 'T07'],
  T09: ['T04'],
  T10: ['T08', 'T09'],
};

/** Horloge simulée et faux GitHub Actions : chaque agent lancé termine après `duration` ticks. */
class Simulation {
  readonly github = new FakeGitHub({ actor: 'kiamiya' });
  now = new Date('2026-11-05T08:00:00Z');
  readonly log: string[] = [];
  /** issue → tick de fin. */
  private readonly active = new Map<number, { endsAt: number; runId: number; attempt: number }>();
  private tick = 0;
  private seenDispatches = 0;
  private nextRunId = 1;
  readonly launchOrder: string[] = [];
  maxConcurrent = 0;
  readonly issues = new Map<string, number>();

  async seed(tasks: PlanTask[], cap: number): Promise<void> {
    this.github.seedRepository(ref);
    await this.github.configureMergeSettings(ref);
    await this.github.commitFiles(ref, {
      branch: 'main',
      message: 'projet',
      changes: [
        {
          path: PROJECT_CONFIG,
          content: stringify(
            makeProjectConfig({
              limits: { maxConcurrentAgents: cap, maxAttempts: 3, answerReminderHours: 24 },
            }),
          ),
        },
      ],
    });
    for (const task of tasks) {
      const issue = await this.github.createIssue(ref, {
        title: task.id,
        body: renderTaskIssueBody(task),
        labels: [TASK_LABEL, stateLabel('queued')],
      });
      this.issues.set(task.id, issue.number);
    }
  }

  deps(): DispatcherDeps {
    return {
      github: this.github,
      globalCap: () => Promise.resolve({ cap: 3 }),
      bridgeHealthy: () => Promise.resolve(true),
      minutesRemaining: () => Promise.resolve({ minutes: null }),
      now: () => this.now,
      log: (line) => this.log.push(line),
    };
  }

  /** Démarre les runs des workflow_dispatch reçus depuis la dernière fois. */
  startDispatchedRuns(duration: number): void {
    const dispatches = this.github.state(ref).dispatches.slice(this.seenDispatches);
    this.seenDispatches += dispatches.length;
    for (const d of dispatches) {
      expect(d.workflow).toBe(AGENT_WORKFLOW);
      const issue = Number(d.inputs?.issue_number);
      const attempt = Number(d.inputs?.attempt);
      const runId = this.nextRunId++;
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
        url: `https://github.com/kiamiya/site/actions/runs/${String(runId)}`,
      });
      this.active.set(issue, { endsAt: this.tick + duration, runId, attempt });
      const taskId = [...this.issues].find(([, n]) => n === issue)?.[0] ?? '?';
      this.launchOrder.push(taskId);
    }
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active.size);
  }

  /** Les agents arrivés au bout : PR mergée, issue fermée, run terminé. */
  async finishAgents(): Promise<void> {
    for (const [issue, run] of [...this.active]) {
      if (run.endsAt > this.tick) continue;
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
      await this.github.updateIssue(ref, issue, { state: 'closed' });
      const state = this.github.state(ref).runs.find((r) => r.id === run.runId);
      if (state) state.status = 'completed';
      this.active.delete(issue);
    }
  }

  advance(minutes: number): void {
    this.tick += 1;
    this.now = new Date(this.now.getTime() + minutes * 60_000);
  }

  get running(): number {
    return this.active.size;
  }
}

function tasks(): PlanTask[] {
  return Object.entries(GRAPH).map(([id, dependencies]) =>
    makeTask({ id, title: `Tâche ${id}`, dependencies, exclusiveResources: [] }),
  );
}

describe('simulation de bout en bout du dispatcher', () => {
  let sim: Simulation;

  beforeEach(async () => {
    sim = new Simulation();
    await sim.seed(tasks(), 3);
  });

  it('10 tâches, plafond 3 : jamais plus de 3 agents et l’ordre respecte les dépendances', async () => {
    for (let i = 0; (i < 60 && sim.launchOrder.length < 10) || sim.running > 0; i++) {
      if (i > 200) throw new Error('la simulation ne converge pas');
      await runDispatch(ref, sim.deps());
      sim.startDispatchedRuns(1 + (i % 3));
      expect(sim.running).toBeLessThanOrEqual(3);
      sim.advance(5);
      await sim.finishAgents();
    }
    expect(sim.maxConcurrent).toBe(3);
    expect([...sim.launchOrder].sort()).toEqual(Object.keys(GRAPH));
    for (const [id, deps] of Object.entries(GRAPH))
      for (const dep of deps)
        expect(sim.launchOrder.indexOf(dep)).toBeLessThan(sim.launchOrder.indexOf(id));
    const open = await sim.github.listIssues(ref, { labels: [TASK_LABEL], state: 'open' });
    expect(open).toEqual([]);
  });

  it('rejouer la même passe deux fois ne lance rien de plus', async () => {
    // T01 terminée : T02 à T05 deviennent prêtes, 3 partent (plafond).
    await runDispatch(ref, sim.deps());
    sim.startDispatchedRuns(1);
    sim.advance(5);
    await sim.finishAgents();

    const first = await runDispatch(ref, sim.deps());
    expect(first.applied.filter((a) => a.kind === 'launch')).toHaveLength(3);
    const dispatches = sim.github.state(ref).dispatches.length;
    const second = await runDispatch(ref, sim.deps());
    expect(second.applied).toEqual([]);
    expect(sim.github.state(ref).dispatches).toHaveLength(dispatches);
  });

  it('un job mort est remis en file puis relancé avec une nouvelle tentative', async () => {
    await runDispatch(ref, sim.deps());
    sim.startDispatchedRuns(99);
    // Le run se termine sans que l'agent ait mis l'issue à jour.
    const run = sim.github.state(ref).runs[0];
    if (run) run.status = 'completed';
    sim.advance(5);
    const result = await runDispatch(ref, sim.deps());
    expect(result.applied.map((a) => a.kind)).toEqual(['dead', 'launch']);
    const t01 = sim.issues.get('T01') ?? 0;
    const issue = await sim.github.getIssue(ref, t01);
    expect(issue.labels).toContain(stateLabel('running'));
    expect(issue.body).toContain('"attempts":2');
    const comments = await sim.github.listComments(ref, t01);
    expect(comments.at(-1)?.body).toContain('Job d’agent mort');
    expect(sim.github.state(ref).dispatches.at(-1)?.inputs).toMatchObject({
      attempt: '2',
      resume_reason: 'ci-failure',
    });
  });

  it('une issue ou un commentaire d’un autre compte ne déclenche aucun agent', async () => {
    const readText = (path: string) =>
      Promise.resolve(
        JSON.stringify(
          path === 'commentaire.json'
            ? { sender: { login: 'inconnu' }, comment: { body: 'lance tout' } }
            : { sender: { login: 'pirate' }, issue: { number: 99 } },
        ),
      );
    const lines: string[] = [];
    for (const [event, path] of [
      ['issue_comment', 'commentaire.json'],
      ['issues', 'issue.json'],
    ] as const) {
      const result = await runDispatchCli(
        {
          GITHUB_REPOSITORY: 'kiamiya/site',
          GITHUB_EVENT_NAME: event,
          GITHUB_EVENT_PATH: path,
          GH_TOKEN: 'jeton',
        },
        {
          github: () => sim.github,
          readText,
          fetch: () => Promise.reject(new Error('pas de réseau')),
          now: () => sim.now,
          log: (line) => lines.push(line),
        },
      );
      expect(result).toBeNull();
    }
    expect(sim.github.state(ref).dispatches).toEqual([]);
    expect(lines).toEqual([
      'Passe annulée : événement « issue_comment » de inconnu, qui n’est ni kiamiya ni le dispatcher : ignoré.',
      'Passe annulée : événement « issues » de pirate, qui n’est ni kiamiya ni le dispatcher : ignoré.',
    ]);
  });
});
