/**
 * Monde simulé des tests de bout en bout (T22) : un faux GitHub où tournent le vrai
 * dispatcher et le vrai planificateur, avec Claude, les agents, la CI et l'auto-merge
 * rejoués depuis la bibliothèque de régression (`tests/fixtures/regression`).
 *
 * Réservé aux tests : seul `src/main/testing/` peut importer `dispatcher` et `planner`
 * (exception dependency-cruiser), et le cockpit ne le charge qu'en mode E2E, par import
 * dynamique.
 */
import { agentRunTitle, AGENT_WORKFLOW, readGlobalCap, runDispatch, taskBranch } from 'dispatcher';
import type { FakeGitHub, RepoRef } from 'github';
import { readFile } from 'node:fs/promises';
import { runPlanner, type ClaudePort, type Prompts } from 'planner';
import {
  CADRAGE_LABEL,
  ciChecksFor,
  formatZodError,
  parseTaskIssueBody,
  PlanDraftSchema,
  PROJECT_TYPES,
  QuestionSchema,
  renderQuestionComment,
  requiredChecksFor,
  stateLabel,
  TASK_LABEL,
  type QualityProfile,
} from 'shared';
import { z } from 'zod';

/** Workflow d'appel du planificateur, posé au bootstrap. */
const PLANNER_WORKFLOW = 'agentlake-planner.yml';

/** Comportement scripté de l'agent d'une tâche. */
export const AgentScriptSchema = z.object({
  /** Question bloquante posée à la première tentative ; la réponse de Kia relance l'agent. */
  question: QuestionSchema.pick({ id: true, text: true, options: true }).optional(),
  /** Nombre de livraisons dont la CI échoue avant de passer. */
  ciFailures: z.number().int().min(0).default(0),
});
export type AgentScript = z.infer<typeof AgentScriptSchema>;

/** Scénario de la bibliothèque de régression : brief, réponses de Claude, agents, attendus. */
export const RegressionScenarioSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'Nom de scénario en minuscules et tirets.'),
  description: z.string().min(1),
  /** Brief de référence (chemin relatif au dossier de la bibliothèque). */
  brief: z.string().min(1),
  /** Phase 1 du planificateur : questions de clarification renvoyées par Claude. */
  clarification: z.array(QuestionSchema.omit({ id: true })),
  /** Réponses de Kia aux questions de cadrage (C1, C2…). */
  answers: z.record(z.string(), z.string()),
  /** Phase 2 du planificateur : plan renvoyé par Claude. */
  plan: PlanDraftSchema,
  agents: z.record(z.string(), AgentScriptSchema).default({}),
  /** Réponses de Kia aux questions des agents, par identifiant de question. */
  agentAnswers: z.record(z.string(), z.string()).default({}),
  expected: z.object({
    /** Lancements d'agent attendus par tâche (1 sans incident). */
    launches: z.record(z.string(), z.number().int().min(1)),
  }),
});
export type RegressionScenario = z.infer<typeof RegressionScenarioSchema>;

/** Lit et valide un scénario de la bibliothèque ; erreur lisible si le fichier est invalide. */
export async function loadScenario(path: string): Promise<RegressionScenario> {
  const parsed = RegressionScenarioSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.success)
    throw new Error(`Scénario de régression invalide (${path}) :\n${formatZodError(parsed.error)}`);
  return parsed.data;
}

/** Claude simulé : questions puis plan du scénario, dans l'ordre des appels du planificateur. */
export function scenarioClaude(scenario: RegressionScenario): ClaudePort {
  let calls = 0;
  return {
    run: () => {
      calls += 1;
      const structured = calls === 1 ? { questions: scenario.clarification } : scenario.plan;
      return Promise.resolve({ text: JSON.stringify(structured), structured });
    },
  };
}

/** Prompts vides : Claude simulé ne les lit pas. */
const NO_PROMPTS: Prompts = {
  system: '',
  clarification: '',
  decoupe: '',
  correction: '',
  types: Object.fromEntries(PROJECT_TYPES.map((t) => [t, ''])) as Prompts['types'],
};

interface Project {
  ref: RepoRef;
  scenario: RegressionScenario;
  qualityProfile: QualityProfile;
  claude: ClaudePort;
  seenDispatches: number;
  /** Commentaires de l'issue Cadrage déjà vus (une réponse relance le planificateur). */
  seenCadrage: number;
  planned: boolean;
  /** Questions d'agent déjà posées, CI en échec restantes, par tâche. */
  asked: Set<string>;
  failuresLeft: Map<string, number>;
  /** Agents lancés, terminés au tick suivant. */
  pending: { issue: number; attempt: number; runId: number }[];
}

export interface WorldOptions {
  now?: () => Date;
  log?: (line: string) => void;
}

