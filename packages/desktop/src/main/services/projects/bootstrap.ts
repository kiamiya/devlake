import { randomBytes } from 'node:crypto';
import type { FileChange, GitHubPort, RepoRef } from 'github';
import { isGitHubError } from 'github';
import {
  ALL_LABELS,
  DEFAULT_SCOPE_RULES,
  isGameProject,
  PROFILES_DIR,
  requiredChecksFor,
  type ProjectConfig,
  type ProjectType,
  type QualityProfile,
} from 'shared';
import type { SecretVault } from '../../vault.js';
import {
  DEVLAKE_REPOSITORY,
  gitattributes,
  PROJECT_CONFIG_PATH,
  projectYaml,
  renderCallers,
} from './files.js';

export interface BootstrapInput {
  name: string;
  type: ProjectType;
  private: boolean;
  qualityProfile: QualityProfile;
  /** Propriétaire du dépôt (organisation) ; absent = compte du jeton. */
  owner?: string | undefined;
  /**
   * Projet repris : le dépôt doit exister (jamais créé), sa protection de main garde ses
   * checks, son `.gitattributes` est complété, et project.yml le marque `adopted`.
   */
  adopted?: boolean | undefined;
}

export const BOOTSTRAP_STEPS = [
  'repository',
  'merge-settings',
  'actions-permissions',
  'labels',
  'files',
  'branch-protection',
  'secrets',
  'variables',
] as const;
export type BootstrapStep = (typeof BOOTSTRAP_STEPS)[number];
export type StepStatus = 'created' | 'updated' | 'unchanged';

export interface BootstrapReport {
  repository: RepoRef;
  steps: { step: BootstrapStep; status: StepStatus }[];
}

export class ClaudeTokenMissingError extends Error {
  constructor() {
    super('Jeton Claude Code absent : l’enregistrer dans les réglages avant de créer un projet.');
    this.name = 'ClaudeTokenMissingError';
  }
}

export class BootstrapStepError extends Error {
  readonly step: BootstrapStep;

  constructor(step: BootstrapStep, cause: unknown) {
    super(
      `Bootstrap interrompu à l’étape « ${step} » : ${cause instanceof Error ? cause.message : String(cause)} Relancer le bootstrap reprendra là où il s’est arrêté.`,
      { cause },
    );
    this.name = 'BootstrapStepError';
    this.step = step;
  }
}

export interface BootstrapDeps {
  github: GitHubPort;
  vault: SecretVault;
  /** Version épinglée des workflows réutilisables (tag de devlake). */
  workflowsRef: string;
  /** Tentatives avant escalade, reprises dans project.yml. */
  maxAttempts: number;
  callerTemplates: Readonly<Record<string, string>>;
  /** Profils d'agents par défaut (`templates/profiles`), nom du fichier → contenu. */
  profileTemplates: Readonly<Record<string, string>>;
}

const MAIN = 'main';

/** Couleurs des labels AgentLake. */
function labelColor(name: string): string {
  if (name === 'agentlake:task') return '5319e7';
  if (name.endsWith('/awaiting-answer') || name.endsWith('/escalated')) return 'd93f0b';
  if (name.endsWith('/running') || name.endsWith('/fixing')) return '0e8a16';
  if (name.startsWith('agentlake:state/')) return 'fbca04';
  return 'c5def5';
}

export function projectConfigFor(input: BootstrapInput, maxAttempts: number): ProjectConfig {
  return {
    type: input.type,
    qualityProfile: input.qualityProfile,
    limits: { maxAttempts, answerReminderHours: 24 },
    // Le planificateur retiendra les profils utiles ; au départ, architecte et relecteur.
    profiles: ['architect', 'reviewer'],
    exclusiveResources: [],
    bridgeRequired: isGameProject(input.type),
    // Règles de périmètre par profil (documentation, assets 3D), modifiables par projet.
    scopeRules: isGameProject(input.type)
      ? DEFAULT_SCOPE_RULES
      : { docs: DEFAULT_SCOPE_RULES.docs ?? { paths: ['docs/**'] } },
    ...(input.adopted === true ? { adopted: true } : {}),
  };
}

