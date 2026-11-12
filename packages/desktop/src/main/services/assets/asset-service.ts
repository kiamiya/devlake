import type { FileChange, GitHubPort, RepoRef } from 'github';
import { lfsPointerText } from 'github';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import {
  ASSET_LIBRARY_PATH,
  ASSET_LICENSE_LABELS,
  AssetLibrarySchema,
  EMPTY_ASSET_LIBRARY,
  isRestrictedLicense,
  ProjectConfigSchema,
  type AssetEntry,
  type AssetLibrary,
  type AssetLicense,
} from 'shared';
import { parse } from 'yaml';
import type {
  AssetImportInput,
  AssetImportResult,
  AssetLibraryView,
  FreeAsset,
  FreeAssetType,
  FreeSource,
  OwnedAsset,
} from '../../../shared/ipc-contract.js';
import type { Repositories } from '../../db/repositories.js';
import { UnknownProjectError } from '../../projects-service.js';
import { mergeGitattributes } from '../projects/bootstrap.js';
import { lfsExtensions, PROJECT_CONFIG_PATH } from '../projects/files.js';
import type { AdhocTaskService } from '../tasks/adhoc-service.js';
import { downloadFree, searchFree, type Fetch } from './free.js';
import {
  defaultEpicVaultCache,
  defaultUnityStoreCache,
  listFiles,
  readLocal,
  scanOwned,
} from './local.js';
import { commonDirectory, extractUnityPackage } from './unitypackage.js';

const MAIN = 'main';
/** Limite de GitHub pour un fichier Git LFS. */
const LFS_FILE_MAX = 2 * 1024 ** 3;
/** Au-delà, avertir : le stockage Git LFS gratuit de GitHub est de 1 Go par compte. */
const LARGE_IMPORT = 500 * 1024 ** 2;
const LFS_BATCH_BYTES = 256 * 1024 ** 2;

export class AssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

/** Licence restreinte dans un dépôt public : le versement attend la confirmation de Kia. */
export class AssetLicenseError extends AssetError {
  constructor(license: AssetLicense) {
    super(
      `Dépôt public et licence « ${ASSET_LICENSE_LABELS[license]} » : ces fichiers seraient visibles de tous, ce que la licence interdit probablement. Confirmer pour verser quand même.`,
    );
    this.name = 'AssetLicenseError';
  }
}

interface FileToCommit {
  path: string;
  data: Uint8Array;
}

export function assetSlug(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s === '' ? 'asset' : s;
}

