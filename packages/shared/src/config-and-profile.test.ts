import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadAgentProfile, parseAgentProfile, placeholdersIn } from './agent-profile.js';
import { PROFILE_IDS } from './ids.js';
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
        limits: { maxAttempts: 3, answerReminderHours: 24 },
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

describe('profils par défaut (templates/profiles)', () => {
  const dir = fileURLToPath(new URL('../../../templates/profiles/', import.meta.url));
  const load = (id: string) => loadAgentProfile(readFileSync(join(dir, `${id}.yml`), 'utf8'), id);

  it.each(PROFILE_IDS)('%s passe le schéma et porte les règles communes', (id) => {
    const loaded = load(id);
    if (!loaded.ok) throw new Error(loaded.error);
    const prompt = loaded.value.systemPrompt;
    expect(prompt).toContain('outcome = blocked');
    if (id !== 'reviewer') {
      expect(prompt).toContain('Écris les tests');
      expect(prompt).toContain('Ne modifie, ne désactive et ne supprime aucun test existant');
    }
    // Moteurs : pont Aura ; Artiste 3D : pont Blender ; les autres : aucun pont.
    const server = id === 'unity' || id === 'unreal' ? 'aura' : id === 'blender' ? 'blender' : null;
    expect(Object.keys(loaded.value.mcpServers)).toEqual(server === null ? [] : [server]);
    expect(loaded.value.allowedTools.includes('mcp__aura')).toBe(server === 'aura');
    expect(loaded.value.allowedTools.includes('mcp__blender')).toBe(server === 'blender');
    if (server !== null) expect(prompt).toContain('editor_checkout');
  });

  it('modèle par alias : Opus pour architecte et relecteur, Sonnet ailleurs', () => {
    for (const id of PROFILE_IDS) {
      const loaded = load(id);
      expect(loaded.ok && loaded.value.model).toBe(
        id === 'architect' || id === 'reviewer' ? 'opus' : 'sonnet',
      );
    }
  });
});

describe('chargement d’un profil YAML', () => {
  it('signale un YAML invalide, un profil invalide ou un autre identifiant', () => {
    expect(errorOf(loadAgentProfile('model: [', 'qa'))).toContain(
      '.agentlake/profiles/qa.yml n’est pas un YAML valide',
    );
    expect(errorOf(loadAgentProfile('id: qa\n', 'qa'))).toContain('est invalide');
    expect(errorOf(loadAgentProfile(stringify(makeAgentProfile({ id: 'qa' })), 'docs'))).toContain(
      'décrit le profil « qa »',
    );
  });

  it('refuse une variable inconnue, un serveur MCP non HTTP ou mal nommé', () => {
    const withServers = (servers: unknown) =>
      parseAgentProfile({ ...makeAgentProfile(), mcpServers: servers });
    expect(errorOf(withServers({ aura: { type: 'http', url: '${SECRET}' } }))).toContain(
      'L’URL du serveur MCP cite une variable inconnue',
    );
    expect(
      errorOf(
        withServers({ aura: { type: 'http', url: 'https://x', headers: { A: '${GH_TOKEN}' } } }),
      ),
    ).toContain('Un en-tête du serveur MCP cite une variable inconnue');
    expect(errorOf(withServers({ aura: { type: 'stdio', url: 'x' } }))).toContain(
      'Seuls les serveurs MCP de type « http »',
    );
    expect(errorOf(withServers({ Aura: { type: 'http', url: 'x' } }))).toContain(
      'Nom de serveur MCP attendu en minuscules',
    );
    expect(placeholdersIn('${A} et ${B}')).toEqual(['A', 'B']);
  });

  it('les serveurs MCP sont facultatifs', () => {
    const { mcpServers: _omis, ...sans } = makeAgentProfile();
    const parsed = parseAgentProfile(sans);
    expect(parsed.ok && parsed.value.mcpServers).toEqual({});
  });
});
