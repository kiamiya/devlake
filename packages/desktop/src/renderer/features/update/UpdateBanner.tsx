import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { UpdateState } from '../../../shared/ipc-contract.js';
import { Button } from '../../components/ui/button.js';
import { invoke } from '../../lib/ipc.js';

export const UPDATE_KEY = ['update'] as const;

/** État de la mise à jour ; sondé chaque seconde pendant un téléchargement. */
export function useUpdate() {
  return useQuery({
    queryKey: UPDATE_KEY,
    queryFn: () => invoke('update:status'),
    refetchInterval: (query) =>
      query.state.data?.status === 'downloading' || query.state.data?.status === 'checking'
        ? 1000
        : 60_000,
  });
}

export function useUpdateAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (
      action: { kind: 'check' | 'download' | 'install' } | { kind: 'dismiss'; version: string },
    ): Promise<UpdateState> => {
      if (action.kind === 'dismiss') return invoke('update:dismiss', { version: action.version });
      return action.kind === 'check'
        ? invoke('update:check')
        : action.kind === 'download'
          ? invoke('update:download')
          : invoke('update:install');
    },
    onSuccess: (state) => {
      client.setQueryData(UPDATE_KEY, state);
    },
  });
}

/**
 * Bandeau de mise à jour, au-dessus des onglets : version disponible et ses notes,
 * téléchargement sur clic, puis redémarrage (Windows) ou ouverture du .dmg (macOS).
 * Refermé, il réapparaît à la version suivante.
 */
export function UpdateBanner() {
  const update = useUpdate();
  const action = useUpdateAction();
  const [notesOpen, setNotesOpen] = useState(false);
  const state = update.data;
  if (!state || state.version === null) return null;
  if (!['available', 'downloading', 'downloaded', 'error'].includes(state.status)) return null;
  if (state.dismissedVersion === state.version && state.status === 'available') return null;

  return (
    <section
      aria-label="Mise à jour du cockpit"
      className="flex flex-col gap-1 border-b border-border bg-primary/10 px-4 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">
          {state.status === 'downloaded'
            ? `AgentLake ${state.version} est prêt.`
            : `AgentLake ${state.version} est disponible (version actuelle : ${state.currentVersion}).`}
        </span>
        {state.status === 'downloading' && (
          <span role="status" className="text-xs">
            Téléchargement… {String(state.progress ?? 0)} %
          </span>
        )}
        {state.status === 'error' && (
          <span role="alert" className="text-xs text-destructive">
            {state.error}
          </span>
        )}
        {state.notes !== null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setNotesOpen((open) => !open);
            }}
          >
            {notesOpen ? 'Masquer les nouveautés' : 'Voir les nouveautés'}
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          {(state.status === 'available' || state.status === 'error') && (
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => {
                action.mutate({ kind: 'download' });
              }}
            >
              Télécharger
            </Button>
          )}
          {state.status === 'downloaded' && (
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => {
                action.mutate({ kind: 'install' });
              }}
            >
              {state.manualInstall ? 'Ouvrir l’installeur' : 'Redémarrer pour mettre à jour'}
            </Button>
          )}
          {state.status !== 'downloading' && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Fermer le bandeau de mise à jour"
              onClick={() => {
                action.mutate({ kind: 'dismiss', version: state.version ?? '' });
              }}
            >
              ✕
            </Button>
          )}
        </div>
      </div>
      {state.status === 'downloaded' && (
        <p className="text-xs text-muted-foreground">
          {state.manualInstall
            ? 'Le .dmg est dans Téléchargements : ouvre-le et glisse AgentLake dans Applications (en remplaçant l’ancienne version), puis relance le cockpit.'
            : 'Sinon, la mise à jour s’installera à la fermeture du cockpit. Tes réglages, ton cache et tes secrets sont conservés.'}
        </p>
      )}
      {notesOpen && state.notes !== null && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 font-sans text-xs">
          {state.notes}
        </pre>
      )}
    </section>
  );
}

const STATUS_LABELS: Record<UpdateState['status'], string> = {
  unsupported: 'Mises à jour désactivées (version de développement).',
  idle: 'Pas encore vérifié.',
  checking: 'Vérification en cours…',
  'up-to-date': 'À jour.',
  available: 'Nouvelle version disponible.',
  downloading: 'Téléchargement en cours…',
  downloaded: 'Nouvelle version prête à installer.',
  error: 'Échec de la vérification ou du téléchargement.',
};

/** Section « Mises à jour » des Réglages : version, état, vérification manuelle. */
export function UpdateSettings() {
  const update = useUpdate();
  const action = useUpdateAction();
  const state = update.data;
  if (!state) return null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        Version installée : <span className="font-mono">{state.currentVersion}</span>
      </p>
      <p role="status">
        {STATUS_LABELS[state.status]}
        {state.version !== null && state.status !== 'up-to-date' ? ` (${state.version})` : ''}
        {state.checkedAt !== null &&
          ` Dernière vérification : ${new Date(state.checkedAt).toLocaleString('fr-FR')}.`}
      </p>
      {state.error !== null && (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={
            state.status === 'unsupported' || state.status === 'checking' || action.isPending
          }
          onClick={() => {
            action.mutate({ kind: 'check' });
          }}
        >
          Vérifier maintenant
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Vérification automatique au démarrage puis toutes les 6 heures.
      </p>
    </div>
  );
}
