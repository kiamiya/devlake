import type { FakeGitHub, RepoRef } from 'github';
import { ciChecksFor, type QualityProfile } from 'shared';

/** Checks de la CI du profil, tous verts, sur le dernier commit de `main` (porte qualité en place). */
export function seedGreenMain(
  github: FakeGitHub,
  ref: RepoRef,
  profile: QualityProfile = 'web',
): void {
  github.seedCheckRuns(
    ref,
    'main',
    ciChecksFor(profile).map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  );
}
