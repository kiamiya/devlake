import { FakeGitHub, lfsPointerText, type PullRequestFile } from 'github';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkBlenderExports, validExport } from './assets.js';

const ref = { owner: 'kiamiya', repo: 'jeu' };
const BRANCH = 'task/T07-tonneau';
const bytes = (text: string) => new TextEncoder().encode(text);
const FBX = bytes('Kaydara FBX Binary  \u0000\u001a\u0000 contenu');
const GLB = bytes('glTF\u0002\u0000\u0000\u0000 contenu');

const changed = (
  filename: string,
  status: PullRequestFile['status'] = 'added',
): PullRequestFile => ({
  filename,
  status,
  additions: 1,
  deletions: 0,
});

describe('exports des sources Blender', () => {
  let github: FakeGitHub;

  /** Pousse des fichiers : binaires en Git LFS (pointeurs), textes tels quels. */
  async function push(files: Record<string, Uint8Array | string>) {
    const changes = [];
    for (const [path, content] of Object.entries(files)) {
      if (typeof content === 'string') changes.push({ path, content });
      else {
        const [pointer] = await github.uploadLfsObjects(ref, [content]);
        if (!pointer) throw new Error('LFS');
        changes.push({ path, content: lfsPointerText(pointer) });
      }
    }
    await github.commitFiles(ref, { branch: BRANCH, baseBranch: 'main', message: 'art', changes });
  }

  beforeEach(() => {
    github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
  });

  it('source et export valides (FBX, GLB, glTF) : rien à redire', async () => {
    await push({
      'Art/Tonneau/Tonneau.blend': bytes('BLENDER-v400'),
      'Assets/Art/Tonneau/Tonneau.fbx': FBX,
      'Art/Caisse/Caisse.blend': bytes('BLENDER-v400'),
      'Art/Caisse/Caisse.glb': GLB,
      'Art/Pot/Pot.blend': bytes('BLENDER-v400'),
      'Art/Pot/Pot.gltf': JSON.stringify({ asset: { version: '2.0' } }),
    });
    const files = [
      'Art/Tonneau/Tonneau.blend',
      'Assets/Art/Tonneau/Tonneau.fbx',
      'Art/Caisse/Caisse.blend',
      'Art/Caisse/Caisse.glb',
      'Art/Pot/Pot.blend',
      'Art/Pot/Pot.gltf',
    ].map((f) => changed(f));
    expect(await checkBlenderExports(github, ref, BRANCH, files)).toEqual([]);
  });

  it('refus : sans export, export invalide, binaire hors LFS, export absent de la branche', async () => {
    await push({
      'Art/A/A.blend': bytes('BLENDER'),
      'Art/B/B.blend': bytes('BLENDER'),
      'Art/B/B.fbx': bytes('pas un fbx'),
      'Art/C/C.blend': bytes('BLENDER'),
      'Art/C/C.fbx': 'Kaydara FBX Binary hors LFS',
      'Art/D/D.blend': bytes('BLENDER'),
    });
    const reasons = await checkBlenderExports(github, ref, BRANCH, [
      changed('Art/A/A.blend'),
      changed('Art/B/B.blend', 'modified'),
      changed('Art/B/B.fbx'),
      changed('Art/C/C.blend'),
      changed('Art/C/C.fbx'),
      changed('Art/D/D.blend'),
      changed('Art/D/D.fbx'),
    ]);
    expect(reasons).toEqual([
      'Art/A/A.blend n’a pas d’export du même nom (.fbx, .glb ou .gltf) dans la PR : exporter le modèle.',
      'Art/B/B.fbx n’est pas un export valide (en-tête FBX, GLB ou glTF absent).',
      'Art/C/C.fbx n’est pas suivi par Git LFS (.gitattributes).',
      `Art/D/D.fbx introuvable sur la branche ${BRANCH}.`,
    ]);
  });

  it('PR sans source Blender, ou source supprimée : non concernée', async () => {
    expect(await checkBlenderExports(github, ref, BRANCH, [changed('src/a.ts')])).toEqual([]);
    expect(
      await checkBlenderExports(github, ref, BRANCH, [changed('Art/A/A.blend', 'removed')]),
    ).toEqual([]);
  });

  it('signatures', () => {
    expect(validExport('a.fbx', FBX)).toBe(true);
    expect(validExport('a.fbx', bytes('; FBX 7.4.0 project file\nFBXHeaderExtension:  {'))).toBe(
      true,
    );
    expect(validExport('a.glb', GLB)).toBe(true);
    expect(validExport('a.glb', FBX)).toBe(false);
    expect(validExport('a.gltf', bytes('{"asset":{"version":"2.0"}}'))).toBe(true);
    expect(validExport('a.gltf', bytes('{}'))).toBe(false);
    expect(validExport('a.gltf', bytes('pas du json'))).toBe(false);
  });
});
