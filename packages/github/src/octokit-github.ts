import { Octokit } from '@octokit/core';
import { z } from 'zod';
import {
  BranchProtectionApi,
  CheckRunsApi,
  CommentApi,
  CommitApi,
  ContentApi,
  GraphqlApi,
  IssueApi,
  JobsApi,
  LabelApi,
  PublicKeyApi,
  PullRequestApi,
  RefApi,
  RepositoryApi,
  SecretsApi,
  ShaApi,
  WorkflowRunApi,
  WorkflowRunsApi,
  toIssue,
  toPullRequest,
} from './api-schemas.js';
import { readBlockedBy, writeBlockedBy } from './dependencies-block.js';
import { GitHubError, isGitHubError } from './errors.js';
import {
  DEFAULT_RETRY_OPTIONS,
  GitHubHttp,
  systemClock,
  type Clock,
  type RetryOptions,
} from './http.js';
import type { GitHubPort } from './port.js';
import { LfsClient, type LfsPointer } from './lfs.js';
import { encryptSecret } from './secrets.js';
import type {
  ActionsPermissions,
  AuthenticatedUser,
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

export interface OctokitGitHubOptions {
  token: string;
  baseUrl?: string;
  retry?: Partial<RetryOptions>;
  clock?: Clock;
  random?: () => number;
  /** Transport HTTP ; `fetch` global par défaut. Les tests y branchent les handlers msw. */
  fetch?: typeof fetch;
}

const PER_PAGE = 100;

function repoParams(ref: RepoRef) {
  return { owner: ref.owner, repo: ref.repo };
}

/** Adaptateur réel du port GitHub, au-dessus d'Octokit. */
export class OctokitGitHub implements GitHubPort {
  private readonly http: GitHubHttp;
  private readonly lfs: LfsClient;
  private readonly capabilities = new Map<string, Capabilities>();

  constructor(options: OctokitGitHubOptions) {
    const octokit = new Octokit({
      auth: options.token,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      userAgent: 'agentlake',
      request: {
        fetch: options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)),
      },
    });
    const retry = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
    const clock = options.clock ?? systemClock;
    this.http = new GitHubHttp(octokit, retry, clock, options.random);
    this.lfs = new LfsClient(
      options.token,
      options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)),
      retry,
      clock,
    );
  }

  private async paginate<S extends z.ZodType>(
    route: string,
    params: Record<string, unknown>,
    item: S,
  ): Promise<z.infer<S>[]> {
    const all: z.infer<S>[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.http.request(
        route,
        { ...params, per_page: PER_PAGE, page },
        z.array(item),
      );
      all.push(...batch);
      if (batch.length < PER_PAGE) return all;
    }
  }

  // Compte

  async getAuthenticatedUser(): Promise<AuthenticatedUser> {
    return this.http.request('GET /user', {}, z.object({ login: z.string() }));
  }

  async listRepositories(): Promise<Repository[]> {
    return this.paginate(
      'GET /user/repos',
      { affiliation: 'owner', sort: 'full_name' },
      RepositoryApi,
    );
  }

  // Dépôts

  async createRepository(input: CreateRepositoryInput): Promise<Repository> {
    return this.http.request(
      'POST /user/repos',
      { name: input.name, description: input.description, private: input.private, auto_init: true },
      RepositoryApi,
    );
  }

  async getRepository(ref: RepoRef): Promise<Repository> {
    return this.http.request('GET /repos/{owner}/{repo}', repoParams(ref), RepositoryApi);
  }

  async configureMergeSettings(ref: RepoRef): Promise<Repository> {
    this.capabilities.delete(`${ref.owner}/${ref.repo}`);
    return this.http.request(
      'PATCH /repos/{owner}/{repo}',
      {
        ...repoParams(ref),
        allow_auto_merge: true,
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        delete_branch_on_merge: true,
      },
      RepositoryApi,
    );
  }

  async protectBranch(ref: RepoRef, branch: string, input: BranchProtectionInput): Promise<void> {
    await this.http.raw('PUT /repos/{owner}/{repo}/branches/{branch}/protection', {
      ...repoParams(ref),
      branch,
      required_status_checks: { strict: true, contexts: input.requiredChecks },
      enforce_admins: input.enforceAdmins,
      required_pull_request_reviews: { required_approving_review_count: 0 },
      restrictions: null,
    });
  }

  async getBranchProtection(ref: RepoRef, branch: string): Promise<BranchProtection | null> {
    try {
      const p = await this.http.request(
        'GET /repos/{owner}/{repo}/branches/{branch}/protection',
        { ...repoParams(ref), branch },
        BranchProtectionApi,
      );
      return {
        branch,
        requiredChecks: p.required_status_checks?.contexts ?? [],
        enforceAdmins: p.enforce_admins?.enabled ?? false,
        requirePullRequest: p.required_pull_request_reviews != null,
      };
    } catch (error) {
      if (isGitHubError(error, 'not-found')) return null;
      throw error;
    }
  }

  async getCapabilities(ref: RepoRef): Promise<Capabilities> {
    const key = `${ref.owner}/${ref.repo}`;
    const cached = this.capabilities.get(key);
    if (cached) return cached;
    const repository = await this.getRepository(ref);
    const capabilities: Capabilities = {
      autoMerge: repository.allowAutoMerge,
      issueDependencies: await this.probeIssueDependencies(ref),
    };
    this.capabilities.set(key, capabilities);
    return capabilities;
  }

  /** Les relations natives existent si l'API répond sur une issue existante. */
  private async probeIssueDependencies(ref: RepoRef): Promise<boolean> {
    const [first] = await this.http.request(
      'GET /repos/{owner}/{repo}/issues',
      { ...repoParams(ref), state: 'all', per_page: 1 },
      z.array(IssueApi),
    );
    if (!first) return false;
    try {
      await this.http.raw(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
        {
          ...repoParams(ref),
          issue_number: first.number,
        },
      );
      return true;
    } catch (error) {
      if (isGitHubError(error, 'not-found') || isGitHubError(error, 'forbidden')) return false;
      throw error;
    }
  }

  async getActionsPermissions(ref: RepoRef): Promise<ActionsPermissions> {
    const workflow = await this.http.request(
      'GET /repos/{owner}/{repo}/actions/permissions/workflow',
      repoParams(ref),
      z.object({
        default_workflow_permissions: z.enum(['read', 'write']),
        can_approve_pull_request_reviews: z.boolean(),
      }),
    );
    const fork = await this.http.request(
      'GET /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval',
      repoParams(ref),
      z.object({ approval_policy: z.string() }),
    );
    return {
      defaultWorkflowPermissions: workflow.default_workflow_permissions,
      canApprovePullRequestReviews: workflow.can_approve_pull_request_reviews,
      forkPrApproval: fork.approval_policy,
    };
  }

  async configureActionsPermissions(ref: RepoRef): Promise<void> {
    await this.http.raw('PUT /repos/{owner}/{repo}/actions/permissions/workflow', {
      ...repoParams(ref),
      default_workflow_permissions: 'read',
      can_approve_pull_request_reviews: false,
    });
    await this.http.raw(
      'PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval',
      {
        ...repoParams(ref),
        approval_policy: 'all_external_contributors',
      },
    );
  }

  // Fichiers

  async getFile(ref: RepoRef, path: string, branch?: string): Promise<FileContent | null> {
    try {
      const file = await this.http.request(
        'GET /repos/{owner}/{repo}/contents/{path}',
        { ...repoParams(ref), path, ...(branch !== undefined ? { ref: branch } : {}) },
        ContentApi,
      );
      return {
        path: file.path,
        sha: file.sha,
        content: Buffer.from(file.content, 'base64').toString('utf8'),
      };
    } catch (error) {
      if (isGitHubError(error, 'not-found')) return null;
      throw error;
    }
  }

  async commitFiles(ref: RepoRef, input: CommitFilesInput): Promise<string> {
    const p = repoParams(ref);
    let parentSha: string;
    let branchExists = true;
    try {
      parentSha = (
        await this.http.request(
          'GET /repos/{owner}/{repo}/git/ref/{ref}',
          { ...p, ref: `heads/${input.branch}` },
          RefApi,
        )
      ).object.sha;
    } catch (error) {
      if (!isGitHubError(error, 'not-found') || input.baseBranch === undefined) throw error;
      branchExists = false;
      parentSha = (
        await this.http.request(
          'GET /repos/{owner}/{repo}/git/ref/{ref}',
          { ...p, ref: `heads/${input.baseBranch}` },
          RefApi,
        )
      ).object.sha;
    }

    const parent = await this.http.request(
      'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
      { ...p, commit_sha: parentSha },
      CommitApi,
    );

    const tree = [];
    for (const change of input.changes) {
      if ('delete' in change) {
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
      } else {
        const blob = await this.http.request(
          'POST /repos/{owner}/{repo}/git/blobs',
          { ...p, content: change.content, encoding: change.encoding ?? 'utf-8' },
          ShaApi,
        );
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }

    const newTree = await this.http.request(
      'POST /repos/{owner}/{repo}/git/trees',
      { ...p, base_tree: parent.tree.sha, tree },
      ShaApi,
    );
    const commit = await this.http.request(
      'POST /repos/{owner}/{repo}/git/commits',
      { ...p, message: input.message, tree: newTree.sha, parents: [parentSha] },
      ShaApi,
    );

    if (branchExists) {
      await this.http.raw('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
        ...p,
        ref: `heads/${input.branch}`,
        sha: commit.sha,
        force: false,
      });
    } else {
      await this.http.raw('POST /repos/{owner}/{repo}/git/refs', {
        ...p,
        ref: `refs/heads/${input.branch}`,
        sha: commit.sha,
      });
    }
    return commit.sha;
  }

  async uploadLfsObjects(ref: RepoRef, files: readonly Uint8Array[]): Promise<LfsPointer[]> {
    return this.lfs.upload(ref, files);
  }

  async downloadLfsObject(ref: RepoRef, pointer: LfsPointer): Promise<Uint8Array> {
    return this.lfs.download(ref, pointer);
  }

  // Issues, labels, commentaires

  async createIssue(ref: RepoRef, input: CreateIssueInput): Promise<Issue> {
    return toIssue(
      await this.http.request(
        'POST /repos/{owner}/{repo}/issues',
        { ...repoParams(ref), title: input.title, body: input.body, labels: input.labels ?? [] },
        IssueApi,
      ),
    );
  }

  async getIssue(ref: RepoRef, issueNumber: number): Promise<Issue> {
    return toIssue(
      await this.http.request(
        'GET /repos/{owner}/{repo}/issues/{issue_number}',
        { ...repoParams(ref), issue_number: issueNumber },
        IssueApi,
      ),
    );
  }

  async updateIssue(ref: RepoRef, issueNumber: number, input: UpdateIssueInput): Promise<Issue> {
    return toIssue(
      await this.http.request(
        'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
        { ...repoParams(ref), issue_number: issueNumber, ...input },
        IssueApi,
      ),
    );
  }

  async listIssues(ref: RepoRef, input: ListIssuesInput = {}): Promise<Issue[]> {
    const items = await this.paginate(
      'GET /repos/{owner}/{repo}/issues',
      {
        ...repoParams(ref),
        state: input.state ?? 'open',
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels.join(',') } : {}),
      },
      IssueApi,
    );
    return items.filter((i) => !i.isPullRequest).map(toIssue);
  }

  async ensureLabels(ref: RepoRef, labels: LabelDefinition[]): Promise<void> {
    const existing = new Map((await this.listLabels(ref)).map((l) => [l.name, l]));
    for (const label of labels) {
      const current = existing.get(label.name);
      const body = { color: label.color, description: label.description ?? '' };
      if (!current) {
        await this.http.raw('POST /repos/{owner}/{repo}/labels', {
          ...repoParams(ref),
          name: label.name,
          ...body,
        });
      } else if (
        current.color !== label.color ||
        (current.description ?? '') !== (label.description ?? '')
      ) {
        await this.http.raw('PATCH /repos/{owner}/{repo}/labels/{name}', {
          ...repoParams(ref),
          name: label.name,
          ...body,
        });
      }
    }
  }

  async listLabels(ref: RepoRef): Promise<LabelDefinition[]> {
    return this.paginate('GET /repos/{owner}/{repo}/labels', repoParams(ref), LabelApi);
  }

  async addLabels(ref: RepoRef, issueNumber: number, labels: string[]): Promise<void> {
    await this.http.raw('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
      ...repoParams(ref),
      issue_number: issueNumber,
      labels,
    });
  }

  async removeLabel(ref: RepoRef, issueNumber: number, label: string): Promise<void> {
    try {
      await this.http.raw('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
        ...repoParams(ref),
        issue_number: issueNumber,
        name: label,
      });
    } catch (error) {
      if (!isGitHubError(error, 'not-found')) throw error;
    }
  }

  async listComments(ref: RepoRef, issueNumber: number): Promise<Comment[]> {
    return this.paginate(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { ...repoParams(ref), issue_number: issueNumber },
      CommentApi,
    );
  }

  async createComment(ref: RepoRef, issueNumber: number, body: string): Promise<Comment> {
    return this.http.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { ...repoParams(ref), issue_number: issueNumber, body },
      CommentApi,
    );
  }

  // Relations de dépendance

  async getDependencies(ref: RepoRef, issueNumber: number): Promise<number[]> {
    if (!(await this.getCapabilities(ref)).issueDependencies) {
      return readBlockedBy((await this.getIssue(ref, issueNumber)).body);
    }
    const blockers = await this.paginate(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
      { ...repoParams(ref), issue_number: issueNumber },
      IssueApi,
    );
    return blockers.map((b) => b.number).sort((a, b) => a - b);
  }

  async setDependencies(ref: RepoRef, issueNumber: number, blockedBy: number[]): Promise<void> {
    if (!(await this.getCapabilities(ref)).issueDependencies) {
      const issue = await this.getIssue(ref, issueNumber);
      await this.updateIssue(ref, issueNumber, { body: writeBlockedBy(issue.body, blockedBy) });
      return;
    }
    const route = 'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by';
    const current = await this.paginate(
      route,
      { ...repoParams(ref), issue_number: issueNumber },
      IssueApi,
    );
    const wanted = new Set(blockedBy);
    for (const blocker of current) {
      if (!wanted.has(blocker.number)) {
        await this.http.raw(
          'DELETE /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by/{issue_id}',
          {
            ...repoParams(ref),
            issue_number: issueNumber,
            issue_id: blocker.id,
          },
        );
      }
    }
    const present = new Set(current.map((c) => c.number));
    for (const number of wanted) {
      if (present.has(number)) continue;
      const blocker = await this.getIssue(ref, number);
      await this.http.raw(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
        {
          ...repoParams(ref),
          issue_number: issueNumber,
          issue_id: blocker.id,
        },
      );
    }
  }

  // Pull requests et checks

  async createPullRequest(ref: RepoRef, input: CreatePullRequestInput): Promise<PullRequest> {
    return toPullRequest(
      await this.http.request(
        'POST /repos/{owner}/{repo}/pulls',
        { ...repoParams(ref), ...input },
        PullRequestApi,
      ),
    );
  }

  async getPullRequest(ref: RepoRef, prNumber: number): Promise<PullRequest> {
    return toPullRequest(
      await this.http.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        { ...repoParams(ref), pull_number: prNumber },
        PullRequestApi,
      ),
    );
  }

  async listPullRequests(ref: RepoRef, input: ListPullRequestsInput = {}): Promise<PullRequest[]> {
    const pulls = await this.paginate(
      'GET /repos/{owner}/{repo}/pulls',
      {
        ...repoParams(ref),
        state: input.state ?? 'open',
        ...(input.head !== undefined ? { head: `${ref.owner}:${input.head}` } : {}),
      },
      PullRequestApi,
    );
    return pulls.map(toPullRequest);
  }

  async enableAutoMerge(ref: RepoRef, prNumber: number): Promise<void> {
    const pr = await this.http.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { ...repoParams(ref), pull_number: prNumber },
      PullRequestApi,
    );
    const result = await this.http.request(
      'POST /graphql',
      {
        query:
          'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }',
        variables: { id: pr.nodeId },
      },
      GraphqlApi,
    );
    if (result.errors && result.errors.length > 0) {
      throw new GitHubError(
        'validation',
        `Auto-merge refusé par GitHub : ${result.errors.map((e) => e.message).join(' ; ')}`,
      );
    }
  }

  async listCheckRuns(ref: RepoRef, sha: string): Promise<CheckRun[]> {
    return this.http.request(
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      { ...repoParams(ref), ref: sha, per_page: PER_PAGE },
      CheckRunsApi,
    );
  }

  // Actions

  async dispatchWorkflow(ref: RepoRef, input: DispatchWorkflowInput): Promise<void> {
    await this.http.raw('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
      ...repoParams(ref),
      workflow_id: input.workflow,
      ref: input.ref,
      inputs: input.inputs ?? {},
    });
  }

  async listWorkflowRuns(ref: RepoRef, input: ListWorkflowRunsInput = {}): Promise<WorkflowRun[]> {
    const filters = {
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      ...(input.event !== undefined ? { event: input.event } : {}),
      per_page: PER_PAGE,
    };
    return input.workflow !== undefined
      ? this.http.request(
          'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
          { ...repoParams(ref), workflow_id: input.workflow, ...filters },
          WorkflowRunsApi,
        )
      : this.http.request(
          'GET /repos/{owner}/{repo}/actions/runs',
          { ...repoParams(ref), ...filters },
          WorkflowRunsApi,
        );
  }

  async getWorkflowRun(ref: RepoRef, runId: number): Promise<WorkflowRun> {
    return this.http.request(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
      { ...repoParams(ref), run_id: runId },
      WorkflowRunApi,
    );
  }

  async listRunJobs(ref: RepoRef, runId: number): Promise<WorkflowJob[]> {
    return this.http.request(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
      { ...repoParams(ref), run_id: runId, per_page: PER_PAGE },
      JobsApi,
    );
  }

  async getJobLogs(ref: RepoRef, jobId: number): Promise<string> {
    return this.http.request(
      'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
      { ...repoParams(ref), job_id: jobId },
      z.string(),
    );
  }

  // Secrets

  async setRepositorySecret(ref: RepoRef, name: string, value: string): Promise<void> {
    const key = await this.http.request(
      'GET /repos/{owner}/{repo}/actions/secrets/public-key',
      repoParams(ref),
      PublicKeyApi,
    );
    await this.http.raw('PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
      ...repoParams(ref),
      secret_name: name,
      encrypted_value: await encryptSecret(key.key, value),
      key_id: key.key_id,
    });
  }

  async listRepositorySecrets(ref: RepoRef): Promise<string[]> {
    return this.http.request(
      'GET /repos/{owner}/{repo}/actions/secrets',
      { ...repoParams(ref), per_page: PER_PAGE },
      SecretsApi,
    );
  }
}
