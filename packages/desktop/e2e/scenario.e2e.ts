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

/**
 * Scénarios de bout en bout (T22) : cockpit réel, faux GitHub, vrai dispatcher et vrai
 * planificateur, Claude et agents rejoués depuis la bibliothèque de régression.
 */
const appDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scenario = (name: string) =>
  fileURLToPath(
    new URL(`../../../tests/fixtures/regression/scenarios/${name}.json`, import.meta.url),
  );
const BRIEF_DOCX = fileURLToPath(
  new URL('../src/main/services/ingestion/__fixtures__/brief.docx', import.meta.url),
);

/** Faux jetons de test, sans valeur réelle. */
const FAKE_TOKEN = 'ghp_e2eJetonDeTest1234'; // gitleaks:allow
const CLAUDE_TOKEN = 'sk-ant-oat01-faux-jeton-e2e-0042'; // gitleaks:allow

const launched: ElectronApplication[] = [];

async function launch(
  userData: string,
  projects: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir],
    env: {
      ...process.env,
      AGENTLAKE_E2E: '1',
      AGENTLAKE_GITHUB: 'fake',
      AGENTLAKE_FAKE_PROJECTS: '',
      AGENTLAKE_USER_DATA: userData,
      AGENTLAKE_WORLD: JSON.stringify({ projects, tickMs: 200 }),
    },
  });
  launched.push(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/**
 * Le cockpit sonde GitHub toutes les 30 s : on fait tout de suite ce que fait le sondage
 * (questions et projet relus depuis GitHub), puis on rouvre la section pour la relire.
 */
async function refresh(page: Page, projectId: string, section: string): Promise<void> {
  await page.evaluate(async (id) => {
    const { invoke } = (
      window as unknown as { agentlake: { invoke: (c: string, i?: unknown) => Promise<unknown> } }
    ).agentlake;
    await invoke('questions:sync');
    await invoke('projects:sync', { projectId: id });
  }, projectId);
  const other = section === 'Contexte' ? 'Plan' : 'Contexte';
  await page.getByRole('button', { name: other, exact: true }).click();
  await page.getByRole('button', { name: section, exact: true }).click();
}

/**
 * Attend une assertion dans une section, en relisant GitHub entre deux essais. L'assertion
 * a quelques secondes pour passer après chaque relecture (chargement de la section).
 */
async function waitFor(
  page: Page,
  where: { projectId: string; section: string },
  assertion: (timeout: number) => Promise<unknown>,
  timeout = 120_000,
) {
  await expect
    .poll(
      async () => {
        await refresh(page, where.projectId, where.section);
        return assertion(5_000).then(
          () => true,
          () => false,
        );
      },
      { timeout, intervals: [500, 1_000] },
    )
    .toBe(true);
}

async function settings(page: Page, cap?: number): Promise<void> {
  await page.getByRole('button', { name: 'Réglages' }).click();
  await page.getByLabel('Nouveau jeton GitHub').fill(FAKE_TOKEN);
  await page.getByRole('button', { name: 'Enregistrer le jeton GitHub' }).click();
  await expect(page.getByTestId('status-github')).toContainText('OK');
  await page.getByLabel('Nouveau jeton Claude Code').fill(CLAUDE_TOKEN);
  await page.getByRole('button', { name: 'Enregistrer le jeton Claude' }).click();
  await page.getByLabel('Modèle du planificateur').fill('modele-simule');
  if (cap !== undefined)
    await page.getByLabel('Agents simultanés (plafond global)').fill(String(cap));
  await page.getByRole('button', { name: 'Enregistrer les réglages' }).click();
  await expect(page.getByText('Réglages enregistrés.')).toBeVisible();
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Control+1');
  await page.getByRole('button', { name: 'Nouveau projet' }).click();
  await page.getByLabel('Public (minutes Actions gratuites et illimitées)').check();
  await page.getByLabel('Type').selectOption('web');
  await page.getByLabel('Nom du dépôt').fill(name);
  await page.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(page.getByRole('tab', { name: new RegExp(name), selected: true })).toBeVisible();
}

async function launchPlanner(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Lancer le planificateur' }).click();
  await expect(page.getByRole('status')).toContainText('Planificateur lancé');
}

async function validatePlan(page: Page, repo: string, tasks: number): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(repo) }).click();
  await waitFor(page, { projectId: `kiamiya/${repo}`, section: 'Plan' }, (timeout) =>
    expect(page.getByText(`${String(tasks)} tâches.`, { exact: false })).toBeVisible({
      timeout,
    }),
  );
  await page.getByRole('button', { name: 'Valider le plan' }).click();
  await page.getByRole('button', { name: 'Confirmer la validation' }).click();
  await expect(page.getByRole('status')).toContainText(`${String(tasks)} issue(s) créée(s)`);
}

