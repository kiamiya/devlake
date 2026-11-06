import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorSyncError, type GitExec } from '../editor-sync/git.js';
import {
  automationArgs,
  AutomationRunner,
  parseAutomationReport,
  validateRequest,
  type AutomationRequest,
  type ProcessRunner,
} from './automation.js';

const SHA = 'a'.repeat(40);
const REQUEST: AutomationRequest = {
  repo: 'kiamiya/jeu',
  runId: '42',
  branch: 'task/T04-saut',
  sha: SHA,
  filter: 'Project.Unit',
};

const report = (tests: unknown[]) => `\uFEFF${JSON.stringify({ succeeded: 1, tests })}`;
const test = (name: string, state: string, errors: string[] = []) => ({
  fullTestPath: name,
  state,
  entries: [
    ...errors.map((message) => ({ event: { type: 'Error', message } })),
    { event: { type: 'Info', message: 'info' } },
  ],
});

describe('rapport d’automatisation Unreal', () => {
  it('lit états, noms et erreurs (BOM toléré)', () => {
    expect(
      parseAutomationReport(
        report([
          test('Project.Unit.Saut', 'Success'),
          test('Project.Unit.Chute', 'Fail', ['Attendu 2, obtenu 1']),
          { testDisplayName: 'Ignoré', state: 'NotRun' },
          { state: 'InProcess' },
        ]),
      ),
    ).toEqual([
      { name: 'Project.Unit.Saut', state: 'passed', errors: [] },
      { name: 'Project.Unit.Chute', state: 'failed', errors: ['Attendu 2, obtenu 1'] },
      { name: 'Ignoré', state: 'skipped', errors: [] },
      { name: '(test sans nom)', state: 'skipped', errors: [] },
    ]);
    expect(parseAutomationReport('{}')).toEqual([]);
  });

  it('arguments d’UnrealEditor-Cmd : sans rendu, rapport exporté, fermeture', () => {
    expect(automationArgs('C:/c/Jeu.uproject', 'Project.Unit', 'C:/r')).toEqual(
      expect.arrayContaining([
        'C:/c/Jeu.uproject',
        '-ExecCmds=Automation RunTests Project.Unit; Quit',
        '-unattended',
        '-nullrhi',
        '-ReportExportPath=C:/r',
      ]),
    );
  });

  it('refuse commit, branche ou filtre douteux (pas d’injection de commandes)', () => {
    expect(validateRequest(REQUEST)).toBeNull();
    expect(validateRequest({ ...REQUEST, filter: 'Project.Unit+Project.Core' })).toBeNull();
    expect(validateRequest({ ...REQUEST, sha: 'abc' })).toContain('Commit invalide');
    expect(validateRequest({ ...REQUEST, branch: '-x' })).toContain('branche invalide');
    expect(validateRequest({ ...REQUEST, filter: 'Unit; Quit; exec' })).toContain('Filtre');
    expect(validateRequest({ ...REQUEST, filter: '"x"' })).toContain('Filtre');
    expect(validateRequest({ ...REQUEST, filter: '' })).toContain('Filtre');
  });
});

