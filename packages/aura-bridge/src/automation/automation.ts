import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { authArgs, EditorSyncError, systemGit, type GitExec } from '../editor-sync/git.js';
import { cloneDir } from '../editor-sync/sync.js';

/**
 * Tests d'automatisation Unreal lancés par la CI via le pont : `UnrealEditor-Cmd` sur le clone
 * dédié du poste, au commit exact de la PR, sous le verrou d'éditeur. Le job GitHub qui appelle
 * le pont porte le check (`unit-tests`, `integration-tests`).
 */

/** Demande de la CI : commit à tester et filtre de tests d'automatisation. */
export interface AutomationRequest {
  repo: string;
  runId: string;
  branch: string;
  sha: string;
  /** Filtre `Automation RunTests`, ex. `Project.Unit` ou `Project.Unit+Project.Core`. */
  filter: string;
}

export interface AutomationTest {
  name: string;
  state: 'passed' | 'failed' | 'skipped';
  errors: string[];
}

export type AutomationState = 'running' | 'passed' | 'failed' | 'error';

export interface AutomationJob {
  id: string;
  repo: string;
  runId: string;
  branch: string;
  sha: string;
  filter: string;
  state: AutomationState;
  startedAt: string;
  finishedAt: string | null;
  summary: { passed: number; failed: number; skipped: number };
  tests: AutomationTest[];
  /** Raison d'un état `error` (refus, éditeur introuvable, rapport absent…). */
  error: string | null;
  /** Fin de la sortie d'UnrealEditor-Cmd (diagnostic d'un échec). */
  logTail: string[];
}

/** Lancement d'un processus ; renvoie le code de sortie et la sortie combinée. */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; output: string; timedOut: boolean }>;

/* c8 ignore start -- appel système ; exercé par le test d'intégration avec un faux éditeur */
export const systemProcess: ProcessRunner = (command, args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, windowsHide: true, shell: false });
    const chunks: string[] = [];
    let size = 0;
    const keep = (data: Buffer) => {
      chunks.push(data.toString('utf8'));
      size += data.length;
      // Garde la fin de la sortie seulement (les journaux d'Unreal sont très longs).
      while (size > 2_000_000 && chunks.length > 1) size -= (chunks.shift() ?? '').length;
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: chunks.join(''), timedOut });
    });
  });
/* c8 ignore stop */

export interface AutomationRunnerOptions {
  /** Dossier des clones dédiés (`<clonesRoot>/<owner>__<repo>`). */
  clonesRoot: () => string | null;
  /** Chemin d'UnrealEditor-Cmd (réglage du cockpit) ; null s'il n'est pas configuré. */
  editorCmd: () => string | null;
  /** Jeton GitHub du cockpit (coffre), pour le fetch du commit. */
  token: () => Promise<string | null>;
  git?: GitExec;
  run?: ProcessRunner;
  now?: () => Date;
  timeoutMs?: number;
  /** Dossier des rapports (temporaire par défaut). */
  reportsRoot?: string;
}

/** Durée maximale d'une passe de tests d'automatisation. */
export const AUTOMATION_TIMEOUT_MS = 60 * 60_000;
/** Jobs terminés gardés en mémoire (consultation par la CI). */
const KEPT_JOBS = 20;
const LOG_TAIL_LINES = 80;

const FILTER = /^[A-Za-z0-9_.+ -]+$/;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[\w./-]+$/;

/** Rapport `index.json` d'Unreal (`-ReportExportPath`), lu de façon tolérante. */
const ReportSchema = z.object({
  tests: z
    .array(
      z.looseObject({
        testDisplayName: z.string().optional(),
        fullTestPath: z.string().optional(),
        state: z.string(),
        entries: z
          .array(
            z.looseObject({
              event: z.looseObject({ type: z.string(), message: z.string().optional() }),
            }),
          )
          .optional(),
      }),
    )
    .default([]),
});

