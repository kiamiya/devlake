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

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir],
    env: {
      ...process.env,
      AGENTLAKE_E2E: '1',
      AGENTLAKE_GITHUB: 'fake',
      AGENTLAKE_USER_DATA: userData,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
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
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
    await expect(page.getByTestId('status-github')).toContainText('ABSENT');
    await expect(page.getByTestId('status-aura')).toContainText('ABSENT');

    await page.getByLabel('Nouveau jeton').fill('ghp_e2eJetonDeTest1234');
    await page.getByRole('button', { name: 'Enregistrer le jeton' }).click();

    await expect(page.getByTestId('masked-token')).toHaveText('ghp_••••••••1234');
    await expect(page.getByTestId('status-github')).toContainText('OK');
    await expect(page.getByText('ghp_e2eJetonDeTest1234')).toHaveCount(0);

    await page.getByRole('button', { name: 'Tester' }).click();
    await expect(page.getByText('Jeton valide : compte kiamiya.')).toBeVisible();
    await app.close();
  });

  test('un réglage enregistré persiste après redémarrage', async () => {
    let { app, page } = await launch(userData);
    await page.getByLabel('Tentatives avant escalade').fill('5');
    await page.getByLabel('frontend').fill('modele-frontend');
    await page.getByRole('button', { name: 'Enregistrer les réglages' }).click();
    await expect(page.getByText('Réglages enregistrés.')).toBeVisible();
    await app.close();

    ({ app, page } = await launch(userData));
    await expect(page.getByLabel('Tentatives avant escalade')).toHaveValue('5');
    await expect(page.getByLabel('frontend')).toHaveValue('modele-frontend');
    await app.close();
  });

  test('refuse un réglage invalide avec un message clair', async () => {
    const { app, page } = await launch(userData);
    await page.getByLabel('Configuration MCP Aura — Unity').fill('pas du json');
    await page.getByRole('button', { name: 'Enregistrer les réglages' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Le bloc collé depuis Aura doit être un objet JSON valide.',
    );
    await app.close();
  });
});
