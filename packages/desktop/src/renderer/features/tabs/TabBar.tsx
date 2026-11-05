import { Settings, X } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import type { ProjectSummary } from '../../../shared/ipc-contract.js';
import { cn } from '../../lib/utils.js';
import { HOME } from './model.js';
import { useTabs } from './store.js';

export function QuestionsBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      aria-label={`${String(count)} question${count > 1 ? 's' : ''} en attente`}
      className="rounded-full bg-destructive px-1.5 text-[10px] font-bold leading-4 text-white"
    >
      {count}
    </span>
  );
}

export function ActivityIndicator({ active }: { active: number }) {
  if (active === 0) return null;
  return (
    <span
      aria-label={`${String(active)} agent${active > 1 ? 's' : ''} actif${active > 1 ? 's' : ''}`}
      className="size-2 animate-pulse rounded-full bg-success"
    />
  );
}

const tabClass = (selected: boolean) =>
  cn(
    'flex h-9 items-center gap-2 rounded-t-md border border-b-0 px-3 text-sm',
    selected
      ? 'border-border bg-background font-medium'
      : 'border-transparent text-muted-foreground hover:bg-background/60',
  );

export function TabBar({ projects }: { projects: readonly ProjectSummary[] }) {
  const tabs = useTabs((s) => s.tabs);
  const active = useTabs((s) => s.active);
  const settingsOpen = useTabs((s) => s.settingsOpen);
  const activateTab = useTabs((s) => s.activate);
  const close = useTabs((s) => s.close);
  const move = useTabs((s) => s.move);
  const toggleSettings = useTabs((s) => s.toggleSettings);
  const [dragged, setDragged] = useState<string | null>(null);
  const byId = new Map(projects.map((p) => [p.id, p]));

  const onDrop = (event: DragEvent, index: number) => {
    event.preventDefault();
    if (dragged) move(dragged, index);
    setDragged(null);
  };

  return (
    <nav className="flex items-end gap-1 border-b border-border bg-muted px-2 pt-2">
      <div
        role="tablist"
        aria-label="Projets ouverts"
        className="flex flex-1 items-end gap-1 overflow-x-auto"
      >
        <button
          role="tab"
          type="button"
          aria-selected={active === HOME && !settingsOpen}
          className={tabClass(active === HOME && !settingsOpen)}
          onClick={() => {
            activateTab(HOME);
          }}
        >
          Accueil
        </button>
        {tabs.map((id, index) => {
          const project = byId.get(id);
          const selected = active === id && !settingsOpen;
          return (
            <div
              key={id}
              data-testid={`tab-${id}`}
              draggable
              onDragStart={() => {
                setDragged(id);
              }}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                onDrop(event, index);
              }}
              className={tabClass(selected)}
            >
              <button
                role="tab"
                type="button"
                aria-selected={selected}
                title={id}
                className="flex items-center gap-2"
                onClick={() => {
                  activateTab(id);
                }}
              >
                <ActivityIndicator active={project?.activeAgents ?? 0} />
                <span>{project?.repo ?? id}</span>
                <QuestionsBadge count={project?.pendingQuestions ?? 0} />
              </button>
              <button
                type="button"
                aria-label={`Fermer ${project?.repo ?? id}`}
                className="rounded p-0.5 hover:bg-muted"
                onClick={() => {
                  close(id);
                }}
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="Réglages"
        aria-pressed={settingsOpen}
        className={cn('mb-1 rounded-md p-2 hover:bg-background', settingsOpen && 'bg-background')}
        onClick={() => {
          toggleSettings();
        }}
      >
        <Settings className="size-4" />
      </button>
    </nav>
  );
}
