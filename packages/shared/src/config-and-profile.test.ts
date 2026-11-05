import { describe, expect, it } from 'vitest';
import { parseAgentProfile } from './agent-profile.js';
import type { ParseResult } from './common.js';
import { parseProjectConfig } from './project-config.js';
import { makeAgentProfile, makeProjectConfig } from './test-utils.js';

function errorOf(result: ParseResult<unknown>): string {
  if (result.ok) throw new Error('La donnée aurait dû être refusée.');
  return result.error;
}

describe('ProjectConfig', () => {
  it('accepte une configuration complète', () => {
    const config = makeProjectConfig();
    expect(parseProjectConfig(config)).toEqual({ ok: true, value: config });
  });

  it('applique les valeurs par défaut : 3 tentatives, aucune ressource exclusive', () => {
    const result = parseProjectConfig({
      type: 'unity',
      qualityProfile: 'unity',
      limits: {},
      profiles: ['architect', 'unity'],
      bridgeRequired: true,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        type: 'unity',
        qualityProfile: 'unity',
        limits: { maxAttempts: 3 },
        profiles: ['architect', 'unity'],
        exclusiveResources: [],
        bridgeRequired: true,
      },
    });
  });

  it.each([
    ['type inconnu', { type: 'desktop' }, 'type : Type de projet inconnu.'],
    [
      'profil qualité inconnu',
      { qualityProfile: 'script' },
      'qualityProfile : Profil qualité inconnu.',
    ],
    ['aucun profil', { profiles: [] }, 'Le projet doit retenir au moins un profil.'],
    ['profil en double', { profiles: ['qa', 'qa'] }, 'Un profil est listé deux fois.'],
    [
      'plafond nul',
      { limits: { maxConcurrentAgents: 0, maxAttempts: 3 } },
      'Le plafond d’agents doit être au moins 1.',
    ],
    [
      'tentatives décimales',
      { limits: { maxAttempts: 2.5 } },
      'Le nombre de tentatives doit être un entier.',
    ],
    ['pont non booléen', { bridgeRequired: 'oui' }, 'bridgeRequired doit valoir true ou false.'],
  ])('refuse : %s', (_name, overrides, message) => {
    expect(errorOf(parseProjectConfig({ ...makeProjectConfig(), ...overrides }))).toContain(
      message,
    );
  });
});

describe('AgentProfile', () => {
  it('accepte un profil complet', () => {
    const profile = makeAgentProfile();
    expect(parseAgentProfile(profile)).toEqual({ ok: true, value: profile });
  });

  it.each([
    ['modèle absent', { model: undefined }, 'model :'],
    ['modèle vide', { model: '' }, 'Le modèle ne peut pas être vide.'],
    ['prompt vide', { systemPrompt: '  ' }, 'Le prompt système est vide.'],
    ['zéro tour', { maxTurns: 0 }, 'Il faut au moins un tour.'],
    ['coût nul', { estimatedMinutes: 0 }, 'Le coût estimé doit être d’au moins une minute.'],
    ['outil vide', { allowedTools: [''] }, 'Un outil autorisé ne peut pas être vide.'],
    ['profil inconnu', { id: 'designer' }, 'id : Profil inconnu.'],
  ])('refuse : %s', (_name, overrides, message) => {
    expect(errorOf(parseAgentProfile({ ...makeAgentProfile(), ...overrides }))).toContain(message);
  });
});