function uniqueId(base: string, library: AssetLibrary): string {
  const taken = new Set(library.assets.map((a) => a.id));
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${String(n)}`;
  return id;
}

const isBinary = (data: Uint8Array) => data.subarray(0, 8000).includes(0);
const utf8 = new TextDecoder('utf-8', { fatal: true });

const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} Go`
    : `${(bytes / 1024 ** 2).toFixed(1)} Mo`;

/**
 * Bibliothèque d'assets d'un projet de jeu : assets possédés (caches des boutiques, dossiers),
 * liens de boutique, bibliothèques gratuites ; versement en Git LFS et tâche d'intégration.
 */
export class AssetService {
  constructor(
    private readonly deps: {
      repos: Repositories;
      github: () => Promise<GitHubPort>;
      adhoc: AdhocTaskService;
      fetch?: Fetch;
      platform?: NodeJS.Platform;
      env?: NodeJS.ProcessEnv;
      home?: string;
      now?: () => string;
    },
  ) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private ref(projectId: string): RepoRef {
    const project = this.deps.repos.projects.list().find((p) => p.id === projectId);
    if (!project) throw new UnknownProjectError(projectId);
    return { owner: project.owner, repo: project.repo };
  }

  private async project(projectId: string) {
    const github = await this.deps.github();
    const ref = this.ref(projectId);
    const file = await github.getFile(ref, PROJECT_CONFIG_PATH, MAIN);
    const config = file === null ? null : ProjectConfigSchema.safeParse(parse(file.content)).data;
    if (!config) throw new AssetError(`${PROJECT_CONFIG_PATH} absent ou invalide.`);
    const repository = await github.getRepository(ref);
    return { github, ref, type: config.type, private: repository.private };
  }

  private async read(github: GitHubPort, ref: RepoRef): Promise<AssetLibrary> {
    const file = await github.getFile(ref, ASSET_LIBRARY_PATH, MAIN);
    if (!file) return EMPTY_ASSET_LIBRARY;
    const parsed = AssetLibrarySchema.safeParse(JSON.parse(file.content));
    if (!parsed.success) throw new AssetError(`${ASSET_LIBRARY_PATH} invalide.`);
    return parsed.data;
  }

  private static change(library: AssetLibrary): FileChange {
    return {
      path: ASSET_LIBRARY_PATH,
      content: `${JSON.stringify(AssetLibrarySchema.parse(library), null, 2)}\n`,
    };
  }

  async library(projectId: string): Promise<AssetLibraryView> {
    const { github, ref, type, private: isPrivate } = await this.project(projectId);
    return {
      type,
      game: type === 'unity' || type === 'unreal',
      private: isPrivate,
      library: await this.read(github, ref),
    };
  }

  private roots() {
    const settings = this.deps.repos.settings.get().assets;
    const platform = this.deps.platform ?? process.platform;
    return {
      unityStoreCache:
        settings.unityStoreCache ??
        defaultUnityStoreCache(platform, this.deps.env ?? process.env, this.deps.home ?? homedir()),
      epicVaultCache: settings.epicVaultCache ?? defaultEpicVaultCache(platform),
      folders: settings.folders,
    };
  }

  owned(): Promise<{ assets: OwnedAsset[]; notes: string[] }> {
    return scanOwned(this.roots());
  }

  /** Asset possédé désigné par sa clé, seulement s'il est dans un dossier réglé. */
  private async ownedByKey(key: string): Promise<OwnedAsset> {
    const asset = (await this.owned()).assets.find((a) => a.key === key);
    if (!asset) throw new AssetError('Asset introuvable dans les dossiers d’assets réglés.');
    return asset;
  }

  async measure(key: string): Promise<{ files: number; size: number }> {
    const asset = await this.ownedByKey(key);
    if (asset.kind === 'unitypackage' || asset.kind === 'file')
      return { files: 1, size: asset.size ?? 0 };
    const list = await listFiles(
      asset.kind === 'unreal-content' ? join(asset.path, 'data', 'Content') : asset.path,
    );
    return { files: list.length, size: list.reduce((s, f) => s + f.size, 0) };
  }

  /**
   * Recherche dans une bibliothèque gratuite. Les vignettes sont téléchargées ici et rendues en
   * `data:` : la CSP du cockpit n'autorise aucune image distante.
   */
  async search(source: FreeSource, query: string, type: FreeAssetType): Promise<FreeAsset[]> {
    const fetchFn = this.deps.fetch ?? fetch;
    const results = await searchFree(fetchFn, source, query, type);
    return Promise.all(
      results.map(async (r) => {
        if (r.thumbnail === null || !r.thumbnail.startsWith('https://'))
          return { ...r, thumbnail: null };
        try {
          const response = await fetchFn(r.thumbnail, { signal: AbortSignal.timeout(15_000) });
          const mime = response.headers.get('content-type') ?? '';
          if (!response.ok || !/^image\/(png|jpeg|webp)/.test(mime))
            return { ...r, thumbnail: null };
          const data = Buffer.from(await response.arrayBuffer()).toString('base64');
          return { ...r, thumbnail: `data:${mime.split(';')[0] ?? 'image/png'};base64,${data}` };
        } catch {
          return { ...r, thumbnail: null };
        }
      }),
    );
  }

  async addLink(input: {
    projectId: string;
    url: string;
    name: string;
    license: AssetLicense;
    note?: string | undefined;
  }): Promise<AssetEntry> {
    const { github, ref, type } = await this.project(input.projectId);
    if (type !== 'unity' && type !== 'unreal')
      throw new AssetError('Bibliothèque d’assets réservée aux projets de jeu (Unity, Unreal).');
    const library = await this.read(github, ref);
    const entry: AssetEntry = {
      id: uniqueId(assetSlug(input.name), library),
      name: input.name,
      origin: 'store-link',
      status: 'wanted',
      license: input.license,
      url: input.url,
      ...(input.note ? { note: input.note } : {}),
      addedAt: this.now(),
    };
    await github.commitFiles(ref, {
      branch: MAIN,
      message: `docs(assets): ${input.name} à acquérir`,
      changes: [AssetService.change({ version: 1, assets: [...library.assets, entry] })],
    });
    return entry;
  }

  /** Retire un asset de la bibliothèque ; les fichiers déjà versés restent dans le dépôt. */
  async remove(projectId: string, id: string): Promise<{ commitSha: string }> {
    const { github, ref } = await this.project(projectId);
    const library = await this.read(github, ref);
    const entry = library.assets.find((a) => a.id === id);
    if (!entry) throw new AssetError(`Asset inconnu : ${id}.`);
    return {
      commitSha: await github.commitFiles(ref, {
        branch: MAIN,
        message: `docs(assets): retrait de ${entry.name} de la bibliothèque`,
        changes: [
          AssetService.change({ version: 1, assets: library.assets.filter((a) => a.id !== id) }),
        ],
      }),
    };
  }

  /** Fichiers de l'asset à leur chemin dans le dépôt, et son dossier. */
  private async gather(
    input: AssetImportInput,
    type: 'unity' | 'unreal',
    id: string,
  ): Promise<{ files: FileToCommit[]; root: string; origin: AssetEntry['origin'] }> {
    const base = `${type === 'unity' ? 'Assets' : 'SourceArt'}/ThirdParty/${id}`;
    if (input.from.kind === 'free') {
      const downloaded = await downloadFree(
        this.deps.fetch ?? fetch,
        input.from.source,
        input.from.id,
        input.from.type,
        input.from.resolution,
      );
      return {
        files: downloaded.map((f) => ({ path: `${base}/${f.relative}`, data: f.data })),
        root: base,
        origin: input.from.source,
      };
    }
    const asset = await this.ownedByKey(input.from.key);
    if (asset.engine !== null && asset.engine !== type)
      throw new AssetError(
        asset.engine === 'unity'
          ? 'Package Unity : il ne peut être versé que dans un projet Unity.'
          : 'Contenu Unreal : il ne peut être versé que dans un projet Unreal.',
      );
    if (asset.kind === 'unitypackage') {
      const files = extractUnityPackage(await readLocal(asset.path));
      // Dossier commun des vrais fichiers (les .meta de dossiers parents ne comptent pas).
      const real = files.map((f) => f.path).filter((p) => !p.endsWith('.meta'));
      return {
        files,
        root: commonDirectory(real.length > 0 ? real : files.map((f) => f.path)),
        origin: asset.origin,
      };
    }
    if (asset.kind === 'file')
      return {
        files: [{ path: `${base}/${basename(asset.path)}`, data: await readLocal(asset.path) }],
        root: base,
        origin: asset.origin,
      };
    const dir = asset.kind === 'unreal-content' ? join(asset.path, 'data', 'Content') : asset.path;
    const files: FileToCommit[] = [];
    for (const f of await listFiles(dir))
      files.push({
        // Contenu Unreal : chemins sous Content/ gardés, sinon ses références se cassent.
        path: asset.kind === 'unreal-content' ? `Content/${f.relative}` : `${base}/${f.relative}`,
        data: await readLocal(join(dir, ...f.relative.split('/'))),
      });
    return {
      files,
      root: asset.kind === 'unreal-content' ? commonDirectory(files.map((f) => f.path)) : base,
      origin: asset.origin,
    };
  }

  async import(input: AssetImportInput): Promise<AssetImportResult> {
    const { github, ref, type, private: isPrivate } = await this.project(input.projectId);
    if (type !== 'unity' && type !== 'unreal')
      throw new AssetError('Bibliothèque d’assets réservée aux projets de jeu (Unity, Unreal).');
    const warnings: string[] = [];
    if (isRestrictedLicense(input.license) && !isPrivate) {
      if (!input.acknowledgePublicLicense) throw new AssetLicenseError(input.license);
      warnings.push(
        `Licence « ${ASSET_LICENSE_LABELS[input.license]} » versée dans un dépôt public, confirmé par Kia.`,
      );
    }
    const library = await this.read(github, ref);
    const replaced =
      input.replaces === undefined
        ? undefined
        : library.assets.find((a) => a.id === input.replaces);
    if (input.replaces !== undefined && replaced?.status !== 'wanted')
      throw new AssetError(`Lien de boutique à remplir introuvable : ${input.replaces}.`);
    const id = replaced?.id ?? uniqueId(assetSlug(input.name), library);

    const { files, root, origin } = await this.gather(input, type, id);
    if (files.length === 0) throw new AssetError('Asset vide : aucun fichier à verser.');
    const tooBig = files.find((f) => f.data.byteLength > LFS_FILE_MAX);
    if (tooBig)
      throw new AssetError(`Fichier trop gros pour Git LFS (2 Go au plus) : ${tooBig.path}.`);
    const size = files.reduce((s, f) => s + f.data.byteLength, 0);
    if (size > LARGE_IMPORT)
      warnings.push(
        `Asset volumineux (${formatSize(size)}) : le stockage Git LFS gratuit de GitHub est de 1 Go.`,
      );

    // Binaires en Git LFS ; une extension binaire inconnue rejoint .gitattributes.
    const covered = new Set(lfsExtensions(type));
    const extra = new Set<string>();
    const changes: FileChange[] = [];
    const lfs: FileToCommit[] = [];
    for (const file of files) {
      const ext = extname(file.path).slice(1).toLowerCase();
      const binary = isBinary(file.data);
      if (covered.has(ext) || (binary && ext !== '' && /^[a-z0-9]+$/.test(ext))) {
        lfs.push(file);
        if (!covered.has(ext)) extra.add(ext);
        continue;
      }
      let text: string | null = null;
      if (!binary)
        try {
          text = utf8.decode(file.data);
        } catch {
          text = null;
        }
      changes.push(
        text === null
          ? {
              path: file.path,
              content: Buffer.from(file.data).toString('base64'),
              encoding: 'base64',
            }
          : { path: file.path, content: text },
      );
    }
    for (let start = 0; start < lfs.length;) {
      const batch: FileToCommit[] = [];
      let bytes = 0;
      while (start < lfs.length && (batch.length === 0 || bytes < LFS_BATCH_BYTES)) {
        const next = lfs[start];
        if (next === undefined) break;
        batch.push(next);
        bytes += next.data.byteLength;
        start += 1;
      }
      const pointers = await github.uploadLfsObjects(
        ref,
        batch.map((f) => f.data),
      );
      batch.forEach((f, i) => {
        const pointer = pointers[i];
        if (pointer) changes.push({ path: f.path, content: lfsPointerText(pointer) });
      });
    }
    if (extra.size > 0) {
      const current = (await github.getFile(ref, '.gitattributes', MAIN))?.content ?? null;
      const wanted = [...extra]
        .sort()
        .map((e) => `*.${e} filter=lfs diff=lfs merge=lfs -text`)
        .join('\n');
      changes.push({ path: '.gitattributes', content: mergeGitattributes(current, `${wanted}\n`) });
    }

    const url = input.url ?? replaced?.url ?? undefined;
    const entry: AssetEntry = {
      id,
      name: input.name,
      origin: replaced ? 'store-link' : origin,
      status: 'imported',
      license: input.license,
      ...(input.attribution ? { attribution: input.attribution } : {}),
      ...(url !== undefined ? { url } : {}),
      path: root,
      files: files.length,
      size,
      ...(replaced?.note ? { note: replaced.note } : {}),
      addedAt: replaced?.addedAt ?? this.now(),
    };
    const others = library.assets.filter((a) => a.id !== id);
    const commitSha = await github.commitFiles(ref, {
      branch: MAIN,
      message: `feat(assets): ${input.name} (${String(files.length)} fichiers)`,
      changes: [...changes, AssetService.change({ version: 1, assets: [...others, entry] })],
    });

    // Tâche d'intégration, une fois les fichiers sur main.
    let task: AssetImportResult['task'] = null;
    try {
      const created = await this.deps.adhoc.create(integrationTask(input.projectId, type, entry));
      task = { taskId: created.taskId, issueNumber: created.issueNumber, url: created.url };
      warnings.push(...created.warnings);
      const withIssue: AssetEntry = { ...entry, integrationIssue: created.issueNumber };
      await github.commitFiles(ref, {
        branch: MAIN,
        message: `docs(assets): tâche d’intégration de ${input.name}`,
        changes: [AssetService.change({ version: 1, assets: [...others, withIssue] })],
      });
      return { entry: withIssue, commitSha, task, warnings };
    } catch (error) {
      warnings.push(
        `Tâche d’intégration non créée : ${error instanceof Error ? error.message : String(error)}`,
      );
      return { entry, commitSha, task, warnings };
    }
  }
}

/** Tâche ad hoc qui importe et câble l'asset versé dans le moteur, via le pont. */
export function integrationTask(projectId: string, type: 'unity' | 'unreal', entry: AssetEntry) {
  const credits =
    entry.license === 'cc-by'
      ? ` Licence CC-BY : ajoute l’attribution dans \`CREDITS.md\`${entry.attribution ? ` (« ${entry.attribution} »)` : ''}.`
      : '';
  const description =
    type === 'unity'
      ? `L’asset « ${entry.name} » (${entry.license}) a été versé dans \`${entry.path ?? ''}\` (${String(entry.files ?? 0)} fichiers). Vérifie son import dans Unity via le pont : réglages d’import (échelle, matériaux, compression), prefabs prêts à l’emploi dans ce dossier, aucune erreur ni référence manquante dans la console. Ne réécris pas les fichiers versés, sauf pour corriger leur import.${credits}`
      : `L’asset « ${entry.name} » (${entry.license}) a été versé dans \`${entry.path ?? ''}\` (${String(entry.files ?? 0)} fichiers). Via le pont, importe les sources dans \`Content/ThirdParty/${entry.id}\` (ou vérifie le contenu Unreal déjà sous Content/) : réglages d’import (échelle, matériaux, collisions), aucune erreur ni référence manquante. Ne réécris pas les fichiers versés.${credits}`;
  return {
    projectId,
    title: `Intégrer l’asset « ${entry.name} »`,
    description,
    kind: 'config' as const,
    profile: type,
    complexity: (entry.files ?? 0) > 200 ? ('M' as const) : ('S' as const),
    acceptanceCriteria: [
      'L’asset s’ouvre dans l’éditeur sans erreur ni référence manquante.',
      type === 'unity'
        ? 'Des prefabs prêts à l’emploi existent dans son dossier.'
        : 'Les assets importés sont sous Content/ThirdParty.',
      ...(entry.license === 'cc-by' ? ['L’attribution figure dans CREDITS.md.'] : []),
    ].join('\n'),
    tests: '',
    testCategory: 'integration' as const,
    codeZones: entry.path ?? '',
    scopePaths: [
      `${entry.path ?? `ThirdParty/${entry.id}`}/**`,
      ...(type === 'unreal' ? [`Content/ThirdParty/${entry.id}/**`] : []),
      ...(entry.license === 'cc-by' ? ['CREDITS.md'] : []),
    ].join('\n'),
    scopeTools: '',
    dependencies: [],
    priority: false,
  };
}
