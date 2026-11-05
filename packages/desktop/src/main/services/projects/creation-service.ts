import type { GitHubPort } from 'github';
import { ProjectConfigSchema } from 'shared';
import { parse } from 'yaml';
import type { CreateProjectInput, ProjectSummary } from '../../../shared/ipc-contract.js';
import type { Repositories } from '../../db/repositories.js';
import {
  NotAProjectError,
  UnknownProjectError,
  type ProjectsService,
} from '../../projects-service.js';
import type { SecretVault } from '../../vault.js';
import { bootstrapProject, type BootstrapReport } from './bootstrap.js';
import { PROJECT_CONFIG_PATH } from './files.js';

export interface CreationDeps {
  repos: Repositories;
  vault: SecretVault;
  github: () => Promise<GitHubPort>;
  projects: ProjectsService;
  callerTemplates: Readonly<Record<string, string>>;
  profileTemplates: Readonly<Record<string, string>>;
}

/** Création d'un projet par l'assistant, et relance du bootstrap d'un projet existant. */
export class ProjectCreationService {
  constructor(private readonly deps: CreationDeps) {}

  private async bootstrap(input: CreateProjectInput): Promise<BootstrapReport> {
    const settings = this.deps.repos.settings.get();
    return bootstrapProject(input, {
      github: await this.deps.github(),
      vault: this.deps.vault,
      workflowsRef: settings.workflowsVersion,
      maxAttempts: settings.maxAttempts,
      callerTemplates: this.deps.callerTemplates,
      profileTemplates: this.deps.profileTemplates,
    });
  }

  async create(
    input: CreateProjectInput,
  ): Promise<{ project: ProjectSummary; report: BootstrapReport }> {
    const report = await this.bootstrap(input);
    const project = await this.deps.projects.open(report.repository);
    return { project, report };
  }

  /** Relance le bootstrap avec le type et le profil qualité lus dans project.yml. */
  async rebootstrap(projectId: string): Promise<BootstrapReport> {
    const project = this.deps.repos.projects.list().find((p) => p.id === projectId);
    if (!project) throw new UnknownProjectError(projectId);
    const github = await this.deps.github();
    const ref = { owner: project.owner, repo: project.repo };
    const file = await github.getFile(ref, PROJECT_CONFIG_PATH);
    if (!file) throw new NotAProjectError(projectId);
    const config = ProjectConfigSchema.parse(parse(file.content));
    const repository = await github.getRepository(ref);
    return this.bootstrap({
      name: project.repo,
      type: config.type,
      private: repository.private,
      qualityProfile: config.qualityProfile,
    });
  }
}
