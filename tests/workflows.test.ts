import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Garde-fous statiques des workflows (T21) : permissions minimales, pas de
 * `pull_request_target`, pas de code de PR exécuté avec des secrets, forks écartés.
 * Workflows réutilisables de devlake, workflows d'appel posés dans les projets, gabarits qualité.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Permissions = Record<string, string> | string;
interface Step {
  uses?: string;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  permissions?: Permissions;
  steps?: Step[];
  secrets?: unknown;
}
interface Workflow {
  on: Record<string, unknown> | string | string[];
  permissions?: Permissions;
  jobs: Record<string, Job>;
}

const FILES = [
  ...readdirSync(join(ROOT, '.github/workflows')).map((f) => `.github/workflows/${f}`),
  ...readdirSync(join(ROOT, 'templates/caller')).map((f) => `templates/caller/${f}`),
  ...readdirSync(join(ROOT, 'templates/quality')).map((d) => `templates/quality/${d}/ci.yml`),
];
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const load = (file: string) => parse(read(file)) as Workflow;
const triggers = (w: Workflow): string[] =>
  typeof w.on === 'string' ? [w.on] : Array.isArray(w.on) ? w.on : Object.keys(w.on);

/**
 * Seules permissions en écriture autorisées, job par job, avec leur raison. Toute écriture
 * nouvelle, ou retirée, fait échouer le test : la table se relit en revue.
 */
const WRITE_ALLOWED: Record<string, string[]> = {
  // Agent : branche de tâche, issue (état, questions), PR ; OIDC pour le jeton de l'app Claude.
  '.github/workflows/agent-task.yml#agent': ['contents', 'issues', 'pull-requests', 'id-token'],
  // @live nocturne : issue d'échec dans devlake.
  '.github/workflows/nightly-live.yml#live': ['issues'],
  'templates/caller/agentlake-agent-task.yml#agent': [
    'contents',
    'issues',
    'pull-requests',
    'id-token',
  ],
  // Dispatcher : états et commentaires des issues, workflow_dispatch des agents, relance de checks.
  '.github/workflows/dispatcher.yml#dispatch': ['issues', 'actions'],
  'templates/caller/agentlake-dispatcher.yml#dispatch': ['issues', 'actions'],
  // Planificateur : plan commité, issues de tâches.
  '.github/workflows/planner.yml#plan': ['contents', 'issues'],
  'templates/caller/agentlake-planner.yml#plan': ['contents', 'issues'],
  // Porte qualité : question de la garde sur l'issue, verdict du relecteur sur la PR.
  '.github/workflows/review.yml#tests-guard': ['issues'],
  '.github/workflows/review.yml#review': ['pull-requests', 'issues'],
  'templates/caller/agentlake-review.yml#agentlake': ['pull-requests', 'issues'],
  // CodeQL publie ses alertes.
  ...Object.fromEntries(
    readdirSync(join(ROOT, 'templates/quality')).map((d) => [
      `templates/quality/${d}/ci.yml#codeql`,
      ['security-events'],
    ]),
  ),
};

/** Une étape exécute-t-elle le code de tête d'une PR ou d'un run (checkout de sa référence) ? */
export function checksOutEventHead(step: Step): boolean {
  if (step.uses?.startsWith('actions/checkout@') !== true) return false;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const target = `${text(step.with?.ref)} ${text(step.with?.repository)}`;
  return /github\.event\.(pull_request|workflow_run|check_suite)\.head|github\.head_ref/.test(
    target,
  );
}

describe('garde-fous des workflows', () => {
  it('chaque fichier se lit et déclare des permissions au niveau du workflow', () => {
    expect(FILES.length).toBeGreaterThan(10);
    for (const file of FILES) {
      const workflow = load(file);
      expect(workflow.permissions, file).toBeDefined();
    }
  });

  it('permissions minimales : lecture par défaut, écritures limitées à la table', () => {
    const seen = new Set<string>();
    for (const file of FILES) {
      const workflow = load(file);
      const top = workflow.permissions ?? {};
      // Niveau workflow : rien, ou lecture seule (jamais read-all ni write-all).
      expect(typeof top, file).toBe('object');
      for (const [scope, level] of Object.entries(top as Record<string, string>))
        expect(level, `${file} ${scope}`).not.toBe('write');
      for (const [id, job] of Object.entries(workflow.jobs)) {
        const key = `${file}#${id}`;
        const permissions = job.permissions ?? top;
        expect(typeof permissions, key).toBe('object');
        const writes = Object.entries(permissions as Record<string, string>)
          .filter(([, level]) => level === 'write')
          .map(([scope]) => scope)
          .sort();
        for (const level of Object.values(permissions as Record<string, string>))
          expect(['read', 'write', 'none'], key).toContain(level);
        expect(writes, key).toEqual([...(WRITE_ALLOWED[key] ?? [])].sort());
        if (writes.length > 0) seen.add(key);
      }
    }
    // La table ne garde pas d'entrée morte.
    expect([...seen].sort()).toEqual(Object.keys(WRITE_ALLOWED).sort());
  });

  it('pull_request_target interdit ; jamais le code de tête d’un événement avec des secrets', () => {
    for (const file of FILES) {
      const text = read(file);
      expect(text, file).not.toMatch(/^\s*pull_request_target\s*:/m);
      const workflow = load(file);
      // workflow_run et check_suite tournent dans le contexte du dépôt, secrets compris.
      if (!triggers(workflow).some((t) => ['workflow_run', 'check_suite'].includes(t))) continue;
      for (const job of Object.values(workflow.jobs))
        for (const step of job.steps ?? []) expect(checksOutEventHead(step), file).toBe(false);
    }
  });

  it('détection du checkout de la tête d’un événement', () => {
    const checkout = (ref: string): Step => ({ uses: 'actions/checkout@v4', with: { ref } });
    expect(checksOutEventHead(checkout('${{ github.event.pull_request.head.sha }}'))).toBe(true);
    expect(checksOutEventHead(checkout('${{ github.event.workflow_run.head_sha }}'))).toBe(true);
    expect(checksOutEventHead(checkout('${{ github.head_ref }}'))).toBe(true);
    expect(checksOutEventHead(checkout('v1'))).toBe(false);
    expect(checksOutEventHead({ uses: 'actions/setup-node@v4' })).toBe(false);
  });

  it('PR de fork : aucun job qui reçoit les secrets du projet ne tourne pour elle', () => {
    const SAME_REPO = 'github.event.pull_request.head.repo.full_name == github.repository';
    /**
     * Exception : le dispatcher n'exécute aucun code de la PR (scripts devlake épinglés) et
     * écarte lui-même les événements venant d'un fork, avec une trace dans le journal
     * (`forkOrigin` dans dispatch/adapters.ts) ; un `if` sauterait le job en silence.
     */
    const SELF_FILTERED = ['templates/caller/agentlake-dispatcher.yml#dispatch'];
    for (const file of FILES.filter((f) => f.startsWith('templates/caller/'))) {
      const workflow = load(file);
      if (!triggers(workflow).includes('pull_request')) continue;
      for (const [id, job] of Object.entries(workflow.jobs)) {
        if (job.secrets === undefined || SELF_FILTERED.includes(`${file}#${id}`)) continue;
        expect(job.if ?? '', `${file}#${id}`).toContain(SAME_REPO);
      }
    }
  });
});
