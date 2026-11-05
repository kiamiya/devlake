import { z } from 'zod';
import type {
  CheckRun,
  Comment,
  Issue,
  LabelDefinition,
  PullRequest,
  Repository,
  WorkflowJob,
  WorkflowRun,
} from './types.js';

// Messages d'erreur zod en français.
z.config(z.locales.fr());

/** Schémas des réponses de l'API REST GitHub : seuls les champs utilisés. */

const user = z.object({ login: z.string() });

export const RepositoryApi = z
  .object({
    name: z.string(),
    owner: user,
    private: z.boolean(),
    default_branch: z.string(),
    allow_auto_merge: z.boolean().optional(),
    allow_squash_merge: z.boolean().optional(),
    allow_merge_commit: z.boolean().optional(),
    allow_rebase_merge: z.boolean().optional(),
    delete_branch_on_merge: z.boolean().optional(),
  })
  .transform((r): Repository => ({
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch,
    allowAutoMerge: r.allow_auto_merge ?? false,
    allowSquashMerge: r.allow_squash_merge ?? true,
    allowMergeCommit: r.allow_merge_commit ?? true,
    allowRebaseMerge: r.allow_rebase_merge ?? true,
    deleteBranchOnMerge: r.delete_branch_on_merge ?? false,
  }));

export const BranchProtectionApi = z.object({
  required_status_checks: z.object({ contexts: z.array(z.string()) }).nullish(),
  enforce_admins: z.object({ enabled: z.boolean() }).nullish(),
  required_pull_request_reviews: z.object({}).loose().nullish(),
});

export const ContentApi = z.object({
  type: z.literal('file'),
  path: z.string(),
  sha: z.string(),
  content: z.string(),
  encoding: z.literal('base64'),
});

export const RefApi = z.object({ object: z.object({ sha: z.string() }) });
export const ShaApi = z.object({ sha: z.string() });
export const CommitApi = z.object({ sha: z.string(), tree: z.object({ sha: z.string() }) });

const labelName = z.union([z.string(), z.object({ name: z.string() })]);

export const IssueApi = z
  .object({
    id: z.number(),
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(['open', 'closed']),
    labels: z.array(labelName),
    user: user.nullable(),
    pull_request: z.unknown().optional(),
  })
  .transform((i): Issue & { isPullRequest: boolean } => ({
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    state: i.state,
    labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    author: i.user?.login ?? '',
    isPullRequest: i.pull_request !== undefined,
  }));

export function toIssue(issue: z.infer<typeof IssueApi>): Issue {
  const { isPullRequest: _ignored, ...rest } = issue;
  return rest;
}

export const LabelApi = z
  .object({ name: z.string(), color: z.string(), description: z.string().nullable() })
  .transform((l): LabelDefinition =>
    l.description
      ? { name: l.name, color: l.color, description: l.description }
      : { name: l.name, color: l.color },
  );

export const CommentApi = z
  .object({
    id: z.number(),
    body: z.string().nullish(),
    user: user.nullable(),
    created_at: z.string(),
  })
  .transform((c): Comment => ({
    id: c.id,
    body: c.body ?? '',
    author: c.user?.login ?? '',
    createdAt: c.created_at,
  }));

export const PullRequestApi = z
  .object({
    number: z.number(),
    node_id: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(['open', 'closed']),
    merged_at: z.string().nullable(),
    head: z.object({ ref: z.string(), sha: z.string() }),
    base: z.object({ ref: z.string() }),
    auto_merge: z.unknown().nullable(),
    user: user.nullable(),
  })
  .transform((p): PullRequest & { nodeId: string } => ({
    number: p.number,
    nodeId: p.node_id,
    title: p.title,
    body: p.body ?? '',
    head: p.head.ref,
    base: p.base.ref,
    headSha: p.head.sha,
    state: p.merged_at !== null ? 'merged' : p.state,
    autoMerge: p.auto_merge !== null,
    author: p.user?.login ?? '',
  }));

export function toPullRequest(pr: z.infer<typeof PullRequestApi>): PullRequest {
  const { nodeId: _ignored, ...rest } = pr;
  return rest;
}

export const CheckRunsApi = z
  .object({
    check_runs: z.array(
      z.object({
        name: z.string(),
        status: z.enum(['queued', 'in_progress', 'completed']),
        conclusion: z.string().nullable(),
      }),
    ),
  })
  .transform((r): CheckRun[] => r.check_runs);

const WorkflowRunObject = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    display_title: z.string().nullish(),
    path: z.string(),
    status: z.string().nullable(),
    conclusion: z.string().nullable(),
    head_branch: z.string().nullable(),
    event: z.string(),
    created_at: z.string(),
    html_url: z.string(),
  })
  .transform((r): WorkflowRun => ({
    id: r.id,
    name: r.name ?? '',
    title: r.display_title ?? r.name ?? '',
    workflow: r.path.split('/').pop() ?? r.path,
    status: r.status ?? '',
    conclusion: r.conclusion,
    headBranch: r.head_branch ?? '',
    event: r.event,
    createdAt: r.created_at,
    url: r.html_url,
  }));

export const WorkflowRunApi = WorkflowRunObject;
export const WorkflowRunsApi = z
  .object({ workflow_runs: z.array(WorkflowRunObject) })
  .transform((r) => r.workflow_runs);

export const JobsApi = z
  .object({
    jobs: z.array(
      z.object({
        id: z.number(),
        run_id: z.number(),
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable(),
      }),
    ),
  })
  .transform((r): WorkflowJob[] =>
    r.jobs.map((j) => ({
      id: j.id,
      runId: j.run_id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
    })),
  );

export const PublicKeyApi = z.object({ key_id: z.string(), key: z.string() });

export const SecretsApi = z
  .object({ secrets: z.array(z.object({ name: z.string() })) })
  .transform((r) => r.secrets.map((s) => s.name));

export const GraphqlApi = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});
