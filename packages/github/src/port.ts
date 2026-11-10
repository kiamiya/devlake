import type { LfsPointer } from './lfs.js';
import type {
  Artifact,
  ActionsPermissions,
  AuthenticatedUser,
  BranchProtection,
  BranchProtectionInput,
  BranchProtectionSummary,
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
  PullRequestFile,
  RepoRef,
  Repository,
  RepositoryTree,
  UpdateIssueInput,
  UpdatePullRequestInput,
  WorkflowJob,
  WorkflowRun,
} from './types.js';

/**
 * Toutes les interactions avec GitHub. Implémenté par `OctokitGitHub` (réel)
 * et `FakeGitHub` (doublure en mémoire). Les erreurs sont des `GitHubError`.
 */
export interface GitHubPort {
  // Compte
  /** Compte du jeton ; sert aussi à vérifier le jeton. */
  getAuthenticatedUser(): Promise<AuthenticatedUser>;
  /** Dépôts dont le compte authentifié est propriétaire. */
  listRepositories(): Promise<Repository[]>;
  /**
   * Dépôts non archivés que le compte administre : les siens et ceux des organisations
   * dont il est administrateur du dépôt (droits nécessaires au bootstrap).
   */
  listAdministrableRepositories(): Promise<Repository[]>;

  // Dépôts
  createRepository(input: CreateRepositoryInput): Promise<Repository>;
  getRepository(ref: RepoRef): Promise<Repository>;
  /** Auto-merge activé, merge squash seul, suppression des branches mergées. */
  configureMergeSettings(ref: RepoRef): Promise<Repository>;
  protectBranch(ref: RepoRef, branch: string, input: BranchProtectionInput): Promise<void>;
  getBranchProtection(ref: RepoRef, branch: string): Promise<BranchProtection | null>;
  /** Renomme une branche (GitHub redirige l'ancien nom et repointe les PR ouvertes). */
  renameBranch(ref: RepoRef, branch: string, newName: string): Promise<void>;
  /** Protection lisible avec `contents: read` (dispatcher) ; null si la branche n'existe pas. */
  getBranchProtectionSummary(ref: RepoRef, branch: string): Promise<BranchProtectionSummary | null>;
  getCapabilities(ref: RepoRef): Promise<Capabilities>;
  getActionsPermissions(ref: RepoRef): Promise<ActionsPermissions>;
  /** GITHUB_TOKEN en lecture seule, approbation obligatoire des workflows de tous les contributeurs externes. */
  configureActionsPermissions(ref: RepoRef): Promise<void>;

  // Fichiers
  branchExists(ref: RepoRef, branch: string): Promise<boolean>;
  /** Fichiers d'une branche, récursivement. */
  listTree(ref: RepoRef, branch: string): Promise<RepositoryTree>;
  getFile(ref: RepoRef, path: string, branch?: string): Promise<FileContent | null>;
  /** Plusieurs fichiers en un seul commit ; renvoie le SHA du commit. */
  commitFiles(ref: RepoRef, input: CommitFilesInput): Promise<string>;

  /**
   * Envoie des binaires dans le stockage Git LFS du dépôt ; renvoie un pointeur par fichier,
   * à commiter (`lfsPointerText`) à la place du binaire.
   */
  uploadLfsObjects(ref: RepoRef, files: readonly Uint8Array[]): Promise<LfsPointer[]>;
  /** Télécharge un binaire du stockage Git LFS du dépôt. */
  downloadLfsObject(ref: RepoRef, pointer: LfsPointer): Promise<Uint8Array>;

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
  updatePullRequest(
    ref: RepoRef,
    prNumber: number,
    input: UpdatePullRequestInput,
  ): Promise<PullRequest>;
  /** Auto-merge en squash dès que les checks obligatoires sont verts. */
  enableAutoMerge(ref: RepoRef, prNumber: number): Promise<void>;
  /** Checks d'un commit ; `sha` peut aussi être un nom de branche. */
  listCheckRuns(ref: RepoRef, sha: string): Promise<CheckRun[]>;
  /** Fichiers modifiés par une PR, avec lignes ajoutées et supprimées. */
  listPullRequestFiles(ref: RepoRef, prNumber: number): Promise<PullRequestFile[]>;

  // Actions
  dispatchWorkflow(ref: RepoRef, input: DispatchWorkflowInput): Promise<void>;
  listWorkflowRuns(ref: RepoRef, input?: ListWorkflowRunsInput): Promise<WorkflowRun[]>;
  getWorkflowRun(ref: RepoRef, runId: number): Promise<WorkflowRun>;
  listRunJobs(ref: RepoRef, runId: number): Promise<WorkflowJob[]>;
  getJobLogs(ref: RepoRef, jobId: number): Promise<string>;
  /** Relance les jobs en échec d'un run (après une autorisation de Kia, par exemple). */
  rerunFailedJobs(ref: RepoRef, runId: number): Promise<void>;
  listRunArtifacts(ref: RepoRef, runId: number): Promise<Artifact[]>;
  /** Archive zip d'un artefact. */
  downloadArtifact(ref: RepoRef, artifactId: number): Promise<Uint8Array>;
  /** Variable Actions du dépôt ; null si elle n'existe pas. */
  getRepositoryVariable(ref: RepoRef, name: string): Promise<string | null>;
  setRepositoryVariable(ref: RepoRef, name: string, value: string): Promise<void>;

  // Secrets
  /** Chiffré avec la clé publique du dépôt (libsodium, boîte scellée). */
  setRepositorySecret(ref: RepoRef, name: string, value: string): Promise<void>;
  listRepositorySecrets(ref: RepoRef): Promise<string[]>;
}
