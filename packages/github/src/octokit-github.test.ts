import { http, HttpResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { GitHubError, isGitHubError } from './errors.js';
import type { Clock } from './http.js';
import { OctokitGitHub } from './octokit-github.js';
import { decryptSecret, encryptSecret, generateSecretKeyPair } from './secrets.js';
import { API } from './testing/github-emulator.js';
import { mswFetch } from './testing/msw-fetch.js';

const ref = { owner: 'kiamiya', repo: 'demo' };
const REPO_URL = `${API}/repos/kiamiya/demo`;
const repoBody = {
  name: 'demo',
  owner: { login: 'kiamiya' },
  private: false,
  default_branch: 'main',
};

class FakeClock implements Clock {
  current = 1_700_000_000_000;
  readonly sleeps: number[] = [];
  now(): number {
    return this.current;
  }
  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
    return Promise.resolve();
  }
}

/** Renvoie les réponses dans l'ordre, puis répète la dernière. */
function sequence(...responses: (() => Response)[]): {
  handler: RequestHandler;
  calls: () => number;
} {
  let calls = 0;
  const handler = http.get(REPO_URL, () => {
    const make = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    if (!make) throw new Error('aucune réponse');
    return make();
  });
  return { handler, calls: () => calls };
}

function adapter(handlers: RequestHandler[], clock = new FakeClock(), maxRetries = 3) {
  return new OctokitGitHub({
    token: 'jeton',
    clock,
    random: () => 1,
    retry: { maxRetries, baseDelayMs: 100, maxDelayMs: 1_000, maxRateLimitWaitMs: 60_000 },
    fetch: mswFetch(() => handlers),
  });
}

const ok = () => HttpResponse.json(repoBody);
const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    HttpResponse.json({ message: `erreur ${String(code)}` }, { status: code, headers });

async function errorOf(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitHubError) return error;
    throw error;
  }
  throw new Error('Aucune erreur levée.');
}

