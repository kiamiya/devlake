import type { GitHubPort, RepoRef } from 'github';
import {
  countRequiredTests,
  formatZodError,
  parseTaskIssueBody,
  PlanTaskSchema,
  profileLabel,
  renderTaskIssueBody,
  renderTaskIssueTitle,
  stateLabel,
  TASK_LABEL,
  type PlanTask,
} from 'shared';
import type { AdhocTaskInput } from '../../../shared/ipc-contract.js';
import type { Repositories } from '../../db/repositories.js';
import { UnknownProjectError } from '../../projects-service.js';
import { DISPATCHER_CALLER, PLAN_PATH } from '../plan/plan-service.js';

/** Identifiants des tâches ad hoc : à partir de T500, hors de la plage des plans. */
export const ADHOC_FIRST_ID = 500;

export class AdhocTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdhocTaskError';
  }
}

export interface AdhocTaskResult {
  taskId: string;
  issueNumber: number;
  url: string;
  dispatched: boolean;
  warnings: string[];
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

/**
 * Tâche ajoutée hors plan depuis le cockpit : validée comme une tâche du plan, créée en issue
 * avec ses dépendances, puis le dispatcher est déclenché pour la lancer dans les plafonds.
 */
export class AdhocTaskService {
  constructor(
    private readonly repos: Repositories,
    private readonly github: () => Promise<GitHubPort>,
  ) {}

  private ref(projectId: string): RepoRef {
    const project = this.repos.projects.list().find((p) => p.id === projectId);
    if (!project) throw new UnknownProjectError(projectId);
    return { owner: project.owner, repo: project.repo };
  }

  /** Tâches du projet, d'après les issues (ouvertes et fermées). */
  private async existing(github: GitHubPort, ref: RepoRef) {
    const byId = new Map<string, number>();
    for (const issue of await github.listIssues(ref, { labels: [TASK_LABEL], state: 'all' })) {
      const task = parseTaskIssueBody(issue.body);
      if (task.ok && !byId.has(task.value.id)) byId.set(task.value.id, issue.number);
    }
    return byId;
  }

  /** Prochain identifiant ad hoc : au-delà de toutes les tâches connues et de T500. */
  private async nextId(github: GitHubPort, ref: RepoRef, known: Iterable<string>) {
    const ids = [...known];
    const plan = await github.getFile(ref, PLAN_PATH, 'main');
    if (plan) {
      try {
        const tasks = (JSON.parse(plan.content) as { tasks?: { id?: unknown }[] }).tasks ?? [];
        for (const t of tasks) if (typeof t.id === 'string') ids.push(t.id);
      } catch {
        // Plan illisible : seules les issues comptent.
      }
    }
    const max = Math.max(ADHOC_FIRST_ID - 1, ...ids.map((id) => Number(id.slice(1)) || 0));
    return `T${String(max + 1)}`;
  }

  async create(input: AdhocTaskInput): Promise<AdhocTaskResult> {
    const ref = this.ref(input.projectId);
    const github = await this.github();
    const known = await this.existing(github, ref);
    const unknown = input.dependencies.filter((d) => !known.has(d));
    if (unknown.length > 0)
      throw new AdhocTaskError(`Dépendances inconnues dans ce projet : ${unknown.join(', ')}.`);

    const tests = lines(input.tests);
    const draft = {
      id: await this.nextId(github, ref, known.keys()),
      title: input.title,
      description: input.description,
      kind: input.kind,
      profile: input.profile,
      complexity: input.complexity,
      acceptanceCriteria: lines(input.acceptanceCriteria),
      requiredTests: tests.length > 0 ? { [input.testCategory]: tests } : {},
      codeZones: lines(input.codeZones),
      exclusiveResources: [],
      dependencies: [...new Set(input.dependencies)],
      adhoc: true,
      ...(input.priority ? { priority: true } : {}),
    };
    const parsed = PlanTaskSchema.safeParse(draft);
    if (!parsed.success) throw new AdhocTaskError(formatZodError(parsed.error));
    const task: PlanTask = parsed.data;
    // Même règle que le plan : une tâche de code exige ses tests.
    if (task.kind === 'code' && countRequiredTests(task.requiredTests) === 0)
      throw new AdhocTaskError('Une tâche de code doit exiger au moins un test.');

    const issue = await github.createIssue(ref, {
      title: renderTaskIssueTitle(task),
      body: renderTaskIssueBody(task),
      labels: [TASK_LABEL, stateLabel('queued'), profileLabel(task.profile)],
    });
    const blockedBy = task.dependencies
      .map((d) => known.get(d))
      .filter((n): n is number => n !== undefined)
      .sort((a, b) => a - b);
    if (blockedBy.length > 0) await github.setDependencies(ref, issue.number, blockedBy);

    const result: AdhocTaskResult = {
      taskId: task.id,
      issueNumber: issue.number,
      url: `https://github.com/${ref.owner}/${ref.repo}/issues/${String(issue.number)}`,
      dispatched: false,
      warnings: [],
    };
    try {
      await github.dispatchWorkflow(ref, { workflow: DISPATCHER_CALLER, ref: 'main' });
      result.dispatched = true;
    } catch (error) {
      result.warnings.push(
        `Dispatcher non déclenché (la passe planifiée la prendra) : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return result;
  }
}
