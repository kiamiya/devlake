import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Editor } from '../types.js';

/** Journal de l'éditeur : Unity (Editor.log global) ou Unreal (Saved/Logs du projet). */
export async function editorLogPath(editor: Editor, clone: string): Promise<string> {
  if (editor === 'unreal') {
    const entries = await readdir(clone).catch(() => [] as string[]);
    const project = entries.find((e) => e.endsWith('.uproject'));
    return join(
      clone,
      'Saved',
      'Logs',
      `${project ? basename(project, '.uproject') : 'Projet'}.log`,
    );
  }
  /* c8 ignore next 4 -- emplacement propre à chaque système */
  if (process.platform === 'win32')
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
      'Unity',
      'Editor',
      'Editor.log',
    );
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Logs', 'Unity', 'Editor.log');
  return join(homedir(), '.config', 'unity3d', 'Editor.log');
}

/** Lignes qui signalent la fin d'un import ou d'une compilation. */
const DONE: Record<Editor, RegExp> = {
  unity:
    /(Asset Pipeline Refresh.*Total:|Refresh completed in|Reloading assemblies after finished compiling|Domain Reload Profiling)/,
  unreal:
    /(Live coding (succeeded|failed)|Hot ?reload.*(complete|succeeded|failed)|Compile of .* (complete|failed)|LogInit: Display: Engine is initialized)/i,
};

/** Erreurs de compilation : C# (Unity), C++ et Blueprints (Unreal). */
const ERROR: Record<Editor, RegExp> = {
  unity: /error CS\d{4}:/,
  unreal: /(error C\d{4}:|error LNK\d{4}:|LogBlueprint: Error:|: error:)/,
};

export async function logSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Texte ajouté au journal depuis `offset` (un journal raccourci repart du début). */
export async function readLogSince(path: string, offset: number): Promise<string> {
  const size = await logSize(path);
  const start = size < offset ? 0 : offset;
  if (size <= start) return '';
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export function compileErrors(editor: Editor, text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .filter((l) => ERROR[editor].test(l))
        .map((l) => l.trim()),
    ),
  ].slice(0, 50);
}

export interface WaitOptions {
  timeoutMs: number;
  /** Silence du journal qui vaut fin d'import, une fois une activité vue. */
  quietMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DEFAULT_WAIT: WaitOptions = { timeoutMs: 5 * 60_000, quietMs: 5_000, pollMs: 500 };

/**
 * Attend la fin de l'import ou de la compilation après un checkout : ligne de fin dans le
 * journal, ou journal silencieux après une activité. Renvoie le texte lu et l'issue.
 */
export async function waitForEditor(
  editor: Editor,
  path: string,
  offset: number,
  options: WaitOptions = DEFAULT_WAIT,
): Promise<{ settled: boolean; text: string }> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  let lastSize = await logSize(path);
  let lastChange = started;
  let active = lastSize !== offset;
  for (;;) {
    const text = await readLogSince(path, offset);
    if (DONE[editor].test(text)) return { settled: true, text };
    const size = await logSize(path);
    if (size !== lastSize) {
      lastSize = size;
      lastChange = now();
      active = true;
    }
    if (active && now() - lastChange >= options.quietMs) return { settled: true, text };
    if (now() - started >= options.timeoutMs) return { settled: false, text };
    await sleep(options.pollMs);
  }
}
