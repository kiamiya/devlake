import { describe, expect, it } from 'vitest';
import {
  BRIDGE_TOKEN_TTL_SECONDS,
  signBridgeToken,
  TOKEN_REFUSALS,
  verifyBridgeToken,
  type BridgePayload,
} from './bridge-token.js';

const SECRET = 'secret-de-test-du-pont'; // gitleaks:allow
const NOW = new Date('2026-11-21T10:00:00.000Z');
const payload: BridgePayload = {
  repo: 'kiamiya/jeu',
  runId: '123456',
  profile: 'unity',
  exp: Math.floor(NOW.getTime() / 1000) + BRIDGE_TOKEN_TTL_SECONDS,
};

describe('jeton du pont Aura', () => {
  it('signé puis vérifié : contenu rendu tel quel', () => {
    const token = signBridgeToken(payload, SECRET);
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(verifyBridgeToken(token, SECRET, NOW)).toEqual({ ok: true, payload });
  });

  it('expiré : refusé à l’échéance exacte et après', () => {
    const token = signBridgeToken(payload, SECRET);
    expect(verifyBridgeToken(token, SECRET, new Date(payload.exp * 1000))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyBridgeToken(token, SECRET, new Date(payload.exp * 1000 - 1)).ok).toBe(true);
  });

  it('falsifié : contenu modifié, autre secret, signature tronquée', () => {
    const token = signBridgeToken(payload, SECRET);
    const [part = '', signature = ''] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, repo: 'pirate/jeu' })).toString(
      'base64url',
    );
    expect(verifyBridgeToken(`${forged}.${signature}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(verifyBridgeToken(token, 'autre-secret', NOW).ok).toBe(false);
    expect(verifyBridgeToken(`${part}.${signature.slice(0, 10)}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(verifyBridgeToken(token, '', NOW).ok).toBe(false);
  });

  it('mal formé ou contenu invalide', () => {
    expect(verifyBridgeToken('', SECRET, NOW)).toEqual({ ok: false, reason: 'format' });
    expect(verifyBridgeToken('a.b.c', SECRET, NOW)).toEqual({ ok: false, reason: 'format' });
    // Contenu signé correctement mais illisible : refusé après la signature.
    const signedGarbage = (part: string) => {
      const forged = signBridgeToken(payload, SECRET).split('.');
      return { token: `${part}.${forged[1] ?? ''}`, part };
    };
    expect(verifyBridgeToken(signedGarbage('x').token, SECRET, NOW).ok).toBe(false);
    expect(() => signBridgeToken(payload, '')).toThrow('Secret du pont vide.');
    expect(() => signBridgeToken({ ...payload, repo: 'sans-barre' }, SECRET)).toThrow();
    expect(TOKEN_REFUSALS.expired).toBe('Jeton du pont expiré.');
  });

  it('contenu non JSON ou incomplet, bien signé : refusé comme illisible', async () => {
    const { createHmac } = await import('node:crypto');
    const sign = (raw: string) => {
      const part = Buffer.from(raw).toString('base64url');
      const mac = createHmac('sha256', SECRET).update(part).digest('base64url');
      return `${part}.${mac}`;
    };
    expect(verifyBridgeToken(sign('pas du json'), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'payload',
    });
    expect(verifyBridgeToken(sign('{"repo":"a/b"}'), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'payload',
    });
  });
});