describe('passe de tests d’automatisation', () => {
  let root: string;
  let clone: string;
  let gitCalls: string[][];
  let pending: string;
  let failFetch: boolean;
  let reportBody: string | null;
  let runResult: { code: number | null; output: string; timedOut: boolean };
  let runCalls: { command: string; args: readonly string[] }[];
  let editorCmd: string | null;
  let clonesRoot: string | null;

  const git: GitExec = (_cwd, args) => {
    gitCalls.push([...args]);
    if (args[0] === 'status') return Promise.resolve(pending);
    if (args.includes('fetch') && failFetch) return Promise.reject(new Error('introuvable'));
    return Promise.resolve('');
  };
  const run: ProcessRunner = (command, args) => {
    runCalls.push({ command, args });
    const dir = args.find((a) => a.startsWith('-ReportExportPath='))?.split('=')[1] ?? '';
    if (reportBody !== null) writeFileSync(join(dir, 'index.json'), reportBody);
    return Promise.resolve(runResult);
  };

  const runner = () =>
    new AutomationRunner({
      clonesRoot: () => clonesRoot,
      editorCmd: () => editorCmd,
      token: () => Promise.resolve('jeton'),
      git,
      run,
      reportsRoot: join(root, 'rapports'),
      now: () => new Date('2026-11-06T10:00:00Z'),
    });

  async function finished(r: AutomationRunner, request = REQUEST) {
    let done = 0;
    const job = r.start(request, () => {
      done += 1;
    });
    expect(job.state).toBe('running');
    await r.idle();
    expect(done).toBe(1);
    return r.get(job.id);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentlake-automation-'));
    clone = join(root, 'clones', 'kiamiya__jeu');
    mkdirSync(join(clone, '.git'), { recursive: true });
    writeFileSync(join(clone, 'Jeu.uproject'), '{}');
    gitCalls = [];
    pending = '';
    failFetch = false;
    reportBody = report([test('Project.Unit.Saut', 'Success')]);
    runResult = { code: 0, output: 'LogAutomation: début\nLogAutomation: fin\n', timedOut: false };
    runCalls = [];
    editorCmd = 'C:/UE/UnrealEditor-Cmd.exe';
    clonesRoot = join(root, 'clones');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('succès : clone au commit de la PR, UnrealEditor-Cmd sur le .uproject, rapport lu', async () => {
    const job = await finished(runner());
    expect(job).toMatchObject({
      state: 'passed',
      summary: { passed: 1, failed: 0, skipped: 0 },
      error: null,
      finishedAt: '2026-11-06T10:00:00.000Z',
      logTail: ['LogAutomation: début', 'LogAutomation: fin'],
    });
    const fetch = gitCalls.find((c) => c.includes('fetch')) ?? [];
    expect(fetch.slice(-1)).toEqual([
      '+refs/heads/task/T04-saut:refs/remotes/origin/task/T04-saut',
    ]);
    // Jeton en en-tête de la commande, jamais dans l'URL ni la config du clone.
    expect(fetch[1]).toContain('extraheader=AUTHORIZATION: basic');
    expect(gitCalls).toContainEqual(['checkout', '--detach', SHA]);
    expect(runCalls[0]?.command).toBe('C:/UE/UnrealEditor-Cmd.exe');
    expect(runCalls[0]?.args[0]).toBe(join(clone, 'Jeu.uproject'));
  });

  it('test en échec : passe en échec, erreurs rapportées', async () => {
    reportBody = report([
      test('Project.Unit.Saut', 'Success'),
      test('Project.Unit.Chute', 'Fail', ['Attendu 2']),
    ]);
    const job = await finished(runner());
    expect(job).toMatchObject({ state: 'failed', summary: { passed: 1, failed: 1 } });
    expect(job?.tests[1]?.errors).toEqual(['Attendu 2']);
  });

  it('aucun test pour le filtre : échec (un check vide serait un check sauté)', async () => {
    reportBody = report([]);
    const job = await finished(runner());
    expect(job).toMatchObject({ state: 'failed' });
    expect(job?.error).toContain('Aucun test d’automatisation ne correspond au filtre');
  });

  it.each([
    ['UnrealEditor-Cmd non configuré', () => (editorCmd = null), 'non configuré dans le cockpit'],
    [
      'dossier des clones non configuré',
      () => (clonesRoot = null),
      'Dossier des clones d’éditeur non configuré',
    ],
    [
      'clone absent',
      () => {
        rmSync(join(clone, '.git'), { recursive: true });
      },
      'Clone dédié de kiamiya/jeu absent',
    ],
    ['travail non poussé', () => (pending = ' M Content/Map.umap\n'), 'Modifications non poussées'],
    ['branche introuvable', () => (failFetch = true), 'Branche task/T04-saut introuvable'],
    ['sans rapport', () => (reportBody = null), 'sans rapport de tests'],
    [
      'délai dépassé',
      () => (runResult = { code: null, output: '', timedOut: true }),
      'interrompus au bout de 60 min',
    ],
    [
      'sans .uproject',
      () => {
        rmSync(join(clone, 'Jeu.uproject'));
      },
      'Aucun fichier .uproject à la racine',
    ],
  ])('erreur : %s', async (_name, arrange, message) => {
    arrange();
    const job = await finished(runner());
    expect(job?.state).toBe('error');
    expect(job?.error).toContain(message);
  });

  it('demande invalide : erreur sans toucher au clone', async () => {
    const job = await finished(runner(), { ...REQUEST, filter: 'x; Quit' });
    expect(job?.error).toContain('Filtre de tests invalide');
    expect(gitCalls).toEqual([]);
  });

  it('une passe à la fois ; jobs anciens oubliés', async () => {
    const r = runner();
    const first = r.start(REQUEST);
    expect(r.busy).toBe(true);
    expect(() => r.start(REQUEST)).toThrow(EditorSyncError);
    await r.idle();
    expect(r.busy).toBe(false);
    for (let i = 0; i < 20; i++) {
      r.start(REQUEST);
      await r.idle();
    }
    expect(r.get(first.id)).toBeNull();
    expect(r.get('inconnu')).toBeNull();
  });
});
