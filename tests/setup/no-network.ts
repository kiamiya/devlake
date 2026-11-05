import net from 'node:net';

/**
 * Bloque tout accès réseau pendant les tests unitaires.
 * Toute connexion TCP (http, https, tls, sockets bruts) et tout appel à fetch échouent.
 */
export class NetworkBlockedError extends Error {
  constructor(target: string) {
    super(
      `Accès réseau interdit en test unitaire (${target}). Utiliser une doublure ou un test d'intégration.`,
    );
    this.name = 'NetworkBlockedError';
  }
}

function asText(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function describeTarget(args: unknown[]): string {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof options.path === 'string') return options.path;
    return `${asText(options.host, 'localhost')}:${asText(options.port, '?')}`;
  }
  return `${asText(second, 'localhost')}:${asText(first, '?')}`;
}

net.Socket.prototype.connect = function blockedConnect(...args: unknown[]): never {
  throw new NetworkBlockedError(describeTarget(args));
};

globalThis.fetch = (input: Parameters<typeof fetch>[0]) => {
  const target = input instanceof Request ? input.url : input.toString();
  return Promise.reject(new NetworkBlockedError(target));
};
