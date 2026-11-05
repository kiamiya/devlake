import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_IDS } from 'shared';
import { describe, expect, it } from 'vitest';
import { buildMcpConfig, claudeArgs, parseProfile, profileEnvFrom } from './profile.js';

/** Profils par défaut copiés au bootstrap (templates/profiles). */
const TEMPLATES = fileURLToPath(new URL('../../../../templates/profiles/', import.meta.url));

const env = profileEnvFrom({
  AURA_BRIDGE_URL: 'https://pont.exemple.ts.net/mcp',
  AURA_BRIDGE_TOKEN: 'jeton-signe',
  AUTRE: 'ignorée',
});

describe('profils par défaut', () => {
  it('fournit un fichier par profil, et rien d’autre', () => {
    expect(readdirSync(TEMPLATES).sort()).toEqual(PROFILE_IDS.map((id) => `${id}.yml`).sort());
  });

  it.each(PROFILE_IDS)('%s : configuration générée par le workflow d’agent', (id) => {
    const profile = parseProfile(readFileSync(join(TEMPLATES, `${id}.yml`), 'utf8'), id);
    const mcp = buildMcpConfig(profile, env);
    expect({
      claudeArgs: claudeArgs(profile, mcp === null ? null : '/runner/tmp/agentlake-mcp.json'),
      mcpConfig: mcp === null ? null : (JSON.parse(mcp.json) as unknown),
      secrets: mcp?.secrets ?? [],
      exclusiveResources: profile.exclusiveResources,
      estimatedMinutes: profile.estimatedMinutes,
    }).toMatchSnapshot();
  });

  it('ignore les variables vides ou inconnues de l’environnement', () => {
    expect(profileEnvFrom({ AURA_BRIDGE_URL: '', AURA_BRIDGE_TOKEN: 'x', PATH: '/bin' })).toEqual({
      AURA_BRIDGE_TOKEN: 'x',
    });
  });
});
