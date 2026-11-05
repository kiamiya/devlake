import type { GitHubPort } from 'github';
import type { ContextEntry } from 'shared';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Repositories } from '../../db/repositories.js';
import { UnknownProjectError } from '../../projects-service.js';
import {
  depositContext,
  readContextIndex,
  type DepositResult,
  type ImportRole,
} from './deposit.js';
import {
  planValidatedAt,
  previewDocument,
  previewFiles,
  readDecisions,
  removeDocument,
  setDocumentNote,
  setDocumentRole,
  type Preview,
} from './context-ops.js';
import type { ParserRegistry } from './registry.js';

export interface ChosenFiles {
  files: { token: string; name: string; size: number }[];
  repositoryPrivate: boolean;
}

export class PublicRepoNotAcknowledgedError extends Error {
  constructor() {
    super(
      'Dépôt public : confirmer que ces documents peuvent être visibles de tous avant de les verser.',
    );
    this.name = 'PublicRepoNotAcknowledgedError';
  }
}

export class UnknownFileError extends Error {
  constructor() {
    super('Fichier inconnu : le choisir de nouveau avec le sélecteur.');
    this.name = 'UnknownFileError';
  }
}

export interface ContextDeps {
  repos: Repositories;
  github: () => Promise<GitHubPort>;
  registry: ParserRegistry;
  /** Sélecteur de fichiers natif ; renvoie des chemins absolus. */
  pickFiles: (extensions: string[]) => Promise<string[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  fileSize: (path: string) => Promise<number>;
}

/**
 * Import de documents dans le contexte d'un projet. Le renderer ne manipule jamais
 * de chemin : il reçoit des identifiants opaques pour les fichiers choisis ici.
 */
export class ContextService {
  private readonly chosen = new Map<string, string>();

  constructor(private readonly deps: ContextDeps) {}

  private project(projectId: string) {
    const project = this.deps.repos.projects.list().find((p) => p.id === projectId);
    if (!project) throw new UnknownProjectError(projectId);
    return { owner: project.owner, repo: project.repo };
  }

  async chooseFiles(projectId: string): Promise<ChosenFiles> {
    const ref = this.project(projectId);
    const repository = await (await this.deps.github()).getRepository(ref);
    const paths = await this.deps.pickFiles(this.deps.registry.extensions());
    return this.register(paths, repository.private);
  }

  /** Fichiers déposés dans le cockpit : chemins fournis par le preload (webUtils). */
  async registerDropped(projectId: string, paths: readonly string[]): Promise<ChosenFiles> {
    const ref = this.project(projectId);
    const repository = await (await this.deps.github()).getRepository(ref);
    return this.register(paths, repository.private);
  }

  private async register(
    paths: readonly string[],
    repositoryPrivate: boolean,
  ): Promise<ChosenFiles> {
    const files = [];
    for (const path of paths) {
      const token = randomUUID();
      this.chosen.set(token, path);
      files.push({ token, name: basename(path), size: await this.deps.fileSize(path) });
    }
    return { files, repositoryPrivate };
  }

  async import(input: {
    projectId: string;
    files: { token: string; role: ImportRole }[];
    acknowledgePublic: boolean;
  }): Promise<DepositResult> {
    const ref = this.project(input.projectId);
    const github = await this.deps.github();
    if (!(await github.getRepository(ref)).private && !input.acknowledgePublic) {
      throw new PublicRepoNotAcknowledgedError();
    }
    const items = [];
    for (const { token, role } of input.files) {
      const path = this.chosen.get(token);
      if (path === undefined) throw new UnknownFileError();
      items.push({ file: { name: basename(path), data: await this.deps.readFile(path) }, role });
    }
    const maxBytes = this.deps.repos.settings.get().maxImportMegabytes * 1024 * 1024;
    const result = await depositContext(github, ref, items, {
      registry: this.deps.registry,
      maxBytes,
    });
    for (const { token } of input.files) this.chosen.delete(token);
    return result;
  }

  async list(
    projectId: string,
  ): Promise<{ entries: ContextEntry[]; planValidatedAt: string | null }> {
    const github = await this.deps.github();
    const ref = this.project(projectId);
    const [index, validatedAt] = await Promise.all([
      readContextIndex(github, ref, 'main'),
      planValidatedAt(github, ref),
    ]);
    return { entries: index.files, planValidatedAt: validatedAt };
  }

  /** Aperçu des fichiers choisis ou déposés, avant versement. */
  async previewStaged(tokens: readonly string[]): Promise<(Preview & { token: string })[]> {
    const files = [];
    for (const token of tokens) {
      const path = this.chosen.get(token);
      if (path === undefined) throw new UnknownFileError();
      files.push({ name: basename(path), data: await this.deps.readFile(path) });
    }
    const previews = await previewFiles(this.deps.registry, files);
    return previews.map((preview, i) => ({ ...preview, token: tokens[i] ?? '' }));
  }

  async preview(projectId: string, path: string): Promise<Preview> {
    return previewDocument(await this.deps.github(), this.project(projectId), path);
  }

  async setRole(
    projectId: string,
    path: string,
    role: ImportRole,
  ): Promise<{ commitSha: string | null }> {
    return {
      commitSha: await setDocumentRole(
        await this.deps.github(),
        this.project(projectId),
        path,
        role,
      ),
    };
  }

  async setNote(
    projectId: string,
    path: string,
    note: string,
  ): Promise<{ commitSha: string | null }> {
    return {
      commitSha: await setDocumentNote(
        await this.deps.github(),
        this.project(projectId),
        path,
        note,
      ),
    };
  }

  async remove(projectId: string, path: string): Promise<{ commitSha: string | null }> {
    return {
      commitSha: await removeDocument(await this.deps.github(), this.project(projectId), path),
    };
  }

  async decisions(projectId: string): Promise<{ content: string | null }> {
    return { content: await readDecisions(await this.deps.github(), this.project(projectId)) };
  }
}
