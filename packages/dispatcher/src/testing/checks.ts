import type { FakeGitHub, RepoRef } from 'github';
import { ciChecksFor, requiredChecksFor, type QualityProfile } from 'shared';

/** `main` protégée comme au bootstrap : checks obligatoires du profil, PR exigée. */
export function seedProtectedMain(
  github: FakeGitHub,
  ref: RepoRef,
  profile: QualityProfile = 'web',
): void {
  github.state(ref).protections.set('main', {
    branch: 'main',
    requiredChecks: requiredChecksFor(profile),
    enforceAdmins: false,
    requirePullRequest: true,
  });
}

/**
 * Porte qualité en place : `main` protégée, et checks de la CI du profil tous verts sur son
 * dernier commit.
 */
export function seedGreenMain(
  github: FakeGitHub,
  ref: RepoRef,
  profile: QualityProfile = 'web',
): void {
  seedProtectedMain(github, ref, profile);
  github.seedCheckRuns(
    ref,
    'main',
    ciChecksFor(profile).map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  );
}
