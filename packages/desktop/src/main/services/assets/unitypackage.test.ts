import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { tar, unityPackage } from './testing.js';
import {
  commonDirectory,
  extractUnityPackage,
  readTar,
  UnityPackageError,
} from './unitypackage.js';

const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);

describe('package Unity (.unitypackage)', () => {
  it('fichiers à leur chemin dans le projet, avec leurs .meta ; dossiers : .meta seul', () => {
    const files = extractUnityPackage(
      unityPackage({
        'Assets/Caisses': null,
        'Assets/Caisses/caisse.fbx': new Uint8Array([0, 1, 2]),
        'Assets/Caisses/caisse.mat': 'Material: {}\n',
      }),
    );
    expect(files.map((f) => f.path)).toEqual([
      'Assets/Caisses.meta',
      'Assets/Caisses/caisse.fbx',
      'Assets/Caisses/caisse.fbx.meta',
      'Assets/Caisses/caisse.mat',
      'Assets/Caisses/caisse.mat.meta',
    ]);
    expect(text(files.find((f) => f.path === 'Assets/Caisses/caisse.fbx.meta')?.data)).toContain(
      'guid: 00000000000000000000000000000002',
    );
    expect(commonDirectory(files.map((f) => f.path))).toBe('Assets');
    expect(commonDirectory(files.slice(1).map((f) => f.path))).toBe('Assets/Caisses');
  });

  it('refuse les chemins hors du projet, un package vide ou illisible', () => {
    expect(() => extractUnityPackage(unityPackage({ '../evasion.txt': 'x' }))).toThrow(
      'Package Unity vide.',
    );
    expect(() => extractUnityPackage(new Uint8Array([1, 2, 3]))).toThrow(UnityPackageError);
  });

  it('tar : noms longs pax et préfixe « ./ »', () => {
    const long = `${'a'.repeat(120)}/fichier.txt`;
    const archive = tar({
      'PaxHeader/x': `${String(long.length + 9)} path=${long}\n`,
      x: 'contenu',
    });
    // En-tête pax : type « x ».
    archive[156] = 'x'.charCodeAt(0);
    expect(text(readTar(archive).get(long))).toBe('contenu');
    expect([...readTar(tar({ './a/b': 'c' })).keys()]).toEqual(['a/b']);
    expect(
      extractUnityPackage(gzipSync(tar({ 'g/pathname': 'Assets/x.txt', 'g/asset': 'x' }))),
    ).toHaveLength(1);
  });
});
