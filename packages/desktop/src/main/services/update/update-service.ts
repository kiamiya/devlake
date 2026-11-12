import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { z } from 'zod';
import type { UpdateState } from '../../../shared/ipc-contract.js';
import type { Repositories } from '../../db/repositories.js';

/** Dépôt des releases du cockpit. */
export const RELEASES_REPOSITORY = 'kiamiya/devlake';
/** Vérification périodique : toutes les 6 heures. */
export const CHECK_INTERVAL_MS = 6 * 3_600_000;
const NOTES_MAX = 4000;

/** Sous-ensemble d'`autoUpdater` (electron-updater) utilisé ici, pour Windows. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ updateInfo: { version: string; releaseNotes?: unknown } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
}

export interface UpdateDeps {
  repos: Repositories;
  currentVersion: string;
  /** Application installée (pas le mode développement ni les tests). */
  packaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  /** Windows : `autoUpdater` d'electron-updater, créé seulement si besoin. */
  autoUpdater?: () => AutoUpdaterLike;
  fetch?: typeof fetch;
  /** Dossier Téléchargements (macOS : le .dmg y est enregistré). */
  downloadsDir?: string;
  openPath?: (path: string) => Promise<string>;
  now?: () => string;
}

const ReleaseSchema = z.object({
  tag_name: z.string(),
  body: z.string().nullish(),
  html_url: z.string(),
  assets: z.array(
    z.object({ name: z.string(), browser_download_url: z.string(), size: z.number() }),
  ),
});

/** Comparaison de versions X.Y.Z : positif si `a` est plus récente que `b`. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function notesText(notes: unknown): string | null {
  const text =
    typeof notes === 'string'
      ? notes
      : Array.isArray(notes)
        ? notes
            .map((n: unknown) =>
              typeof n === 'object' && n !== null && 'note' in n ? String(n.note) : '',
            )
            .join('\n')
        : '';
  // Notes HTML de GitHub (electron-updater) : texte seul, sans balises.
  const plain = text
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain === '' ? null : plain.slice(0, NOTES_MAX);
}

/**
 * Mises à jour du cockpit : vérification (démarrage, toutes les 6 h, ou à la demande),
 * téléchargement sur clic, installation sur clic ou à la fermeture. Windows : mise à jour
 * intégrée (electron-updater). macOS (installeur non signé) : le .dmg est téléchargé puis ouvert,
 * l'application se remplace en la glissant dans Applications.
 */
export class UpdateService {
  private state: UpdateState;
  private updater: AutoUpdaterLike | null = null;
  private dmgPath: string | null = null;

  constructor(private readonly deps: UpdateDeps) {
    this.state = {
      // Mode développement, tests et constructions de test (0.0.0) : pas de mise à jour.
      status: deps.packaged && deps.currentVersion !== '0.0.0' ? 'idle' : 'unsupported',
      currentVersion: deps.currentVersion,
      version: null,
      notes: null,
      progress: null,
      error: null,
      checkedAt: null,
      manualInstall: deps.platform === 'darwin',
      dismissedVersion: deps.repos.settings.get().updates.dismissedVersion,
    };
  }

