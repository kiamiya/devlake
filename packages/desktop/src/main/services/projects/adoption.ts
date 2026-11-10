import type { GitHubPort, RepoRef, TreeEntry } from 'github';
import {
  DEFAULT_QUALITY_PROFILE,
  isGameProject,
  TASK_LABEL,
  type ProjectType,
  type QualityProfile,
} from 'shared';
import type {
  AdoptableRepository,
  AdoptionReport,
  ProjectSummary,
} from '../../../shared/ipc-contract.js';
import type { Repositories } from '../../db/repositories.js';
import type { ProjectsService } from '../../projects-service.js';
import type { BootstrapReport } from './bootstrap.js';
import type { ProjectCreationService } from './creation-service.js';
import { lfsExtensions, PROJECT_CONFIG_PATH } from './files.js';

const MAIN = 'main';
/** Au-delà, un fichier « binaire » n'est pas un pointeur Git LFS (≈ 130 octets). */
const LFS_POINTER_MAX = 1024;
const HEAVY_SHOWN = 10;

export class AdoptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdoptionError';
  }
}

const isRoot = (path: string) => !path.includes('/');
const parentOf = (path: string, depth: number) => path.split('/').slice(0, -depth).join('/');

interface Engine {
  type: 'unity' | 'unreal';
  /** Dossier du projet moteur ; '' pour la racine. */
  dir: string;
}

/** Projets Unity (ProjectSettings/ProjectVersion.txt) et Unreal (.uproject) du dépôt. */
export function findEngines(entries: readonly TreeEntry[]): Engine[] {
  const engines: Engine[] = [];
  for (const { path } of entries) {
    if (
      path === 'ProjectSettings/ProjectVersion.txt' ||
      path.endsWith('/ProjectSettings/ProjectVersion.txt')
    )
      engines.push({ type: 'unity', dir: parentOf(path, 2) });
    else if (path.toLowerCase().endsWith('.uproject'))
      engines.push({ type: 'unreal', dir: parentOf(path, 1) });
  }
  return engines;
}

/** Type proposé hors moteur de jeu, d'après les fichiers de la racine. */
function guessType(entries: readonly TreeEntry[], packageJson: string | null): ProjectType {
  const root = new Set(entries.filter((e) => isRoot(e.path)).map((e) => e.path));
  const dirs = new Set(entries.map((e) => e.path.split('/')[0] ?? ''));
  if (
    root.has('pubspec.yaml') ||
    (packageJson !== null && /"(react-native|expo)"/.test(packageJson)) ||
    (dirs.has('android') && dirs.has('ios'))
  )
    return 'mobile';
  if (packageJson !== null) return 'web';
  const backend = [
    'go.mod',
    'pom.xml',
    'build.gradle',
    'Cargo.toml',
    'pyproject.toml',
    'requirements.txt',
  ];
  if (
    backend.some((f) => root.has(f)) ||
    [...root].some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))
  )
    return 'backend';
  return 'tool';
}

/** Fichiers binaires commités hors Git LFS (taille supérieure à celle d'un pointeur). */
export function heavyOutsideLfs(entries: readonly TreeEntry[], type: ProjectType): TreeEntry[] {
  const extensions = new Set(lfsExtensions(type));
  return entries
    .filter((e) => {
      const ext = e.path.split('.').pop()?.toLowerCase() ?? '';
      return e.path.includes('.') && extensions.has(ext) && e.size > LFS_POINTER_MAX;
    })
    .sort((a, b) => b.size - a.size);
}