/** Variable Actions du compte de Kia : les dépôts d'organisation n'appartiennent pas à Kia. */
export const OWNER_VARIABLE = 'AGENTLAKE_OWNER';

export class RepositoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Dépôt introuvable ou inaccessible : ${id}.`);
    this.name = 'RepositoryNotFoundError';
  }
}

/** `.gitattributes` d'un projet repris : l'existant est gardé, les règles manquantes ajoutées. */
export function mergeGitattributes(current: string | null, wanted: string): string {
  if (current === null || current.trim() === '') return wanted;
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = wanted
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#') && !have.has(l.trim()));
  if (missing.length === 0) return current;
  return `${current.trimEnd()}\n\n# Ajouté par AgentLake : binaires dans Git LFS (fichiers déjà commités inchangés).\n${missing.join('\n')}\n`;
}

/**
 * Crée ou complète un projet sur GitHub. Chaque étape lit l'état avant d'agir :
 * relancer le bootstrap ne modifie que ce qui manque ou diffère.
 */
export async function bootstrapProject(
  input: BootstrapInput,
  deps: BootstrapDeps,
): Promise<BootstrapReport> {
  const { github, vault } = deps;
  const claudeToken = await vault.get('claude-oauth-token');
  if (claudeToken === null) throw new ClaudeTokenMissingError();

  const login = (await github.getAuthenticatedUser()).login;
  const owner = input.owner ?? login;
  const ref: RepoRef = { owner, repo: input.name };
  const adopted = input.adopted === true;
  const steps: BootstrapReport['steps'] = [];

  const run = async (step: BootstrapStep, action: () => Promise<StepStatus>) => {
    try {
      steps.push({ step, status: await action() });
    } catch (error) {
      throw new BootstrapStepError(step, error);
    }
  };

  await run('repository', async () => {
    try {
      await github.getRepository(ref);
      return 'unchanged';
    } catch (error) {
      if (!isGitHubError(error, 'not-found')) throw error;
      if (adopted || owner !== login) throw new RepositoryNotFoundError(`${owner}/${input.name}`);
      await github.createRepository({
        name: input.name,
        private: input.private,
        description: 'Projet AgentLake',
      });
      return 'created';
    }
  });

  await run('merge-settings', async () => {
    const r = await github.getRepository(ref);
    const ok =
      r.allowAutoMerge &&
      r.allowSquashMerge &&
      !r.allowMergeCommit &&
      !r.allowRebaseMerge &&
      r.deleteBranchOnMerge;
    if (ok) return 'unchanged';
    await github.configureMergeSettings(ref);
    return 'updated';
  });

  await run('actions-permissions', async () => {
    const p = await github.getActionsPermissions(ref);
    const ok =
      p.defaultWorkflowPermissions === 'read' &&
      !p.canApprovePullRequestReviews &&
      p.forkPrApproval === 'all_external_contributors';
    if (ok) return 'unchanged';
    await github.configureActionsPermissions(ref);
    return 'updated';
  });

  await run('labels', async () => {
    const wanted = ALL_LABELS.map((name) => ({
      name,
      color: labelColor(name),
      description: 'AgentLake',
    }));
    const existing = new Map((await github.listLabels(ref)).map((l) => [l.name, l]));
    const missing = wanted.filter((w) => {
      const e = existing.get(w.name);
      return !e || e.color !== w.color || e.description !== w.description;
    });
    if (missing.length === 0) return 'unchanged';
    await github.ensureLabels(ref, missing);
    return missing.length === wanted.length ? 'created' : 'updated';
  });

  await run('files', async () => {
    const desired = new Map<string, string>([
      ...renderCallers(deps.callerTemplates, {
        repository: DEVLAKE_REPOSITORY,
        ref: deps.workflowsRef,
      }),
      [
        '.gitattributes',
        adopted
          ? mergeGitattributes(
              (await github.getFile(ref, '.gitattributes', MAIN))?.content ?? null,
              gitattributes(input.type),
            )
          : gitattributes(input.type),
      ],
    ]);
    const changes: FileChange[] = [];
    for (const [path, content] of desired) {
      if ((await github.getFile(ref, path, MAIN))?.content !== content)
        changes.push({ path, content });
    }
    // project.yml et les profils ne sont écrits que s'ils manquent : le projet peut les avoir
    // ajustés depuis (modifier un profil le surcharge pour ce projet).
    const ifMissing = new Map<string, () => string>([
      [PROJECT_CONFIG_PATH, () => projectYaml(projectConfigFor(input, deps.maxAttempts))],
      ...Object.entries(deps.profileTemplates)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, content]): [string, () => string] => [
          `${PROFILES_DIR}/${name}`,
          () => content,
        ]),
    ]);
    for (const [path, content] of ifMissing) {
      if (!(await github.getFile(ref, path, MAIN))) changes.push({ path, content: content() });
    }
    if (changes.length === 0) return 'unchanged';
    await github.commitFiles(ref, {
      branch: MAIN,
      message: 'chore: bootstrap AgentLake',
      changes,
    });
    return changes.length === desired.size + ifMissing.size ? 'created' : 'updated';
  });

  await run('branch-protection', async () => {
    const current = await github.getBranchProtection(ref, MAIN);
    // Projet repris : les checks de sa CI restent exigés, ceux de la porte qualité s'ajoutent.
    const wanted = [
      ...new Set([
        ...(adopted ? (current?.requiredChecks ?? []) : []),
        ...requiredChecksFor(input.qualityProfile),
      ]),
    ];
    const same =
      current !== null &&
      current.requirePullRequest &&
      !current.enforceAdmins &&
      current.requiredApprovals === 0 &&
      [...current.requiredChecks].sort().join() === [...wanted].sort().join();
    if (same) return 'unchanged';
    // Kia (administrateur) reste exempté : le cockpit commite le contexte et le plan.
    await github.protectBranch(ref, MAIN, { requiredChecks: wanted, enforceAdmins: false });
    return current === null ? 'created' : 'updated';
  });

  await run('secrets', async () => {
    const present = new Set(await github.listRepositorySecrets(ref));
    const added: string[] = [];
    if (!present.has('CLAUDE_CODE_OAUTH_TOKEN')) {
      await github.setRepositorySecret(ref, 'CLAUDE_CODE_OAUTH_TOKEN', claudeToken);
      added.push('CLAUDE_CODE_OAUTH_TOKEN');
    }
    if (isGameProject(input.type) && !present.has('AURA_BRIDGE_SECRET')) {
      await github.setRepositorySecret(ref, 'AURA_BRIDGE_SECRET', await auraBridgeSecret(vault));
      added.push('AURA_BRIDGE_SECRET');
    }
    return added.length === 0 ? 'unchanged' : present.size === 0 ? 'created' : 'updated';
  });

  await run('variables', async () => {
    const current = await github.getRepositoryVariable(ref, OWNER_VARIABLE);
    if (current === login) return 'unchanged';
    await github.setRepositoryVariable(ref, OWNER_VARIABLE, login);
    return current === null ? 'created' : 'updated';
  });

  return { repository: ref, steps };
}

/** Secret partagé avec le pont Aura : un seul par cockpit, créé au premier besoin. */
export async function auraBridgeSecret(vault: SecretVault): Promise<string> {
  const existing = await vault.get('aura-bridge-secret');
  if (existing !== null) return existing;
  const secret = randomBytes(32).toString('base64url');
  await vault.set('aura-bridge-secret', secret);
  return secret;
}
