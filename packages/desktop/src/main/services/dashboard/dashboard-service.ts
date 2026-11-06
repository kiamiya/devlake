import { unzipSync, strFromU8 } from 'fflate';
import type { GitHubPort, RepoRef } from 'github';
import {
  isPausedValue,
  parseAnswerComment,
  parseQuestionComment,
  PAUSE_VARIABLE,
  readDispatchMeta,
  renderAnswerComment,
  stateLabel,
  writeDispatchMeta,
} from 'shared';
import {
  computeConsumption,
  computeProgress,
  dashboardTasks,
  runViews,
} from '../../../shared/dashboard.js';
import type { DashboardView } from '../../../shared/ipc-contract.js';
import type { Repositories } from '../../db/repositories.js';
import { UnknownProjectError } from '../../projects-service.js';

const PR_MARKER = /<!-- agentlake:pr task=(T\d+) /;

export class DashboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashboardError';
  }
}

export interface DashboardDeps {
  repos: Repositories;
  github: () => Promise<GitHubPort>;
  now?: () => Date;
}

/** Texte d'une archive d'artefact : chaque fichier texte, précédé de son nom. */
export function artifactText(zip: Uint8Array): string {
  const files = unzipSync(zip);
  const names = Object.keys(files).sort();
  if (names.length === 0) return '';
  return names
    .map((name) => {
      const raw = strFromU8(files[name] ?? new Uint8Array());
      let text = raw;
      if (name.endsWith('.json')) {
        try {
          text = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          text = raw;
        }
      }
      return names.length === 1 ? text : `=== ${name} ===\n${text}`;
    })
    .join('\n\n');
}

/**
 * Tableau de bord d'un projet : lit le miroir local (issues, runs, sondé toutes les 30 s)
 * et GitHub pour ce qui n'y est pas (PR, pause, journaux, transcriptions).
 */
export class DashboardService {
  private readonly now: () => Date;

  constructor(private readonly deps: DashboardDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private ref(projectId: string): RepoRef {
    const project = this.deps.repos.projects.list().find((p) => p.id === projectId);
    if (!project) throw new UnknownProjectError(projectId);
    return { owner: project.owner, repo: project.repo };
  }

  async get(projectId: string): Promise<DashboardView> {
    const ref = this.ref(projectId);
    const github = await this.deps.github();
    const tasks = dashboardTasks(this.deps.repos.mirror.listIssues(projectId));
    const now = this.now();
    const runs = runViews(this.deps.repos.mirror.listRuns(projectId), tasks, now);
    const [paused, pulls] = await Promise.all([
      github.getRepositoryVariable(ref, PAUSE_VARIABLE),
      github.listPullRequests(ref, { state: 'all' }),
    ]);
    const pullRequests: Record<string, { number: number; url: string; state: string }> = {};
    for (const pr of [...pulls].sort((a, b) => a.number - b.number)) {
      const task = PR_MARKER.exec(pr.body)?.[1];
      if (task !== undefined)
        pullRequests[task] = {
          number: pr.number,
          url: `https://github.com/${ref.owner}/${ref.repo}/pull/${String(pr.number)}`,
          state: pr.state,
        };
    }
    return {
      projectId,
      repositoryUrl: `https://github.com/${ref.owner}/${ref.repo}`,
      paused: isPausedValue(paused),
      tasks,
      progress: computeProgress(tasks),
      runs,
      consumption: computeConsumption(runs, now),
      pullRequests,
    };
  }

  /** Pause : variable AGENTLAKE_PAUSED du dépôt, lue par le dispatcher à chaque passe. */
  async setPaused(projectId: string, paused: boolean): Promise<{ paused: boolean }> {
    const ref = this.ref(projectId);
    await (await this.deps.github()).setRepositoryVariable(ref, PAUSE_VARIABLE, String(paused));
    return { paused };
  }

  /**
   * Relance d'une tâche escaladée : compteur d'échecs remis à zéro, puis réponse « Relancer »
   * à la question d'escalade ; le dispatcher relance l'agent avec cette réponse.
   */
  async relaunch(
    projectId: string,
    issueNumber: number,
    instruction: string,
  ): Promise<{ questionId: string }> {
    const ref = this.ref(projectId);
    const github = await this.deps.github();
    const issue = await github.getIssue(ref, issueNumber);
    if (issue.state !== 'open' || !issue.labels.includes(stateLabel('escalated')))
      throw new DashboardError(`L’issue #${String(issueNumber)} n’est pas une tâche escaladée.`);
    const comments = await github.listComments(ref, issueNumber);
    const pending = comments
      .map((c, index) => ({ q: parseQuestionComment(c.body), index }))
      .filter((x) => x.q.ok && x.q.value.blocking)
      .at(-1);
    if (!pending?.q.ok)
      throw new DashboardError(`Aucune question d’escalade sur l’issue #${String(issueNumber)}.`);
    const questionId = pending.q.value.id;
    const answered = comments.slice(pending.index + 1).some((c) => {
      const a = parseAnswerComment(c.body);
      return a.ok && a.value.id === questionId;
    });
    if (answered)
      throw new DashboardError(`La question ${questionId} a déjà une réponse : relance en cours.`);

    // Échecs = tentatives − reprises : toutes les tentatives passées deviennent des reprises.
    const meta = readDispatchMeta(issue.body);
    await github.updateIssue(ref, issueNumber, {
      body: writeDispatchMeta(issue.body, { ...meta, resumes: meta.attempts }),
    });
    const consigne = instruction.trim();
    await github.createComment(
      ref,
      issueNumber,
      renderAnswerComment({
        id: questionId,
        decision: false,
        text: consigne === '' ? 'Relancer.' : `Relancer avec cette consigne : ${consigne}`,
      }),
    );
    return { questionId };
  }

  /** Journaux des jobs d'un run, dans l'ordre, précédés du nom du job. */
  async logs(projectId: string, runId: number): Promise<{ text: string }> {
    const ref = this.ref(projectId);
    const github = await this.deps.github();
    const jobs = await github.listRunJobs(ref, runId);
    if (jobs.length === 0) return { text: '' };
    const parts: string[] = [];
    for (const job of jobs)
      parts.push(`=== ${job.name} ===\n${await github.getJobLogs(ref, job.id)}`);
    return { text: parts.join('\n') };
  }

  /** Transcription de session : artefact du run (archive zip), décompressé. */
  async transcript(
    projectId: string,
    runId: number,
  ): Promise<{ name: string; text: string } | null> {
    const ref = this.ref(projectId);
    const github = await this.deps.github();
    const artifact = (await github.listRunArtifacts(ref, runId)).find((a) => !a.expired);
    if (!artifact) return null;
    return {
      name: artifact.name,
      text: artifactText(await github.downloadArtifact(ref, artifact.id)),
    };
  }
}
