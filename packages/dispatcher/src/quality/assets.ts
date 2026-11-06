import { parseLfsPointer, type GitHubPort, type PullRequestFile, type RepoRef } from 'github';

/**
 * Livrables des agents Artiste 3D (Blender) : chaque source `.blend` ajoutée ou modifiée dans
 * une PR part avec un export du même nom (FBX, GLB ou glTF), valide et suivi par Git LFS
 * (binaires). Vérifié par le check « tests-guard » de la porte qualité.
 */
const BLEND = /\.blend$/i;
const EXPORT = /\.(fbx|glb|gltf)$/i;

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

/** Le contenu est-il un export 3D lisible, d'après sa signature ? */
export function validExport(path: string, data: Uint8Array): boolean {
  const head = Buffer.from(data.subarray(0, 4096)).toString('latin1');
  if (/\.fbx$/i.test(path))
    return head.startsWith('Kaydara FBX Binary') || head.includes('FBXHeaderExtension');
  if (/\.glb$/i.test(path)) return head.startsWith('glTF');
  try {
    const json = JSON.parse(Buffer.from(data).toString('utf8')) as {
      asset?: { version?: unknown };
    };
    return typeof json.asset?.version === 'string';
  } catch {
    return false;
  }
}

/** Raisons d'échec du check pour les livrables Blender de la PR ; vide si tout est en ordre. */
export async function checkBlenderExports(
  github: GitHubPort,
  ref: RepoRef,
  head: string,
  files: readonly PullRequestFile[],
): Promise<string[]> {
  const present = files.filter((f) => f.status !== 'removed').map((f) => f.filename);
  const blends = present.filter((f) => BLEND.test(f));
  if (blends.length === 0) return [];
  const exports = present.filter((f) => EXPORT.test(f));
  const reasons: string[] = [];
  for (const blend of blends) {
    const candidates = exports.filter((e) => baseName(e) === baseName(blend));
    const exported = candidates[0];
    if (exported === undefined) {
      reasons.push(
        `${blend} n’a pas d’export du même nom (.fbx, .glb ou .gltf) dans la PR : exporter le modèle.`,
      );
      continue;
    }
    const file = await github.getFile(ref, exported, head);
    if (file === null) {
      reasons.push(`${exported} introuvable sur la branche ${head}.`);
      continue;
    }
    const pointer = parseLfsPointer(file.content);
    let data: Uint8Array;
    if (pointer !== null) {
      try {
        data = await github.downloadLfsObject(ref, pointer);
      } catch (error) {
        reasons.push(
          `${exported} : contenu Git LFS illisible (${error instanceof Error ? error.message : String(error)}).`,
        );
        continue;
      }
    } else if (/\.gltf$/i.test(exported)) {
      data = Buffer.from(file.content, 'utf8');
    } else {
      reasons.push(`${exported} n’est pas suivi par Git LFS (.gitattributes).`);
      continue;
    }
    if (!validExport(exported, data))
      reasons.push(`${exported} n’est pas un export valide (en-tête FBX, GLB ou glTF absent).`);
  }
  return reasons;
}
