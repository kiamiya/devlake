import { EDITORS, PROFILE_IDS, type EditorId as Editor, type ProfileId } from 'shared';

import { useEffect, useState, type FormEvent } from 'react';
import type { Settings } from '../../shared/settings.js';
import {
  useClearToken,
  useMaskedToken,
  useSetToken,
  useSettings,
  useTestToken,
  useUpdateSettings,
} from '../hooks/queries.js';
import { BridgePanel } from '../features/bridge/BridgePanel.js';
import { McpGuide } from '../features/bridge/McpGuide.js';
import { McpDetect } from '../features/bridge/McpDetect.js';
import { EDITOR_LABELS } from '../hooks/bridge.js';
import { ClaudeTokenSection } from './ClaudeTokenSection.js';
import { Button } from './ui/button.js';
import { Card, CardDescription, CardTitle, Input, Label, Textarea } from './ui/primitives.js';

type ExtraServers = Settings['extraMcp']['unity'];

/**
 * Autres serveurs MCP du pont d'un éditeur (Unity MCP, Unreal MCP…) : nom (préfixe des
 * outils, ex. `unity__…`) et configuration collée (commande stdio ou URL locale).
 */
function ExtraMcpServers({
  editor,
  servers,
  onChange,
}: {
  editor: Editor;
  servers: ExtraServers;
  onChange: (servers: ExtraServers) => void;
}) {
  const label = EDITOR_LABELS[editor];
  const update = (index: number, patch: Partial<ExtraServers[number]>) => {
    onChange(servers.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
      <legend className="px-1 text-sm">Autres serveurs MCP — {label}</legend>
      <p className="text-xs text-muted-foreground">
        Relayés par le même pont ; leurs outils sont proposés aux agents sous le nom «
        serveur__outil », à autoriser dans la liste blanche.
      </p>
      {servers.map((server, index) => (
        <div key={index} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Input
              aria-label={`Nom du serveur MCP ${String(index + 1)} (${label})`}
              placeholder="unity"
              value={server.name}
              onChange={(e) => {
                update(index, { name: e.target.value.trim().toLowerCase() });
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                onChange(servers.filter((_, i) => i !== index));
              }}
            >
              Retirer {server.name || 'le serveur'}
            </Button>
          </div>
          <Textarea
            aria-label={`Configuration du serveur MCP ${String(index + 1)} (${label})`}
            placeholder='{ "command": "uvx", "args": ["mcp-unity"] } ou { "url": "http://127.0.0.1:6400/mcp" }'
            value={server.config}
            onChange={(e) => {
              update(index, { config: e.target.value });
            }}
          />
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        disabled={servers.length >= 8}
        onClick={() => {
          onChange([...servers, { name: '', config: '' }]);
        }}
      >
        Ajouter un serveur MCP ({label})
      </Button>
    </fieldset>
  );
}

function Feedback({ error, success }: { error: unknown; success?: string | undefined }) {
  if (error instanceof Error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  }
  if (success) {
    return (
      <p role="status" className="text-sm text-success">
        {success}
      </p>
    );
  }
  return null;
}

function TokenSection() {
  const { data } = useMaskedToken();
  const setToken = useSetToken();
  const clearToken = useClearToken();
  const testToken = useTestToken();
  const [value, setValue] = useState('');

  const save = (event: FormEvent) => {
    event.preventDefault();
    setToken.mutate(value, {
      onSuccess: () => {
        setValue('');
      },
    });
  };

  const testedLogin = testToken.data as { login: string } | undefined;

  return (
    <Card>
      <CardTitle>Jeton GitHub</CardTitle>
      <CardDescription>
        Jeton à granularité fine, chiffré par le coffre du système. Il n’est jamais affiché en
        clair.
      </CardDescription>
      <p className="mb-4 text-sm">
        Jeton enregistré :{' '}
        <span data-testid="masked-token" className="font-mono">
          {data?.masked ?? 'aucun'}
        </span>
      </p>
      <form onSubmit={save} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-72 flex-1 flex-col gap-2">
          <Label htmlFor="token">Nouveau jeton GitHub</Label>
          <Input
            id="token"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </div>
        <Button type="submit" disabled={value.trim() === '' || setToken.isPending}>
          Enregistrer le jeton GitHub
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!data?.masked || testToken.isPending}
          onClick={() => {
            testToken.mutate(undefined);
          }}
        >
          Tester
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!data?.masked}
          onClick={() => {
            clearToken.mutate(undefined);
          }}
        >
          Supprimer
        </Button>
      </form>
      <div className="mt-3">
        <Feedback
          error={setToken.error ?? testToken.error ?? clearToken.error}
          success={testedLogin ? `Jeton valide : compte ${testedLogin.login}.` : undefined}
        />
      </div>
    </Card>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const update = useUpdateSettings();
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setForm(initial);
  }, [initial]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const setModel = (profile: ProfileId, model: string) => {
    const others = Object.entries(form.modelsByProfile).filter(([key]) => key !== profile);
    const next = model.trim() === '' ? others : [...others, [profile, model]];
    set('modelsByProfile', Object.fromEntries(next) as Settings['modelsByProfile']);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(form, {
      onSuccess: () => {
        setSaved(true);
      },
    });
  };

  const number = (text: string) => (text === '' ? Number.NaN : Number(text));

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Card>
        <CardTitle>Compte et agents</CardTitle>
        <CardDescription>Plafonds appliqués à tous les projets.</CardDescription>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="githubAccount">Compte GitHub</Label>
            <Input
              id="githubAccount"
              value={form.githubAccount}
              onChange={(e) => {
                set('githubAccount', e.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="maxConcurrentAgents">Agents simultanés (plafond global)</Label>
            <Input
              id="maxConcurrentAgents"
              type="number"
              min={1}
              value={Number.isNaN(form.maxConcurrentAgents) ? '' : form.maxConcurrentAgents}
              onChange={(e) => {
                set('maxConcurrentAgents', number(e.target.value));
              }}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              id="globalPaused"
              type="checkbox"
              checked={form.globalPaused}
              onChange={(e) => {
                set('globalPaused', e.target.checked);
              }}
            />
            <span>
              Pause globale : aucun agent lancé, tous projets confondus (les agents en cours
              finissent).
            </span>
          </label>
          <div className="flex flex-col gap-2">
            <Label htmlFor="maxAttempts">Tentatives avant escalade</Label>
            <Input
              id="maxAttempts"
              type="number"
              min={1}
              value={Number.isNaN(form.maxAttempts) ? '' : form.maxAttempts}
              onChange={(e) => {
                set('maxAttempts', number(e.target.value));
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="workflowsVersion">Version des workflows devlake</Label>
            <Input
              id="workflowsVersion"
              value={form.workflowsVersion}
              onChange={(e) => {
                set('workflowsVersion', e.target.value);
              }}
            />
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>Modèles par profil</CardTitle>
        <CardDescription>
          Aucun modèle n’est imposé : laisser vide tant qu’un profil n’est pas utilisé.
        </CardDescription>
        <div className="mb-4 flex flex-col gap-2 md:w-1/3">
          <Label htmlFor="plannerModel">Modèle du planificateur</Label>
          <Input
            id="plannerModel"
            value={form.plannerModel ?? ''}
            onChange={(e) => {
              set('plannerModel', e.target.value.trim() === '' ? null : e.target.value);
            }}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {PROFILE_IDS.map((profile) => (
            <div key={profile} className="flex flex-col gap-2">
              <Label htmlFor={`model-${profile}`}>{profile}</Label>
              <Input
                id={`model-${profile}`}
                value={form.modelsByProfile[profile] ?? ''}
                onChange={(e) => {
                  setModel(profile, e.target.value);
                }}
              />
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardTitle>Assets possédés</CardTitle>
        <CardDescription>
          Où le cockpit cherche tes assets pour les projets de jeu. Caches vides : emplacements par
          défaut de Unity et du launcher Epic.
        </CardDescription>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="unityStoreCache">Cache de l’Asset Store (Unity)</Label>
            <Input
              id="unityStoreCache"
              placeholder="%APPDATA%\Unity\Asset Store-5.x"
              value={form.assets.unityStoreCache ?? ''}
              onChange={(e) => {
                set('assets', {
                  ...form.assets,
                  unityStoreCache: e.target.value.trim() === '' ? null : e.target.value,
                });
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="epicVaultCache">VaultCache du launcher Epic (Fab, Unreal)</Label>
            <Input
              id="epicVaultCache"
              placeholder="C:\ProgramData\Epic\EpicGamesLauncher\VaultCache"
              value={form.assets.epicVaultCache ?? ''}
              onChange={(e) => {
                set('assets', {
                  ...form.assets,
                  epicVaultCache: e.target.value.trim() === '' ? null : e.target.value,
                });
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="assetFolders">Dossiers d’assets (un par ligne)</Label>
            <Textarea
              id="assetFolders"
              className="font-mono text-xs"
              value={form.assets.folders.join('\n')}
              onChange={(e) => {
                set('assets', {
                  ...form.assets,
                  folders: e.target.value.split(/\r?\n/).filter((l) => l.trim() !== ''),
                });
              }}
            />
            <p className="text-xs text-muted-foreground">
              Chaque sous-dossier est un asset, ainsi que chaque fichier reconnu (modèle, texture,
              son, .blend, .unitypackage).
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>Éditeurs et Aura</CardTitle>
        <CardDescription>
          Blocs JSON copiés depuis l’écran « MCP Configuration » d’Aura, collés tels quels, ou
          trouvés par la détection.
        </CardDescription>
        <div className="flex flex-col gap-4">
          <McpDetect />
          <div className="flex flex-col gap-2">
            <Label htmlFor="editorClonesDir">Dossier des clones d’éditeur</Label>
            <Input
              id="editorClonesDir"
              value={form.editorClonesDir ?? ''}
              onChange={(e) => {
                set('editorClonesDir', e.target.value.trim() === '' ? null : e.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="unrealEditorCmd">Chemin d’UnrealEditor-Cmd</Label>
            <Input
              id="unrealEditorCmd"
              placeholder="C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
              value={form.unrealEditorCmd ?? ''}
              onChange={(e) => {
                set('unrealEditorCmd', e.target.value.trim() === '' ? null : e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Tests d’automatisation Unreal lancés par la CI via le pont, sur le clone dédié.
            </p>
          </div>
          {EDITORS.map((editor) => (
            <div key={editor} className="flex flex-col gap-2">
              <McpGuide editor={editor} />
              <Label htmlFor={`aura-${editor}`}>
                {editor === 'blender'
                  ? 'Configuration MCP Blender (blender-mcp)'
                  : `Configuration MCP Aura — ${EDITOR_LABELS[editor]}`}
              </Label>
              <Textarea
                id={`aura-${editor}`}
                value={form.auraMcp[editor] ?? ''}
                onChange={(e) => {
                  set('auraMcp', {
                    ...form.auraMcp,
                    [editor]: e.target.value.trim() === '' ? null : e.target.value,
                  });
                }}
              />
              <ExtraMcpServers
                editor={editor}
                servers={form.extraMcp[editor]}
                onChange={(servers) => {
                  set('extraMcp', { ...form.extraMcp, [editor]: servers });
                }}
              />
            </div>
          ))}
        </div>
      </Card>

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={update.isPending}>
          Enregistrer les réglages
        </Button>
        <Feedback error={update.error} success={saved ? 'Réglages enregistrés.' : undefined} />
      </div>
    </form>
  );
}

export function SettingsPage() {
  const { data, error } = useSettings();
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">Réglages</h1>
      <TokenSection />
      <ClaudeTokenSection />
      {data ? <SettingsForm initial={data} /> : <Feedback error={error} />}
      <BridgePanel />
    </div>
  );
}