  private set(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch };
    return this.status();
  }

  status(): UpdateState {
    return {
      ...this.state,
      dismissedVersion: this.deps.repos.settings.get().updates.dismissedVersion,
    };
  }

  private windowsUpdater(): AutoUpdaterLike {
    if (this.updater === null) {
      if (!this.deps.autoUpdater) throw new Error('Mise à jour intégrée indisponible.');
      this.updater = this.deps.autoUpdater();
      // Téléchargement sur clic de Kia ; installation aussi à la fermeture du cockpit.
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = true;
      this.updater.on('download-progress', (p) => {
        this.set({ status: 'downloading', progress: Math.round(p.percent) });
      });
    }
    return this.updater;
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async check(): Promise<UpdateState> {
    if (this.state.status === 'unsupported') return this.status();
    // Déjà téléchargée, ou en cours : rien à revérifier.
    if (this.state.status === 'downloading' || this.state.status === 'downloaded')
      return this.status();
    this.set({ status: 'checking', error: null });
    try {
      if (this.deps.platform === 'darwin') return await this.checkRelease();
      const result = await this.windowsUpdater().checkForUpdates();
      const version = result?.updateInfo.version ?? null;
      if (version === null || compareVersions(version, this.deps.currentVersion) <= 0)
        return this.set({
          status: 'up-to-date',
          version: null,
          notes: null,
          checkedAt: this.now(),
        });
      return this.set({
        status: 'available',
        version,
        notes: notesText(result?.updateInfo.releaseNotes),
        checkedAt: this.now(),
      });
    } catch (error) {
      return this.set({ status: 'error', error: message(error), checkedAt: this.now() });
    }
  }

  /** macOS : dernière release de GitHub, sans electron-updater (application non signée). */
  private async checkRelease(): Promise<UpdateState> {
    const response = await (this.deps.fetch ?? fetch)(
      `https://api.github.com/repos/${RELEASES_REPOSITORY}/releases/latest`,
      {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'AgentLake-cockpit' },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub : HTTP ${String(response.status)}.`);
    const release = ReleaseSchema.parse(await response.json());
    const version = release.tag_name.replace(/^v/, '');
    if (compareVersions(version, this.deps.currentVersion) <= 0)
      return this.set({ status: 'up-to-date', version: null, notes: null, checkedAt: this.now() });
    return this.set({
      status: 'available',
      version,
      notes: notesText(release.body ?? ''),
      checkedAt: this.now(),
    });
  }

  async download(): Promise<UpdateState> {
    if (this.state.status !== 'available' && this.state.status !== 'error') return this.status();
    if (this.state.version === null) return this.status();
    this.set({ status: 'downloading', progress: 0, error: null });
    try {
      if (this.deps.platform === 'darwin') await this.downloadDmg(this.state.version);
      else await this.windowsUpdater().downloadUpdate();
      return this.set({ status: 'downloaded', progress: 100 });
    } catch (error) {
      return this.set({ status: 'error', error: message(error), progress: null });
    }
  }

  private async downloadDmg(version: string): Promise<void> {
    const arch = this.deps.arch === 'arm64' ? 'arm64' : 'x64';
    const name = `AgentLake-${version}-${arch}.dmg`;
    const url = `https://github.com/${RELEASES_REPOSITORY}/releases/download/v${version}/${name}`;
    const response = await (this.deps.fetch ?? fetch)(url, { redirect: 'follow' });
    if (!response.ok || response.body === null)
      throw new Error(`Téléchargement de ${name} refusé (HTTP ${String(response.status)}).`);
    const total = Number(response.headers.get('content-length') ?? '0');
    const target = join(this.deps.downloadsDir ?? '.', name);
    let received = 0;
    const source = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (total > 0) this.set({ progress: Math.min(99, Math.round((received / total) * 100)) });
    });
    await pipeline(source, createWriteStream(target));
    this.dmgPath = target;
  }

  /** Windows : quitte et installe. macOS : ouvre le .dmg téléchargé. */
  async install(): Promise<UpdateState> {
    if (this.state.status !== 'downloaded') return this.status();
    if (this.deps.platform === 'darwin') {
      if (this.dmgPath === null) return this.status();
      const error = await (this.deps.openPath ?? (() => Promise.resolve('ouverture impossible')))(
        this.dmgPath,
      );
      return error === '' ? this.status() : this.set({ status: 'error', error });
    }
    this.windowsUpdater().quitAndInstall();
    return this.status();
  }

  /** Bandeau refermé : il réapparaîtra à la version suivante. */
  dismiss(version: string): UpdateState {
    this.deps.repos.settings.update({ updates: { dismissedVersion: version } });
    return this.status();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
