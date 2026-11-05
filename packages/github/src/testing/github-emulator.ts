import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw';
import { GitHubError } from '../errors.js';
import { newSha, type FakeGitHub, type FakeRepoState, type FileTree } from '../fake-github.js';
import type {
  Comment,
  Issue,
  LabelDefinition,
  PullRequest,
  RepoRef,
  Repository,
  WorkflowJob,
  WorkflowRun,
} from '../types.js';

/**
 * Émulateur HTTP de l'API REST GitHub pour msw, adossé à un `FakeGitHub`.
 * Il permet de faire passer à l'adaptateur Octokit la même suite de contrat que la doublure.
 */

export const API = 'https://api.github.com';

type Params = Record<string, string | readonly string[] | undefined>;
type Body = Record<string, unknown>;

function param(params: Params, name: string): string {
  const value = params[name];
  return decodeURIComponent(Array.isArray(value) ? value.join('/') : String(value));
}

function refOf(params: Params): RepoRef {
  return { owner: param(params, 'owner'), repo: param(params, 'repo') };
}

/** Valeur texte d'un champ JSON (vide si absent). */
function str(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function wildcard(params: Params): string {
  return param(params, '0');
}

function errorResponse(error: unknown): Response {
  if (error instanceof GitHubError) {
    return HttpResponse.json({ message: error.message }, { status: error.status ?? 500 });
  }
  throw error;
}

/** Enveloppe un handler : erreurs du fake → réponses HTTP GitHub. */
function handle(
  run: (args: { params: Params; body: Body; url: URL }) => Promise<Response> | Response,
) {
  return async ({ params, request }: { params: Params; request: Request }) => {
    try {
      const text =
        request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
      const body = (text ? JSON.parse(text) : {}) as Body;
      return await run({ params, body, url: new URL(request.url) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

const json = (data: JsonBodyType, status = 200) => HttpResponse.json(data, { status });
const empty = (status = 204) => new HttpResponse(null, { status });

function repoJson(r: Repository) {
  return {
    name: r.name,
    owner: { login: r.owner },
    private: r.private,
    default_branch: r.defaultBranch,
    allow_auto_merge: r.allowAutoMerge,
    allow_squash_merge: r.allowSquashMerge,
    allow_merge_commit: r.allowMergeCommit,
    allow_rebase_merge: r.allowRebaseMerge,
    delete_branch_on_merge: r.deleteBranchOnMerge,
  };
}

function issueJson(i: Issue, isPullRequest = false) {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((name) => ({ name })),
    user: { login: i.author },
    ...(isPullRequest ? { pull_request: { url: '' } } : {}),
  };
}

function labelJson(l: LabelDefinition) {
  return { name: l.name, color: l.color, description: l.description ?? null };
}

function commentJson(c: Comment) {
  return { id: c.id, body: c.body, user: { login: c.author }, created_at: c.createdAt };
}

function pullJson(p: PullRequest, ref: RepoRef) {
  return {
    number: p.number,
    node_id: `PR_${ref.owner}/${ref.repo}#${String(p.number)}`,
    title: p.title,
    body: p.body,
    state: p.state === 'open' ? 'open' : 'closed',
    merged_at: p.state === 'merged' ? new Date().toISOString() : null,
    head: { ref: p.head, sha: p.headSha },
    base: { ref: p.base },
    auto_merge: p.autoMerge ? { merge_method: 'squash' } : null,
    user: { login: p.author },
  };
}

function runJson(r: WorkflowRun) {
  return {
    id: r.id,
    name: r.name,
    path: `.github/workflows/${r.workflow}`,
    status: r.status,
    conclusion: r.conclusion,
    head_branch: r.headBranch,
    event: r.event,
    created_at: r.createdAt,
    html_url: r.url,
  };
}

function jobJson(j: WorkflowJob) {
  return { id: j.id, run_id: j.runId, name: j.name, status: j.status, conclusion: j.conclusion };
}

function page<T>(items: T[], url: URL): T[] {
  const perPage = Number(url.searchParams.get('per_page') ?? '30');
  const pageNumber = Number(url.searchParams.get('page') ?? '1');
  return items.slice((pageNumber - 1) * perPage, pageNumber * perPage);
}

function issueByNumber(state: FakeRepoState, n: number) {
  const issue = state.issues.get(n);
  if (!issue) throw new GitHubError('not-found', 'Not Found', 404);
  return issue;
}

export function githubEmulator(fake: FakeGitHub): HttpHandler[] {
  const blobs = new Map<string, string>();
  const trees = new Map<string, FileTree>();
  const commitTrees = new Map<string, string>();

  const treeOfCommit = (state: FakeRepoState, sha: string): string => {
    const known = commitTrees.get(sha);
    if (known) return known;
    const files = state.commits.get(sha);
    if (!files) throw new GitHubError('not-found', 'Not Found', 404);
    const treeSha = `tree-${sha}`;
    trees.set(treeSha, new Map(files));
    commitTrees.set(sha, treeSha);
    return treeSha;
  };

  const R = `${API}/repos/:owner/:repo`;

  return [
    // Compte
    http.get(
      `${API}/user`,
      handle(async () => json(await fake.getAuthenticatedUser())),
    ),
    http.get(
      `${API}/user/repos`,
      handle(async ({ url }) => json(page((await fake.listRepositories()).map(repoJson), url))),
    ),

    // Dépôts
    http.post(
      `${API}/user/repos`,
      handle(async ({ body }) =>
        json(
          repoJson(
            await fake.createRepository({
              name: str(body.name),
              private: Boolean(body.private),
            }),
          ),
          201,
        ),
      ),
    ),
    http.get(
      R,
      handle(async ({ params }) => json(repoJson(await fake.getRepository(refOf(params))))),
    ),
    http.patch(
      R,
      handle(async ({ params }) =>
        json(repoJson(await fake.configureMergeSettings(refOf(params)))),
      ),
    ),
    http.put(
      `${R}/branches/:branch/protection`,
      handle(async ({ params, body }) => {
        const checks = body.required_status_checks as { contexts: string[] };
        await fake.protectBranch(refOf(params), param(params, 'branch'), {
          requiredChecks: checks.contexts,
          enforceAdmins: Boolean(body.enforce_admins),
        });
        return json({});
      }),
    ),
    http.get(
      `${R}/branches/:branch/protection`,
      handle(async ({ params }) => {
        const p = await fake.getBranchProtection(refOf(params), param(params, 'branch'));
        if (!p) return json({ message: 'Branch not protected' }, 404);
        return json({
          required_status_checks: { contexts: p.requiredChecks },
          enforce_admins: { enabled: p.enforceAdmins },
          required_pull_request_reviews: p.requirePullRequest
            ? { required_approving_review_count: 0 }
            : null,
        });
      }),
    ),

    // Fichiers et Git Data
    http.get(
      `${R}/contents/*`,
      handle(async ({ params, url }) => {
        const path = wildcard(params);
        const file = await fake.getFile(
          refOf(params),
          path,
          url.searchParams.get('ref') ?? undefined,
        );
        if (!file) return json({ message: 'Not Found' }, 404);
        return json({
          type: 'file',
          path: file.path,
          sha: file.sha,
          content: Buffer.from(file.content).toString('base64'),
          encoding: 'base64',
        });
      }),
    ),
    http.get(
      `${R}/git/ref/*`,
      handle(({ params }) => {
        const branch = wildcard(params).replace(/^heads\//, '');
        const target = fake.state(refOf(params)).branches.get(branch);
        if (!target) return json({ message: 'Not Found' }, 404);
        return json({ object: { sha: target.sha } });
      }),
    ),
    http.get(
      `${R}/git/commits/:sha`,
      handle(({ params }) => {
        const sha = param(params, 'sha');
        return json({ sha, tree: { sha: treeOfCommit(fake.state(refOf(params)), sha) } });
      }),
    ),
    http.post(
      `${R}/git/blobs`,
      handle(({ body }) => {
        const sha = newSha();
        const content = str(body.content);
        blobs.set(
          sha,
          body.encoding === 'base64' ? content : Buffer.from(content).toString('base64'),
        );
        return json({ sha }, 201);
      }),
    ),
    http.post(
      `${R}/git/trees`,
      handle(({ body }) => {
        const base = trees.get(str(body.base_tree));
        if (!base) return json({ message: 'base_tree inconnu' }, 422);
        const files = new Map(base);
        for (const entry of body.tree as { path: string; sha: string | null }[]) {
          if (entry.sha === null) files.delete(entry.path);
          else {
            const blob = blobs.get(entry.sha);
            if (blob === undefined) return json({ message: 'blob inconnu' }, 422);
            files.set(entry.path, blob);
          }
        }
        const sha = `tree-${newSha()}`;
        trees.set(sha, files);
        return json({ sha }, 201);
      }),
    ),
    http.post(
      `${R}/git/commits`,
      handle(({ params, body }) => {
        const files = trees.get(str(body.tree));
        if (!files) return json({ message: 'tree inconnu' }, 422);
        const sha = newSha();
        fake.state(refOf(params)).commits.set(sha, new Map(files));
        commitTrees.set(sha, str(body.tree));
        return json({ sha }, 201);
      }),
    ),
    http.patch(
      `${R}/git/refs/*`,
      handle(({ params, body }) => {
        const state = fake.state(refOf(params));
        const branch = wildcard(params).replace(/^heads\//, '');
        const sha = str(body.sha);
        const files = state.commits.get(sha);
        if (!state.branches.has(branch) || !files)
          return json({ message: 'Reference does not exist' }, 422);
        state.branches.set(branch, { sha, files: new Map(files) });
        return json({ object: { sha } });
      }),
    ),
    http.post(
      `${R}/git/refs`,
      handle(({ params, body }) => {
        const state = fake.state(refOf(params));
        const branch = str(body.ref).replace(/^refs\/heads\//, '');
        const sha = str(body.sha);
        const files = state.commits.get(sha);
        if (state.branches.has(branch)) return json({ message: 'Reference already exists' }, 422);
        if (!files) return json({ message: 'Object does not exist' }, 422);
        state.branches.set(branch, { sha, files: new Map(files) });
        return json({ object: { sha } }, 201);
      }),
    ),

    // Issues
    http.get(
      `${R}/issues`,
      handle(({ params, url }) => {
        const state = fake.state(refOf(params));
        const wanted = url.searchParams.get('state') ?? 'open';
        const labels = url.searchParams.get('labels')?.split(',') ?? [];
        const items = [...state.issues.values()]
          .filter((i) => wanted === 'all' || i.state === wanted)
          .filter((i) => labels.every((l) => i.labels.includes(l)))
          .sort((a, b) => b.number - a.number)
          .map((i) => issueJson(i, i.isPullRequest));
        return json(page(items, url));
      }),
    ),
    http.post(
      `${R}/issues`,
      handle(async ({ params, body }) =>
        json(
          issueJson(
            await fake.createIssue(refOf(params), {
              title: str(body.title),
              body: str(body.body ?? ''),
              labels: (body.labels as string[] | undefined) ?? [],
            }),
          ),
          201,
        ),
      ),
    ),
    http.get(
      `${R}/issues/:number`,
      handle(async ({ params }) =>
        json(issueJson(await fake.getIssue(refOf(params), Number(param(params, 'number'))))),
      ),
    ),
    http.patch(
      `${R}/issues/:number`,
      handle(async ({ params, body }) =>
        json(
          issueJson(
            await fake.updateIssue(refOf(params), Number(param(params, 'number')), {
              ...(body.title !== undefined ? { title: str(body.title) } : {}),
              ...(body.body !== undefined ? { body: str(body.body) } : {}),
              ...(body.state !== undefined ? { state: body.state as 'open' | 'closed' } : {}),
            }),
          ),
        ),
      ),
    ),
    http.post(
      `${R}/issues/:number/labels`,
      handle(async ({ params, body }) => {
        const ref = refOf(params);
        const n = Number(param(params, 'number'));
        await fake.addLabels(ref, n, body.labels as string[]);
        return json((await fake.getIssue(ref, n)).labels.map((name) => ({ name })));
      }),
    ),
    http.delete(
      `${R}/issues/:number/labels/:name`,
      handle(async ({ params }) => {
        const ref = refOf(params);
        const n = Number(param(params, 'number'));
        const name = param(params, 'name');
        if (!(await fake.getIssue(ref, n)).labels.includes(name)) {
          return json({ message: 'Label does not exist' }, 404);
        }
        await fake.removeLabel(ref, n, name);
        return json([]);
      }),
    ),
    http.get(
      `${R}/issues/:number/comments`,
      handle(async ({ params, url }) =>
        json(
          page(
            (await fake.listComments(refOf(params), Number(param(params, 'number')))).map(
              commentJson,
            ),
            url,
          ),
        ),
      ),
    ),
    http.post(
      `${R}/issues/:number/comments`,
      handle(async ({ params, body }) =>
        json(
          commentJson(
            await fake.createComment(
              refOf(params),
              Number(param(params, 'number')),
              str(body.body),
            ),
          ),
          201,
        ),
      ),
    ),

    // Relations de dépendance natives
    http.get(
      `${R}/issues/:number/dependencies/blocked_by`,
      handle(async ({ params, url }) => {
        const ref = refOf(params);
        const state = fake.state(ref);
        if (!state.issueDependencies) return json({ message: 'Not Found' }, 404);
        const numbers = await fake.getDependencies(ref, Number(param(params, 'number')));
        return json(
          page(
            numbers.map((n) => issueJson(issueByNumber(state, n))),
            url,
          ),
        );
      }),
    ),
    http.post(
      `${R}/issues/:number/dependencies/blocked_by`,
      handle(async ({ params, body }) => {
        const ref = refOf(params);
        const state = fake.state(ref);
        if (!state.issueDependencies) return json({ message: 'Not Found' }, 404);
        const n = Number(param(params, 'number'));
        const blocker = [...state.issues.values()].find((i) => i.id === body.issue_id);
        if (!blocker) return json({ message: 'Validation Failed' }, 422);
        await fake.setDependencies(ref, n, [
          ...(await fake.getDependencies(ref, n)),
          blocker.number,
        ]);
        return json(issueJson(issueByNumber(state, n)), 201);
      }),
    ),
    http.delete(
      `${R}/issues/:number/dependencies/blocked_by/:issueId`,
      handle(async ({ params }) => {
        const ref = refOf(params);
        const state = fake.state(ref);
        const n = Number(param(params, 'number'));
        const blocker = [...state.issues.values()].find(
          (i) => i.id === Number(param(params, 'issueId')),
        );
        if (!blocker) return json({ message: 'Not Found' }, 404);
        await fake.setDependencies(
          ref,
          n,
          (await fake.getDependencies(ref, n)).filter((d) => d !== blocker.number),
        );
        return json(issueJson(issueByNumber(state, n)));
      }),
    ),

    // Labels
    http.get(
      `${R}/labels`,
      handle(async ({ params, url }) =>
        json(page((await fake.listLabels(refOf(params))).map(labelJson), url)),
      ),
    ),
    http.post(
      `${R}/labels`,
      handle(async ({ params, body }) => {
        const label = {
          name: str(body.name),
          color: str(body.color),
          ...(body.description ? { description: str(body.description) } : {}),
        };
        await fake.ensureLabels(refOf(params), [label]);
        return json(labelJson(label), 201);
      }),
    ),
    http.patch(
      `${R}/labels/:name`,
      handle(async ({ params, body }) => {
        const label = {
          name: param(params, 'name'),
          color: str(body.color),
          ...(body.description ? { description: str(body.description) } : {}),
        };
        await fake.ensureLabels(refOf(params), [label]);
        return json(labelJson(label));
      }),
    ),

    // Pull requests et checks
    http.post(
      `${R}/pulls`,
      handle(async ({ params, body }) =>
        json(
          pullJson(
            await fake.createPullRequest(refOf(params), {
              title: str(body.title),
              body: str(body.body ?? ''),
              head: str(body.head),
              base: str(body.base),
            }),
            refOf(params),
          ),
          201,
        ),
      ),
    ),
    http.get(
      `${R}/pulls`,
      handle(async ({ params, url }) => {
        const ref = refOf(params);
        const head = url.searchParams.get('head')?.split(':')[1];
        const state = url.searchParams.get('state') ?? 'open';
        const pulls = await fake.listPullRequests(ref, {
          state: state as 'open' | 'closed' | 'all',
          ...(head !== undefined ? { head } : {}),
        });
        return json(
          page(
            pulls.map((p) => pullJson(p, ref)),
            url,
          ),
        );
      }),
    ),
    http.get(
      `${R}/pulls/:number`,
      handle(async ({ params }) =>
        json(
          pullJson(
            await fake.getPullRequest(refOf(params), Number(param(params, 'number'))),
            refOf(params),
          ),
        ),
      ),
    ),
    http.get(
      `${R}/commits/:sha/check-runs`,
      handle(async ({ params }) => {
        const runs = await fake.listCheckRuns(refOf(params), param(params, 'sha'));
        return json({ total_count: runs.length, check_runs: runs });
      }),
    ),

    // Actions
    http.post(
      `${R}/actions/workflows/:workflow/dispatches`,
      handle(async ({ params, body }) => {
        await fake.dispatchWorkflow(refOf(params), {
          workflow: param(params, 'workflow'),
          ref: str(body.ref),
          inputs: (body.inputs as Record<string, string> | undefined) ?? {},
        });
        return empty();
      }),
    ),
    http.get(
      `${R}/actions/runs`,
      handle(async ({ params, url }) => {
        const runs = await fake.listWorkflowRuns(refOf(params), {
          ...(url.searchParams.get('branch')
            ? { branch: String(url.searchParams.get('branch')) }
            : {}),
          ...(url.searchParams.get('event')
            ? { event: String(url.searchParams.get('event')) }
            : {}),
        });
        return json({ total_count: runs.length, workflow_runs: runs.map(runJson) });
      }),
    ),
    http.get(
      `${R}/actions/workflows/:workflow/runs`,
      handle(async ({ params, url }) => {
        const runs = await fake.listWorkflowRuns(refOf(params), {
          workflow: param(params, 'workflow'),
          ...(url.searchParams.get('branch')
            ? { branch: String(url.searchParams.get('branch')) }
            : {}),
          ...(url.searchParams.get('event')
            ? { event: String(url.searchParams.get('event')) }
            : {}),
        });
        return json({ total_count: runs.length, workflow_runs: runs.map(runJson) });
      }),
    ),
    http.get(
      `${R}/actions/runs/:runId`,
      handle(async ({ params }) =>
        json(runJson(await fake.getWorkflowRun(refOf(params), Number(param(params, 'runId'))))),
      ),
    ),
    http.get(
      `${R}/actions/runs/:runId/jobs`,
      handle(async ({ params }) => {
        const jobs = await fake.listRunJobs(refOf(params), Number(param(params, 'runId')));
        return json({ total_count: jobs.length, jobs: jobs.map(jobJson) });
      }),
    ),
    http.get(
      `${R}/actions/jobs/:jobId/logs`,
      handle(async ({ params }) =>
        HttpResponse.text(await fake.getJobLogs(refOf(params), Number(param(params, 'jobId')))),
      ),
    ),

    // Secrets
    http.get(
      `${R}/actions/secrets/public-key`,
      handle(async () => {
        const key = await fake.publicKey();
        return json({ key_id: 'cle-1', key: key.publicKey });
      }),
    ),
    http.put(
      `${R}/actions/secrets/:name`,
      handle(async ({ params, body }) => {
        if (body.key_id !== 'cle-1') return json({ message: 'key_id inconnu' }, 422);
        await fake.putEncryptedSecret(
          refOf(params),
          param(params, 'name'),
          str(body.encrypted_value),
        );
        return empty(201);
      }),
    ),
    http.get(
      `${R}/actions/secrets`,
      handle(async ({ params }) => {
        const names = await fake.listRepositorySecrets(refOf(params));
        return json({ total_count: names.length, secrets: names.map((name) => ({ name })) });
      }),
    ),

    // GraphQL : auto-merge
    http.post(
      `${API}/graphql`,
      handle(async ({ body }) => {
        const variables = body.variables as { id: string };
        const match = /^PR_([^/]+)[/]([^#]+)#([0-9]+)$/.exec(variables.id);
        if (!match) return json({ data: null, errors: [{ message: 'Identifiant de PR inconnu' }] });
        const [, owner = '', repo = '', number = '0'] = match;
        try {
          await fake.enableAutoMerge({ owner, repo }, Number(number));
          return json({ data: { enablePullRequestAutoMerge: { clientMutationId: null } } });
        } catch (error) {
          return json({
            data: null,
            errors: [{ message: error instanceof Error ? error.message : String(error) }],
          });
        }
      }),
    ),
  ];
}
