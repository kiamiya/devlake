import type { GitHubPort, RepoRef } from 'github';
import {
  formatZodError,
  parseTaskIssueBody,
  profileLabel,
  ProjectConfigSchema,
  ProjectPlanSchema,
  renderTaskIssueBody,
  renderTaskIssueTitle,
  stateLabel,
  TASK_LABEL,
  type ProjectConfig,
  type ProjectPlan,
} from 'shared';
import { parse, stringify } from 'yaml';
import type { Repositories } from '../../db/repositories.js';
import { UnknownProjectError } from '../../projects-service.js';

export const PLAN_PATH = '.agentlake/plan.json';
export const PROJECT_CONFIG_PATH = '.agentlake/project.yml';
export const DISPATCHER_CALLER = 'agentlake-dispatcher.yml';

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

export interface PlanVersion {
  version: number;
  branch: string;
}

export interface ValidationReport {
  /** Tâches → numéro d'issue. */
  issues: { taskId: string; issueNumber: number; created: boolean }[];
  dependencies: number;
  planCommitted: boolean;
  dispatched: boolean;
  warnings: string[];
}

const branchOf = (version: number) => `plan/v${String(version)}`;

function serialize(plan: ProjectPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** Lecture, édition et validation des plans d'un projet. */
export class PlanService {
  constructor(
    private readonly repos: Repositories,
    private readonly github: () => Promise<GitHubPort>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private ref(projectId: string): RepoRef {
    const project = this.repos.projects.list().find((p) => p.id === projectId);
    if (!project) throw new UnknownProjectError(projectId);
    return { owner: project.owner, repo: project.repo };
  }

  private static parsePlan(text: string, where: string): ProjectPlan {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new PlanError(`${where} : plan.json n’est pas un JSON valide.`);
    }
    const parsed = ProjectPlanSchema.safeParse(data);
    if (!parsed.success)
      throw new PlanError(`${where} : plan invalide.\n${formatZodError(parsed.error)}`);
    return parsed.data;
  }

  /** Versions proposées par le planificateur (branches plan/v1, plan/v2…). */
  async versions(projectId: string): Promise<PlanVersion[]> {
    const github = await this.github();
    const ref = this.ref(projectId);
    const found: PlanVersion[] = [];
    for (let version = 1; await github.branchExists(ref, branchOf(version)); version += 1) {
      found.push({ version, branch: branchOf(version) });
    }
    return found;
  }

  async get(
    projectId: string,
    version: number,
  ): Promise<{ plan: ProjectPlan; config: ProjectConfig | null }> {
    const github = await this.github();
    const ref = this.ref(projectId);
    const file = await github.getFile(ref, PLAN_PATH, branchOf(version));
    if (!file) throw new PlanError(`Aucun plan sur ${branchOf(version)}.`);
    return {
      plan: PlanService.parsePlan(file.content, branchOf(version)),
      config: await this.config(github, ref),
    };
  }

  private async config(github: GitHubPort, ref: RepoRef): Promise<ProjectConfig | null> {
    const file = await github.getFile(ref, PROJECT_CONFIG_PATH);
    if (!file) return null;
    const parsed = ProjectConfigSchema.safeParse(parse(file.content));
    return parsed.success ? parsed.data : null;
  }

  /** Enregistre un plan modifié et revalidé sur sa branche plan/vN. */
  async save(
    projectId: string,
    version: number,
    plan: ProjectPlan,
  ): Promise<{ commitSha: string | null }> {
    const valid = ProjectPlanSchema.safeParse(plan);
    if (!valid.success) throw new PlanError(`Plan refusé :\n${formatZodError(valid.error)}`);
    const github = await this.github();
    const ref = this.ref(projectId);
    const branch = branchOf(version);
    const current = await github.getFile(ref, PLAN_PATH, branch);
    if (!current) throw new PlanError(`Aucun plan sur ${branch}.`);
    if (current.content === serialize(valid.data)) return { commitSha: null };
    return {
      commitSha: await github.commitFiles(ref, {
        branch,
        message: `docs(plan): ajustements de Kia sur le plan v${String(version)}`,
        changes: [{ path: PLAN_PATH, content: serialize(valid.data) }],
      }),
    };
  }

  /** Plafond d'agents du projet (C_projet) dans project.yml ; null pour le retirer. */
  async setProjectCap(projectId: string, cap: number | null): Promise<ProjectConfig> {
    const github = await this.github();
    const ref = this.ref(projectId);
    const config = await this.config(github, ref);
    if (!config) throw new PlanError(`${PROJECT_CONFIG_PATH} absent ou invalide.`);
    const { maxConcurrentAgents: _previous, ...limits } = config.limits;
    const next: ProjectConfig = {
      ...config,
      limits: cap === null ? limits : { ...limits, maxConcurrentAgents: cap },
    };
    if (JSON.stringify(next) !== JSON.stringify(config)) {
      await github.commitFiles(ref, {
        branch: 'main',
        message: `chore(projet): plafond d’agents ${cap === null ? 'retiré' : `à ${String(cap)}`}`,
        changes: [
          {
            path: PROJECT_CONFIG_PATH,
            content: `# Configuration AgentLake du projet.\n${stringify(ProjectConfigSchema.parse(next))}`,
          },
        ],
      });
    }
    return next;
  }

  /**
   * Validation : plan sur main (avec validatedAt), une issue par tâche, relations de dépendance,
   * puis dispatcher. Idempotente : rien n'est recréé ni recommité si tout est déjà en place.
   */
  async validate(projectId: string, version: number): Promise<ValidationReport> {
    const github = await this.github();
    const ref = this.ref(projectId);
    const proposed = (await this.get(projectId, version)).plan;
    const report: ValidationReport = {
      issues: [],
      dependencies: 0,
      planCommitted: false,
      dispatched: false,
      warnings: [],
    };

    // 1. Plan sur main : on garde la date de validation si ce plan y est déjà.
    const onMain = await github.getFile(ref, PLAN_PATH);
    const existing = onMain ? PlanService.parsePlan(onMain.content, 'main') : null;
    const { validatedAt: _ignored, ...withoutDate } = proposed;
    const sameAsMain =
      existing !== null &&
      JSON.stringify({ ...existing, validatedAt: undefined }) ===
        JSON.stringify({ ...withoutDate, validatedAt: undefined });
    if (!sameAsMain) {
      const validated: ProjectPlan = { ...withoutDate, validatedAt: this.now() };
      await github.commitFiles(ref, {
        branch: 'main',
        message: `docs(plan): plan v${String(version)} validé`,
        changes: [{ path: PLAN_PATH, content: serialize(validated) }],
      });
      report.planCommitted = true;
    }

    // 2. Une issue par tâche, retrouvée par son bloc caché agentlake:task.
    const byTask = new Map<string, number>();
    for (const issue of await github.listIssues(ref, { labels: [TASK_LABEL], state: 'all' })) {
      const task = parseTaskIssueBody(issue.body);
      if (task.ok && !byTask.has(task.value.id)) byTask.set(task.value.id, issue.number);
    }
    for (const task of proposed.tasks) {
      const known = byTask.get(task.id);
      if (known !== undefined) {
        report.issues.push({ taskId: task.id, issueNumber: known, created: false });
        continue;
      }
      const issue = await github.createIssue(ref, {
        title: renderTaskIssueTitle(task),
        body: renderTaskIssueBody(task),
        labels: [TASK_LABEL, stateLabel('queued'), profileLabel(task.profile)],
      });
      byTask.set(task.id, issue.number);
      report.issues.push({ taskId: task.id, issueNumber: issue.number, created: true });
    }

    // 3. Relations de dépendance (natives ou repli dans le corps, selon le compte).
    for (const task of proposed.tasks) {
      const issueNumber = byTask.get(task.id);
      if (issueNumber === undefined) continue;
      const wanted = task.dependencies
        .map((d) => byTask.get(d))
        .filter((n): n is number => n !== undefined)
        .sort((a, b) => a - b);
      const current = await github.getDependencies(ref, issueNumber);
      if (JSON.stringify(current) !== JSON.stringify(wanted))
        await github.setDependencies(ref, issueNumber, wanted);
      report.dependencies += wanted.length;
    }

    // 4. Le dispatcher prend le relais (T12) ; son absence n'empêche pas la validation.
    try {
      await github.dispatchWorkflow(ref, { workflow: DISPATCHER_CALLER, ref: 'main' });
      report.dispatched = true;
    } catch (error) {
      report.warnings.push(
        `Dispatcher non déclenché : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return report;
  }
}
