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
const fixture = (name: string) =>
  fileURLToPath(new URL(`../src/main/services/ingestion/__fixtures__/${name}`, import.meta.url));
const BRIEF_DOCX = fixture('brief.docx');

/** Faux jeton de test, sans valeur réelle. */
const FAKE_TOKEN = 'ghp_e2eJetonDeTest1234'; // gitleaks:allow
/** Faux jeton Claude Code de test. */
const CLAUDE_TOKEN = 'sk-ant-oat01-faux-jeton-e2e-0042'; // gitleaks:allow

/** Applications lancées par le test en cours, fermées même en cas d'échec. */
const launched: ElectronApplication[] = [];

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
  launched.push(app);
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
  await page.getByLabel('Nouveau jeton GitHub').fill(FAKE_TOKEN);
  await page.getByRole('button', { name: 'Enregistrer le jeton GitHub' }).click();
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

  test.afterEach(async () => {
    for (const app of launched.splice(0)) await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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

  test('assistant : crée un projet web public, l’ouvre, puis le bootstrap relancé ne change rien', async () => {
    const { app, page } = await launch(userData);
    await saveToken(page);
    await page.getByLabel('Nouveau jeton Claude Code').fill(CLAUDE_TOKEN);
    await page.getByRole('button', { name: 'Enregistrer le jeton Claude' }).click();
    await expect(page.getByTestId('masked-claude-token')).toHaveText('sk-ant-oat01-••••••••0042');

    await page.keyboard.press('Control+1');
    await page.getByRole('button', { name: 'Nouveau projet' }).click();
    await expect(page.getByRole('note')).toContainText('Dépôt public');
    await page.getByLabel('Privé').check();
    await expect(page.getByRole('note')).toContainText('2 000 minutes');
    await page.getByLabel('Public (minutes Actions gratuites et illimitées)').check();
    await page.getByLabel('Type').selectOption('script');
    await expect(page.getByLabel('Profil qualité')).toHaveValue('tool');
    await page.getByLabel('Type').selectOption('web');
    await expect(page.getByLabel('Profil qualité')).toHaveValue('web');

    await page.getByLabel('Nom du dépôt').fill('nouveau-site');
    await page.getByRole('button', { name: 'Créer le projet' }).click();
    await expect(page.getByRole('tab', { name: /nouveau-site/, selected: true })).toBeVisible();

    await page.getByRole('button', { name: 'Relancer le bootstrap' }).click();
    const steps = page.getByRole('list', { name: 'Étapes du bootstrap' }).getByRole('listitem');
    await expect(steps).toHaveCount(7);
    for (const step of await steps.allTextContents()) expect(step).toContain('déjà en place');
    await app.close();
  });

  test('contexte : verse un brief docx dans un dépôt public, puis le réimport ne change rien', async () => {
    const { app, page } = await launch(userData);
    await saveToken(page);
    await page.keyboard.press('Control+1');
    await page.getByRole('button', { name: 'Ouvrir un dépôt existant' }).click();
    await page.getByRole('button', { name: 'Ouvrir jeu' }).click();
    await expect(page.getByRole('heading', { name: 'Contexte', exact: true })).toBeVisible();

    // Sélecteur de fichiers natif simulé.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, BRIEF_DOCX);

    for (const attempt of [1, 2]) {
      await page.getByRole('button', { name: 'Choisir des fichiers' }).click();
      await page.getByLabel('Rôle de brief.docx').selectOption('brief');
      await expect(page.getByRole('note')).toContainText('public');
      const send = page.getByRole('button', { name: 'Verser 1 fichier' });
      await expect(send).toBeDisabled();
      await page.getByLabel('Je confirme que ces documents peuvent être publics.').check();
      await send.click();
      if (attempt === 1) {
        await expect(page.getByRole('status')).toContainText('1 document versé en un commit.');
        await expect(page.getByRole('list', { name: 'Documents versés' })).toContainText(
          'brief.md',
        );
      } else {
        await expect(page.getByRole('status')).toContainText('Aucun changement');
        await expect(page.getByRole('status')).toContainText('déjà importé');
      }
    }
    await app.close();
  });

  test('bibliothèque : cinq fichiers déposés d’un coup, prévisualisés et versés en un commit', async () => {
    const { app, page } = await launch(userData);
    await saveToken(page);
    await page.keyboard.press('Control+1');
    await page.getByRole('button', { name: 'Ouvrir un dépôt existant' }).click();
    await page.getByRole('button', { name: 'Ouvrir site' }).click();
    await expect(page.getByTestId('drop-zone')).toBeVisible();

    // Vrai glisser-déposer : des File adossés aux fichiers du disque (comme depuis l'explorateur),
    // portés par un DataTransfer jusqu'à l'événement drop de la zone.
    const names = ['brief.docx', 'annexe.pdf', 'page.html', 'notes.md', 'logo.png'];
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.id = 'e2e-source';
      input.style.display = 'none';
      document.body.append(input);
    });
    await page.setInputFiles('#e2e-source', names.map(fixture));
    await page.evaluate(() => {
      const input = document.getElementById('e2e-source') as HTMLInputElement;
      const transfer = new DataTransfer();
      for (const file of Array.from(input.files ?? [])) transfer.items.add(file);
      const zone = document.querySelector('[data-testid=drop-zone]');
      zone?.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true }));
      zone?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
    });

    const staged = page.getByRole('list', { name: 'Fichiers à verser' }).getByRole('listitem');
    await expect(staged).toHaveCount(5);
    for (const name of names) {
      await expect(page.getByRole('article', { name: `Aperçu de ${name}` })).toBeVisible();
    }
    await expect(
      page.getByRole('article', { name: 'Aperçu de brief.docx' }).getByRole('table'),
    ).toBeVisible();
    await expect(
      page.getByRole('article', { name: 'Aperçu de logo.png' }).getByRole('img'),
    ).toBeVisible();

    await page.getByLabel('Rôle de brief.docx').selectOption('brief');
    await page.getByLabel('Je confirme que ces documents peuvent être publics.').check();
    await page.getByRole('button', { name: 'Verser 5 fichiers' }).click();
    await expect(page.getByRole('status')).toContainText('5 documents versés en un commit.');

    const documents = page.getByRole('list', { name: 'Documents versés' }).getByRole('listitem');
    await expect(documents).toHaveCount(5);
    await page.getByRole('button', { name: 'Aperçu' }).first().click();
    await expect(page.getByRole('article', { name: 'Aperçu du document' })).toBeVisible();
    await app.close();
  });
  test('plan : le planificateur exige un modèle réglé, puis se lance', async () => {
    const { app, page } = await launch(userData);
    await saveToken(page);
    await page.keyboard.press('Control+1');
    await page.getByRole('button', { name: 'Ouvrir un dépôt existant' }).click();
    await page.getByRole('button', { name: 'Ouvrir outil' }).click();
    await page.getByRole('button', { name: 'Plan', exact: true }).click();
    await page.getByRole('button', { name: 'Lancer le planificateur' }).click();
    await expect(page.getByRole('alert')).toContainText('Aucun modèle pour le planificateur');

    await page.getByRole('button', { name: 'Réglages' }).click();
    await page.getByLabel('Modèle du planificateur').fill('modele-planificateur');
    await page.getByRole('button', { name: 'Enregistrer les réglages' }).click();
    await expect(page.getByText('Réglages enregistrés.')).toBeVisible();
    await page.getByRole('tab', { name: /outil/ }).click();
    await page.getByRole('button', { name: 'Lancer le planificateur' }).click();
    await expect(page.getByRole('status')).toContainText('Planificateur lancé');
    await expect(page.getByRole('button', { name: 'Régénérer le plan' })).toBeDisabled();
    await page.getByLabel('Consigne pour régénérer le plan').fill('Moins de tâches.');
    await expect(page.getByRole('button', { name: 'Régénérer le plan' })).toBeEnabled();
    await app.close();
  });
});
