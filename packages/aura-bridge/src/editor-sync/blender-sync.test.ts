import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileErrors, editorLogPath, waitForEditor } from './editor-log.js';
import type { GitExec } from './git.js';
import { BLENDER_CLONE_SUFFIX, cloneDir, EditorSync } from './sync.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Clone Blender sur disque (fichiers réels), git simulé. */
function blenderClone(files: Record<string, string>) {
  const clone = mkdtempSync(join(tmpdir(), `agentlake-blender${BLENDER_CLONE_SUFFIX}-`));
  dirs.push(clone);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(clone, path, '..'), { recursive: true });
    writeFileSync(join(clone, path), content);
  }
  const calls: string[][] = [];
  const staged = Object.keys(files).join('\n');
  const git: GitExec = (_cwd, args) => {
    calls.push([...args]);
    if (args.includes('rev-parse') && args.includes('--abbrev-ref'))
      return Promise.resolve('task/T07-tonneau\n');
    if (args.includes('diff')) return Promise.resolve(staged);
    if (args.includes('check-attr'))
      return Promise.resolve(
        args
          .slice(args.indexOf('--') + 1)
          .map((f) => `${f}: filter: lfs`)
          .join('\n'),
      );
    if (args.includes('rev-parse')) return Promise.resolve('abc123\n');
    return Promise.resolve('');
  };
  const requested: string[] = [];
  const sync = new EditorSync({
    editor: 'blender',
    currentClone: (repo) => {
      requested.push(repo);
      return Promise.resolve({ clone, repo: 'kiamiya/jeu' });
    },
    token: () => Promise.resolve(null),
    git,
  });
  return { clone, calls, sync, requested };
}

describe('synchronisation du clone Blender', () => {
  it('clone à part du moteur, pas de journal ni d’attente après la bascule', async () => {
    expect(cloneDir('/clones', 'kiamiya', 'jeu', 'blender')).toBe(
      join('/clones', 'kiamiya__jeu__blender'),
    );
    expect(cloneDir('/clones', 'kiamiya', 'jeu', 'unity')).toBe(join('/clones', 'kiamiya__jeu'));
    expect(await editorLogPath('blender', '/clones/x')).toBe(
      join('/clones/x', '.git', 'agentlake-blender.log'),
    );
    expect(await waitForEditor('blender', 'absent.log', 0)).toEqual({ settled: true, text: '' });
    expect(compileErrors('blender', 'error CS0103: x')).toEqual([]);

    const { sync, requested } = blenderClone({});
    expect(await sync.checkout('kiamiya/jeu', 'task/T07-tonneau')).toMatchObject({
      settled: true,
      compileErrors: [],
    });
    // Le clone est choisi d'après le dépôt du run (un clone Blender par projet).
    expect(requested).toEqual(['kiamiya/jeu']);
  });

  it('pousse la source .blend avec son export ; refuse une source sans export', async () => {
    const ok = blenderClone({
      'Art/Tonneau/Tonneau.blend': 'BLENDER',
      'Assets/Art/Tonneau/Tonneau.fbx': 'Kaydara FBX Binary',
    });
    expect(await ok.sync.commitPush('kiamiya/jeu', 'feat(T07): tonneau')).toMatchObject({
      pushed: true,
      files: ['Art/Tonneau/Tonneau.blend', 'Assets/Art/Tonneau/Tonneau.fbx'],
    });
    // Chemins de Blender : Art/ et Assets/Art/ seulement.
    expect(ok.calls).toContainEqual(['add', '-A', '--', 'Art', 'Assets/Art']);

    const missing = blenderClone({ 'Art/Caisse/Caisse.blend': 'BLENDER' });
    await expect(missing.sync.commitPush('kiamiya/jeu', 'feat: caisse')).rejects.toThrow(
      'Art/Caisse/Caisse.blend n’a pas d’export du même nom (.fbx, .glb ou .gltf)',
    );
    expect(missing.calls.some((c) => c.includes('push'))).toBe(false);
  });
});