/** Lit le rapport d'automatisation d'Unreal : un test par entrée, erreurs comprises. */
export function parseAutomationReport(text: string): AutomationTest[] {
  // Rapport écrit avec une marque d'ordre des octets (U+FEFF) par Unreal sous Windows.
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const data = ReportSchema.parse(JSON.parse(json));
  return data.tests.map((t) => {
    const state = t.state.toLowerCase();
    return {
      name: t.fullTestPath ?? t.testDisplayName ?? '(test sans nom)',
      state: state === 'success' ? 'passed' : state === 'fail' ? 'failed' : 'skipped',
      errors: (t.entries ?? [])
        .filter((e) => e.event.type.toLowerCase() === 'error')
        .map((e) => e.event.message ?? '')
        .filter((m) => m !== ''),
    };
  });
}

/** Arguments d'UnrealEditor-Cmd : tests d'automatisation sans rendu, puis fermeture. */
export function automationArgs(uproject: string, filter: string, reportDir: string): string[] {
  return [
    uproject,
    `-ExecCmds=Automation RunTests ${filter}; Quit`,
    '-unattended',
    '-nullrhi',
    '-nosplash',
    '-nosound',
    '-nop4',
    `-ReportExportPath=${reportDir}`,
    '-stdout',
    '-FullStdOutLogOutput',
  ];
}

/** Vérifie une demande de la CI avant de toucher au clone. */
export function validateRequest(request: AutomationRequest): string | null {
  if (!SHA.test(request.sha)) return `Commit invalide : ${request.sha}.`;
  if (!BRANCH.test(request.branch) || request.branch.startsWith('-'))
    return `Nom de branche invalide : ${request.branch}.`;
  if (!FILTER.test(request.filter.trim()) || request.filter.trim().startsWith('-'))
    return `Filtre de tests invalide : ${request.filter} (lettres, chiffres, « . », « _ », « + »).`;
  return null;
}

/**
 * Passes de tests d'automatisation, une à la fois : prépare le clone au commit de la PR,
 * lance UnrealEditor-Cmd, lit le rapport. Le verrou d'éditeur est géré par le pont.
 */
export class AutomationRunner {
  private readonly jobs = new Map<string, AutomationJob>();
  private readonly git: GitExec;
  private readonly run: ProcessRunner;
  private readonly now: () => Date;
  private active: Promise<void> | null = null;

  constructor(private readonly options: AutomationRunnerOptions) {
    this.git = options.git ?? systemGit;
    this.run = options.run ?? systemProcess;
    this.now = options.now ?? (() => new Date());
  }

  get busy(): boolean {
    return this.active !== null;
  }

  get(id: string): AutomationJob | null {
    return this.jobs.get(id) ?? null;
  }

  /** Attend la fin de la passe en cours (tests). */
  async idle(): Promise<void> {
    await this.active;
  }

  /**
   * Démarre une passe ; la réponse est immédiate (état `running`), la CI interroge ensuite.
   * `onDone` est appelé à la fin, quel que soit le résultat (libération du verrou).
   */
  start(request: AutomationRequest, onDone: () => void = () => undefined): AutomationJob {
    if (this.active) throw new EditorSyncError('Une passe de tests d’automatisation tourne déjà.');
    const job: AutomationJob = {
      id: randomUUID(),
      repo: request.repo,
      runId: request.runId,
      branch: request.branch,
      sha: request.sha,
      filter: request.filter.trim(),
      state: 'running',
      startedAt: this.now().toISOString(),
      finishedAt: null,
      summary: { passed: 0, failed: 0, skipped: 0 },
      tests: [],
      error: null,
      logTail: [],
    };
    this.jobs.set(job.id, job);
    for (const old of [...this.jobs.keys()].slice(0, Math.max(0, this.jobs.size - KEPT_JOBS)))
      this.jobs.delete(old);
    this.active = this.execute(job)
      .catch((error: unknown) => {
        job.state = 'error';
        job.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        job.finishedAt = this.now().toISOString();
        this.active = null;
        onDone();
      });
    return { ...job };
  }

