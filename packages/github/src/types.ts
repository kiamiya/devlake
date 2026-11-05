/** Types du domaine exposés par le port GitHub (indépendants du format de l'API). */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface AuthenticatedUser {
  login: string;
}

export interface Repository {
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  allowAutoMerge: boolean;
  allowSquashMerge: boolean;
  allowMergeCommit: boolean;
  allowRebaseMerge: boolean;
  deleteBranchOnMerge: boolean;
}

export interface CreateRepositoryInput {
  name: string;
  description?: string;
  private: boolean;
}

export interface BranchProtectionInput {
  /** Noms des checks obligatoires (contextes). */
  requiredChecks: string[];
  /** Les administrateurs sont soumis aux mêmes règles. */
  enforceAdmins: boolean;
}

export interface BranchProtection extends BranchProtectionInput {
  branch: string;
  requirePullRequest: boolean;
}

export interface FileContent {
  path: string;
  /** Contenu décodé en UTF-8. */
  content: string;
  sha: string;
}

export type FileChange =
  { path: string; content: string; encoding?: 'utf-8' | 'base64' } | { path: string; delete: true };

export interface CommitFilesInput {
  branch: string;
  message: string;
  changes: FileChange[];
  /** Branche de départ si `branch` n'existe pas encore. */
  baseBranch?: string;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  /** Identifiant interne GitHub (utilisé par les relations de dépendance). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  author: string;
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels?: string[];
}

export interface UpdateIssueInput {
  title?: string;
  body?: string;
  state?: IssueState;
}

export interface ListIssuesInput {
  labels?: string[];
  state?: IssueState | 'all';
}

export interface LabelDefinition {
  name: string;
  /** Couleur hexadécimale sans « # ». */
  color: string;
  description?: string;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export type PullRequestState = 'open' | 'closed' | 'merged';

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  headSha: string;
  state: PullRequestState;
  autoMerge: boolean;
  author: string;
}

/** Fichier modifié par une PR. */
export interface PullRequestFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  /** Ancien chemin d'un fichier renommé. */
  previousFilename?: string;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface UpdatePullRequestInput {
  title?: string;
  body?: string;
}

export interface ListPullRequestsInput {
  state?: 'open' | 'closed' | 'all';
  head?: string;
}

export interface CheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
}

export interface WorkflowRun {
  id: number;
  name: string;
  /** Titre affiché du run (`run-name`), s'il diffère du nom du workflow. */
  title?: string;
  /** Nom de fichier du workflow, ex. `agent-task.yml`. */
  workflow: string;
  status: string;
  conclusion: string | null;
  headBranch: string;
  event: string;
  createdAt: string;
  /** Dernière mise à jour (fin du run une fois terminé). */
  updatedAt?: string;
  url: string;
}

export interface ListWorkflowRunsInput {
  /** Nom de fichier du workflow, ex. `agent-task.yml`. */
  workflow?: string;
  branch?: string;
  event?: string;
}

export interface WorkflowJob {
  id: number;
  runId: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface DispatchWorkflowInput {
  workflow: string;
  ref: string;
  inputs?: Record<string, string>;
}

/** Réglages Actions d'un dépôt. */
export interface ActionsPermissions {
  /** Permissions par défaut du GITHUB_TOKEN. */
  defaultWorkflowPermissions: 'read' | 'write';
  canApprovePullRequestReviews: boolean;
  /** Qui doit être approuvé avant que ses workflows de PR (forks) ne tournent. */
  forkPrApproval: string;
}

/** Capacités du compte ou du dépôt. */
export interface Capabilities {
  /** Relations de dépendance natives entre issues. */
  issueDependencies: boolean;
  /** Auto-merge activé sur le dépôt. */
  autoMerge: boolean;
}
