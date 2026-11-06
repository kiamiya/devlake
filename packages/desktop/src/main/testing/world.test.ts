import { FakeGitHub, type RepoRef } from 'github';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseProjectPlan,
  proposeAgents,
  renderGlobalConfig,
  requiredChecksFor,
  TASK_LABEL,
} from 'shared';
import { makeProjectConfig } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { openDatabase } from '../db/database.js';
import { rebuildFromGitHub } from '../db/rebuild.js';
import { createRepositories, type Repositories } from '../db/repositories.js';
import { PlanService } from '../services/plan/plan-service.js';
import { PlannerLaunchService } from '../services/planner/planner-launch.js';
import { QuestionsService } from '../services/questions/questions-service.js';
import { DashboardService } from '../services/dashboard/dashboard-service.js';
import {
  loadScenario,
  RegressionScenarioSchema,
  SimulatedWorld,
  type RegressionScenario,
} from './world.js';

/** Bibliothèque de régression partagée (tests/fixtures/regression). */
const LIBRARY = fileURLToPath(
  new URL('../../../../../tests/fixtures/regression/', import.meta.url),
);
const SCENARIOS = readdirSync(`${LIBRARY}scenarios`).filter((f) => f.endsWith('.json'));
const scenario = (name: string) => loadScenario(`${LIBRARY}scenarios/${name}.json`);

/** Le cockpit simulé sans interface : services réels sur le faux GitHub. */
class Cockpit {
  readonly repos: Repositories = createRepositories(openDatabase(':memory:').db);
  readonly github = new FakeGitHub({ actor: 'kiamiya' });
  readonly world = new SimulatedWorld(this.github);
  private readonly port = () => Promise.resolve(this.github);
  readonly questions = new QuestionsService({
    repos: this.repos,
    github: this.port,
    notify: () => undefined,
    badge: () => undefined,
  });
  readonly plans = new PlanService(this.repos, this.port);
  readonly planner = new PlannerLaunchService(this.repos, this.port);
  readonly dashboard = new DashboardService({ repos: this.repos, github: this.port });
  private readonly validated = new Set<string>();
  private readonly scenarios = new Map<string, RegressionScenario>();

  constructor() {
    this.repos.settings.update({ plannerModel: 'modele-simule' });
  }

  /** Projet bootstrappé : project.yml, main protégée, auto-merge, brief versé. */
  async project(repo: string, scenarioOf: RegressionScenario): Promise<RepoRef> {
    const ref = { owner: 'kiamiya', repo };
    this.github.seedRepository(ref);
    await this.github.configureMergeSettings(ref);
    await this.github.commitFiles(ref, {
      branch: 'main',
      message: 'chore: bootstrap AgentLake',
      changes: [
        {
          path: '.agentlake/project.yml',
          content: stringify(makeProjectConfig({ type: 'web', qualityProfile: 'web' })),
        },
        { path: '.agentlake/context/brief.md', content: `# ${scenarioOf.name}\n` },
      ],
    });
    await this.github.protectBranch(ref, 'main', {
      requiredChecks: requiredChecksFor('web'),
      enforceAdmins: false,
    });
    this.repos.projects.upsert('kiamiya', repo, '2026-11-06T08:00:00.000Z');
    this.world.register(ref, scenarioOf, 'web');
    this.scenarios.set(`kiamiya/${repo}`, scenarioOf);
    return ref;
  }

  /** Ce que Kia fait dans le cockpit : répondre aux questions, valider le plan proposé. */
  async act(): Promise<void> {
    await this.questions.syncAll();
    for (const q of this.questions.list({ status: 'pending' })) {
      const s = this.scenarios.get(q.projectId);
      const text = s?.answers[q.questionId] ?? s?.agentAnswers[q.questionId];
      if (text === undefined) continue;
      await this.questions.answer({
        projectId: q.projectId,
        issueNumber: q.issueNumber,
        questionId: q.questionId,
        text,
        decision: true,
        ignore: false,
        attachments: [],
      });
    }
    for (const id of this.scenarios.keys()) {
      if (this.validated.has(id)) continue;
      const [owner = '', repo = ''] = id.split('/');
      if (!(await this.github.branchExists({ owner, repo }, 'plan/v1'))) continue;
      await this.plans.validate(id, 1);
      this.validated.add(id);
    }
  }

