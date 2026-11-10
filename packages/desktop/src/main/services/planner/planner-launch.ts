import type { GitHubPort } from 'github';
import type { Repositories } from '../../db/repositories.js';
import { UnknownProjectError } from '../../projects-service.js';

export const PLANNER_CALLER = 'agentlake-planner.yml';

export class PlannerModelMissingError extends Error {
  constructor() {
    super('Aucun modèle pour le planificateur : le choisir dans les réglages avant de lancer.');
    this.name = 'PlannerModelMissingError';
  }
}

/** Lance le planificateur d'un projet (workflow_dispatch du workflow d'appel posé au bootstrap). */
export class PlannerLaunchService {
  constructor(
    private readonly repos: Repositories,
    private readonly github: () => Promise<GitHubPort>,
  ) {}

  async start(input: {
    projectId: string;
    mode: 'auto' | 'regenerate' | 'inventory';
    instruction?: string | undefined;
  }): Promise<{ dispatched: true }> {
    const project = this.repos.projects.list().find((p) => p.id === input.projectId);
    if (!project) throw new UnknownProjectError(input.projectId);
    const settings = this.repos.settings.get();
    if (settings.plannerModel === null) throw new PlannerModelMissingError();
    await (
      await this.github()
    ).dispatchWorkflow(
      { owner: project.owner, repo: project.repo },
      {
        workflow: PLANNER_CALLER,
        ref: 'main',
        inputs: {
          mode: input.mode,
          model: settings.plannerModel,
          max_agents: String(settings.maxConcurrentAgents),
          instruction: input.instruction?.trim() ?? '',
        },
      },
    );
    return { dispatched: true };
  }
}
