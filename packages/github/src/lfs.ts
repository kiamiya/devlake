import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GitHubError, errorFromStatus } from './errors.js';
import type { Clock, RetryOptions } from './http.js';
import type { RepoRef } from './types.js';

/** Objet Git LFS : empreinte SHA-256 et taille. */
export interface LfsPointer {
  oid: string;
  size: number;
}

export function lfsPointerOf(data: Uint8Array): LfsPointer {
  return { oid: createHash('sha256').update(data).digest('hex'), size: data.byteLength };
}

/** Contenu du fichier pointeur commité à la place du binaire. */
export function lfsPointerText(pointer: LfsPointer): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${pointer.oid}\nsize ${String(pointer.size)}\n`;
}

const LFS_JSON = 'application/vnd.git-lfs+json';

const BatchResponse = z.object({
  objects: z.array(
    z.object({
      oid: z.string(),
      size: z.number(),
      actions: z
        .object({
          upload: z
            .object({ href: z.string(), header: z.record(z.string(), z.string()).optional() })
            .optional(),
          verify: z
            .object({ href: z.string(), header: z.record(z.string(), z.string()).optional() })
            .optional(),
          download: z
            .object({ href: z.string(), header: z.record(z.string(), z.string()).optional() })
            .optional(),
        })
        .optional(),
      error: z.object({ code: z.number(), message: z.string() }).optional(),
    }),
  ),
});

/**
 * Client de l'API batch Git LFS (github.com/<dépôt>.git/info/lfs).
 * L'API REST ne gère pas LFS : on envoie l'objet ici, puis on commite un pointeur.
 */
export class LfsClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly retry: RetryOptions,
    private readonly clock: Clock,
    private readonly webUrl = 'https://github.com',
  ) {}

  private async send(url: string, init: RequestInit, what: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.retry.timeoutMs),
        });
      } catch (error) {
        if (attempt >= this.retry.maxRetries) {
          throw new GitHubError('network', `Stockage LFS injoignable (${what}).`, undefined, {
            cause: error,
          });
        }
      }
      if (response?.ok) return response;
      if (response && response.status < 500) {
        throw errorFromStatus(response.status, `LFS ${what} : ${await response.text()}`);
      }
      if (attempt >= this.retry.maxRetries) {
        throw errorFromStatus(response?.status ?? 500, `LFS ${what}`);
      }
      await this.clock.sleep(
        Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt),
      );
    }
  }

  /** Envoie les objets absents du stockage LFS du dépôt ; renvoie un pointeur par fichier. */
  async upload(ref: RepoRef, files: readonly Uint8Array[]): Promise<LfsPointer[]> {
    const pointers = files.map(lfsPointerOf);
    const unique = [...new Map(pointers.map((p) => [p.oid, p])).values()];
    if (unique.length === 0) return pointers;
    const dataByOid = new Map(files.map((data, i) => [pointers[i]?.oid ?? '', data]));
    const auth = `Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`;

    const batch = await this.send(
      `${this.webUrl}/${ref.owner}/${ref.repo}.git/info/lfs/objects/batch`,
      {
        method: 'POST',
        headers: { accept: LFS_JSON, 'content-type': LFS_JSON, authorization: auth },
        body: JSON.stringify({
          operation: 'upload',
          transfers: ['basic'],
          objects: unique,
          hash_algo: 'sha256',
        }),
      },
      'batch',
    );
    const parsed = BatchResponse.safeParse(await batch.json());
    if (!parsed.success)
      throw new GitHubError('invalid-response', 'Réponse inattendue de l’API LFS.');

    for (const object of parsed.data.objects) {
      if (object.error) {
        throw new GitHubError(
          'validation',
          `LFS a refusé ${object.oid} : ${object.error.message}`,
          object.error.code,
        );
      }
      const upload = object.actions?.upload;
      if (!upload) continue; // Déjà présent dans le stockage.
      const data = dataByOid.get(object.oid);
      if (!data) continue;
      await this.send(
        upload.href,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', ...upload.header },
          body: data,
        },
        `envoi ${object.oid.slice(0, 12)}`,
      );
      const verify = object.actions?.verify;
      if (verify) {
        await this.send(
          verify.href,
          {
            method: 'POST',
            headers: { accept: LFS_JSON, 'content-type': LFS_JSON, ...verify.header },
            body: JSON.stringify({ oid: object.oid, size: object.size }),
          },
          `vérification ${object.oid.slice(0, 12)}`,
        );
      }
    }
    return pointers;
  }

  /** Télécharge un objet du stockage LFS du dépôt. */
  async download(ref: RepoRef, pointer: LfsPointer): Promise<Uint8Array> {
    const auth = `Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`;
    const batch = await this.send(
      `${this.webUrl}/${ref.owner}/${ref.repo}.git/info/lfs/objects/batch`,
      {
        method: 'POST',
        headers: { accept: LFS_JSON, 'content-type': LFS_JSON, authorization: auth },
        body: JSON.stringify({
          operation: 'download',
          transfers: ['basic'],
          objects: [pointer],
          hash_algo: 'sha256',
        }),
      },
      'batch',
    );
    const parsed = BatchResponse.safeParse(await batch.json());
    if (!parsed.success)
      throw new GitHubError('invalid-response', 'Réponse inattendue de l’API LFS.');
    const object = parsed.data.objects[0];
    if (object?.error) {
      throw new GitHubError(
        object.error.code === 404 ? 'not-found' : 'validation',
        `LFS : ${object.error.message}`,
        object.error.code,
      );
    }
    const download = object?.actions?.download;
    if (!download) throw new GitHubError('not-found', `Objet LFS ${pointer.oid} introuvable.`, 404);
    const response = await this.send(
      download.href,
      { method: 'GET', headers: { ...download.header } },
      `téléchargement ${pointer.oid.slice(0, 12)}`,
    );
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** Lit un fichier pointeur LFS ; null si le texte n'en est pas un. */
export function parseLfsPointer(text: string): LfsPointer | null {
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  if (!text.startsWith('version https://git-lfs.github.com/spec/') || !oid || !size) return null;
  return { oid, size: Number(size) };
}
