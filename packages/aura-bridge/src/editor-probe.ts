import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Editor } from './types.js';

/** État de l'éditeur vu depuis le poste : clone dédié ouvert, projet et branche courants. */
export interface EditorState {
  open: boolean;
  /** Dépôt du clone ouvert, « owner/repo ». */
  repo: string | null;
  branch: string | null;
  clone: string | null;
}

export const EDITOR_CLOSED: EditorState = { open: false, repo: null, branch: null, clone: null };

export interface ProbeDeps {
  /** Lignes de commande des processus en cours (détection d'Unreal). */
  listProcesses: () => Promise<string[]>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function text(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Branche courante d'un clone (`.git/HEAD`) ; null si HEAD est détaché ou illisible. */
export async function currentBranch(clone: string): Promise<string | null> {
  const head = await text(join(clone, '.git', 'HEAD'));
  const match = head === null ? null : /^ref: refs\/heads\/(.+)$/m.exec(head.trim());
  return match?.[1] ?? null;
}

/** Dépôt GitHub du remote `origin` (`.git/config`), « owner/repo ». */
export async function originRepository(clone: string): Promise<string | null> {
  const config = await text(join(clone, '.git', 'config'));
  if (config === null) return null;
  const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? '';
  const url = /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() ?? '';
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1] ?? ''}/${match[2] ?? ''}` : null;
}

/** L'éditeur est-il ouvert sur ce clone ? Unity : verrou `Temp/UnityLockfile` ; Unreal : processus. */
async function isOpen(
  clone: string,
  editor: Editor,
  processes: () => Promise<string[]>,
): Promise<boolean> {
  if (editor === 'unity') return exists(join(clone, 'Temp', 'UnityLockfile'));
  const entries = await readdir(clone).catch(() => [] as string[]);
  const project = entries.find((e) => e.endsWith('.uproject'));
  if (project === undefined) return false;
  const target = resolve(clone, project).toLowerCase().replaceAll('\\', '/');
  return (await processes()).some((line) => {
    const normalized = line.toLowerCase().replaceAll('\\', '/');
    return normalized.includes('unrealeditor') && normalized.includes(target);
  });
}

/**
 * Cherche, dans le dossier des clones dédiés, celui que l'éditeur a ouvert. Le premier clone
 * ouvert donne le projet et la branche courants.
 */
export async function probeEditor(
  clonesRoot: string | null,
  editor: Editor,
  deps: ProbeDeps = { listProcesses: systemProcesses },
): Promise<EditorState> {
  if (clonesRoot === null) return EDITOR_CLOSED;
  const entries = await readdir(clonesRoot, { withFileTypes: true }).catch(() => []);
  let processes: string[] | null = null;
  const lazyProcesses = async () => (processes ??= await deps.listProcesses());
  for (const entry of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const clone = join(clonesRoot, entry.name);
    if (!(await exists(join(clone, '.git')))) continue;
    if (!(await isOpen(clone, editor, lazyProcesses))) continue;
    return {
      open: true,
      repo: await originRepository(clone),
      branch: await currentBranch(clone),
      clone,
    };
  }
  return EDITOR_CLOSED;
}

/* c8 ignore start -- dépend du système : couvert par l'usage réel du cockpit */
export function systemProcesses(): Promise<string[]> {
  const [command, args] =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }',
          ],
        ]
      : ['ps', ['-A', '-o', 'args=']];
  return new Promise((done) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      done(error ? [] : stdout.split(/\r?\n/).filter((l) => l.trim() !== ''));
    });
  });
}
/* c8 ignore stop */
