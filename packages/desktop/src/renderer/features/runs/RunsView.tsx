import { useState } from 'react';
import type { DashboardView } from '../../../shared/ipc-contract.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/primitives.js';
import { useDashboard, useRunLogs, useRunTranscript } from '../../hooks/dashboard.js';
import { VirtualLog } from './VirtualLog.js';

type Run = DashboardView['runs'][number];

export function formatMinutes(minutes: number): string {
  if (minutes < 1) return `${String(Math.round(minutes * 60))} s`;
  if (minutes < 60) return `${String(Math.round(minutes))} min`;
  return `${String(Math.floor(minutes / 60))} h ${String(Math.round(minutes % 60))} min`;
}

function outcome(run: Run): { label: string; tone: 'ok' | 'degraded' | 'absent' } {
  if (run.status !== 'completed') return { label: 'En cours', tone: 'absent' };
  if (run.conclusion === 'success') return { label: 'Réussi', tone: 'ok' };
  return {
    label: run.conclusion === null ? 'Terminé' : `Échec (${run.conclusion})`,
    tone: 'degraded',
  };
}

/** Tableau des runs en cours et passés : profil, tâche, durée, tentative, conclusion, liens. */
export function RunsTable({
  dashboard,
  selected,
  onSelect,
}: {
  dashboard: DashboardView;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  if (dashboard.runs.length === 0)
    return <p className="text-sm text-muted-foreground">Aucun run pour l’instant.</p>;
  return (
    <table aria-label="Runs" className="w-full text-left text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="py-1">Run</th>
          <th>Tâche</th>
          <th>Profil</th>
          <th>Tentative</th>
          <th>Durée</th>
          <th>Conclusion</th>
          <th>Liens</th>
        </tr>
      </thead>
      <tbody>
        {dashboard.runs.map((run) => {
          const status = outcome(run);
          const pr = run.taskId === null ? undefined : dashboard.pullRequests[run.taskId];
          return (
            <tr
              key={run.id}
              aria-selected={selected === run.id}
              className={selected === run.id ? 'bg-muted' : 'hover:bg-muted/50'}
            >
              <td className="py-1">
                <button
                  type="button"
                  className="text-left underline-offset-2 hover:underline"
                  onClick={() => {
                    onSelect(run.id);
                  }}
                >
                  {run.name}
                </button>
              </td>
              <td>{run.taskId ?? '—'}</td>
              <td>{run.profile ?? '—'}</td>
              <td>{run.attempt ?? '—'}</td>
              <td>{formatMinutes(run.minutes)}</td>
              <td>
                <Badge tone={status.tone}>{status.label}</Badge>
              </td>
              <td className="flex gap-2 py-1 text-xs">
                <a href={run.url} target="_blank" rel="noreferrer" className="underline">
                  run
                </a>
                {run.issueNumber !== null && (
                  <a
                    href={`${dashboard.repositoryUrl}/issues/${String(run.issueNumber)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    issue
                  </a>
                )}
                {pr && (
                  <>
                    <a href={pr.url} target="_blank" rel="noreferrer" className="underline">
                      PR #{pr.number}
                    </a>
                    <a
                      href={`${pr.url}/checks`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      checks
                    </a>
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Journal et transcription d'un run, lus à la demande sur GitHub. */
function RunDetail({ projectId, run }: { projectId: string; run: Run }) {
  const [view, setView] = useState<'logs' | 'transcript'>('logs');
  const logs = useRunLogs(projectId, run.id);
  const transcript = useRunTranscript(projectId, run.id, view === 'transcript');
  const error = view === 'logs' ? logs.error : transcript.error;
  return (
    <section aria-label={`Détail du run ${String(run.id)}`} className="flex flex-col gap-2">
      <div className="flex gap-2">
        {(['logs', 'transcript'] as const).map((v) => (
          <Button
            key={v}
            size="sm"
            aria-pressed={view === v}
            variant={view === v ? 'default' : 'outline'}
            onClick={() => {
              setView(v);
            }}
          >
            {v === 'logs' ? 'Journal' : 'Transcription'}
          </Button>
        ))}
      </div>
      {error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      {view === 'logs' &&
        (logs.isPending ? (
          <p className="text-sm text-muted-foreground">Téléchargement du journal…</p>
        ) : (
          logs.data && <VirtualLog text={logs.data.text} label="Journal du run" />
        ))}
      {view === 'transcript' &&
        (transcript.isPending ? (
          <p className="text-sm text-muted-foreground">Téléchargement de l’artefact…</p>
        ) : transcript.data === null ? (
          <p className="text-sm text-muted-foreground">Aucun artefact (expiré ou absent).</p>
        ) : (
          transcript.data && (
            <VirtualLog
              text={transcript.data.text}
              label={`Transcription ${transcript.data.name}`}
            />
          )
        ))}
    </section>
  );
}

export function RunsView({ projectId }: { projectId: string }) {
  const dashboard = useDashboard(projectId);
  const [selected, setSelected] = useState<number | null>(null);
  if (dashboard.error instanceof Error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {dashboard.error.message}
      </p>
    );
  if (!dashboard.data) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  const run = dashboard.data.runs.find((r) => r.id === selected);
  return (
    <div className="flex flex-col gap-6">
      <RunsTable dashboard={dashboard.data} selected={selected} onSelect={setSelected} />
      {run && <RunDetail key={run.id} projectId={projectId} run={run} />}
    </div>
  );
}
