import { randomBytes } from 'node:crypto';
import { readBlockedBy, writeBlockedBy } from './dependencies-block.js';
import { GitHubError } from './errors.js';
import type { GitHubPort } from './port.js';
import { decryptSecret, generateSecretKeyPair, type SecretKeyPair } from './secrets.js';
import type {
  BranchProtection,
  BranchProtectionInput,
  Capabilities,
  CheckRun,
  Comment,
  CommitFilesInput,
  CreateIssueInput,
  CreatePullRequestInput,
  CreateRepositoryInput,
  DispatchWorkflowInput,
  FileContent,
  Issue,
  LabelDefinition,
  ListIssuesInput,
  ListPullRequestsInput,
  ListWorkflowRunsInput,
  PullRequest,
  RepoRef,
  Repository,
  UpdateIssueInput,
  WorkflowJob,
  WorkflowRun,
} from './types.js';

/** Fichiers d'une branche : chemin → contenu en base64. */
export type FileTree = Map<string, string>;

export interface FakeBranch {
  sha: string;
  files: FileTree;
}

interface FakeIssue extends Issue {
  isPullRequest: boolean;
}

type FakePullRequest = PullRequest;

export interface FakeRepoState {
  repository: Repository;
  issues: Map<number, FakeIssue>;
  pulls: Map<number, FakePullRequest>;
  nextNumber: number;
  labels: Map<string, LabelDefinition>;
  comments: Map<number, Comment[]>;
  blockedBy: Map<number, number[]>;
  branches: Map<string, FakeBranch>;
  /** Instantanés des commits : SHA → fichiers. */
  commits: Map<string, FileTree>;
  protections: Map<string, BranchProtection>;
  checkRuns: Map<string, CheckRun[]>;
  runs: WorkflowRun[];
  jobs: WorkflowJob[];
  logs: Map<number, string>;
  dispatches: DispatchWorkflowInput[];
  secrets: Map<string, string>;
  issueDependencies: boolean;
}

export interface FakeGitHubOptions {
  /** Compte authentifié (auteur des issues, commentaires, PR). */
  actor?: string;
  /** Relations de dépendance natives disponibles (vrai par défaut). */
  issueDependencies?: boolean;
}

let nextId = 1000;
function newId(): number {
  nextId += 1;
  return nextId;
}

export function newSha(): string {
  return randomBytes(20).toString('hex');
}

