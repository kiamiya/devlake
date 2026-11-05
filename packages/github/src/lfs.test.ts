import { http, HttpResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { GitHubError } from './errors.js';
import { DEFAULT_RETRY_OPTIONS, type Clock } from './http.js';
import { LfsClient, lfsPointerOf, lfsPointerText } from './lfs.js';
import { mswFetch } from './testing/msw-fetch.js';

const ref = { owner: 'kiamiya', repo: 'demo' };
const BATCH = 'https://github.com/kiamiya/demo.git/info/lfs/objects/batch';
const clock: Clock = { now: () => 0, sleep: () => Promise.resolve() };

function client(handlers: RequestHandler[], maxRetries = 2) {
  return new LfsClient(
    'jeton',
    mswFetch(() => handlers),
    { ...DEFAULT_RETRY_OPTIONS, maxRetries },
    clock,
  );
}

async function errorOf(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitHubError) return error;
    throw error;
  }
  throw new Error('Aucune erreur levée.');
}

describe('pointeurs LFS', () => {
  it('calcule l’empreinte SHA-256 et écrit le pointeur standard', () => {
    const pointer = lfsPointerOf(new TextEncoder().encode('abc'));
    expect(pointer).toEqual({
      oid: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      size: 3,
    });
    expect(lfsPointerText(pointer)).toBe(
      'version https://git-lfs.github.com/spec/v1\noid sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\nsize 3\n',
    );
  });
});

describe('client LFS', () => {
  it('s’authentifie en Basic et n’envoie rien de déjà présent', async () => {
    let auth = '';
    const handlers = [
      http.post(BATCH, ({ request }) => {
        auth = request.headers.get('authorization') ?? '';
        return HttpResponse.json({ objects: [{ oid: 'x', size: 1 }] });
      }),
    ];
    await client(handlers).upload(ref, [new Uint8Array([1])]);
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe(
      'x-access-token:jeton',
    );
  });

  it('relance une 503 du batch puis réussit', async () => {
    let calls = 0;
    const handlers = [
      http.post(BATCH, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ message: 'indisponible' }, { status: 503 })
          : HttpResponse.json({ objects: [] });
      }),
    ];
    await client(handlers).upload(ref, [new Uint8Array([1])]);
    expect(calls).toBe(2);
  });

  it('type une erreur 4xx sans relance et une 5xx persistante', async () => {
    const forbidden = [http.post(BATCH, () => HttpResponse.text('interdit', { status: 403 }))];
    expect((await errorOf(client(forbidden).upload(ref, [new Uint8Array([1])]))).kind).toBe(
      'forbidden',
    );
    const down = [http.post(BATCH, () => HttpResponse.text('panne', { status: 502 }))];
    expect((await errorOf(client(down, 1).upload(ref, [new Uint8Array([1])]))).kind).toBe('server');
  });

  it('remonte une erreur réseau persistante', async () => {
    const handlers = [http.post(BATCH, () => HttpResponse.error())];
    expect((await errorOf(client(handlers, 1).upload(ref, [new Uint8Array([1])]))).kind).toBe(
      'network',
    );
  });

  it('signale un objet refusé et une réponse invalide', async () => {
    const refused = [
      http.post(BATCH, () =>
        HttpResponse.json({
          objects: [{ oid: 'x', size: 1, error: { code: 422, message: 'trop gros' } }],
        }),
      ),
    ];
    expect((await errorOf(client(refused).upload(ref, [new Uint8Array([1])]))).message).toContain(
      'trop gros',
    );
    const invalid = [http.post(BATCH, () => HttpResponse.json({ pas: 'ça' }))];
    expect((await errorOf(client(invalid).upload(ref, [new Uint8Array([1])]))).kind).toBe(
      'invalid-response',
    );
  });
});