async function answer(page: Page, repo: string, questionId: string, option: string): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(repo) }).click();
  const card = page.getByRole('article', { name: `Question ${questionId}` });
  await waitFor(page, { projectId: `kiamiya/${repo}`, section: 'Questions' }, (timeout) =>
    expect(card).toBeVisible({ timeout }),
  );
  await card.getByRole('button', { name: option }).click();
  await card.getByRole('button', { name: 'Répondre' }).click();
  await expect(card).toBeHidden();
}

/** Statistiques du monde simulé, lues dans le processus principal. */
function worldStats(app: ElectronApplication) {
  return app.evaluate(() => {
    const world = (
      globalThis as {
        __agentlakeWorld?: {
          stats: {
            launches: Map<string, number>;
            maxConcurrent: number;
            merged: number;
            errors: string[];
          };
        };
      }
    ).__agentlakeWorld;
    if (!world) return null;
    return {
      launches: Object.fromEntries(world.stats.launches),
      maxConcurrent: world.stats.maxConcurrent,
      merged: world.stats.merged,
      errors: world.stats.errors,
    };
  });
}

test.describe('scénarios de bout en bout (monde simulé)', () => {
  let userData: string;

  test.beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'agentlake-e2e-monde-'));
  });

  test.afterEach(async () => {
    for (const app of launched.splice(0)) await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('création → docx → questions → réponses → plan → validation → 5 tâches mergées, 100 %', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launch(userData, { 'rendez-vous': scenario('rendez-vous') });
    await settings(page);
    await createProject(page, 'rendez-vous');

    // Brief docx versé dans le contexte du dépôt public.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, BRIEF_DOCX);
    await page.getByRole('button', { name: 'Choisir des fichiers' }).click();
    await page
      .getByRole('list', { name: 'Fichiers à verser' })
      .getByLabel('Rôle de brief.docx')
      .selectOption('brief');
    await page.getByLabel('Je confirme que ces documents peuvent être publics.').check();
    await page.getByRole('button', { name: 'Verser 1 fichier' }).click();
    await expect(page.getByRole('status')).toContainText('1 document versé en un commit.');

    // Planificateur : questions de cadrage, réponses de Kia, puis plan.
    await launchPlanner(page);
    await answer(page, 'rendez-vous', 'C1', 'E-mail seulement');
    await answer(page, 'rendez-vous', 'C2', 'Sans compte');
    await validatePlan(page, 'rendez-vous', 5);

    // Une tâche pose une question bloquante en cours de route.
    await answer(page, 'rendez-vous', 'format-telephone', 'Obligatoire, format français');

    // Toutes les tâches mergées : avancement 100 %.
    const progress = page.getByRole('progressbar', { name: 'Avancement global' });
    await waitFor(page, { projectId: 'kiamiya/rendez-vous', section: 'Exécution' }, (timeout) =>
      expect(progress).toHaveAttribute('aria-valuenow', '100', { timeout }),
    );
    await expect(page.getByRole('region', { name: 'Colonne Terminée' })).toContainText('T04');

    // Une question bloquante et un échec de CI : un lancement de plus chacun.
    expect(await worldStats(app)).toEqual({
      launches: { T00: 1, T01: 2, T02: 2, T03: 1, T04: 1 },
      maxConcurrent: expect.any(Number) as unknown,
      merged: 5,
      errors: [],
    });
    await app.close();
  });

  test('deux projets, plafond global de 2 : jamais plus de 2 agents au total', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launch(userData, {
      'stock-a': scenario('inventaire'),
      'stock-b': scenario('inventaire'),
    });
    await settings(page);
    await createProject(page, 'stock-a');
    await createProject(page, 'stock-b');
    // Plafond global publié dans devlake-config avec la liste des projets.
    await settings(page, 2);

    for (const name of ['stock-a', 'stock-b']) {
      await page.getByRole('tab', { name: new RegExp(name) }).click();
      await launchPlanner(page);
      await validatePlan(page, name, 5);
      expect((await worldStats(app))?.errors).toEqual([]);
    }
    await expect.poll(async () => (await worldStats(app))?.merged, { timeout: 180_000 }).toBe(10);
    expect(await worldStats(app)).toMatchObject({ maxConcurrent: 2, errors: [] });
    await app.close();
  });
});
