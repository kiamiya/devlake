import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EDITORS, type EditorId } from 'shared';
import { useState } from 'react';
import type { DiscoveredMcp } from '../../../shared/ipc-contract.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/primitives.js';
import { EDITOR_LABELS } from '../../hooks/bridge.js';
import { invoke } from '../../lib/ipc.js';

const KIND_LABELS: Record<DiscoveredMcp['kind'], string> = {
  stdio: 'commande',
  http: 'HTTP local',
  hint: 'piste',
};

interface Choice {
  checked: boolean;
  name: string;
  editor: EditorId | '';
}

/**
 * Détection des serveurs MCP du poste (clients MCP, projets des clones, serveurs en cours), puis
 * ajout des serveurs cochés aux ponts : secrets au coffre, pont redémarré, outils autorisés.
 */
export function McpDetect() {
  const client = useQueryClient();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const detect = useMutation({
    mutationFn: () => invoke('mcp:detect'),
    onSuccess: (servers) => {
      setChoices(
        Object.fromEntries(
          servers.map((s) => [
            s.id,
            {
              checked: s.importable && s.alreadyConfigured === null && s.editor !== null,
              name: s.name,
              editor: s.editor ?? '',
            },
          ]),
        ),
      );
    },
  });
  const apply = useMutation({
    mutationFn: (selections: { id: string; editor: EditorId; name: string }[]) =>
      invoke('mcp:import', { selections }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['settings'] });
      await client.invalidateQueries({ queryKey: ['bridge'] });
    },
  });
  const servers = detect.data ?? [];
  const selections = servers.flatMap((s) => {
    const c = choices[s.id];
    return c?.checked && c.editor !== '' && s.importable
      ? [{ id: s.id, editor: c.editor, name: c.name }]
      : [];
  });
  const update = (id: string, patch: Partial<Choice>) => {
    setChoices((all) => {
      const current = all[id];
      return current ? { ...all, [id]: { ...current, ...patch } } : all;
    });
  };

  return (
    <section
      aria-label="Détection des serveurs MCP"
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={detect.isPending}
          onClick={() => {
            apply.reset();
            detect.mutate();
          }}
        >
          {detect.isPending ? 'Détection en cours…' : 'Détecter les MCP du poste'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Claude Code, Claude Desktop, Cursor, VS Code, Windsurf ; paquets MCP des clones d’éditeur
          ; serveurs HTTP locaux qui répondent. Rien n’est ajouté sans ta confirmation.
        </p>
      </div>
      {detect.error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {detect.error.message}
        </p>
      )}
      {detect.isSuccess && servers.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucun serveur MCP trouvé sur le poste.</p>
      )}
      {servers.length > 0 && (
        <>
          <ul aria-label="Serveurs MCP trouvés" className="flex flex-col divide-y divide-border">
            {servers.map((s) => {
              const c = choices[s.id];
              const disabled = !s.importable || s.alreadyConfigured !== null;
              return (
                <li key={s.id} className="flex flex-col gap-1 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`Ajouter ${s.name}`}
                      disabled={disabled}
                      checked={c?.checked === true && !disabled}
                      onChange={(e) => {
                        update(s.id, { checked: e.target.checked });
                      }}
                    />
                    <Input
                      aria-label={`Nom de ${s.name}`}
                      className="h-8 w-40"
                      disabled={disabled}
                      value={c?.name ?? s.name}
                      onChange={(e) => {
                        update(s.id, { name: e.target.value });
                      }}
                    />
                    <select
                      aria-label={`Éditeur de ${s.name}`}
                      className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                      disabled={disabled}
                      value={c?.editor ?? ''}
                      onChange={(e) => {
                        update(s.id, { editor: e.target.value as EditorId | '' });
                      }}
                    >
                      <option value="">Éditeur ?</option>
                      {EDITORS.map((e) => (
                        <option key={e} value={e}>
                          {EDITOR_LABELS[e]}
                        </option>
                      ))}
                    </select>
                    <span className="rounded-full border border-border px-2 text-xs">
                      {KIND_LABELS[s.kind]}
                    </span>
                    <code className="truncate text-xs" title={s.summary}>
                      {s.summary}
                    </code>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {s.sources.join(' ; ')}
                    {s.secrets.length > 0 &&
                      ` · ${String(s.secrets.length)} secret(s) (${s.secrets.join(', ')}) rangé(s) dans le coffre du cockpit`}
                    {s.alreadyConfigured !== null &&
                      ` · déjà configuré pour ${EDITOR_LABELS[s.alreadyConfigured]}`}
                  </p>
                  {s.reason !== null && <p className="text-xs text-warning">{s.reason}</p>}
                </li>
              );
            })}
          </ul>
          <p role="note" className="rounded-md bg-warning/15 p-3 text-sm">
            Tous les outils des serveurs ajoutés seront autorisés aux agents, y compris ceux qui
            exécutent du code ou modifient le projet. Tu peux en retirer ensuite dans la liste
            blanche du pont.
          </p>
          <div>
            <Button
              type="button"
              disabled={selections.length === 0 || apply.isPending}
              onClick={() => {
                apply.mutate(selections);
              }}
            >
              {apply.isPending
                ? 'Ajout et test en cours…'
                : `Ajouter la sélection (${String(selections.length)})`}
            </Button>
          </div>
        </>
      )}
      {apply.error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {apply.error.message}
        </p>
      )}
      {apply.data && (
        <ul aria-label="Serveurs ajoutés" className="flex flex-col gap-1 text-sm">
          {apply.data.map((r) => (
            <li
              key={`${r.editor}/${r.name}`}
              className={r.connected ? 'text-success' : 'text-destructive'}
            >
              {EDITOR_LABELS[r.editor]} · {r.name}
              {r.slot === 'primary' ? ' (serveur principal)' : ''} :{' '}
              {r.connected
                ? `connecté, ${String(r.tools)} outil(s) autorisé(s)`
                : `non connecté${r.error ? ` (${r.error})` : ''}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
