import { describe, expect, it } from 'vitest';
import { PROJECT_TYPES, QUALITY_PROFILES } from './ids.js';
import {
  COMMON_REQUIRED_CHECKS,
  DEFAULT_QUALITY_PROFILE,
  isGameProject,
  requiredChecksFor,
} from './quality.js';

describe('profils qualité', () => {
  it('propose un profil qualité existant pour chaque type de projet', () => {
    for (const type of PROJECT_TYPES)
      expect(QUALITY_PROFILES).toContain(DEFAULT_QUALITY_PROFILE[type]);
    expect(DEFAULT_QUALITY_PROFILE.script).toBe('tool');
  });

  it('exige les checks communs du cadrage pour chaque profil', () => {
    for (const profile of QUALITY_PROFILES)
      expect(requiredChecksFor(profile)).toEqual([...COMMON_REQUIRED_CHECKS]);
    expect(COMMON_REQUIRED_CHECKS).toContain('review');
  });

  it('reconnaît les projets de jeu', () => {
    expect(PROJECT_TYPES.filter(isGameProject)).toEqual(['unity', 'unreal']);
  });
});