function notFound(what: string): GitHubError {
  return new GitHubError('not-found', `Introuvable sur GitHub : ${what}`, 404);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Doublure en mémoire fidèle du port GitHub, pour les tests des autres paquets.
 * Les méthodes `seed*` et `state` servent à préparer et inspecter l'état.
 */
export class FakeGitHub implements GitHubPort {
  readonly actor: string;
  private readonly defaultIssueDependencies: boolean;
  private readonly repos = new Map<string, FakeRepoState>();
  private keyPair: SecretKeyPair | undefined;

  constructor(options: FakeGitHubOptions = {}) {
    this.actor = options.actor ?? 'kiamiya';
    this.defaultIssueDependencies = options.issueDependencies ?? true;
  }

  // Préparation et inspection

  /** Crée un dépôt avec une branche `main` contenant un README. */
  seedRepository(ref: RepoRef, options: { private?: boolean } = {}): FakeRepoState {
    const sha = newSha();
    const files: FileTree = new Map([
      ['README.md', Buffer.from(`# ${ref.repo}\n`).toString('base64')],
    ]);
    const state: FakeRepoState = {
      repository: {
        owner: ref.owner,
        name: ref.repo,
        private: options.private ?? false,
        defaultBranch: 'main',
        allowAutoMerge: false,
        allowSquashMerge: true,
        allowMergeCommit: true,
        allowRebaseMerge: true,
        deleteBranchOnMerge: false,
      },
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      labels: new Map(),
      comments: new Map(),
      blockedBy: new Map(),
      branches: new Map([['main', { sha, files }]]),
      commits: new Map([[sha, new Map(files)]]),
      protections: new Map(),
      checkRuns: new Map(),
      runs: [],
      jobs: [],
      logs: new Map(),
      dispatches: [],
      secrets: new Map(),
      issueDependencies: this.defaultIssueDependencies,
    };
    this.repos.set(`${ref.owner}/${ref.repo}`, state);
    return state;
  }

  state(ref: RepoRef): FakeRepoState {
    const state = this.repos.get(`${ref.owner}/${ref.repo}`);
    if (!state) throw notFound(`dépôt ${ref.owner}/${ref.repo}`);
    return state;
  }

  seedCheckRuns(ref: RepoRef, sha: string, runs: CheckRun[]): void {
    this.state(ref).checkRuns.set(sha, clone(runs));
  }

  seedWorkflowRun(
    ref: RepoRef,
    run: WorkflowRun,
    jobs: { job: WorkflowJob; logs: string }[] = [],
  ): void {
    const state = this.state(ref);
    state.runs.push(clone(run));
    for (const { job, logs } of jobs) {
      state.jobs.push(clone(job));
      state.logs.set(job.id, logs);
    }
  }

  /** Simule le merge d'une PR par GitHub. */
  mergePullRequest(ref: RepoRef, prNumber: number): void {
    const pr = this.state(ref).pulls.get(prNumber);
    if (!pr) throw notFound(`PR #${String(prNumber)}`);
    pr.state = 'merged';
  }

  /** Valeur en clair d'un secret (les vrais secrets GitHub sont illisibles). */
  secretValue(ref: RepoRef, name: string): string | undefined {
    return this.state(ref).secrets.get(name);
  }

  /** Clé publique « GitHub » pour chiffrer les secrets. */
  async publicKey(): Promise<SecretKeyPair> {
    this.keyPair ??= await generateSecretKeyPair();
    return this.keyPair;
  }

  /** Reçoit un secret chiffré, comme l'API GitHub. */
  async putEncryptedSecret(ref: RepoRef, name: string, encryptedValue: string): Promise<void> {
    const value = await decryptSecret(await this.publicKey(), encryptedValue);
    this.state(ref).secrets.set(name, value);
  }

  // Dépôts

  createRepository(input: CreateRepositoryInput): Promise<Repository> {
    const ref = { owner: this.actor, repo: input.name };
    if (this.repos.has(`${ref.owner}/${ref.repo}`)) {
      return Promise.reject(
        new GitHubError('validation', `Le dépôt ${input.name} existe déjà.`, 422),
      );
    }
    return Promise.resolve(clone(this.seedRepository(ref, { private: input.private }).repository));
  }

  getRepository(ref: RepoRef): Promise<Repository> {
    return this.run(() => clone(this.state(ref).repository));
  }

  configureMergeSettings(ref: RepoRef): Promise<Repository> {
    return this.run(() => {
      const repository = this.state(ref).repository;
      Object.assign(repository, {
        allowAutoMerge: true,
        allowSquashMerge: true,
        allowMergeCommit: false,
        allowRebaseMerge: false,
        deleteBranchOnMerge: true,
      });
      return clone(repository);
    });
  }

  protectBranch(ref: RepoRef, branch: string, input: BranchProtectionInput): Promise<void> {
    return this.run(() => {
      const state = this.state(ref);
      if (!state.branches.has(branch)) throw notFound(`branche ${branch}`);
      state.protections.set(branch, {
        branch,
        requiredChecks: [...input.requiredChecks],
        enforceAdmins: input.enforceAdmins,
        requirePullRequest: true,
      });
    });
  }

  getBranchProtection(ref: RepoRef, branch: string): Promise<BranchProtection | null> {
    return this.run(() => clone(this.state(ref).protections.get(branch) ?? null));
  }

  getCapabilities(ref: RepoRef): Promise<Capabilities> {
    return this.run(() => {
      const state = this.state(ref);
      return {
        autoMerge: state.repository.allowAutoMerge,
        issueDependencies: state.issueDependencies,
      };
    });
  }

  // Fichiers

  getFile(ref: RepoRef, path: string, branch?: string): Promise<FileContent | null> {
    return this.run(() => {
      const state = this.state(ref);
      const target = state.branches.get(branch ?? state.repository.defaultBranch);
      if (!target) throw notFound(`branche ${branch ?? ''}`);
      const content = target.files.get(path);
      if (content === undefined) return null;
      return {
        path,
        sha: `${target.sha}:${path}`,
        content: Buffer.from(content, 'base64').toString('utf8'),
      };
    });
  }

  commitFiles(ref: RepoRef, input: CommitFilesInput): Promise<string> {
    return this.run(() => {
      const state = this.state(ref);
      const source =
        state.branches.get(input.branch) ??
        (input.baseBranch !== undefined ? state.branches.get(input.baseBranch) : undefined);
      if (!source) throw notFound(`branche ${input.branch}`);
      const files = new Map(source.files);
      for (const change of input.changes) {
        if ('delete' in change) files.delete(change.path);
        else
          files.set(
            change.path,
            change.encoding === 'base64'
              ? change.content
              : Buffer.from(change.content).toString('base64'),
          );
      }
      const sha = newSha();
      state.commits.set(sha, files);
      state.branches.set(input.branch, { sha, files: new Map(files) });
      return sha;
    });
  }

  // Issues, labels, commentaires

  private publicIssue(issue: FakeIssue): Issue {
    const { isPullRequest: _ignored, ...rest } = issue;
    return clone(rest);
  }

  private issue(ref: RepoRef, issueNumber: number): FakeIssue {
    const issue = this.state(ref).issues.get(issueNumber);
    if (!issue) throw notFound(`issue #${String(issueNumber)}`);
    return issue;
  }

  private touchLabels(state: FakeRepoState, labels: readonly string[]): void {
    for (const name of labels) {
      if (!state.labels.has(name)) state.labels.set(name, { name, color: 'ededed' });
    }
  }

  createIssue(ref: RepoRef, input: CreateIssueInput): Promise<Issue> {
    return this.run(() => {
      const state = this.state(ref);
      const labels = [...new Set(input.labels ?? [])];
      this.touchLabels(state, labels);
      const issue: FakeIssue = {
        id: newId(),
        number: state.nextNumber++,
        title: input.title,
        body: input.body,
        state: 'open',
        labels,
        author: this.actor,
        isPullRequest: false,
      };
      state.issues.set(issue.number, issue);
      return this.publicIssue(issue);
    });
  }

  getIssue(ref: RepoRef, issueNumber: number): Promise<Issue> {
    return this.run(() => this.publicIssue(this.issue(ref, issueNumber)));
  }

  updateIssue(ref: RepoRef, issueNumber: number, input: UpdateIssueInput): Promise<Issue> {
    return this.run(() => {
      const issue = this.issue(ref, issueNumber);
      if (input.title !== undefined) issue.title = input.title;
      if (input.body !== undefined) issue.body = input.body;
      if (input.state !== undefined) issue.state = input.state;
      return this.publicIssue(issue);
    });
  }

  listIssues(ref: RepoRef, input: ListIssuesInput = {}): Promise<Issue[]> {
    return this.run(() => {
      const wanted = input.state ?? 'open';
      return [...this.state(ref).issues.values()]
        .filter((i) => !i.isPullRequest)
        .filter((i) => wanted === 'all' || i.state === wanted)
        .filter((i) => (input.labels ?? []).every((l) => i.labels.includes(l)))
        .sort((a, b) => b.number - a.number)
        .map((i) => this.publicIssue(i));
    });
  }

  ensureLabels(ref: RepoRef, labels: LabelDefinition[]): Promise<void> {
    return this.run(() => {
      const state = this.state(ref);
      for (const label of labels) state.labels.set(label.name, clone(label));
    });
  }

  listLabels(ref: RepoRef): Promise<LabelDefinition[]> {
    return this.run(() => [...this.state(ref).labels.values()].map(clone));
  }

  addLabels(ref: RepoRef, issueNumber: number, labels: string[]): Promise<void> {
    return this.run(() => {
      const issue = this.issue(ref, issueNumber);
      this.touchLabels(this.state(ref), labels);
      issue.labels = [...new Set([...issue.labels, ...labels])];
    });
  }

  removeLabel(ref: RepoRef, issueNumber: number, label: string): Promise<void> {
    return this.run(() => {
      const issue = this.issue(ref, issueNumber);
      issue.labels = issue.labels.filter((l) => l !== label);
    });
  }

  listComments(ref: RepoRef, issueNumber: number): Promise<Comment[]> {
    return this.run(() => {
      this.issue(ref, issueNumber);
      return clone(this.state(ref).comments.get(issueNumber) ?? []);
    });
  }

  createComment(ref: RepoRef, issueNumber: number, body: string): Promise<Comment> {
    return this.run(() => {
      this.issue(ref, issueNumber);
      const state = this.state(ref);
      const comment: Comment = {
        id: newId(),
        body,
        author: this.actor,
        createdAt: new Date().toISOString(),
      };
      state.comments.set(issueNumber, [...(state.comments.get(issueNumber) ?? []), comment]);
      return clone(comment);
    });
  }

  // Relations de dépendance

  getDependencies(ref: RepoRef, issueNumber: number): Promise<number[]> {
    return this.run(() => {
      const state = this.state(ref);
      const issue = this.issue(ref, issueNumber);
      if (!state.issueDependencies) return readBlockedBy(issue.body);
      return [...(state.blockedBy.get(issueNumber) ?? [])].sort((a, b) => a - b);
    });
  }

  setDependencies(ref: RepoRef, issueNumber: number, blockedBy: number[]): Promise<void> {
    return this.run(() => {
      const state = this.state(ref);
      const issue = this.issue(ref, issueNumber);
      for (const number of blockedBy) this.issue(ref, number);
      if (!state.issueDependencies) {
        issue.body = writeBlockedBy(issue.body, blockedBy);
        return;
      }
      state.blockedBy.set(issueNumber, [...new Set(blockedBy)]);
    });
  }

  // Pull requests et checks

  private pull(ref: RepoRef, prNumber: number): FakePullRequest {
    const pr = this.state(ref).pulls.get(prNumber);
    if (!pr) throw notFound(`PR #${String(prNumber)}`);
    return pr;
  }

  createPullRequest(ref: RepoRef, input: CreatePullRequestInput): Promise<PullRequest> {
    return this.run(() => {
      const state = this.state(ref);
      const head = state.branches.get(input.head);
      if (!head) throw new GitHubError('validation', `Branche ${input.head} absente.`, 422);
      if (!state.branches.has(input.base))
        throw new GitHubError('validation', `Branche ${input.base} absente.`, 422);
      const pr: FakePullRequest = {
        number: state.nextNumber++,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        headSha: head.sha,
        state: 'open',
        autoMerge: false,
        author: this.actor,
      };
      state.pulls.set(pr.number, pr);
      state.issues.set(pr.number, {
        id: newId(),
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: 'open',
        labels: [],
        author: this.actor,
        isPullRequest: true,
      });
      return clone(pr);
    });
  }

  getPullRequest(ref: RepoRef, prNumber: number): Promise<PullRequest> {
    return this.run(() => {
      const pr = this.pull(ref, prNumber);
      const head = this.state(ref).branches.get(pr.head);
      if (head) pr.headSha = head.sha;
      return clone(pr);
    });
  }

  listPullRequests(ref: RepoRef, input: ListPullRequestsInput = {}): Promise<PullRequest[]> {
    return this.run(() => {
      const wanted = input.state ?? 'open';
      return [...this.state(ref).pulls.values()]
        .filter(
          (p) => wanted === 'all' || (wanted === 'open' ? p.state === 'open' : p.state !== 'open'),
        )
        .filter((p) => input.head === undefined || p.head === input.head)
        .sort((a, b) => b.number - a.number)
        .map(clone);
    });
  }

  enableAutoMerge(ref: RepoRef, prNumber: number): Promise<void> {
    return this.run(() => {
      const state = this.state(ref);
      const pr = this.pull(ref, prNumber);
      if (!state.repository.allowAutoMerge) {
        throw new GitHubError(
          'validation',
          'Auto-merge refusé par GitHub : auto-merge désactivé sur le dépôt.',
        );
      }
      pr.autoMerge = true;
    });
  }

  listCheckRuns(ref: RepoRef, sha: string): Promise<CheckRun[]> {
    return this.run(() => clone(this.state(ref).checkRuns.get(sha) ?? []));
  }

  // Actions

  dispatchWorkflow(ref: RepoRef, input: DispatchWorkflowInput): Promise<void> {
    return this.run(() => {
      const state = this.state(ref);
      if (!state.branches.has(input.ref))
        throw new GitHubError('validation', `Référence ${input.ref} absente.`, 422);
      state.dispatches.push({
        workflow: input.workflow,
        ref: input.ref,
        inputs: { ...(input.inputs ?? {}) },
      });
    });
  }

  listWorkflowRuns(ref: RepoRef, input: ListWorkflowRunsInput = {}): Promise<WorkflowRun[]> {
    return this.run(() =>
      this.state(ref)
        .runs.filter((r) => input.workflow === undefined || r.workflow === input.workflow)
        .filter((r) => input.branch === undefined || r.headBranch === input.branch)
        .filter((r) => input.event === undefined || r.event === input.event)
        .map(clone),
    );
  }

  getWorkflowRun(ref: RepoRef, runId: number): Promise<WorkflowRun> {
    return this.run(() => {
      const run = this.state(ref).runs.find((r) => r.id === runId);
      if (!run) throw notFound(`run ${String(runId)}`);
      return clone(run);
    });
  }

  listRunJobs(ref: RepoRef, runId: number): Promise<WorkflowJob[]> {
    return this.run(() =>
      this.state(ref)
        .jobs.filter((j) => j.runId === runId)
        .map(clone),
    );
  }

  getJobLogs(ref: RepoRef, jobId: number): Promise<string> {
    return this.run(() => {
      const logs = this.state(ref).logs.get(jobId);
      if (logs === undefined) throw notFound(`journaux du job ${String(jobId)}`);
      return logs;
    });
  }

  // Secrets

  setRepositorySecret(ref: RepoRef, name: string, value: string): Promise<void> {
    return this.run(() => {
      this.state(ref).secrets.set(name, value);
    });
  }

  listRepositorySecrets(ref: RepoRef): Promise<string[]> {
    return this.run(() => [...this.state(ref).secrets.keys()].sort());
  }

  /** Exécute de façon asynchrone et transforme les exceptions en promesses rejetées. */
  private run<T>(action: () => T): Promise<T> {
    try {
      return Promise.resolve(action());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
