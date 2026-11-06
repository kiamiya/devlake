import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test de fumée de l'application packagée (T23) : l'exécutable installé (ou décompressé)
 * démarre, ouvre sa fenêtre, charge SQLite (module natif) et garde ses réglages après un
 * redémarrage. Faux GitHub : aucun réseau.
 *
 *   AGENTLAKE_APP_PATH=<chemin de AgentLake.exe ou de AgentLake.app/Contents/MacOS/AgentLake>
 */
const executablePath = process.env.AGENTLAKE_APP_PATH ?? '';

/** Faux jeton de test, sans valeur réelle. */
const FAKE_TOKEN = 'ghp_fumeeJetonDeTest1234'; // gitleaks:allow

test.describe('application packagée', () => {
  let userData: string;
  const apps: ElectronApplication[] = [];

  test.beforeAll(() => {
    expect(executablePath, 'AGENTLAKE_APP_PATH absent').not.toBe('');
    expect(existsSync(executablePath), `${executablePath} introuvable`).toBe(true);
  });

  test.beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'agentlake-fumee-'));
  });

  test.afterEach(async () => {
    for (const app of apps.splice(0)) await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function launch() {
    const app = await electron.launch({
      executablePath,
      env: {
        ...process.env,
        AGENTLAKE_E2E: '1',
        AGENTLAKE_GITHUB: 'fake',
        AGENTLAKE_FAKE_PROJECTS: '',
        AGENTLAKE_USER_DATA: userData,
      },
    });
    apps.push(app);
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    return { app, page };
  }

  test('démarre, enregistre un réglage et le retrouve après redémarrage', async () => {
    const first = await launch();
    expect(await first.page.title()).toContain('AgentLake');
    await expect(first.page.getByRole('contentinfo', { name: 'Barre d’état' })).toBeVisible();
    // Version de l'application : celle du tag de la release.
    const version = await first.app.evaluate(({ app }) => app.getVersion());
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    await first.page.getByRole('button', { name: 'Réglages' }).click();
    await first.page.getByLabel('Nouveau jeton GitHub').fill(FAKE_TOKEN);
    await first.page.getByRole('button', { name: 'Enregistrer le jeton GitHub' }).click();
    await expect(first.page.getByTestId('status-github')).toContainText('OK');
    await first.page.getByLabel('Tentatives avant escalade').fill('4');
    await first.page.getByRole('button', { name: 'Enregistrer les réglages' }).click();
    await expect(first.page.getByText('Réglages enregistrés.')).toBeVisible();
    await first.app.close();

    // SQLite (module natif hors asar) : le réglage a survécu au redémarrage.
    const second = await launch();
    await second.page.getByRole('button', { name: 'Réglages' }).click();
    await expect(second.page.getByLabel('Tentatives avant escalade')).toHaveValue('4');
  });
});