  async run(maxTicks = 200): Promise<number> {
    for (let tick = 1; tick <= maxTicks; tick++) {
      await this.act();
      await this.world.tick();
      const open = await Promise.all(
        [...this.scenarios.keys()].map(async (id) => {
          const [owner = '', repo = ''] = id.split('/');
          const tasks = await this.github.listIssues({ owner, repo }, { labels: [TASK_LABEL] });
          return tasks.length > 0 || !this.validated.has(id);
        }),
      );
      if (!open.some(Boolean)) return tick;
    }
    throw new Error('Le scénario ne converge pas.');
  }
}

describe('bibliothèque de régression', () => {
  it.each(SCENARIOS)('%s : scénario valide, plan attendu valide et cohérent', async (file) => {
    const s = await loadScenario(`${LIBRARY}scenarios/${file}`);
    const plan = parseProjectPlan({
      ...s.plan,
      proposedAgents: proposeAgents(s.plan.tasks, { runners: 20, global: 3 }).agents,
    });
    expect(plan.ok ? null : plan.error).toBeNull();
    const ids = s.plan.tasks.map((t) => t.id);
    expect(Object.keys(s.expected.launches).sort()).toEqual([...ids].sort());
    for (const id of Object.keys(s.agents)) expect(ids).toContain(id);
    for (const script of Object.values(s.agents))
      if (script.question) expect(s.agentAnswers).toHaveProperty(script.question.id);
  });

  it('scénario invalide : refusé avec un message lisible', () => {
    const result = RegressionScenarioSchema.safeParse({ name: 'Avec Espace', description: '' });
    expect(result.success).toBe(false);
  });
});

describe('monde simulé : vrai planificateur, vrai dispatcher, agents scriptés', () => {
  it('création → questions → réponses → plan → validation → 5 tâches mergées, avancement 100 %', async () => {
    const cockpit = new Cockpit();
    const rdv = await scenario('rendez-vous');
    const ref = await cockpit.project('rendez-vous', rdv);
    await cockpit.planner.start({ projectId: 'kiamiya/rendez-vous', mode: 'auto' });
    const ticks = await cockpit.run();
    expect(ticks).toBeLessThan(100);

    // Chaque tâche : lancements attendus (question bloquante et échec de CI comptent un de plus).
    expect(Object.fromEntries(cockpit.world.stats.launches)).toEqual(rdv.expected.launches);
    expect(cockpit.world.stats.merged).toBe(5);
    const issues = await cockpit.github.listIssues(ref, { labels: [TASK_LABEL], state: 'all' });
    expect(issues.every((i) => i.state === 'closed')).toBe(true);
    // Questions : cadrage répondu, question de l'agent répondue, plus rien en attente.
    expect(cockpit.questions.list({ status: 'pending' })).toEqual([]);
    expect(
      cockpit.questions
        .list({ status: 'answered' })
        .map((q) => q.questionId)
        .sort(),
    ).toEqual(['C1', 'C2', 'format-telephone']);
    // Le cockpit resynchronise son miroir (sondage), puis affiche l'avancement.
    await rebuildFromGitHub(ref, cockpit.github, cockpit.repos);
    const dashboard = await cockpit.dashboard.get('kiamiya/rendez-vous');
    expect(dashboard.progress.overall.percent).toBe(100);
  });

  it('deux projets, plafond global de 2 : jamais plus de 2 agents au total', async () => {
    const cockpit = new Cockpit();
    const inventaire = await scenario('inventaire');
    const refs = [
      await cockpit.project('stock-a', inventaire),
      await cockpit.project('stock-b', inventaire),
    ];
    // Configuration globale publiée par le cockpit : plafond et projets.
    const config = { owner: 'kiamiya', repo: 'devlake-config' };
    cockpit.github.seedRepository(config, { private: true });
    await cockpit.github.commitFiles(config, {
      branch: 'main',
      message: 'chore: configuration globale',
      changes: [
        {
          path: 'config.yml',
          content: renderGlobalConfig({
            maxConcurrentAgents: 2,
            projects: ['kiamiya/stock-a', 'kiamiya/stock-b'],
          }),
        },
      ],
    });
    for (const ref of refs)
      await cockpit.planner.start({ projectId: `${ref.owner}/${ref.repo}`, mode: 'auto' });
    await cockpit.run();
    expect(cockpit.world.stats.maxConcurrent).toBe(2);
    expect(cockpit.world.stats.merged).toBe(10);
  });
});
