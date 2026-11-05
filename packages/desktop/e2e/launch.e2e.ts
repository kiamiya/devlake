import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Sans séparateur final : sous Windows, « …\" » échapperait le guillemet de l'argument.
const appDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Faux jeton de test, sans valeur réelle. */
const FAKE_TOKEN = 'ghp_e2eJetonDeTest1234'; // gitleaks:allow

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir],
    env: {
      ...process.env,
      AGENTLAKE_E2E: '1',
      AGENTLAKE_GITHUB: 'fake',
      AGENTLAKE_FAKE_PROJECTS: 'jeu,site,outil',
      AGENTLAKE_USER_DATA: userData,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Réglages' }).click();
  await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
}

async function saveToken(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByLabel('Nouveau jeton').fill(FAKE_TOKEN);
  await page.getByRole('button', { name: 'Enregistrer le jeton' }).click();
  await expect(page.getByTestId('status-github')).toContainText('OK');
}

/** Libellés des onglets dans l'ordre, et onglet actif. */
async function tabsOf(page: Page): Promise<{ labels: string[]; active: string }> {
  const tabs = page.getByRole('tablist', { name: 'Projets ouverts' }).getByRole('tab');
  const labels = (await tabs.allTextContents()).map((t) => t.replace(/\d+$/, ''));
  const active = (await page.getByRole('tab', { selected: true }).textContent()) ?? '';
  return { labels, active: active.replace(/\d+$/, '') };
}

test.describe('cockpit', () => {
  let userData: string;

  test.beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'agentlake-e2e-'));
  });

  test.afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  test('démarre, enregistre le jeton masqué et le statut GitHub passe à OK', async () => {
    const { app, page } = await launch(userData);
    await expect(page).toHaveTitle('AgentLake');
    await expect(page.getByRole('heading', { name: 'Accueil' })).toBeVisible();
    await expect(page.getByTestId('status-github')).toContainText('ABSENT');
    await expect(page.getByTestId('status-aura')).toContainText('ABSENT');

    await saveToken(page);
    await expect(page.getByTestId('masked-token')).toHaveText('ghp_••••••••1234');
    await expect(page.getByText(FAKE_TOKEN)).toHaveCount(0);

    await page.getByRole('button', { name: 'Tester' }).click();
    await expect(page.getByText('Jeton valide : compte kiamiya.')).toBeVisible();
    await app.close();
  });

  test('un réglage enregistré persiste après redémarrage', async () => {
    let { app, page } = await launch(userData);
    await openSettings(page);
    await page.getByLabel('Tentatives avant escalade').fill('5');
    await page.getByLabel('frontend').fill('modele-frontend');
    await page.getByRole('button', { name: 'Enregistrer les réglages' }).click();
    await expect(page.getByText('Réglages enregistrés.')).toBeVisible();
    await app.close();

    ({ app, page } = await launch(userData));
    await openSettings(page);
    await expect(page.getByLabel('Tentatives avant escalade')).toHaveValue('5');
    await expect(page.getByLabel('frontend')).toHaveValue('modele-frontend');
    await app.close();
  });

  test('refuse un réglage invalide avec un message clair', async () => {
    const { app, page } = await launch(userData);
    await openSettings(page);
    await page.getByLabel('Configuration MCP Aura — Unity').fill('pas du json');
    await page.getByRole('button', { name: 'Enregistrer les réglages' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Le bloc collé depuis Aura doit être un objet JSON valide.',
    );
    await app.close();
  });

  test('trois projets, navigation au clavier, réordonnancement, redémarrage : mêmes onglets', async () => {
    let { app, page } = await launch(userData);
    await saveToken(page);
    await page.keyboard.press('Control+1');
    await expect(page.getByRole('heading', { name: 'Accueil' })).toBeVisible();

    await page.getByRole('button', { name: 'Ouvrir un dépôt existant' }).click();
    for (const repo of ['jeu', 'site', 'outil']) {
      await page.getByRole('button', { name: `Ouvrir ${repo}` }).click();
      await expect(page.getByRole('tab', { name: new RegExp(repo) })).toBeVisible();
      await page.keyboard.press('Control+1');
      await page
        .getByRole('button', { name: 'Ouvrir un dépôt existant' })
        .click()
        .catch(() => undefined);
    }
    expect(await tabsOf(page)).toEqual({
      labels: ['Accueil', 'jeu', 'site', 'outil'],
      active: 'Accueil',
    });

    // Badges et barre d'état globale.
    await expect(page.getByLabel('1 question en attente').first()).toBeVisible();
    await expect(page.getByTestId('activity-questions')).toHaveText('Questions en attente : 3');
    await expect(page.getByTestId('activity-agents')).toHaveText('Agents actifs : 3 / 3');

    // Navigation au clavier.
    await page.keyboard.press('Control+Tab');
    expect((await tabsOf(page)).active).toBe('jeu');
    await page.keyboard.press('Control+9');
    expect((await tabsOf(page)).active).toBe('outil');
    await page.keyboard.press('Control+Shift+Tab');
    expect((await tabsOf(page)).active).toBe('site');
    await page.getByRole('button', { name: 'Runs' }).click();
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();

    // Réordonnancement : « outil » glissé en première position.
    await page.getByTestId('tab-kiamiya/outil').dragTo(page.getByTestId('tab-kiamiya/jeu'));
    expect(await tabsOf(page)).toEqual({
      labels: ['Accueil', 'outil', 'jeu', 'site'],
      active: 'site',
    });

    // Ctrl+W ferme l'onglet actif ; on le rouvre depuis l'Accueil, en dernière position.
    await page.keyboard.press('Control+w');
    expect(await tabsOf(page)).toEqual({ labels: ['Accueil', 'outil', 'jeu'], active: 'jeu' });
    await page.keyboard.press('Control+1');
    await page
      .getByRole('list', { name: 'Projets connus' })
      .getByRole('button', { name: /site/ })
      .click();
    await page.keyboard.press('Control+3');
    const before = await tabsOf(page);
    expect(before).toEqual({ labels: ['Accueil', 'outil', 'jeu', 'site'], active: 'jeu' });
    await app.close();

    ({ app, page } = await launch(userData));
    await expect(page.getByRole('tab', { name: /site/ })).toBeVisible();
    expect(await tabsOf(page)).toEqual(before);
    await app.close();
  });
});
