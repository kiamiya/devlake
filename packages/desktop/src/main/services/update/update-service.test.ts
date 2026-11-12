import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { createRepositories } from '../../db/repositories.js';
import { compareVersions, UpdateService, type AutoUpdaterLike } from './update-service.js';

const repos = () => createRepositories(openDatabase(':memory:').db);

function fakeUpdater(version: string | null) {
  let progress: ((p: { percent: number }) => void) | undefined;
  const updater: AutoUpdaterLike & { installed: boolean } = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    installed: false,
    checkForUpdates: () =>
      Promise.resolve(
        version === null
          ? null
          : {
              updateInfo: {
                version,
                releaseNotes: '<h2>Nouveautés</h2><p>Mises à jour intégrées.</p>',
              },
            },
      ),
    downloadUpdate: () => {
      progress?.({ percent: 42.4 });
      return Promise.resolve([]);
    },
    quitAndInstall: () => {
      updater.installed = true;
    },
    on: (_event, listener) => {
      progress = listener;
      return updater;
    },
  };
  return updater;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('mises à jour du cockpit', () => {
  it('versions comparées X.Y.Z ; développement et 0.0.0 : désactivées', async () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('v1.7.0', '1.7.0')).toBe(0);
    expect(compareVersions('1.6.9', '1.7.0')).toBeLessThan(0);
    const dev = new UpdateService({
      repos: repos(),
      currentVersion: '1.7.0',
      packaged: false,
      platform: 'win32',
      arch: 'x64',
    });
    expect((await dev.check()).status).toBe('unsupported');
    const test = new UpdateService({
      repos: repos(),
      currentVersion: '0.0.0',
      packaged: true,
      platform: 'win32',
      arch: 'x64',
    });
    expect(test.status().status).toBe('unsupported');
  });

  it('Windows : disponible (notes en texte), téléchargement sur clic, redémarrage ; refermé jusqu’à la suivante', async () => {
    const updater = fakeUpdater('1.8.0');
    const store = repos();
    const service = new UpdateService({
      repos: store,
      currentVersion: '1.7.0',
      packaged: true,
      platform: 'win32',
      arch: 'x64',
      autoUpdater: () => updater,
      now: () => '2026-11-12T10:00:00.000Z',
    });
    expect(await service.check()).toMatchObject({
      status: 'available',
      version: '1.8.0',
      notes: 'NouveautésMises à jour intégrées.',
      checkedAt: '2026-11-12T10:00:00.000Z',
      manualInstall: false,
    });
    // Téléchargement sur clic seulement ; installation aussi à la fermeture.
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(await service.download()).toMatchObject({ status: 'downloaded', progress: 100 });
    // Déjà téléchargée : pas de nouvelle vérification.
    expect((await service.check()).status).toBe('downloaded');
    await service.install();
    expect(updater.installed).toBe(true);
    expect(service.dismiss('1.8.0').dismissedVersion).toBe('1.8.0');
    expect(store.settings.get().updates.dismissedVersion).toBe('1.8.0');
  });

  it('Windows : à jour, ou erreur lisible', async () => {
    const upToDate = new UpdateService({
      repos: repos(),
      currentVersion: '1.8.0',
      packaged: true,
      platform: 'win32',
      arch: 'x64',
      autoUpdater: () => fakeUpdater('1.8.0'),
    });
    expect((await upToDate.check()).status).toBe('up-to-date');
    const failing = fakeUpdater(null);
    failing.checkForUpdates = () => Promise.reject(new Error('réseau coupé'));
    const broken = new UpdateService({
      repos: repos(),
      currentVersion: '1.7.0',
      packaged: true,
      platform: 'win32',
      arch: 'x64',
      autoUpdater: () => failing,
    });
    expect(await broken.check()).toMatchObject({ status: 'error', error: 'réseau coupé' });
  });

  it('macOS : dernière release GitHub, .dmg du processeur téléchargé puis ouvert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlake-maj-'));
    dirs.push(dir);
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/releases/latest')
          ? Response.json({
              tag_name: 'v1.8.0',
              body: '## Nouveautés\n- Mises à jour',
              html_url: 'https://github.com/kiamiya/devlake/releases/tag/v1.8.0',
              assets: [],
            })
          : new Response(Buffer.from('dmg'), { headers: { 'content-length': '3' } }),
      ),
    );
    const opened: string[] = [];
    const service = new UpdateService({
      repos: repos(),
      currentVersion: '1.7.0',
      packaged: true,
      platform: 'darwin',
      arch: 'arm64',
      fetch: fetchFn as unknown as typeof fetch,
      downloadsDir: dir,
      openPath: (path) => {
        opened.push(path);
        return Promise.resolve('');
      },
    });
    expect(await service.check()).toMatchObject({
      status: 'available',
      version: '1.8.0',
      manualInstall: true,
    });
    expect(await service.download()).toMatchObject({ status: 'downloaded' });
    expect(fetchFn.mock.calls[1]?.[0]).toBe(
      'https://github.com/kiamiya/devlake/releases/download/v1.8.0/AgentLake-1.8.0-arm64.dmg',
    );
    const dmg = join(dir, 'AgentLake-1.8.0-arm64.dmg');
    expect(readFileSync(dmg, 'utf8')).toBe('dmg');
    await service.install();
    expect(opened).toEqual([dmg]);
  });
});
