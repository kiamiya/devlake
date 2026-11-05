import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from 'electron';
import { FakeGitHub, OctokitGitHub, type GitHubPort } from 'github';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CockpitService } from './cockpit-service.js';
import { openDatabase } from './db/database.js';
import { createRepositories } from './db/repositories.js';
import { registerIpc, serviceHandlers } from './ipc.js';
import { SafeStorageVault } from './vault.js';

/**
 * Amorçage Electron du cockpit (couvert par les tests E2E).
 * La logique vit dans des modules testables sans Electron.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const testMode = process.env.AGENTLAKE_E2E === '1';

// Profil isolé pour les tests E2E ; trousseau simulé sur macOS (pas d'invite en CI).
if (process.env.AGENTLAKE_USER_DATA) app.setPath('userData', process.env.AGENTLAKE_USER_DATA);
if (testMode && process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');

const devServerUrl = process.env.ELECTRON_RENDERER_URL;

function isTrustedUrl(url: string): boolean {
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  return url.startsWith('file://') && url.includes('/renderer/');
}

function githubFactory(): (token: string) => GitHubPort {
  if (testMode && process.env.AGENTLAKE_GITHUB === 'fake') {
    const fake = new FakeGitHub({ actor: 'kiamiya' });
    return () => fake;
  }
  return (token) => new OctokitGitHub({ token });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'AgentLake',
    show: false,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  // Aucune navigation hors de l'interface ; les liens externes s'ouvrent dans le navigateur.
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://github.com/')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(join(here, '../renderer/index.html'));
  return window;
}

async function start(): Promise<void> {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  const { db, created } = openDatabase(join(app.getPath('userData'), 'cockpit.sqlite'));
  const repos = createRepositories(db);
  const vault = new SafeStorageVault(
    join(app.getPath('userData'), 'github-token.bin'),
    safeStorage,
  );
  const service = new CockpitService({ repos, vault, github: githubFactory() });
  registerIpc(ipcMain, serviceHandlers(service), isTrustedUrl);

  createWindow();
  await service.refreshGitHubStatus();
  // Base créée à l'instant (supprimée ou poste neuf) : reconstruction depuis GitHub en arrière-plan.
  if (created && (await vault.getToken()) !== null) {
    service.rebuildCache().catch(() => undefined);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

start().catch((error: unknown) => {
  console.error(
    'Échec du démarrage du cockpit :',
    error instanceof Error ? error.message : 'erreur inconnue',
  );
  app.exit(1);
});
