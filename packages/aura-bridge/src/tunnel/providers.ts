import { execFile, spawn, type ChildProcess } from 'node:child_process';

/** Fournisseur de tunnel HTTPS vers la passerelle locale. */
export interface TunnelProvider {
  readonly name: 'tailscale' | 'cloudflare';
  /** Ouvre le tunnel vers `localPort` ; renvoie l'URL publique (sans « / » final). */
  start(localPort: number): Promise<string>;
  stop(): Promise<void>;
}

export class TunnelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelError';
  }
}

/** Exécution d'une commande : sortie standard, ou erreur avec la sortie d'erreur. */
export type Exec = (command: string, args: readonly string[]) => Promise<string>;

/* c8 ignore start -- appel système, remplacé par une doublure dans les tests */
export const systemExec: Exec = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new TunnelError(`${command} ${args.join(' ')} : ${stderr.trim() || error.message}`),
          );
        else resolve(stdout);
      },
    );
  });
/* c8 ignore stop */

/**
 * Tailscale Funnel (par défaut, gratuit, sans domaine) : `https://<poste>.<tailnet>.ts.net`
 * relaie le port 443 public vers la passerelle locale. Exige Tailscale connecté et Funnel
 * autorisé sur le tailnet.
 */
export class TailscaleFunnel implements TunnelProvider {
  readonly name = 'tailscale';

  constructor(private readonly exec: Exec = systemExec) {}

  async start(localPort: number): Promise<string> {
    let status: { Self?: { DNSName?: string } };
    try {
      status = JSON.parse(await this.exec('tailscale', ['status', '--json'])) as typeof status;
    } catch (error) {
      throw new TunnelError(
        `Tailscale indisponible : installer Tailscale et se connecter (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    const dns = status.Self?.DNSName?.replace(/\.$/, '');
    if (!dns)
      throw new TunnelError('Tailscale n’a pas de nom DNS pour ce poste (MagicDNS désactivé ?).');
    await this.exec('tailscale', ['funnel', '--bg', '--https=443', String(localPort)]);
    return `https://${dns}`;
  }

  async stop(): Promise<void> {
    await this.exec('tailscale', ['funnel', '--https=443', 'off']);
  }
}

export type Spawn = (command: string, args: readonly string[]) => ChildProcess;

/* c8 ignore next -- appel système */
const systemSpawn: Spawn = (command, args) => spawn(command, [...args], { windowsHide: true });

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * Cloudflare Tunnel (adaptateur alternatif) : tunnel rapide `cloudflared`, URL aléatoire en
 * `*.trycloudflare.com`, changée à chaque ouverture (la variable des projets est mise à jour).
 */
export class CloudflareTunnel implements TunnelProvider {
  readonly name = 'cloudflare';
  private child: ChildProcess | null = null;

  constructor(
    private readonly spawnFn: Spawn = systemSpawn,
    private readonly timeoutMs = 30_000,
  ) {}

  start(localPort: number): Promise<string> {
    const child = this.spawnFn('cloudflared', [
      'tunnel',
      '--no-autoupdate',
      '--url',
      `http://127.0.0.1:${String(localPort)}`,
    ]);
    this.child = child;
    return new Promise((resolve, reject) => {
      let output = '';
      const fail = (message: string) => {
        clearTimeout(timer);
        child.kill();
        this.child = null;
        reject(new TunnelError(message));
      };
      const timer = setTimeout(() => {
        fail('cloudflared n’a pas donné d’URL publique à temps.');
      }, this.timeoutMs);
      const read = (chunk: Buffer | string) => {
        output += chunk.toString();
        const url = QUICK_TUNNEL_URL.exec(output)?.[0];
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.once('error', (error) => {
        fail(`cloudflared introuvable ou en échec : ${error.message}`);
      });
      child.once('exit', (code) => {
        if (QUICK_TUNNEL_URL.test(output)) return;
        fail(`cloudflared s’est arrêté (code ${String(code)}).`);
      });
    });
  }

  stop(): Promise<void> {
    this.child?.kill();
    this.child = null;
    return Promise.resolve();
  }
}
