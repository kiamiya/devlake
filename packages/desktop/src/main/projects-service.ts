import type { GitHubPort } from 'github';
import { stateLabel } from 'shared';
import type { Activity, ProjectSummary, TabsState } from '../shared/ipc-contract.js';
import { discoverProjects, PROJECT_CONFIG_PATH, rebuildFromGitHub } from './db/rebuild.js';
import { projectId, type ProjectRow, type Repositories } from './db/repositories.js';

export class NotAProjectError extends Error {
  constructor(id: string) {
    super(`Le dépôt ${id} n’est pas un projet AgentLake (${PROJECT_CONFIG_PATH} absent).`);
    this.name = 'NotAProjectError';
  }
}

export class UnknownProjectError extends Error {
  constructor(id: string) {
    super(`Projet inconnu du cockpit : ${id}.`);
    this.name = 'UnknownProjectError';
  }
}

const AWAITING = stateLabel('awaiting-answer');
const ACTIVE = [stateLabel('running'), stateLabel('fixing')];

/**
 * Projets, onglets et activité. Fermer un onglet ou le cockpit
 * n'agit jamais sur GitHub : seules des lectures y sont faites ici.
 */
export class ProjectsService {
  constructor(
    private readonly repos: Repositories,
    private readonly github: () => Promise<GitHubPort>,
    /** Projet ajouté : la liste des projets de devlake-config est republiée. */
    private readonly onProjectAdded: () => Promise<void> = () => Promise.resolve(),
  ) {}

  private summary(project: ProjectRow): ProjectSummary {
    const open = this.repos.mirror.listIssues(project.id).filter((i) => i.state === 'open');
    return {
      id: project.id,
      owner: project.owner,
      repo: project.repo,
      lastSyncedAt: project.lastSyncedAt,
      pendingQuestions: open.filter((i) => i.labels.includes(AWAITING)).length,
      activeAgents: open.filter((i) => i.labels.some((l) => ACTIVE.includes(l))).length,
    };
  }

  private project(id: string): ProjectRow {
    const project = this.repos.projects.list().find((p) => p.id === id);
    if (!project) throw new UnknownProjectError(id);
    return project;
  }

  list(): ProjectSummary[] {
    return this.repos.projects.list().map((p) => this.summary(p));
  }

  /** Projets du compte pas encore connus du cockpit. */
  async discover(): Promise<{ owner: string; repo: string }[]> {
    const known = new Set(this.repos.projects.list().map((p) => p.id));
    return (await discoverProjects(await this.github())).filter(
      (ref) => !known.has(projectId(ref.owner, ref.repo)),
    );
  }

  /** Ajoute un dépôt déjà bootstrappé et recopie son état. */
  async open(ref: { owner: string; repo: string }): Promise<ProjectSummary> {
    const github = await this.github();
    if (!(await github.getFile(ref, PROJECT_CONFIG_PATH)))
      throw new NotAProjectError(projectId(ref.owner, ref.repo));
    const known = this.repos.projects.list().some((p) => p.id === projectId(ref.owner, ref.repo));
    await rebuildFromGitHub(ref, github, this.repos);
    // C_global compté sur tous les projets : un échec de publication ne bloque pas l'ouverture.
    if (!known) await this.onProjectAdded().catch(() => undefined);
    return this.summary(this.project(projectId(ref.owner, ref.repo)));
  }

  async sync(id: string): Promise<ProjectSummary> {
    const project = this.project(id);
    await rebuildFromGitHub(
      { owner: project.owner, repo: project.repo },
      await this.github(),
      this.repos,
    );
    return this.summary(this.project(id));
  }

  getTabs(): TabsState {
    const rows = this.repos.tabs.list();
    return {
      tabs: rows.map((t) => t.projectId),
      active: rows.find((t) => t.active)?.projectId ?? null,
    };
  }

  /** Enregistre les onglets ; les projets inconnus sont ignorés. */
  saveTabs(state: TabsState): TabsState {
    const known = new Set(this.repos.projects.list().map((p) => p.id));
    const tabs = [...new Set(state.tabs)].filter((id) => known.has(id));
    const active = state.active !== null && tabs.includes(state.active) ? state.active : null;
    this.repos.tabs.save(
      tabs.map((id, position) => ({ projectId: id, position, active: id === active })),
    );
    return this.getTabs();
  }

  activity(): Activity {
    const projects = this.list();
    return {
      activeAgents: projects.reduce((sum, p) => sum + p.activeAgents, 0),
      maxAgents: this.repos.settings.get().maxConcurrentAgents,
      pendingQuestions: projects.reduce((sum, p) => sum + p.pendingQuestions, 0),
    };
  }
}
