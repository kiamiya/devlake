import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemGit } from './git.js';
import { cloneDir, EditorSync, prepareEditorClone } from './sync.js';

const BRANCH = 'task/T04-saut';
const YAML = (name: string) =>
  `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &1\nGameObject:\n  m_Name: ${name}\n`;
const META = (guid: string) => `fileFormatVersion: 2\nguid: ${guid}\n`;

/** git avec une identité, pour les dépôts de test (graine et runner). */
const git = (cwd: string, ...args: string[]) =>
  systemGit(cwd, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'core.autocrlf=false',
    ...args,
  ]);

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

describe('synchronisation de l’éditeur sur un vrai dépôt git', { timeout: 60_000 }, () => {
  let root: string;
  let origin: string;
  let runner: string;
  let editorClone: string;
  let log: string;
  let sync: EditorSync;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agentlake-editor-'));
    origin = join(root, 'origin.git');
    await systemGit(root, ['init', '--bare', '-b', 'main', origin]);
    // Projet Unity de départ, poussé sur main.
    const seed = join(root, 'graine');
    await systemGit(root, ['clone', origin, seed]);
    write(seed, {
      '.gitattributes':
        '*.fbx filter=lfs diff=lfs merge=lfs -text\n*.unity merge=unityyamlmerge eol=lf\n',
      'ProjectSettings/EditorSettings.asset':
        '%YAML 1.1\n  m_SerializationMode: 2\n  m_ExternalVersionControlSupport: Visible Meta Files\n',
      'Assets/Scripts/Player.cs': 'public class Player {}\n',
      'Assets/Scripts/Player.cs.meta': META('a1'),
      'Assets/Scenes/Main.unity': YAML('Main'),
      'Assets/Scenes/Main.unity.meta': META('b2'),
    });
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-m', 'chore: projet Unity');
    await git(seed, 'push', 'origin', 'HEAD:main');

    // Clone dédié préparé par le cockpit.
    const clones = join(root, 'clones');
    const prepared = await prepareEditorClone({
      clonesRoot: clones,
      owner: 'kiamiya',
      repo: 'jeu',
      editor: 'unity',
      token: null,
      remoteUrl: origin,
    });
    editorClone = prepared.dir;
    expect(prepared).toMatchObject({
      dir: cloneDir(clones, 'kiamiya', 'jeu'),
      created: true,
      warnings: [],
    });

    // Le runner de l'agent : code poussé sur la branche de la tâche.
    runner = join(root, 'runner');
    await systemGit(root, ['clone', origin, runner]);
    await git(runner, 'checkout', '-b', BRANCH);
    write(runner, {
      'Assets/Scripts/Player.cs': 'public class Player { public float saut = 2f; }\n',
    });
    await git(runner, 'commit', '-am', 'feat(T04): hauteur de saut');
    await git(runner, 'push', 'origin', `HEAD:${BRANCH}`);

    log = join(root, 'Editor.log');
    writeFileSync(log, '');
    sync = new EditorSync({
      editor: 'unity',
      currentClone: () => Promise.resolve({ clone: editorClone, repo: 'kiamiya/jeu' }),
      token: () => Promise.resolve(null),
      logPath: () => Promise.resolve(log),
      wait: { timeoutMs: 5_000, quietMs: 200, pollMs: 20 },
    });
  }, 60_000);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('script poussé par l’agent et scène modifiée dans l’éditeur arrivent sur la même branche', async () => {
    // L'éditeur ouvert réimporte après chaque changement de fichiers et l'écrit dans son journal.
    const editorRefresh = setInterval(() => {
      appendFileSync(log, 'Refresh completed in 0.4 seconds\n');
    }, 100);
    const checkout = await sync.checkout('kiamiya/jeu', BRANCH).finally(() => {
      clearInterval(editorRefresh);
    });
    expect(checkout).toMatchObject({ branch: BRANCH, settled: true, compileErrors: [] });
    expect(readFileSync(join(editorClone, 'Assets/Scripts/Player.cs'), 'utf8')).toContain('saut');

    // Aura modifie la scène et crée un prefab dans l'éditeur.
    write(editorClone, {
      'Assets/Scenes/Main.unity': `${YAML('Main')}  m_IsActive: 1\n`,
      'Assets/Prefabs/Saut.prefab': YAML('Saut'),
      'Assets/Prefabs/Saut.prefab.meta': META('c3'),
    });
    const status = await sync.status('kiamiya/jeu');
    expect(status.branch).toBe(BRANCH);
    expect(status.modified.length).toBeGreaterThan(0);
    const pushed = await sync.commitPush('kiamiya/jeu', 'feat(T04): scène et prefab du saut');
    expect(pushed).toMatchObject({ branch: BRANCH, pushed: true });
    expect(pushed.files).toEqual(
      expect.arrayContaining([
        'Assets/Scenes/Main.unity',
        'Assets/Prefabs/Saut.prefab',
        'Assets/Prefabs/Saut.prefab.meta',
      ]),
    );
    expect((await sync.status('kiamiya/jeu')).unpushed).toBe(0);

    // Le runner récupère ce que l'éditeur a poussé : script et scène sur la même branche.
    await git(runner, 'pull', '--ff-only', 'origin', BRANCH);
    expect(readFileSync(join(runner, 'Assets/Scripts/Player.cs'), 'utf8')).toContain('saut');
    expect(readFileSync(join(runner, 'Assets/Scenes/Main.unity'), 'utf8')).toContain(
      'm_IsActive: 1',
    );
    expect(existsSync(join(runner, 'Assets/Prefabs/Saut.prefab'))).toBe(true);
    const author = await systemGit(runner, ['log', '-1', '--format=%an']);
    expect(author.trim()).toBe('AgentLake (éditeur)');
  });

  it('refus : checkout avec des modifications en attente, push sur main', async () => {
    write(editorClone, { 'Assets/Scenes/Main.unity': `${YAML('Main')}  m_IsActive: 0\n` });
    await expect(sync.checkout('kiamiya/jeu', BRANCH)).rejects.toThrow(
      'Modifications non poussées',
    );
    // Toujours sur main : pousser est refusé.
    await expect(sync.commitPush('kiamiya/jeu', 'feat: sur main')).rejects.toThrow(
      'Refus de pousser sur main',
    );
  });

  it('refus : scène sérialisée en binaire, asset sans .meta, binaire hors LFS', async () => {
    setTimeout(() => {
      appendFileSync(log, 'Refresh completed in 0.1 seconds\n');
    }, 50);
    await sync.checkout('kiamiya/jeu', BRANCH);
    write(editorClone, {
      'Assets/Scenes/Main.unity': 'UnityFS binaire',
      'Assets/Textures/Saut.png': 'PNG',
      'Assets/Textures/Saut.png.meta': META('d4'),
      'Assets/Notes/sans-meta.txt': 'x',
    });
    const refusal = await sync.commitPush('kiamiya/jeu', 'feat: refus').then(
      () => '',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(refusal).toContain('Assets/Scenes/Main.unity est sérialisé en binaire');
    expect(refusal).toContain('Assets/Notes/sans-meta.txt n’a pas de fichier .meta');
    expect(refusal).toContain('Assets/Textures/Saut.png n’est pas suivi par Git LFS');
    // Rien n'est resté indexé, rien n'est poussé.
    expect((await systemGit(editorClone, ['diff', '--cached', '--name-only'])).trim()).toBe('');
    expect((await sync.status('kiamiya/jeu')).unpushed).toBe(0);
  });

  it('clone déjà préparé : mis à jour, pas recloné', async () => {
    const again = await prepareEditorClone({
      clonesRoot: join(root, 'clones'),
      owner: 'kiamiya',
      repo: 'jeu',
      editor: 'unity',
      token: null,
      remoteUrl: origin,
    });
    expect(again.created).toBe(false);
  });
});