  private async execute(job: AutomationJob): Promise<void> {
    const invalid = validateRequest(job);
    if (invalid) throw new EditorSyncError(invalid);
    const editorCmd = this.options.editorCmd();
    if (editorCmd === null || editorCmd === '')
      throw new EditorSyncError(
        'Chemin d’UnrealEditor-Cmd non configuré dans le cockpit (Pont Aura, Unreal).',
      );
    const [owner = '', repo = ''] = job.repo.split('/');
    const clonesRoot = this.options.clonesRoot();
    if (clonesRoot === null)
      throw new EditorSyncError('Dossier des clones d’éditeur non configuré dans le cockpit.');
    const clone = cloneDir(clonesRoot, owner, repo);
    if (!existsSync(join(clone, '.git')))
      throw new EditorSyncError(
        `Clone dédié de ${job.repo} absent du poste : le préparer depuis le cockpit.`,
      );
    await this.checkout(clone, job);
    const uproject = (await readdir(clone)).find((e) => e.endsWith('.uproject'));
    if (uproject === undefined)
      throw new EditorSyncError(`Aucun fichier .uproject à la racine du clone de ${job.repo}.`);

    const reportDir = join(
      this.options.reportsRoot ?? join(tmpdir(), 'agentlake-automation'),
      job.id,
    );
    await mkdir(reportDir, { recursive: true });
    try {
      const result = await this.run(
        editorCmd,
        automationArgs(join(clone, uproject), job.filter, reportDir),
        { cwd: clone, timeoutMs: this.options.timeoutMs ?? AUTOMATION_TIMEOUT_MS },
      );
      job.logTail = result.output
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .slice(-LOG_TAIL_LINES);
      if (result.timedOut)
        throw new EditorSyncError(
          `Tests d’automatisation interrompus au bout de ${String(
            Math.round((this.options.timeoutMs ?? AUTOMATION_TIMEOUT_MS) / 60_000),
          )} min.`,
        );
      const reportPath = join(reportDir, 'index.json');
      if (!existsSync(reportPath))
        throw new EditorSyncError(
          `UnrealEditor-Cmd s’est terminé (code ${String(result.code)}) sans rapport de tests.`,
        );
      job.tests = parseAutomationReport(await readFile(reportPath, 'utf8'));
    } finally {
      await rm(reportDir, { recursive: true, force: true });
    }
    job.summary = {
      passed: job.tests.filter((t) => t.state === 'passed').length,
      failed: job.tests.filter((t) => t.state === 'failed').length,
      skipped: job.tests.filter((t) => t.state === 'skipped').length,
    };
    if (job.tests.length === 0) {
      // Un check qui ne lance aucun test serait un check sauté.
      job.state = 'failed';
      job.error = `Aucun test d’automatisation ne correspond au filtre « ${job.filter} ».`;
      return;
    }
    job.state = job.summary.failed > 0 ? 'failed' : 'passed';
  }

  /** Clone au commit exact de la PR ; refusé si l'éditeur a du travail non poussé. */
  private async checkout(clone: string, job: AutomationJob): Promise<void> {
    const pending = (await this.git(clone, ['status', '--porcelain', '--untracked-files=no']))
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '');
    if (pending.length > 0)
      throw new EditorSyncError(
        'Modifications non poussées dans le clone de l’éditeur : les pousser (editor_commit_push) avant les tests.',
      );
    const token = await this.options.token();
    try {
      await this.git(clone, [
        ...authArgs(token),
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/${job.branch}:refs/remotes/origin/${job.branch}`,
      ]);
    } catch {
      throw new EditorSyncError(`Branche ${job.branch} introuvable sur GitHub.`);
    }
    try {
      await this.git(clone, ['checkout', '--detach', job.sha]);
    } catch {
      throw new EditorSyncError(`Commit ${job.sha} absent de la branche ${job.branch}.`);
    }
  }
}
