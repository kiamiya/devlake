import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Editor } from '../types.js';
import {
  compileErrors,
  DEFAULT_WAIT,
  editorLogPath,
  logSize,
  readLogSince,
  waitForEditor,
  type WaitOptions,
} from './editor-log.js';
import { authArgs, EDITOR_AUTHOR, EditorSyncError, systemGit, type GitExec } from './git.js';

/** Dossiers commités depuis l'éditeur : scènes, prefabs, `.meta`, assets, réglages. */
export const EDITOR_PATHS: Record<Editor, readonly string[]> = {
  unity: ['Assets', 'ProjectSettings', 'Packages'],
  unreal: ['Content', 'Config'],
  // Sources .blend dans Art/, exports dans Art/ (Unreal) ou Assets/Art/ (importés par Unity).
  blender: ['Art', 'Assets/Art'],
};

/** Exports d'un modèle Blender attendus à côté de sa source. */
const BLENDER_EXPORT = /\.(fbx|glb|gltf)$/i;

/** Assets Unity sérialisés en YAML : doivent commencer par `%YAML` (sérialisation texte forcée). */
const UNITY_YAML_ASSET =
  /\.(unity|prefab|asset|mat|controller|anim|overrideController|mask|physicMaterial|playable|preset|lighting|spriteatlas|guiskin|fontsettings|signal|renderTexture|cubemap|flare)$/i;
/** Fichiers binaires qui doivent passer par Git LFS. */
const LFS_REQUIRED =
  /\.(uasset|umap|fbx|glb|obj|blend|png|jpe?g|tga|psd|tiff?|exr|hdr|wav|mp3|ogg|mp4|mov|ttf|otf|unitypackage)$/i;

const PROTECTED_BRANCHES = ['main', 'master', 'HEAD'];

export interface CloneInfo {
  clone: string;
  repo: string | null;
}

export interface EditorSyncOptions {
  editor: Editor;
  /**
   * Clone dédié ouvert dans l'éditeur (sonde du pont). Le dépôt attendu est fourni : Blender
   * a un clone par projet, choisi d'après lui.
   */
  currentClone: (expectedRepo: string) => Promise<CloneInfo | null>;
  /** Jeton GitHub du cockpit (coffre), pour fetch et push. */
  token: () => Promise<string | null>;
  git?: GitExec;
  logPath?: (clone: string) => Promise<string>;
  wait?: WaitOptions;
}

export interface SyncStatus {
  repo: string | null;
  branch: string;
  /** Fichiers modifiés non commités (`git status --porcelain`). */
  modified: string[];
  /** Commits locaux pas encore poussés. */
  unpushed: number;
  compileErrors: string[];
  warnings: string[];
}

const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.trim() !== '');

/**
 * Synchronisation entre le runner et l'éditeur : le clone dédié suit la branche de la tâche
 * (`editor_checkout`), ce que fait Aura dans l'éditeur repart sur cette branche
 * (`editor_commit_push`), `editor_status` décrit l'état du clone.
 */
export class EditorSync {
  private readonly git: GitExec;

  constructor(private readonly options: EditorSyncOptions) {
    this.git = options.git ?? systemGit;
  }

  /** Clone ouvert dans l'éditeur, sur le dépôt du run qui appelle. */
  private async clone(expectedRepo: string): Promise<string> {
    const info = await this.options.currentClone(expectedRepo);
    if (info === null)
      throw new EditorSyncError(
        `Éditeur ${this.options.editor} fermé : ouvrir le clone dédié de ${expectedRepo} sur le poste.`,
      );
    if (info.repo !== expectedRepo)
      throw new EditorSyncError(
        `L’éditeur est ouvert sur ${info.repo ?? 'un autre dépôt'}, pas sur ${expectedRepo}.`,
      );
    return info.clone;
  }