describe('OctokitGitHub — relances et erreurs', () => {
  it('rend transparente une 502 suivie d’un succès', async () => {
    const clock = new FakeClock();
    const { handler, calls } = sequence(status(502), ok);
    const repository = await adapter([handler], clock).getRepository(ref);
    expect(repository.name).toBe('demo');
    expect(calls()).toBe(2);
    expect(clock.sleeps).toEqual([100]);
  });

  it('applique un backoff exponentiel plafonné puis échoue après les relances', async () => {
    const clock = new FakeClock();
    const { handler, calls } = sequence(status(503));
    const error = await errorOf(adapter([handler], clock, 4).getRepository(ref));
    expect(error.kind).toBe('server');
    expect(error.status).toBe(503);
    expect(calls()).toBe(5);
    expect(clock.sleeps).toEqual([100, 200, 400, 800]);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [409, 'conflict'],
    [422, 'validation'],
  ] as const)('ne relance pas une erreur %i et la type en « %s »', async (code, kind) => {
    const { handler, calls } = sequence(status(code));
    const error = await errorOf(adapter([handler]).getRepository(ref));
    expect(error.kind).toBe(kind);
    expect(error.message).toContain(`erreur ${String(code)}`);
    expect(calls()).toBe(1);
  });

  it('attend la fin de la fenêtre de débit (x-ratelimit-reset) puis réessaie', async () => {
    const clock = new FakeClock();
    const reset = String(Math.floor(clock.current / 1000) + 30);
    const { handler } = sequence(
      status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
      ok,
    );
    await adapter([handler], clock).getRepository(ref);
    expect(clock.sleeps).toEqual([30_000]);
  });

  it('respecte retry-after sur une limite secondaire (429)', async () => {
    const clock = new FakeClock();
    const { handler } = sequence(status(429, { 'retry-after': '7' }), ok);
    await adapter([handler], clock).getRepository(ref);
    expect(clock.sleeps).toEqual([7_000]);
  });

  it('échoue en « rate-limited » si l’attente dépasse le plafond', async () => {
    const clock = new FakeClock();
    const { handler, calls } = sequence(status(429, { 'retry-after': '3600' }));
    const error = await errorOf(adapter([handler], clock).getRepository(ref));
    expect(error.kind).toBe('rate-limited');
    expect(error.message).toContain('3600 s');
    expect(calls()).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('attend avant l’appel suivant quand le quota restant tombe à zéro', async () => {
    const clock = new FakeClock();
    const reset = String(Math.floor(clock.current / 1000) + 10);
    const { handler } = sequence(
      () =>
        HttpResponse.json(repoBody, {
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
        }),
      ok,
    );
    const port = adapter([handler], clock);
    await port.getRepository(ref);
    expect(clock.sleeps).toEqual([]);
    await port.getRepository(ref);
    expect(clock.sleeps).toEqual([10_000]);
  });

  it('refuse d’attendre trop longtemps un quota épuisé', async () => {
    const clock = new FakeClock();
    const reset = String(Math.floor(clock.current / 1000) + 3600);
    const { handler } = sequence(() =>
      HttpResponse.json(repoBody, {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      }),
    );
    const port = adapter([handler], clock);
    await port.getRepository(ref);
    expect((await errorOf(port.getRepository(ref))).kind).toBe('rate-limited');
  });

  it('relance une erreur réseau puis réussit', async () => {
    const clock = new FakeClock();
    const { handler, calls } = sequence(() => HttpResponse.error(), ok);
    await adapter([handler], clock).getRepository(ref);
    expect(calls()).toBe(2);
  });

  it('type une erreur réseau persistante', async () => {
    const { handler } = sequence(() => HttpResponse.error());
    expect((await errorOf(adapter([handler], new FakeClock(), 1).getRepository(ref))).kind).toBe(
      'network',
    );
  });

  it('type un délai dépassé et le relance', async () => {
    let calls = 0;
    const port = new OctokitGitHub({
      token: 'jeton',
      clock: new FakeClock(),
      retry: { maxRetries: 1, timeoutMs: 1 },
      fetch: () => {
        calls += 1;
        return Promise.reject(new DOMException('délai', 'TimeoutError'));
      },
    });
    expect((await errorOf(port.getRepository(ref))).kind).toBe('timeout');
    expect(calls).toBe(2);
  });

  it('rejette une réponse qui ne respecte pas le schéma attendu', async () => {
    const { handler } = sequence(() => HttpResponse.json({ name: 42 }));
    const error = await errorOf(adapter([handler]).getRepository(ref));
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toContain('GET /repos/{owner}/{repo}');
  });

  it('remonte les erreurs GraphQL de l’auto-merge', async () => {
    const handlers = [
      http.get(`${REPO_URL}/pulls/3`, () =>
        HttpResponse.json({
          number: 3,
          node_id: 'PR_x',
          title: 'T',
          body: null,
          state: 'open',
          merged_at: null,
          head: { ref: 'b', sha: 's' },
          base: { ref: 'main' },
          auto_merge: null,
          user: null,
        }),
      ),
      http.post(`${API}/graphql`, () =>
        HttpResponse.json({ data: null, errors: [{ message: 'Pull request is in clean status' }] }),
      ),
    ];
    const error = await errorOf(adapter(handlers).enableAutoMerge(ref, 3));
    expect(isGitHubError(error, 'validation')).toBe(true);
    expect(error.message).toContain('Pull request is in clean status');
  });
});

describe('chiffrement des secrets', () => {
  it('chiffre avec la clé publique et seul le détenteur de la clé privée déchiffre', async () => {
    const pair = await generateSecretKeyPair();
    const encrypted = await encryptSecret(pair.publicKey, 'jeton-très-secret');
    expect(encrypted).not.toContain('jeton');
    expect(await decryptSecret(pair, encrypted)).toBe('jeton-très-secret');
    const other = await generateSecretKeyPair();
    await expect(decryptSecret(other, encrypted)).rejects.toThrow();
  });

  it('produit un chiffré différent à chaque appel (boîte scellée)', async () => {
    const pair = await generateSecretKeyPair();
    expect(await encryptSecret(pair.publicKey, 'x')).not.toBe(
      await encryptSecret(pair.publicKey, 'x'),
    );
  });
});
