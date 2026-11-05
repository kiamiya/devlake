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

/**
 * Toutes les interactions avec GitHub. Implémenté par `OctokitGitHub` (réel)
 * et `FakeGitHub` (doublure en mémoire). Les erreurs sont des `GitHubError`.
 */
export interface GitHubPort {
  // Dépôts
  createRepository(input: CreateRepositoryInput): Promise<Repository>;
  getRepository(ref: RepoRef): Promise<Repository>;
  /** Auto-merge activé, merge squash seul, suppression des branches mergées. */
  configureMergeSettings(ref: RepoRef): Promise<Repository>;
  protectBranch(ref: RepoRef, branch: string, input: BranchProtectionInput): Promise<void>;
  getBranchProtection(ref: RepoRef, branch: string): Promise<BranchProtection | null>;
  getCapabilities(ref: RepoRef): Promise<Capabilities>;

  // Fichiers
  getFile(ref: RepoRef, path: string, branch?: string): Promise<FileContent | null>;
  /** Plusieurs fichiers en un seul commit ; renvoie le SHA du commit. */
  commitFiles(ref: RepoRef, input: CommitFilesInput): Promise<string>;

  // Issues, labels, commentaires
  createIssue(ref: RepoRef, input: CreateIssueInput): Promise<Issue>;
  getIssue(ref: RepoRef, issueNumber: number): Promise<Issue>;
  updateIssue(ref: RepoRef, issueNumber: number, input: UpdateIssueInput): Promise<Issue>;
  listIssues(ref: RepoRef, input?: ListIssuesInput): Promise<Issue[]>;
  /** Crée ou met à jour les labels du dépôt. */
  ensureLabels(ref: RepoRef, labels: LabelDefinition[]): Promise<void>;
  listLabels(ref: RepoRef): Promise<LabelDefinition[]>;
  addLabels(ref: RepoRef, issueNumber: number, labels: string[]): Promise<void>;
  /** Sans effet si le label est absent. */
  removeLabel(ref: RepoRef, issueNumber: number, label: string): Promise<void>;
  listComments(ref: RepoRef, issueNumber: number): Promise<Comment[]>;
  createComment(ref: RepoRef, issueNumber: number, body: string): Promise<Comment>;

  // Relations de dépendance (natives si possible, sinon bloc caché dans le corps)
  getDependencies(ref: RepoRef, issueNumber: number): Promise<number[]>;
  setDependencies(ref: RepoRef, issueNumber: number, blockedBy: number[]): Promise<void>;

  // Pull requests et checks
  createPullRequest(ref: RepoRef, input: CreatePullRequestInput): Promise<PullRequest>;
  getPullRequest(ref: RepoRef, prNumber: number): Promise<PullRequest>;
  listPullRequests(ref: RepoRef, input?: ListPullRequestsInput): Promise<PullRequest[]>;
  /** Auto-merge en squash dès que les checks obligatoires sont verts. */
  enableAutoMerge(ref: RepoRef, prNumber: number): Promise<void>;
  listCheckRuns(ref: RepoRef, sha: string): Promise<CheckRun[]>;

  // Actions
  dispatchWorkflow(ref: RepoRef, input: DispatchWorkflowInput): Promise<void>;
  listWorkflowRuns(ref: RepoRef, input?: ListWorkflowRunsInput): Promise<WorkflowRun[]>;
  getWorkflowRun(ref: RepoRef, runId: number): Promise<WorkflowRun>;
  listRunJobs(ref: RepoRef, runId: number): Promise<WorkflowJob[]>;
  getJobLogs(ref: RepoRef, jobId: number): Promise<string>;

  // Secrets
  /** Chiffré avec la clé publique du dépôt (libsodium, boîte scellée). */
  setRepositorySecret(ref: RepoRef, name: string, value: string): Promise<void>;
  listRepositorySecrets(ref: RepoRef): Promise<string[]>;
}