/** Statistiques observées par les tests. */
export interface WorldStats {
  launches: Map<string, number>;
  /** Plus grand nombre d'agents simultanés, tous projets confondus. */
  maxConcurrent: number;
  merged: number;
  /** Erreurs rencontrées (une par message), vides dans un scénario sain. */
  errors: string[];
}

let nextRunId = 9000;

export class SimulatedWorld {
  private readonly projects = new Map<string, Project>();
  readonly stats: WorldStats = { launches: new Map(), maxConcurrent: 0, merged: 0, errors: [] };
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private ticking = false;

  constructor(
    private readonly github: FakeGitHub,
    options: WorldOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  /** Associe un dépôt à un scénario (avant ou après la création du projet par le cockpit). */
  register(ref: RepoRef, scenario: RegressionScenario, qualityProfile: QualityProfile): void {
    this.projects.set(`${ref.owner}/${ref.repo}`, {
      ref,
      scenario,
      qualityProfile,
      claude: scenarioClaude(scenario),
      seenDispatches: 0,
      seenCadrage: 0,
      planned: false,
      asked: new Set(),
      failuresLeft: new Map(
        Object.entries(scenario.agents).map(([id, script]) => [id, script.ciFailures]),
      ),
      pending: [],
    });
  }

  private exists(ref: RepoRef): boolean {
    try {
      this.github.state(ref);
      return true;
    } catch {
      return false;
    }
  }

  /** Un pas du monde : agents, planificateur, CI et merge, puis une passe du dispatcher. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const project of this.projects.values())
        await this.guard(project, async () => {
          await this.finishAgents(project);
          await this.handleDispatches(project);
          await this.handleCadrage(project);
          await this.autoMerge(project);
        });
      for (const project of this.projects.values())
        await this.guard(project, async () => {
          const tasks = await this.github.listIssues(project.ref, { labels: [TASK_LABEL] });
          if (tasks.length === 0) return;
          await this.dispatch(project);
          // GitHub crée le run d'un workflow_dispatch aussitôt : la passe du projet suivant le
          // compte dans C_global.
          await this.handleDispatches(project);
        });
      this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this.running());
    } finally {
      this.ticking = false;
    }
  }

  /** Un projet en erreur n'arrête pas les autres ; l'erreur est gardée pour les tests. */
  private async guard(project: Project, step: () => Promise<void>): Promise<void> {
    if (!this.exists(project.ref)) return;
    try {
      await step();
    } catch (error) {
      const message = `${project.ref.repo} : ${error instanceof Error ? error.message : String(error)}`;
      if (!this.stats.errors.includes(message)) this.stats.errors.push(message);
      this.log(message);
    }
  }

  /** Agents en cours, tous projets confondus. */
  running(): number {
    return [...this.projects.values()].reduce((sum, p) => sum + p.pending.length, 0);
  }

  private async dispatch(project: Project): Promise<void> {
    await runDispatch(project.ref, {
      github: this.github,
      // Vraie lecture de devlake-config (publié par le cockpit) : C_global au total.
      globalCap: () => readGlobalCap(this.github, project.ref),
      bridgeHealthy: () => Promise.resolve(true),
      minutesRemaining: () => Promise.resolve({ minutes: null }),
      now: this.now,
      log: this.log,
    });
  }

  private async handleDispatches(project: Project): Promise<void> {
    const dispatches = this.github.state(project.ref).dispatches;
    const fresh = dispatches.slice(project.seenDispatches);
    project.seenDispatches = dispatches.length;
    for (const d of fresh) {
      if (d.workflow === PLANNER_WORKFLOW) await this.plan(project, d.inputs ?? {});
      if (d.workflow === AGENT_WORKFLOW) this.startAgent(project, d.inputs ?? {});
    }
  }

  private async plan(project: Project, inputs: Record<string, string>): Promise<void> {
    const outcome = await runPlanner(
      {
        ref: project.ref,
        mode: inputs.mode === 'regenerate' ? 'regenerate' : 'auto',
        model: inputs.model || 'modele-simule',
        ...(inputs.max_agents ? { maxAgents: Number(inputs.max_agents) } : {}),
      },
      {
        github: this.github,
        claude: project.claude,
        prompts: NO_PROMPTS,
        readFile: async (path) =>
          (await this.github.getFile(project.ref, path, 'main'))?.content ?? null,
        workspace: '.',
      },
    );
    if (outcome.phase === 'plan') project.planned = true;
    project.seenCadrage = await this.cadrageComments(project);
    this.log(`Planificateur (${project.ref.repo}) : ${outcome.phase}.`);
  }

  private async cadrageComments(project: Project): Promise<number> {
    const [cadrage] = await this.github.listIssues(project.ref, {
      labels: [CADRAGE_LABEL],
      state: 'all',
    });
    return cadrage ? (await this.github.listComments(project.ref, cadrage.number)).length : 0;
  }

  /** Une réponse de Kia dans l'issue Cadrage relance le planificateur (comme le workflow). */
  private async handleCadrage(project: Project): Promise<void> {
    if (project.planned || project.seenCadrage === 0) return;
    if ((await this.cadrageComments(project)) === project.seenCadrage) return;
    await this.plan(project, { mode: 'auto' });
  }

  private startAgent(project: Project, inputs: Record<string, string>): void {
    const issue = Number(inputs.issue_number);
    const attempt = Number(inputs.attempt ?? '1');
    const runId = nextRunId++;
    this.github.seedWorkflowRun(project.ref, {
      id: runId,
      name: 'AgentLake — agent',
      title: agentRunTitle(issue, attempt),
      workflow: AGENT_WORKFLOW,
      status: 'in_progress',
      conclusion: null,
      headBranch: 'main',
      event: 'workflow_dispatch',
      createdAt: this.now().toISOString(),
      url: `https://github.com/${project.ref.owner}/${project.ref.repo}/actions/runs/${String(runId)}`,
    });
    project.pending.push({ issue, attempt, runId });
  }

  /** Les agents lancés au tick précédent finissent : question bloquante ou livraison. */
  private async finishAgents(project: Project): Promise<void> {
    const { ref } = project;
    for (const agent of project.pending.splice(0)) {
      const issue = await this.github.getIssue(ref, agent.issue);
      const parsed = parseTaskIssueBody(issue.body);
      if (!parsed.ok) continue;
      const task = parsed.value;
      this.stats.launches.set(task.id, (this.stats.launches.get(task.id) ?? 0) + 1);
      const script = project.scenario.agents[task.id];
      if (script?.question && !project.asked.has(task.id)) {
        project.asked.add(task.id);
        await this.github.createComment(
          ref,
          agent.issue,
          renderQuestionComment({ ...script.question, blocking: true }),
        );
        await this.github.removeLabel(ref, agent.issue, stateLabel('running'));
        await this.github.addLabels(ref, agent.issue, [stateLabel('awaiting-answer')]);
      } else {
        await this.deliver(project, agent.issue, agent.attempt, task.id, task.title);
      }
      const run = this.github.state(ref).runs.find((r) => r.id === agent.runId);
      if (run) {
        run.status = 'completed';
        run.conclusion = 'success';
        run.updatedAt = this.now().toISOString();
      }
    }
  }

  private async deliver(
    project: Project,
    issue: number,
    attempt: number,
    taskId: string,
    title: string,
  ): Promise<void> {
    const { ref } = project;
    const branch = taskBranch(taskId, title);
    const sha = await this.github.commitFiles(ref, {
      branch,
      baseBranch: 'main',
      message: `feat(${taskId}): tentative ${String(attempt)}`,
      changes: [
        { path: `src/${taskId}.ts`, content: `export const tentative = ${String(attempt)};\n` },
        { path: `src/${taskId}.test.ts`, content: `// test de ${taskId}\n` },
      ],
    });
    const [existing] = await this.github.listPullRequests(ref, { head: branch, state: 'open' });
    const pr =
      existing ??
      (await this.github.createPullRequest(ref, {
        title: `${taskId} — ${title}`,
        body: `<!-- agentlake:pr task=${taskId} attempt=${String(attempt)} -->\nCloses #${String(issue)}`,
        head: branch,
        base: 'main',
      }));
    await this.github.enableAutoMerge(ref, pr.number);
    const left = project.failuresLeft.get(taskId) ?? 0;
    if (left > 0) project.failuresLeft.set(taskId, left - 1);
    this.github.seedCheckRuns(
      ref,
      sha,
      requiredChecksFor(project.qualityProfile).map((name) => ({
        name,
        status: 'completed',
        conclusion: left > 0 && name === 'unit-tests' ? 'failure' : 'success',
      })),
    );
  }

  /** Auto-merge : PR d'agent mergée dès que tous ses checks sont verts, issue fermée. */
  private async autoMerge(project: Project): Promise<void> {
    const { ref } = project;
    for (const pr of await this.github.listPullRequests(ref, { state: 'open' })) {
      if (!pr.autoMerge) continue;
      const checks = await this.github.listCheckRuns(ref, pr.headSha);
      if (checks.length === 0 || checks.some((c) => c.conclusion !== 'success')) continue;
      this.github.mergePullRequest(ref, pr.number);
      this.stats.merged += 1;
      const closes = /Closes #(\d+)/.exec(pr.body);
      if (closes) await this.github.updateIssue(ref, Number(closes[1]), { state: 'closed' });
      // La CI de main repasse au vert après le merge (le bootstrap l'a posée).
      this.github.seedCheckRuns(
        ref,
        'main',
        ciChecksFor(project.qualityProfile).map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
        })),
      );
    }
  }
}
