import type { IntegrationState } from '../../shared/ipc-contract.js';
import { useActivity } from '../hooks/projects.js';
import { useStatus } from '../hooks/queries.js';
import { Badge } from './ui/primitives.js';

const STATE_LABELS: Record<IntegrationState, string> = {
  ok: 'OK',
  degraded: 'DÉGRADÉ',
  absent: 'ABSENT',
};

/** Barre d'état globale : activité de tous les projets et statut des intégrations. */
export function StatusBar() {
  const { data: statuses } = useStatus();
  const { data: activity } = useActivity();
  return (
    <footer
      aria-label="Barre d’état"
      className="flex h-9 items-center gap-4 border-t border-border bg-muted px-4 text-xs"
    >
      {activity && (
        <>
          <span data-testid="activity-agents">
            Agents actifs : {activity.activeAgents} / {activity.maxAgents}
          </span>
          <span data-testid="activity-questions">
            Questions en attente : {activity.pendingQuestions}
          </span>
          <span aria-hidden="true" className="h-4 border-l border-border" />
        </>
      )}
      {(statuses ?? []).map((status) => (
        <span
          key={status.id}
          className="flex items-center gap-2"
          title={status.detail}
          data-testid={`status-${status.id}`}
        >
          <span>{status.label}</span>
          <Badge tone={status.state}>{STATE_LABELS[status.state]}</Badge>
        </span>
      ))}
    </footer>
  );
}
