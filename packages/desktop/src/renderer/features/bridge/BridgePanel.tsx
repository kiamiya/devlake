import { useState } from 'react';
import type { AuditEntryView, BridgeViewData } from '../../../shared/ipc-contract.js';
import { Button } from '../../components/ui/button.js';
import { Badge, Card, CardDescription, CardTitle, Input } from '../../components/ui/primitives.js';
import {
  useBridgeAudit,
  useBridges,
  useBridgeTools,
  useSetBridgeTools,
  useStartBridge,
  useStopBridge,
  useTunnel,
  useTunnelAction,
  type Editor,
} from '../../hooks/bridge.js';

const EDITOR_LABELS: Record<Editor, string> = { unity: 'Unity', unreal: 'Unreal' };
const OUTCOME_LABELS: Record<AuditEntryView['outcome'], string> = {
  ok: 'réussi',
  error: 'erreur',
  refused: 'refusé',
};

export function describeCall(entry: AuditEntryView): string {
  const who = entry.runId === null ? 'inconnu' : `run ${entry.runId}`;
  const what = entry.tool ?? 'accès';
  return `${what} · ${who} · ${OUTCOME_LABELS[entry.outcome]}${entry.tool === null ? '' : ` · ${String(entry.durationMs)} ms`}`;
}

/** Liste blanche : outils d'Aura (pont démarré) cochés, plus ajout manuel d'un nom. */
function Whitelist({ bridge }: { bridge: BridgeViewData }) {
  const tools = useBridgeTools(bridge.editor, true);
  const setTools = useSetBridgeTools();
  const [extra, setExtra] = useState('');
  const allowed = new Set(bridge.allowedTools);
  const save = (next: Set<string>) => {
    setTools.mutate({ editor: bridge.editor, tools: [...next] });
  };
  const list =
    tools.data ?? bridge.allowedTools.map((name) => ({ name, description: '', allowed: true }));
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-medium">
        Outils autorisés aux agents {EDITOR_LABELS[bridge.editor]}
      </legend>
      {list.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {bridge.running
            ? 'Aura ne propose aucun outil.'
            : 'Démarre le pont pour voir les outils d’Aura, ou ajoute un nom ci-dessous.'}
        </p>
      )}
      {list.map((tool) => (
        <label key={tool.name} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowed.has(tool.name)}
            disabled={setTools.isPending}
            onChange={(e) => {
              const next = new Set(allowed);
              if (e.target.checked) next.add(tool.name);
              else next.delete(tool.name);
              save(next);
            }}
          />
          <span>
            <code>{tool.name}</code>
            {tool.description !== '' && (
              <span className="text-muted-foreground"> — {tool.description}</span>
            )}
          </span>
        </label>
      ))}
      <form
        className="mt-1 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (extra.trim() === '') return;
          save(new Set([...allowed, extra.trim()]));
          setExtra('');
        }}
      >
        <Input
          aria-label={`Ajouter un outil ${EDITOR_LABELS[bridge.editor]}`}
          placeholder="nom_de_l_outil"
          className="h-8 max-w-xs text-xs"
          value={extra}
          onChange={(e) => {
            setExtra(e.target.value);
          }}
        />
        <Button type="submit" size="sm" variant="outline">
          Autoriser
        </Button>
      </form>
      {setTools.error instanceof Error && (
        <p role="alert" className="text-xs text-destructive">
          {setTools.error.message}
        </p>
      )}
    </fieldset>
  );
}

