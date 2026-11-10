import type { GitHubPort, RepoRef } from 'github';
import type { Repositories } from './repositories.js';
import { projectId } from './repositories.js';

/** Fichier qui fait d'un dépôt un projet AgentLake. */
export const PROJECT_CONFIG_PATH = '.agentlake/project.yml';

export interface RebuildSummary {
  projects: number;
  issues: number;
  runs: number;
}

/** Recopie dans le cache les issues et runs d'un projet depuis GitHub. */
export async function rebuildFromGitHub(
  project: RepoRef,
  github: GitHubPort,
  repos: Repositories,
  now: () => string = () => new Date().toISOString(),
): Promise<{ issues: number; runs: number }> {
  const [issues, runs] = await Promise.all([
    github.listIssues(project, { state: 'all' }),
    github.listWorkflowRuns(project),
  ]);
  const id = projectId(project.owner, project.repo);
  repos.projects.upsert(project.owner, project.repo, now());
  repos.mirror.replaceIssues(
    id,
    issues.map(({ id: _id, ...issue }) => issue),
  );
  repos.mirror.replaceRuns(id, runs);
  repos.projects.markSynced(id, now());
  return { issues: issues.length, runs: runs.length };
}

/** Projets du compte et des organisations administrées : dépôts avec `.agentlake/project.yml`. */
export async function discoverProjects(github: GitHubPort): Promise<RepoRef[]> {
  const repositories = await github.listAdministrableRepositories();
  const found: RepoRef[] = [];
  for (const repository of repositories) {
    const ref = { owner: repository.owner, repo: repository.name };
    if (await github.getFile(ref, PROJECT_CONFIG_PATH)) found.push(ref);
  }
  return found;
}

/**
 * Reconstruit tout le cache depuis GitHub : projets connus localement
 * plus ceux découverts sur le compte (cache supprimé ou poste neuf).
 */
export async function rebuildAll(
  github: GitHubPort,
  repos: Repositories,
  now: () => string = () => new Date().toISOString(),
): Promise<RebuildSummary> {
  const known = repos.projects.list().map((p) => ({ owner: p.owner, repo: p.repo }));
  const discovered = await discoverProjects(github);
  const all = new Map(
    [...known, ...discovered].map((ref) => [projectId(ref.owner, ref.repo), ref]),
  );
  const summary: RebuildSummary = { projects: 0, issues: 0, runs: 0 };
  for (const ref of all.values()) {
    const counts = await rebuildFromGitHub(ref, github, repos, now);
    summary.projects += 1;
    summary.issues += counts.issues;
    summary.runs += counts.runs;
  }
  return summary;
}
