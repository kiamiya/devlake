import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { NetworkBlockedError } from './setup/no-network.js';

describe('réseau bloqué en test unitaire', () => {
  it('refuse fetch', async () => {
    await expect(fetch('https://api.github.com')).rejects.toBeInstanceOf(NetworkBlockedError);
  });

  it('refuse une connexion TCP brute', () => {
    expect(() => net.connect({ host: 'example.com', port: 443 })).toThrow(NetworkBlockedError);
  });

  it('refuse une requête http', () => {
    expect(() => http.get('http://example.com')).toThrow(NetworkBlockedError);
  });
});
