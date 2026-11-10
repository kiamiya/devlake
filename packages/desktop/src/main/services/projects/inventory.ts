import { createHash } from 'node:crypto';
import type { GitHubPort, RepoRef } from 'github';
import {
  CONTEXT_INDEX_PATH,
  ContextIndexSchema,
  INVENTORY_BRANCH_PREFIX,
  INVENTORY_PATH,
  ProjectConfigSchema,
  type ContextEntry,
} from 'shared';
import { parse } from 'yaml';
import type { InventoryState } from '../../../shared/ipc-contract.js';
import type { Repositories } from '../../db/repositories.js';
import { UnknownProjectError } from '../../projects-service.js';
import { readContextIndex } from '../ingestion/deposit.js';
import { PROJECT_CONFIG_PATH } from './files.js';

const MAIN = 'main';
const branchOf = (version: number) => `${INVENTORY_BRANCH_PREFIX}${String(version)}`;

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryError';
  }
}

/**
 * État des lieux d'un projet repris : proposé par le planificateur sur `etat-des-lieux/vN`,
 * relu dans le cockpit, puis versé dans le contexte (main) quand Kia le valide.
 */
export class InventoryService {
  constructor(
    private readonly repos: Repositories,
    private readonly github: () => Promise<GitHubPort>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private ref(projectId: string): RepoRef {
    const project = this.repos.projects.list().find((p) => p.id === projectId);
    if (!project) throw new UnknownProjectError(projectId);
    return { owner: project.owner, repo: project.repo };
  }

  async get(projectId: string): Promise<InventoryState> {
    const github = await this.github();
    const ref = this.ref(projectId);
    const config = await github.getFile(ref, PROJECT_CONFIG_PATH, MAIN);
    const adopted =
      config !== null &&
      ProjectConfigSchema.safeParse(parse(config.content)).data?.adopted === true;
    const versions: InventoryState['versions'] = [];
    for (let version = 1; await github.branchExists(ref, branchOf(version)); version += 1)
      versions.push({ version, branch: branchOf(version) });
    const last = versions.at(-1);
    const content =
      last === undefined ? null : await github.getFile(ref, INVENTORY_PATH, last.branch);
    const index = await readContextIndex(github, ref, MAIN);
    return {
      adopted,
      versions,
      latest:
        last !== undefined && content !== null
          ? { version: last.version, content: content.content }
          : null,
      validated: index.files.some((f) => f.role === 'inventory'),
    };
  }

  /** Verse la version relue dans le contexte, en un commit sur main (remplace l'ancienne). */
  async validate(projectId: string, version: number): Promise<{ commitSha: string }> {
    const github = await this.github();
    const ref = this.ref(projectId);
    const file = await github.getFile(ref, INVENTORY_PATH, branchOf(version));
    if (!file) throw new InventoryError(`Aucun état des lieux sur ${branchOf(version)}.`);
    const index = await readContextIndex(github, ref, MAIN);
    const entry: ContextEntry = {
      path: INVENTORY_PATH,
      role: 'inventory',
      source: `${branchOf(version)} (planificateur)`,
      sha256: createHash('sha256').update(file.content).digest('hex'),
      size: Buffer.byteLength(file.content),
      importedAt: this.now(),
    };
    const files = [...index.files.filter((f) => f.path !== INVENTORY_PATH), entry].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const commitSha = await github.commitFiles(ref, {
      branch: MAIN,
      message: `docs(context): état des lieux v${String(version)}`,
      changes: [
        { path: INVENTORY_PATH, content: file.content },
        {
          path: CONTEXT_INDEX_PATH,
          content: `${JSON.stringify(ContextIndexSchema.parse({ version: 1, files }), null, 2)}\n`,
        },
      ],
    });
    return { commitSha };
  }
}