function AuditLog({ editor }: { editor: Editor }) {
  const audit = useBridgeAudit(editor, true);
  const entries = audit.data ?? [];
  return (
    <details>
      <summary className="cursor-pointer text-sm">Journal d’audit ({entries.length})</summary>
      {entries.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">Aucun appel pour l’instant.</p>
      ) : (
        <table
          aria-label={`Journal d’audit ${EDITOR_LABELS[editor]}`}
          className="mt-1 w-full text-xs"
        >
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left">Heure</th>
              <th className="text-left">Run</th>
              <th className="text-left">Outil</th>
              <th className="text-left">Durée</th>
              <th className="text-left">Résultat</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, 200).map((e, i) => (
              <tr key={`${e.at}-${String(i)}`}>
                <td>{new Date(e.at).toLocaleTimeString('fr-FR')}</td>
                <td>{e.runId === null ? '—' : `${e.repo ?? ''} #${e.runId}`}</td>
                <td>{e.tool ?? 'accès'}</td>
                <td>{e.tool === null ? '—' : `${String(e.durationMs)} ms`}</td>
                <td title={e.detail ?? undefined}>{OUTCOME_LABELS[e.outcome]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

export function BridgeCard({ bridge }: { bridge: BridgeViewData }) {
  const start = useStartBridge();
  const stop = useStopBridge();
  const error = start.error ?? stop.error;
  return (
    <section
      aria-label={`Pont ${EDITOR_LABELS[bridge.editor]}`}
      className="flex flex-col gap-3 rounded-md border border-border p-4"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{EDITOR_LABELS[bridge.editor]}</h3>
        <Badge tone={bridge.running ? 'ok' : 'absent'}>
          {bridge.running ? 'Démarré' : 'Arrêté'}
        </Badge>
        <span className="text-xs text-muted-foreground">
          127.0.0.1:{bridge.port ?? bridge.configuredPort}
        </span>
        <div className="ml-auto">
          {bridge.running ? (
            <Button
              size="sm"
              variant="outline"
              disabled={stop.isPending}
              onClick={() => {
                stop.mutate(bridge.editor);
              }}
            >
              Arrêter le pont {EDITOR_LABELS[bridge.editor]}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={start.isPending || !bridge.configured}
              onClick={() => {
                start.mutate(bridge.editor);
              }}
            >
              Démarrer le pont {EDITOR_LABELS[bridge.editor]}
            </Button>
          )}
        </div>
      </header>
      {!bridge.configured && (
        <p className="text-xs text-muted-foreground">
          Colle d’abord la configuration MCP d’Aura ({EDITOR_LABELS[bridge.editor]}) dans les
          réglages.
        </p>
      )}
      <p className="text-sm">
        {bridge.activeRun
          ? `Éditeur utilisé par le run ${bridge.activeRun.runId} (${bridge.activeRun.repo}).`
          : 'Aucun agent connecté.'}
      </p>
      <p className="text-xs text-muted-foreground">
        Dernier appel : {bridge.lastCall ? describeCall(bridge.lastCall) : 'aucun'}
      </p>
      {error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      <Whitelist bridge={bridge} />
      <AuditLog editor={bridge.editor} />
    </section>
  );
}

const PROVIDER_LABELS = { tailscale: 'Tailscale Funnel', cloudflare: 'Cloudflare Tunnel' } as const;

/** Tunnel HTTPS : état, URL publique, ouverture, fermeture et interrupteur d'arrêt. */
export function TunnelCard() {
  const tunnel = useTunnel();
  const action = useTunnelAction();
  const state = tunnel.data;
  if (!state) return null;
  const error = action.error instanceof Error ? action.error.message : state.error;
  return (
    <section
      aria-label="Tunnel"
      className="flex flex-col gap-2 rounded-md border border-border p-4"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">Tunnel ({PROVIDER_LABELS[state.provider]})</h3>
        <Badge tone={state.open ? 'ok' : state.killed ? 'degraded' : 'absent'}>
          {state.open ? 'Ouvert' : state.killed ? 'Coupé par l’interrupteur' : 'Fermé'}
        </Badge>
        <div className="ml-auto flex gap-2">
          {state.open ? (
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending}
              onClick={() => {
                action.mutate('close');
              }}
            >
              Fermer le tunnel
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => {
                action.mutate('open');
              }}
            >
              Ouvrir le tunnel
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={action.isPending}
            onClick={() => {
              action.mutate('kill');
            }}
          >
            Interrupteur d’arrêt
          </Button>
        </div>
      </header>
      {state.url !== null && (
        <p className="text-sm">
          URL publique : <code>{state.url}</code>
        </p>
      )}
      {state.projects.length > 0 && (
        <ul aria-label="Projets de jeu reliés" className="text-xs text-muted-foreground">
          {state.projects.map((p) => (
            <li key={p.id}>
              {p.id} → <code>{p.url}</code>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {state.autoExpose
          ? 'Exposition automatique : le tunnel s’ouvre seulement quand une tâche de jeu est prête ou en cours.'
          : 'Exposition manuelle : le tunnel reste ouvert jusqu’à sa fermeture.'}{' '}
        L’interrupteur coupe le tunnel et révoque les jetons des agents en cours.
      </p>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

/** Ponts Aura : démarrer, arrêter, état, dernier appel, liste blanche, audit. */
export function BridgePanel() {
  const bridges = useBridges();
  return (
    <Card>
      <CardTitle>Pont Aura</CardTitle>
      <CardDescription>
        Relaie le MCP d’Aura du poste aux agents de jeu, sur 127.0.0.1, derrière un jeton signé et
        une liste blanche d’outils. Un seul agent à la fois par éditeur.
      </CardDescription>
      {bridges.error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {bridges.error.message}
        </p>
      )}
      <div className="mt-3 flex flex-col gap-4">
        <TunnelCard />
        {bridges.data?.map((b) => (
          <BridgeCard key={b.editor} bridge={b} />
        ))}
      </div>
    </Card>
  );
}