  private async branch(clone: string): Promise<string> {
    return (await this.git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  private async modified(clone: string): Promise<string[]> {
    return lines(await this.git(clone, ['status', '--porcelain', '--untracked-files=all']));
  }

  private async unpushed(clone: string): Promise<number> {
    const count = await this.git(clone, [
      'rev-list',
      '--count',
      'HEAD',
      '--not',
      '--remotes=origin',
    ]);
    return Number(count.trim()) || 0;
  }

  private logPath(clone: string): Promise<string> {
    return (this.options.logPath ?? ((c) => editorLogPath(this.options.editor, c)))(clone);
  }

  async status(expectedRepo: string): Promise<SyncStatus> {
    const clone = await this.clone(expectedRepo);
    const path = await this.logPath(clone);
    const tail = await readLogSince(path, Math.max(0, (await logSize(path)) - 200_000));
    return {
      repo: expectedRepo,
      branch: await this.branch(clone),
      modified: await this.modified(clone),
      unpushed: await this.unpushed(clone),
      compileErrors: compileErrors(this.options.editor, tail),
      warnings: await serializationWarnings(this.options.editor, clone),
    };
  }

  /**
   * Bascule le clone sur la branche de la tâche (poussée par l'agent), puis attend la fin de
   * l'import ou de la compilation. Refusé si l'éditeur a des modifications non poussées.
   */
  async checkout(expectedRepo: string, branch: string) {
    const clone = await this.clone(expectedRepo);
    if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-'))
      throw new EditorSyncError(`Nom de branche invalide : ${branch}.`);
    const pending = await this.modified(clone);
    if (pending.length > 0)
      throw new EditorSyncError(
        `Modifications non poussées dans l’éditeur (${pending
          .slice(0, 10)
          .map((l) => l.trim())
          .join(', ')}) : appeler editor_commit_push avant de changer de branche.`,
      );
    if ((await this.unpushed(clone)) > 0)
      throw new EditorSyncError(
        'Commits de l’éditeur pas encore poussés : appeler editor_commit_push avant de changer de branche.',
      );
    const token = await this.options.token();
    try {
      await this.git(clone, [
        ...authArgs(token),
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
    } catch {
      throw new EditorSyncError(
        `Branche ${branch} introuvable sur GitHub : pousser d’abord le code de la tâche (git push origin HEAD:${branch}).`,
      );
    }
    const path = await this.logPath(clone);
    const offset = await logSize(path);
    await this.git(clone, ['checkout', '-B', branch, `origin/${branch}`]);
    const sha = (await this.git(clone, ['rev-parse', 'HEAD'])).trim();
    const waited = await waitForEditor(
      this.options.editor,
      path,
      offset,
      this.options.wait ?? DEFAULT_WAIT,
    );
    return {
      branch,
      sha,
      settled: waited.settled,
      compileErrors: compileErrors(this.options.editor, waited.text),
    };
  }

  /**
   * Commite scènes, prefabs, `.meta` et assets de l'éditeur, puis pousse sur la branche de la
   * tâche. Refusé sur `main`, pour un asset sérialisé en binaire ou un binaire hors LFS.
   */
  async commitPush(expectedRepo: string, message: string) {
    const clone = await this.clone(expectedRepo);
    const branch = await this.branch(clone);
    if (PROTECTED_BRANCHES.includes(branch))
      throw new EditorSyncError(
        `Refus de pousser sur ${branch} : appeler d’abord editor_checkout sur la branche de la tâche.`,
      );
    if (message.trim() === '') throw new EditorSyncError('Message de commit vide.');
    const paths: string[] = [];
    for (const p of EDITOR_PATHS[this.options.editor])
      if (await exists(join(clone, p))) paths.push(p);
    if (paths.length > 0) await this.git(clone, ['add', '-A', '--', ...paths]);
    const staged = lines(await this.git(clone, ['diff', '--cached', '--name-only']));
    if (staged.length === 0) return { branch, sha: null, files: [] as string[], pushed: false };
    const problems = await this.problems(clone, staged);
    if (problems.length > 0) {
      await this.git(clone, ['reset', '-q', '--', ...paths]);
      throw new EditorSyncError(`Commit refusé :\n- ${problems.join('\n- ')}`);
    }
    await this.git(clone, [
      '-c',
      `user.name=${EDITOR_AUTHOR.name}`,
      '-c',
      `user.email=${EDITOR_AUTHOR.email}`,
      'commit',
      '-m',
      message.trim(),
    ]);
    const token = await this.options.token();
    await this.git(clone, [...authArgs(token), 'push', 'origin', `HEAD:refs/heads/${branch}`]);
    const sha = (await this.git(clone, ['rev-parse', 'HEAD'])).trim();
    return { branch, sha, files: staged, pushed: true };
  }

  private async problems(clone: string, staged: string[]): Promise<string[]> {
    const problems: string[] = [];
    const present = staged.filter((f) => !f.endsWith('/'));
    const existing: string[] = [];
    for (const f of present) if (await exists(join(clone, f))) existing.push(f);
    if (this.options.editor === 'blender') {
      // Chaque source .blend poussée part avec son export (FBX, glTF) du même nom.
      const base = (f: string) => f.slice(f.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      const exported = new Set(existing.filter((f) => BLENDER_EXPORT.test(f)).map(base));
      for (const file of existing.filter((f) => f.toLowerCase().endsWith('.blend')))
        if (!exported.has(base(file)))
          problems.push(
            `${file} n’a pas d’export du même nom (.fbx, .glb ou .gltf) : exporter le modèle avant de pousser.`,
          );
    }
    if (this.options.editor === 'unity') {
      for (const file of existing.filter((f) => UNITY_YAML_ASSET.test(f))) {
        const head = (await readFile(join(clone, file))).subarray(0, 5).toString('utf8');
        if (head !== '%YAML')
          problems.push(
            `${file} est sérialisé en binaire : forcer la sérialisation texte (Edit > Project Settings > Editor).`,
          );
      }
      const stagedSet = new Set(staged);
      for (const file of existing.filter((f) => f.startsWith('Assets/') && !f.endsWith('.meta'))) {
        if (!stagedSet.has(`${file}.meta`) && !(await exists(join(clone, `${file}.meta`))))
          problems.push(`${file} n’a pas de fichier .meta.`);
      }
    }
    const binaries = existing.filter((f) => LFS_REQUIRED.test(f));
    if (binaries.length > 0) {
      const attrs = lines(await this.git(clone, ['check-attr', 'filter', '--', ...binaries]));
      for (const line of attrs) {
        const [file, , value] = line.split(': ');
        if (value?.trim() !== 'lfs')
          problems.push(`${file ?? line} n’est pas suivi par Git LFS (.gitattributes).`);
      }
    }
    return problems;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Unity : sérialisation texte forcée et `.meta` visibles, sinon un avertissement. */
export async function serializationWarnings(editor: Editor, clone: string): Promise<string[]> {
  if (editor !== 'unity') return [];
  let settings: string;
  try {
    settings = await readFile(join(clone, 'ProjectSettings', 'EditorSettings.asset'), 'utf8');
  } catch {
    return ['ProjectSettings/EditorSettings.asset absent : sérialisation texte non vérifiable.'];
  }
  const warnings: string[] = [];
  if (!/m_SerializationMode:\s*2\b/.test(settings))
    warnings.push(
      'Sérialisation des assets non forcée en texte (m_SerializationMode doit valoir 2).',
    );
  const support = /m_ExternalVersionControlSupport:(.*)$/m.exec(settings)?.[1]?.trim();
  if (support !== undefined && support !== 'Visible Meta Files')
    warnings.push('Fichiers .meta non visibles (Version Control : Visible Meta Files).');
  return warnings;
}

export interface PrepareCloneInput {
  clonesRoot: string;
  owner: string;
  repo: string;
  editor: Editor;
  token: string | null;
  git?: GitExec;
  /** URL du dépôt (tests : chemin local). */
  remoteUrl?: string;
}

/** Suffixe des clones Blender : distincts du clone du moteur, pour travailler en parallèle. */
export const BLENDER_CLONE_SUFFIX = '__blender';

/** Dossier du clone dédié d'un projet (Blender : un clone à part). */
export function cloneDir(clonesRoot: string, owner: string, repo: string, editor?: Editor): string {
  return join(clonesRoot, `${owner}__${repo}${editor === 'blender' ? BLENDER_CLONE_SUFFIX : ''}`);
}

/**
 * Prépare le clone dédié d'un projet de jeu (distinct de la copie de travail de Kia) :
 * clone ou mise à jour, Git LFS activé, avertissements de sérialisation (Unity).
 */
export async function prepareEditorClone(input: PrepareCloneInput) {
  const git = input.git ?? systemGit;
  const dir = cloneDir(input.clonesRoot, input.owner, input.repo, input.editor);
  const url = input.remoteUrl ?? `https://github.com/${input.owner}/${input.repo}.git`;
  let created = false;
  if (await exists(join(dir, '.git'))) {
    await git(dir, [...authArgs(input.token), 'fetch', '--no-tags', 'origin']);
  } else {
    await mkdir(input.clonesRoot, { recursive: true });
    await git(input.clonesRoot, [...authArgs(input.token), 'clone', url, dir]);
    created = true;
  }
  await git(dir, ['lfs', 'install', '--local']);
  return { dir, created, warnings: await serializationWarnings(input.editor, dir) };
}
