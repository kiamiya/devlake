import type { GitHubPort, RepoRef } from 'github';
import {
  AVAILABLE_TOOLS_PATH,
  AvailableToolsSchema,
  ProjectConfigSchema,
  type AvailableTools,
} from 'shared';
import { parse } from 'yaml';
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
    const github = await this.github();
    await this.publishTools(github, { owner: project.owner, repo: project.repo });
    await github.dispatchWorkflow(
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

  /**
   * Projet de jeu : outils d'éditeur autorisés sur le poste, publiés pour que le planificateur
   * choisisse le périmètre d'outils de chaque tâche. Rien n'est commité s'ils n'ont pas changé.
   */
  private async publishTools(github: GitHubPort, ref: RepoRef): Promise<void> {
    const file = await github.getFile(ref, '.agentlake/project.yml', 'main');
    const type =
      file === null ? undefined : ProjectConfigSchema.safeParse(parse(file.content)).data?.type;
    if (type !== 'unity' && type !== 'unreal') return;
    const bridge = this.repos.settings.get().auraBridge;
    const tools: AvailableTools = {
      version: 1,
      editors: { [type]: bridge[type].allowedTools, blender: bridge.blender.allowedTools },
    };
    const content = `${JSON.stringify(AvailableToolsSchema.parse(tools), null, 2)}\n`;
    if ((await github.getFile(ref, AVAILABLE_TOOLS_PATH, 'main'))?.content === content) return;
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'chore(agentlake): outils d’éditeur autorisés',
      changes: [{ path: AVAILABLE_TOOLS_PATH, content }],
    });
  }
}