const formatSize = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} Mo`
    : `${String(Math.ceil(bytes / 1024))} Ko`;

/**
 * Reprise d'un projet existant : dépôts administrés (perso et organisations), détection du
 * type et de ce qui va changer, puis bootstrap en mode reprise une fois confirmé par Kia.
 */
export class AdoptionService {
  constructor(
    private readonly deps: {
      repos: Repositories;
      github: () => Promise<GitHubPort>;
      creation: ProjectCreationService;
      projects: ProjectsService;
    },
  ) {}

  /** Dépôts administrés, pas encore connus du cockpit. */
  async candidates(): Promise<AdoptableRepository[]> {
    const known = new Set(this.deps.repos.projects.list().map((p) => p.id.toLowerCase()));
    return (await (await this.deps.github()).listAdministrableRepositories())
      .filter((r) => !known.has(`${r.owner}/${r.name}`.toLowerCase()))
      .map((r) => ({
        owner: r.owner,
        repo: r.name,
        private: r.private,
        defaultBranch: r.defaultBranch,
      }));
  }

  /** Rapport de détection, à confirmer avant la reprise ; rien n'est modifié ici. */
  async detect(ref: RepoRef, typeOverride?: ProjectType): Promise<AdoptionReport> {
    const github = await this.deps.github();
    const repository = await github.getRepository(ref);
    const branch = repository.defaultBranch;
    const tree = await github.listTree(ref, branch);
    const entries = tree.entries;
    const blockers: string[] = [];
    const changes: string[] = [];
    const warnings: string[] = [];

    const alreadyAgentLake = (await github.getFile(ref, PROJECT_CONFIG_PATH, branch)) !== null;

    // Moteur de jeu : à la racine seulement.
    const engines = findEngines(entries);
    const rootEngine = engines.find((e) => e.dir === '');
    for (const e of engines.filter((x) => x.dir !== ''))
      blockers.push(
        `Projet ${e.type === 'unity' ? 'Unity' : 'Unreal'} dans le sous-dossier « ${e.dir} » : seul un projet à la racine du dépôt est pris en charge. Le déplacer à la racine avant la reprise.`,
      );
    if (new Set(engines.filter((e) => e.dir === '').map((e) => e.type)).size > 1)
      blockers.push(
        'Projets Unity et Unreal à la racine en même temps : un seul moteur par dépôt.',
      );

    const packageJson = entries.some((e) => e.path === 'package.json')
      ? ((await github.getFile(ref, 'package.json', branch))?.content ?? null)
      : null;
    const detectedType: ProjectType = rootEngine?.type ?? guessType(entries, packageJson);
    const type = typeOverride ?? detectedType;
    const qualityProfile: QualityProfile = DEFAULT_QUALITY_PROFILE[type];
    if (typeOverride !== undefined && typeOverride !== detectedType)
      warnings.push(`Type choisi (${typeOverride}) différent du type détecté (${detectedType}).`);

    // Branche par défaut renommée en main.
    if (branch !== MAIN) {
      if (await github.branchExists(ref, MAIN))
        blockers.push(
          `La branche par défaut est « ${branch} » et une autre branche « main » existe déjà : la supprimer ou la renommer avant la reprise.`,
        );
      else
        changes.push(
          `Branche par défaut « ${branch} » renommée en « main » (GitHub redirige l’ancien nom ; chaque clone local devra faire « git branch -m ${branch} main »).`,
        );
    }

    // Réglages imposés par AgentLake.
    if (!repository.allowAutoMerge) changes.push('Auto-merge activé.');
    if (repository.allowMergeCommit) changes.push('Merge commits désactivés (squash seulement).');
    if (repository.allowRebaseMerge) changes.push('Rebase merge désactivé (squash seulement).');
    if (!repository.allowSquashMerge) changes.push('Squash merge activé.');
    if (!repository.deleteBranchOnMerge) changes.push('Branches supprimées après fusion.');
    const protection = await github.getBranchProtection(ref, branch);
    if (protection !== null && protection.requiredApprovals > 0)
      changes.push(
        `Relectures humaines exigées sur main : ${String(protection.requiredApprovals)} → 0 (les agents fusionnent seuls une fois les checks verts).`,
      );
    if (protection?.enforceAdmins === true)
      changes.push(
        'Règles de main non imposées aux administrateurs (le cockpit commite le contexte et le plan).',
      );
    const actions = await github.getActionsPermissions(ref);
    if (actions.defaultWorkflowPermissions !== 'read')
      changes.push('GITHUB_TOKEN des workflows en lecture seule par défaut.');
    if (actions.canApprovePullRequestReviews)
      changes.push('Les workflows ne peuvent plus approuver de PR.');

    // Git LFS pour la suite seulement.
    const heavy = heavyOutsideLfs(entries, type);
    if (heavy.length > 0)
      warnings.push(
        `${String(heavy.length)} fichier(s) binaire(s) déjà commités hors Git LFS (${formatSize(heavy.reduce((s, e) => s + e.size, 0))}) : ils restent tels quels, seuls les nouveaux iront dans LFS. Les clones existants les verront peut-être comme modifiés (« git add --renormalize » pour les migrer plus tard).`,
      );
    if (tree.truncated)
      warnings.push(
        'Dépôt très grand : GitHub n’a renvoyé qu’une partie des fichiers, la détection est partielle.',
      );

    const blendFiles = entries.filter((e) => e.path.toLowerCase().endsWith('.blend')).length;
    const settings = this.deps.repos.settings.get();
    const workflows = entries
      .map((e) => e.path)
      .filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))
      .filter((p) => !p.split('/').pop()?.startsWith('agentlake-'));
    const issues = (await github.listIssues(ref, { state: 'open' })).filter(
      (i) => !i.labels.some((l) => l.startsWith('agentlake:')) && !i.labels.includes(TASK_LABEL),
    );
    const pulls = await github.listPullRequests(ref, { state: 'open' });

    return {
      repository: {
        owner: ref.owner,
        repo: ref.repo,
        private: repository.private,
        defaultBranch: branch,
      },
      alreadyAgentLake,
      detectedType,
      type,
      qualityProfile,
      blockers,
      changes,
      warnings,
      heavyOutsideLfs: heavy.slice(0, HEAVY_SHOWN).map((e) => ({ path: e.path, size: e.size })),
      heavyOutsideLfsCount: heavy.length,
      blendFiles,
      workflows,
      requiredChecks: protection?.requiredChecks ?? [],
      openIssues: issues.length,
      openPullRequests: pulls.length,
      engineConfigured:
        type === 'unity' || type === 'unreal' ? settings.auraMcp[type] !== null : null,
      blenderConfigured: isGameProject(type) ? settings.auraMcp.blender !== null : null,
    };
  }

  /**
   * Reprend le projet : refait la détection, refuse s'il reste un blocage ou si des
   * changements n'ont pas été acceptés, renomme la branche si besoin, puis bootstrap.
   */
  async adopt(input: {
    owner: string;
    repo: string;
    type: ProjectType;
    qualityProfile: QualityProfile;
    acceptChanges: boolean;
  }): Promise<{
    project: ProjectSummary;
    report: BootstrapReport | null;
    renamedBranch: string | null;
  }> {
    const ref = { owner: input.owner, repo: input.repo };
    const detection = await this.detect(ref, input.type);
    if (detection.alreadyAgentLake && detection.repository.defaultBranch === MAIN)
      return { project: await this.deps.projects.open(ref), report: null, renamedBranch: null };
    if (detection.blockers.length > 0) throw new AdoptionError(detection.blockers.join(' '));
    if (detection.changes.length > 0 && !input.acceptChanges)
      throw new AdoptionError(
        'Des réglages du dépôt vont changer : les confirmer avant la reprise.',
      );

    const github = await this.deps.github();
    let renamedBranch: string | null = null;
    if (detection.repository.defaultBranch !== MAIN) {
      await github.renameBranch(ref, detection.repository.defaultBranch, MAIN);
      renamedBranch = detection.repository.defaultBranch;
    }
    const report = await this.deps.creation.bootstrap({
      name: input.repo,
      owner: input.owner,
      type: input.type,
      private: detection.repository.private,
      qualityProfile: input.qualityProfile,
      adopted: true,
    });
    return { project: await this.deps.projects.open(ref), report, renamedBranch };
  }
}
