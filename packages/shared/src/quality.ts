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
export const COMMON_REQUIRED_CHECKS = [
  'lint',
  'typecheck',
  'unit-tests',
  'integration-tests',
  'build',
  'dependency-audit',
  'gitleaks',
  'codeql',
  'review',
] as const;

/** Checks obligatoires d'un profil ; les ajouts propres à chaque profil arrivent avec T14. */
export function requiredChecksFor(_profile: QualityProfile): string[] {
  return [...COMMON_REQUIRED_CHECKS];
}

/** Types de projet qui passent par le pont Aura. */
export function isGameProject(type: ProjectType): boolean {
  return type === 'unity' || type === 'unreal';
}
