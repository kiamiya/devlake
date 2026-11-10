import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ASSET_LICENSE_LABELS,
  ASSET_LICENSES,
  isRestrictedLicense,
  type AssetEntry,
  type AssetLicense,
} from 'shared';
import { useState, type FormEvent } from 'react';
import type {
  AssetImportInput,
  AssetLibraryView,
  FreeAsset,
  FreeAssetType,
  FreeSource,
  OwnedAsset,
} from '../../../shared/ipc-contract.js';
import { Button } from '../../components/ui/button.js';
import {
  Card,
  CardDescription,
  CardTitle,
  Input,
  Label,
  Textarea,
} from '../../components/ui/primitives.js';
import { invoke } from '../../lib/ipc.js';

const libraryKey = (projectId: string) => ['assets', projectId] as const;

const ORIGIN_LABELS: Record<string, string> = {
  'unity-store-cache': 'Asset Store (cache Unity)',
  'epic-vault': 'Fab / Marketplace (VaultCache)',
  folder: 'Dossier',
  'store-link': 'Lien de boutique',
  polyhaven: 'Poly Haven',
  ambientcg: 'ambientCG',
};

const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} Go`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} Mo`
      : `${String(Math.ceil(bytes / 1024))} Ko`;

function LicenseSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: AssetLicense;
  onChange: (license: AssetLicense) => void;
}) {
  return (
    <select
      id={id}
      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
      value={value}
      onChange={(e) => {
        onChange(e.target.value as AssetLicense);
      }}
    >
      {ASSET_LICENSES.map((l) => (
        <option key={l} value={l}>
          {ASSET_LICENSE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}

/** Versement d'un asset choisi : licence, attribution, avertissement public, puis import. */
function ImportForm({
  projectId,
  view,
  from,
  defaults,
  onDone,
}: {
  projectId: string;
  view: AssetLibraryView;
  from: AssetImportInput['from'];
  defaults: { name: string; license: AssetLicense; url?: string };
  onDone: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(defaults.name);
  const [license, setLicense] = useState<AssetLicense>(defaults.license);
  const [attribution, setAttribution] = useState('');
  const [replaces, setReplaces] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const wanted = view.library.assets.filter((a) => a.status === 'wanted');
  const publicWarning = !view.private && isRestrictedLicense(license);
  const importAsset = useMutation({
    mutationFn: () =>
      invoke('assets:import', {
        projectId,
        from,
        name,
        license,
        ...(attribution.trim() !== '' ? { attribution } : {}),
        ...(defaults.url !== undefined ? { url: defaults.url } : {}),
        ...(replaces !== '' ? { replaces } : {}),
        acknowledgePublicLicense: acknowledged,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: libraryKey(projectId) });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    importAsset.mutate();
  };
  const result = importAsset.data;
  return (
    <form
      onSubmit={submit}
      className="mt-2 flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="asset-name">Nom dans la bibliothèque</Label>
          <Input
            id="asset-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="asset-license">Licence</Label>
          <LicenseSelect id="asset-license" value={license} onChange={setLicense} />
        </div>
        {license === 'cc-by' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="asset-attribution">Attribution à citer</Label>
            <Input
              id="asset-attribution"
              value={attribution}
              onChange={(e) => {
                setAttribution(e.target.value);
              }}
            />
          </div>
        )}
        {from.kind === 'owned' && wanted.length > 0 && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="asset-replaces">Remplit le lien de boutique</Label>
            <select
              id="asset-replaces"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              value={replaces}
              onChange={(e) => {
                setReplaces(e.target.value);
              }}
            >
              <option value="">Aucun</option>
              {wanted.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {publicWarning && (
        <div role="note" className="rounded-md bg-warning/15 p-3 text-sm">
          Dépôt public : ces fichiers seront visibles de tous, ce que cette licence interdit
          probablement (Asset Store, Fab et la plupart des assets payants).
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => {
                setAcknowledged(e.target.checked);
              }}
            />
            Je confirme verser cet asset dans un dépôt public
          </label>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={
            name.trim() === '' ||
            importAsset.isPending ||
            (publicWarning && !acknowledged) ||
            result !== undefined
          }
        >
          {importAsset.isPending ? 'Versement en cours…' : 'Verser dans le projet'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Fermer
        </Button>
      </div>
      {importAsset.error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {importAsset.error.message}
        </p>
      )}
      {result && (
        <div role="status" className="text-sm text-success">
          Versé dans <code>{result.entry.path}</code> ({String(result.entry.files ?? 0)} fichiers,{' '}
          {formatSize(result.entry.size ?? 0)}).
          {result.task && (
            <>
              {' '}
              Tâche d’intégration {result.task.taskId} (issue #{result.task.issueNumber}).
            </>
          )}
          {result.warnings.map((w) => (
            <p key={w} className="text-warning-foreground">
              {w}
            </p>
          ))}
        </div>
      )}
    </form>
  );
}

function Library({ projectId, view }: { projectId: string; view: AssetLibraryView }) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => invoke('assets:remove', { projectId, id }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: libraryKey(projectId) });
    },
  });
  if (view.library.assets.length === 0)
    return <p className="text-sm text-muted-foreground">Aucun asset choisi pour l’instant.</p>;
  return (
    <ul aria-label="Bibliothèque du projet" className="flex flex-col divide-y divide-border">
      {view.library.assets.map((a: AssetEntry) => (
        <li key={a.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
          <span className="font-medium">{a.name}</span>
          <span className="rounded-full border border-border px-2 text-xs">
            {a.status === 'imported' ? 'versé' : 'à acquérir'}
          </span>
          <span className="text-xs text-muted-foreground">
            {ORIGIN_LABELS[a.origin] ?? a.origin} · {a.license}
            {a.path !== undefined && (
              <>
                {' '}
                · <code>{a.path}</code>
              </>
            )}
            {a.integrationIssue !== undefined && <> · intégration #{a.integrationIssue}</>}
          </span>
          {a.url !== undefined && (
            <a href={a.url} target="_blank" rel="noreferrer" className="text-xs underline">
              page
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate(a.id);
            }}
          >
            Retirer {a.name}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function StoreLink({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [license, setLicense] = useState<AssetLicense>('store');
  const [note, setNote] = useState('');
  const add = useMutation({
    mutationFn: () =>
      invoke('assets:add-link', {
        projectId,
        url: url.trim(),
        name,
        license,
        ...(note.trim() !== '' ? { note } : {}),
      }),
    onSuccess: async () => {
      setUrl('');
      setName('');
      setNote('');
      await client.invalidateQueries({ queryKey: libraryKey(projectId) });
    },
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="store-url">Lien de l’asset</Label>
          <Input
            id="store-url"
            placeholder="https://assetstore.unity.com/packages/… ou https://www.fab.com/listings/…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="store-name">Nom</Label>
          <Input
            id="store-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="store-license">Licence</Label>
          <LicenseSelect id="store-license" value={license} onChange={setLicense} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="store-note">Note (usage prévu)</Label>
          <Textarea
            id="store-note"
            className="font-sans text-sm"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
        </div>
      </div>
      <div>
        <Button type="submit" disabled={url.trim() === '' || name.trim() === '' || add.isPending}>
          Ajouter à la bibliothèque
        </Button>
      </div>
      {add.error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {add.error.message}
        </p>
      )}
    </form>
  );
}

function OwnedAssets({ projectId, view }: { projectId: string; view: AssetLibraryView }) {
  const [shown, setShown] = useState(false);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<OwnedAsset | null>(null);
  const owned = useQuery({
    queryKey: ['assets', 'owned'],
    queryFn: () => invoke('assets:owned'),
    enabled: shown,
  });
  const measure = useMutation({ mutationFn: (key: string) => invoke('assets:measure', { key }) });
  if (!shown)
    return (
      <Button
        variant="outline"
        onClick={() => {
          setShown(true);
        }}
      >
        Chercher mes assets
      </Button>
    );
  const words = filter
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const list = (owned.data?.assets ?? []).filter(
    (a) =>
      (a.engine === null || a.engine === view.type) &&
      words.every((w) => `${a.name} ${a.publisher ?? ''}`.toLowerCase().includes(w)),
  );
  return (
    <div className="flex flex-col gap-3">
      {owned.isFetching && <p className="text-sm text-muted-foreground">Recherche sur le poste…</p>}
      {owned.data?.notes.map((n) => (
        <p key={n} className="text-xs text-muted-foreground">
          {n}
        </p>
      ))}
      <Input
        aria-label="Filtrer mes assets"
        placeholder="Filtrer…"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
        }}
      />
      <ul aria-label="Mes assets" className="flex max-h-96 flex-col gap-1 overflow-y-auto">
        {list.map((a) => (
          <li key={a.key} className="rounded-md border border-border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{a.name}</span>
              <span className="text-xs text-muted-foreground">
                {ORIGIN_LABELS[a.origin]}
                {a.publisher !== null && ` · ${a.publisher}`}
                {a.size !== null && ` · ${formatSize(a.size)}`}
                {measure.variables === a.key &&
                  measure.data &&
                  ` · ${String(measure.data.files)} fichiers, ${formatSize(measure.data.size)}`}
              </span>
              {a.size === null && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    measure.mutate(a.key);
                  }}
                >
                  Taille
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => {
                  setChosen(a);
                }}
              >
                Choisir {a.name}
              </Button>
            </div>
            {chosen?.key === a.key && (
              <ImportForm
                projectId={projectId}
                view={view}
                from={{ kind: 'owned', key: a.key }}
                defaults={{
                  name: a.name,
                  license: a.origin === 'folder' ? 'unknown' : 'store',
                }}
                onDone={() => {
                  setChosen(null);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FreeLibraries({ projectId, view }: { projectId: string; view: AssetLibraryView }) {
  const [source, setSource] = useState<FreeSource>('polyhaven');
  const [type, setType] = useState<FreeAssetType>('model');
  const [query, setQuery] = useState('');
  const [resolution, setResolution] = useState<'1k' | '2k' | '4k'>('2k');
  const [chosen, setChosen] = useState<FreeAsset | null>(null);
  const search = useMutation({
    mutationFn: () => invoke('assets:search', { source, query, type }),
  });
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setChosen(null);
          search.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="free-source">Bibliothèque</Label>
          <select
            id="free-source"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            value={source}
            onChange={(e) => {
              setSource(e.target.value as FreeSource);
            }}
          >
            <option value="polyhaven">Poly Haven</option>
            <option value="ambientcg">ambientCG</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="free-type">Type</Label>
          <select
            id="free-type"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            value={type}
            onChange={(e) => {
              setType(e.target.value as FreeAssetType);
            }}
          >
            <option value="model">Modèles 3D</option>
            <option value="texture">Textures et matériaux</option>
            <option value="hdri">HDRI</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="free-resolution">Résolution</Label>
          <select
            id="free-resolution"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            value={resolution}
            onChange={(e) => {
              setResolution(e.target.value as '1k' | '2k' | '4k');
            }}
          >
            <option value="1k">1K</option>
            <option value="2k">2K</option>
            <option value="4k">4K</option>
          </select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="free-query">Recherche</Label>
          <Input
            id="free-query"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
        </div>
        <Button type="submit" disabled={search.isPending}>
          Rechercher
        </Button>
      </form>
      {search.isPending && <p className="text-sm text-muted-foreground">Recherche…</p>}
      {search.error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {search.error.message}
        </p>
      )}
      {search.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucun résultat.</p>
      )}
      <ul aria-label="Résultats gratuits" className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {search.data?.map((r) => (
          <li
            key={`${r.source}/${r.id}`}
            className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm"
          >
            {r.thumbnail !== null ? (
              <img src={r.thumbnail} alt="" className="aspect-square w-full rounded object-cover" />
            ) : (
              <div className="aspect-square w-full rounded bg-muted" />
            )}
            <span className="truncate font-medium" title={r.name}>
              {r.name}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setChosen(r);
              }}
            >
              Choisir {r.name}
            </Button>
          </li>
        ))}
      </ul>
      {chosen && (
        <ImportForm
          projectId={projectId}
          view={view}
          from={{
            kind: 'free',
            source: chosen.source,
            id: chosen.id,
            type: chosen.type,
            resolution,
          }}
          defaults={{ name: chosen.name, license: 'cc0', url: chosen.url }}
          onDone={() => {
            setChosen(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Assets d'un projet de jeu : bibliothèque du projet (vue par le planificateur et les agents),
 * assets possédés, liens de boutique, bibliothèques gratuites. Chaque versement crée une tâche
 * d'intégration dans le moteur.
 */
export function AssetsSection({ projectId }: { projectId: string }) {
  const view = useQuery({
    queryKey: libraryKey(projectId),
    queryFn: () => invoke('assets:library', { projectId }),
  });
  if (view.error instanceof Error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {view.error.message}
      </p>
    );
  if (!view.data) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (!view.data.game)
    return (
      <p role="note" className="text-sm text-muted-foreground">
        La bibliothèque d’assets sert aux projets de jeu (Unity, Unreal).
      </p>
    );
  const data = view.data;
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Bibliothèque du projet</CardTitle>
        <CardDescription>
          Vue par le planificateur et les agents. Un agent à qui il manque un asset te le demande
          par une question.
        </CardDescription>
        <Library projectId={projectId} view={data} />
      </Card>
      <Card>
        <CardTitle>Mes assets</CardTitle>
        <CardDescription>
          Cache de l’Asset Store, VaultCache d’Epic et dossiers réglés. Un asset est versé en entier
          (Git LFS), puis une tâche d’intégration est créée.
        </CardDescription>
        <OwnedAssets projectId={projectId} view={data} />
      </Card>
      <Card>
        <CardTitle>Boutiques (Asset Store, Fab)</CardTitle>
        <CardDescription>
          Pas d’API publique : colle le lien. Achète et télécharge-le dans l’éditeur ou le launcher,
          puis choisis-le dans « Mes assets » en indiquant ce lien.
        </CardDescription>
        <StoreLink projectId={projectId} />
      </Card>
      <Card>
        <CardTitle>Bibliothèques gratuites (CC0)</CardTitle>
        <CardDescription>
          Poly Haven et ambientCG : recherche et téléchargement direct.
        </CardDescription>
        <FreeLibraries projectId={projectId} view={data} />
      </Card>
    </div>
  );
}
