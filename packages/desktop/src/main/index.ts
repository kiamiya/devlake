import { AdhocTaskService } from './services/tasks/adhoc-service.js';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  safeStorage,
  session,
  shell,
} from 'electron';
import { FakeGitHub, OctokitGitHub, type GitHubPort } from 'github';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CockpitService } from './cockpit-service.js';
import { openDatabase } from './db/database.js';
import { seedFakeProjects, simulateDispatcher } from './e2e-fixtures.js';
import { createRepositories } from './db/repositories.js';
import { registerDroppedFiles, registerIpc, serviceHandlers } from './ipc.js';
import { ProjectsService } from './projects-service.js';
import { CALLER_TEMPLATES, PROFILE_TEMPLATES } from './services/projects/caller-templates.js';
import { ProjectCreationService } from './services/projects/creation-service.js';
import { AdoptionService } from './services/projects/adoption.js';
import { InventoryService } from './services/projects/inventory.js';
import { ContextService } from './services/ingestion/context-service.js';
import { PlannerLaunchService } from './services/planner/planner-launch.js';
import { PlanService } from './services/plan/plan-service.js';
import { DashboardService } from './services/dashboard/dashboard-service.js';
import { BridgeService } from './services/bridge/bridge-service.js';
import { TunnelService } from './services/bridge/tunnel-service.js';
import {
  QuestionsService,
  type QuestionNotification,
} from './services/questions/questions-service.js';
import { defaultRegistry } from './services/ingestion/registry.js';
import { readFile, stat } from 'node:fs/promises';
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

async function githubFactory(): Promise<(token: string) => GitHubPort> {
  if (testMode && process.env.AGENTLAKE_GITHUB === 'fake') {
    const fake = new FakeGitHub({ actor: 'kiamiya' });
    const names = (process.env.AGENTLAKE_FAKE_PROJECTS ?? '').split(',').filter(Boolean);
    await seedFakeProjects(fake, names);
    const world = process.env.AGENTLAKE_WORLD;
    if (world) {
      // Monde simulé (T22) : vrai dispatcher et vrai planificateur, chargés à la demande.
      const { startWorld } = await import('./testing/start-world.js');
      await startWorld(fake, world);
    } else {
      // Pas de GitHub Actions en E2E : une réponse valide relance la tâche comme le dispatcher.
      simulateDispatcher(fake);
    }
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

/** Notifications émises, lisibles par les tests E2E (processus principal). */
const notifications: QuestionNotification[] = [];
(globalThis as { __agentlakeNotifications?: QuestionNotification[] }).__agentlakeNotifications =
  notifications;

function showQuestionNotification(notification: QuestionNotification): void {
  notifications.push(notification);
  if (testMode || !Notification.isSupported()) return;
  const shown = new Notification({ title: notification.title, body: notification.body });
  shown.on('click', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  shown.show();
}

async function start(): Promise<void> {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  const { db, created } = openDatabase(join(app.getPath('userData'), 'cockpit.sqlite'));
  const repos = createRepositories(db);
  const vault = new SafeStorageVault(app.getPath('userData'), safeStorage);
  const bridge: BridgeService = new BridgeService({
    repos,
    vault,
    github: (): Promise<GitHubPort> => service.githubPort(),
  });
  const service: CockpitService = new CockpitService({
    repos,
    vault,
    github: await githubFactory(),
    bridgeStatus: () => bridge.integrationStatus(),
    tunnelStatus: () => tunnel.integrationStatus(),
  });
  const tunnel = new TunnelService({ repos, github: () => service.githubPort(), bridges: bridge });
  // Exposition automatique : vérifiée au rythme du sondage du cockpit (30 s).
  const exposure = setInterval(() => {
    tunnel.tick().catch(() => undefined);
  }, 30_000);
  // Barre d'état : jeton, configuration globale et protection de main revérifiés (10 min).
  const health = setInterval(() => {
    service.refreshHealth().catch(() => undefined);
  }, 10 * 60_000);
  // Fermer le cockpit ferme le tunnel et arrête les ponts (et le serveur MCP d'Aura).
  app.on('before-quit', () => {
    clearInterval(health);
    clearInterval(exposure);
    void tunnel.close().finally(() => bridge.stopAll());
  });
  const projects = new ProjectsService(
    repos,
    () => service.githubPort(),
    () => service.syncGlobalConfig(),
  );
  const creation = new ProjectCreationService({
    repos,
    vault,
    github: () => service.githubPort(),
    projects,
    callerTemplates: CALLER_TEMPLATES,
    profileTemplates: PROFILE_TEMPLATES,
  });
  const context = new ContextService({
    repos,
    github: () => service.githubPort(),
    registry: defaultRegistry(),
    pickFiles: async (extensions) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = {
        title: 'Importer des documents',
        properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
        filters: [{ name: 'Documents et images', extensions }],
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    },
    readFile: async (path) => new Uint8Array(await readFile(path)),
    fileSize: async (path) => (await stat(path)).size,
  });
  registerIpc(
    ipcMain,
    serviceHandlers({
      cockpit: service,
      projects,
      creation,
      context,
      planner: new PlannerLaunchService(repos, () => service.githubPort()),
      adoption: new AdoptionService({
        repos,
        github: () => service.githubPort(),
        creation,
        projects,
      }),
      inventory: new InventoryService(repos, () => service.githubPort()),
      plan: new PlanService(repos, () => service.githubPort()),
      questions: new QuestionsService({
        repos,
        github: () => service.githubPort(),
        notify: showQuestionNotification,
        badge: (count) => app.setBadgeCount(count),
      }),
      dashboard: new DashboardService({ repos, github: () => service.githubPort() }),
      bridge,
      tunnel,
      adhoc: new AdhocTaskService(repos, () => service.githubPort()),
    }),
    isTrustedUrl,
  );
  registerDroppedFiles(ipcMain, context, isTrustedUrl);

  createWindow();
  await service.refreshHealth();
  // Base créée à l'instant (supprimée ou poste neuf) : reconstruction depuis GitHub en arrière-plan.
  if (created && (await vault.get('github-token')) !== null) {
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
