import { describe, expect, it } from 'vitest';
import { PROJECT_TYPES, QUALITY_PROFILES } from './ids.js';
import {
  CI_CHECKS,
  ciChecksFor,
  COMMON_REQUIRED_CHECKS,
  PULL_REQUEST_CHECKS,
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

  it('exige les checks communs du cadrage, plus ceux du profil, pour chaque profil', () => {
    for (const profile of QUALITY_PROFILES) {
      const checks = requiredChecksFor(profile);
      for (const common of COMMON_REQUIRED_CHECKS) expect(checks).toContain(common);
      expect(checks).toEqual([...ciChecksFor(profile), ...PULL_REQUEST_CHECKS]);
      expect(new Set(checks).size).toBe(checks.length);
    }
    expect(requiredChecksFor('web')).toContain('e2e');
    expect(COMMON_REQUIRED_CHECKS).toContain('agentlake / review');
    expect(COMMON_REQUIRED_CHECKS).toContain('agentlake / tests-guard');
    expect(ciChecksFor('unreal')).toEqual([...CI_CHECKS]);
  });

  it('reconnaît les projets de jeu', () => {
    expect(PROJECT_TYPES.filter(isGameProject)).toEqual(['unity', 'unreal']);
  });
});
