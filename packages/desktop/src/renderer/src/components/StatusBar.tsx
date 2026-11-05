import type { IntegrationState } from '../../../shared/ipc-contract.js';
import { useStatus } from '../hooks/queries.js';
import { Badge } from './ui/primitives.js';

const STATE_LABELS: Record<IntegrationState, string> = {
  ok: 'OK',
  degraded: 'DÉGRADÉ',
  absent: 'ABSENT',
};

export function StatusBar() {
  const { data } = useStatus();
  return (
    <footer
      aria-label="Statut des intégrations"
      className="flex h-9 items-center gap-4 border-t border-border bg-muted px-4 text-xs"
    >
      {(data ?? []).map((status) => (
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
