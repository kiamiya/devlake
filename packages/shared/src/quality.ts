import type { ProjectType, QualityProfile } from './ids.js';

/** Profil qualité proposé par défaut selon le type de projet. */
export const DEFAULT_QUALITY_PROFILE: Readonly<Record<ProjectType, QualityProfile>> = {
  web: 'web',
  backend: 'backend',
  mobile: 'mobile',
  tool: 'tool',
  script: 'tool',
  unity: 'unity',
  unreal: 'unreal',
};

/**
 * Checks obligatoires sur `main` (cadrage, « Règles communes ») : lint, types,
 * tests unitaires et d'intégration, build, audit de dépendances, secrets, analyse
 * statique et relecture Claude. Ce sont des noms de checks GitHub : la CI des
 * projets (T14) doit produire exactement ces noms.
 */
export const CI_CHECKS = [
  'lint',
  'typecheck',
  'unit-tests',
  'integration-tests',
  'build',
  'dependency-audit',
  'gitleaks',
  'codeql',
] as const;

/**
 * Checks de la porte qualité d'AgentLake (workflow d'appel `agentlake-review.yml`, job
 * `agentlake`) : ils ne tournent que sur les PR.
 */
export const PULL_REQUEST_CHECKS = ['agentlake / tests-guard', 'agentlake / review'] as const;

export const COMMON_REQUIRED_CHECKS = [...CI_CHECKS, ...PULL_REQUEST_CHECKS] as const;

/** Checks propres à chaque profil qualité, produits par `templates/quality/<profil>/ci.yml`. */
export const PROFILE_CHECKS: Readonly<Record<QualityProfile, readonly string[]>> = {
  web: ['e2e'],
  backend: ['contract-tests'],
  mobile: ['e2e'],
  tool: ['cli-e2e'],
  unity: ['playmode-tests'],
  unreal: [],
};

/** Checks de la CI du projet (`ci.yml`) pour un profil : ils tournent sur les PR et sur `main`. */
export function ciChecksFor(profile: QualityProfile): string[] {
  return [...CI_CHECKS, ...PROFILE_CHECKS[profile]];
}

/** Checks obligatoires sur `main` (protection de branche) pour un profil. */
export function requiredChecksFor(profile: QualityProfile): string[] {
  return [...ciChecksFor(profile), ...PULL_REQUEST_CHECKS];
}

/** Types de projet qui passent par le pont Aura. */
export function isGameProject(type: ProjectType): boolean {
  return type === 'unity' || type === 'unreal';
}
