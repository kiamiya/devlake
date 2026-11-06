import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo, useState } from 'react';
import { COLUMN_LABELS, KANBAN_COLUMNS, type KanbanColumn } from '../../../shared/dashboard.js';
import type { DashboardView } from '../../../shared/ipc-contract.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardTitle, Input } from '../../components/ui/primitives.js';
import { useDashboard, useRelaunch, useSetPaused } from '../../hooks/dashboard.js';
import { depths } from '../plan-review/profiles.js';
import { formatMinutes } from '../runs/RunsView.js';
import { AdhocTaskForm } from '../tasks/AdhocTaskForm.js';

type Task = DashboardView['tasks'][number];
type Progress = DashboardView['progress']['overall'];

/** Couleur de chaque état dans le graphe et le kanban. */
export const STATE_COLORS: Record<KanbanColumn, string> = {
  queued: '#94a3b8',
  ready: '#0ea5e9',
  'waiting-editor': '#a855f7',
  running: '#16a34a',
  'awaiting-answer': '#ea580c',
  fixing: '#ca8a04',
  escalated: '#dc2626',
  done: '#15803d',
};

function ProgressBar({ label, progress }: { label: string; progress: Progress }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {progress.percent} % · {progress.doneTasks}/{progress.totalTasks} tâches
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`Avancement ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary" style={{ width: `${String(progress.percent)}%` }} />
      </div>
    </div>
  );
}

function Relaunch({ projectId, task }: { projectId: string; task: Task }) {
  const [instruction, setInstruction] = useState('');
  const relaunch = useRelaunch(projectId);
  return (
    <div className="mt-2 flex flex-col gap-1">
      <Input
        aria-label={`Consigne pour ${task.id}`}
        placeholder="Consigne (facultative)"
        className="h-7 text-xs"
        value={instruction}
        onChange={(e) => {
          setInstruction(e.target.value);
        }}
      />
      <Button
        size="sm"
        disabled={relaunch.isPending || relaunch.isSuccess}
        onClick={() => {
          relaunch.mutate({ issueNumber: task.number, instruction });
        }}
      >
        {relaunch.isSuccess ? 'Relance demandée' : `Relancer ${task.id}`}
      </Button>
      {relaunch.error instanceof Error && (
        <p role="alert" className="text-xs text-destructive">
          {relaunch.error.message}
        </p>
      )}
    </div>
  );
}

/** Kanban par état ; une tâche escaladée peut être relancée. */
export function Kanban({ dashboard }: { dashboard: DashboardView }) {
  return (
    <div
      aria-label="Kanban"
      className="grid auto-cols-[minmax(11rem,1fr)] grid-flow-col gap-2 overflow-x-auto"
    >
      {KANBAN_COLUMNS.map((column) => {
        const tasks = dashboard.tasks.filter((t) => t.column === column);
        return (
          <section
            key={column}
            aria-label={`Colonne ${COLUMN_LABELS[column]}`}
            className="flex min-h-24 flex-col gap-2 rounded-md bg-muted/50 p-2"
          >
            <h3 className="flex items-center gap-2 text-xs font-semibold">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: STATE_COLORS[column] }}
              />
              {COLUMN_LABELS[column]} <span className="text-muted-foreground">{tasks.length}</span>
            </h3>
            {tasks.map((task) => {
              const pr = dashboard.pullRequests[task.id];
              return (
                <article
                  key={task.number}
                  aria-label={`Tâche ${task.id}`}
                  className="rounded-md border border-border bg-background p-2 text-xs"
                >
                  <p className="font-medium">
                    {task.id} — {task.title}
                  </p>
                  <p className="text-muted-foreground">
                    {task.profile} · {task.complexity}
                    {task.attempts > 0 && ` · ${String(task.attempts)} tentative(s)`}
                  </p>
                  <p className="flex gap-2">
                    <a
                      href={`${dashboard.repositoryUrl}/issues/${String(task.number)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      issue #{task.number}
                    </a>
                    {pr && (
                      <a href={pr.url} target="_blank" rel="noreferrer" className="underline">
                        PR #{pr.number}
                      </a>
                    )}
                  </p>
                  {task.column === 'escalated' && (
                    <Relaunch projectId={dashboard.projectId} task={task} />
                  )}
                </article>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

/** Graphe des dépendances coloré par état. */
export function StateGraph({ tasks }: { tasks: readonly Task[] }) {
  const { nodes, edges } = useMemo(() => {
    const depth = depths(tasks);
    const rows = new Map<number, number>();
    const nodes: Node[] = tasks.map((task) => {
      const column = depth.get(task.id) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return {
        id: task.id,
        position: { x: column * 220, y: row * 80 },
        data: { label: `${task.id} — ${COLUMN_LABELS[task.column]}` },
        style: {
          borderColor: STATE_COLORS[task.column],
          backgroundColor: `${STATE_COLORS[task.column]}22`,
          borderWidth: 2,
          fontSize: 12,
          width: 180,
        },
      };
    });
    const ids = new Set(tasks.map((t) => t.id));
    const edges: Edge[] = tasks.flatMap((task) =>
      task.dependencies
        .filter((d) => ids.has(d))
        .map((dep) => ({ id: `${dep}->${task.id}`, source: dep, target: task.id })),
    );
    return { nodes, edges };
  }, [tasks]);
  return (
    <div
      aria-label="Graphe des dépendances par état"
      className="h-80 rounded-md border border-border"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/** Contenu du tableau de bord, sans chargement (testable tel quel). */
export function DashboardContent({ dashboard }: { dashboard: DashboardView }) {
  const setPaused = useSetPaused(dashboard.projectId);
  const [adding, setAdding] = useState(false);
  const { progress, consumption } = dashboard;
  return (
    <div className="flex flex-col gap-6">
      {adding && (
        <Card>
          <CardTitle>Nouvelle tâche</CardTitle>
          <AdhocTaskForm
            projectId={dashboard.projectId}
            onClose={() => {
              setAdding(false);
            }}
          />
        </Card>
      )}
      <Card>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>Avancement</CardTitle>
          <div className="flex items-center gap-2 text-sm">
            {!adding && (
              <Button
                size="sm"
                onClick={() => {
                  setAdding(true);
                }}
              >
                Nouvelle tâche
              </Button>
            )}
            {dashboard.paused && (
              <span role="status" className="font-medium text-warning">
                Projet en pause : aucun agent ne sera lancé.
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={setPaused.isPending}
              onClick={() => {
                setPaused.mutate(!dashboard.paused);
              }}
            >
              {dashboard.paused ? 'Reprendre le projet' : 'Mettre en pause'}
            </Button>
          </div>
        </div>
        {setPaused.error instanceof Error && (
          <p role="alert" className="text-sm text-destructive">
            {setPaused.error.message}
          </p>
        )}
        <div className="mt-3 flex flex-col gap-3">
          <ProgressBar label="global" progress={progress.overall} />
          {progress.milestones.length > 1 &&
            progress.milestones.map((m) => (
              <ProgressBar key={m.milestone} label={m.milestone} progress={m.progress} />
            ))}
          <p className="text-xs text-muted-foreground">
            Pondéré par la complexité : S = 1, M = 2, L = 3.
          </p>
        </div>
      </Card>
      <Kanban dashboard={dashboard} />
      {dashboard.tasks.length > 0 && <StateGraph tasks={dashboard.tasks} />}
      <Card>
        <CardTitle>Consommation</CardTitle>
        <p className="text-sm">
          Minutes Actions ({consumption.month}) :{' '}
          <strong>{formatMinutes(consumption.monthMinutes)}</strong> · depuis le début :{' '}
          {formatMinutes(consumption.totalMinutes)}
        </p>
        <p className="text-xs text-muted-foreground">
          Somme des durées des runs ; GitHub arrondit chaque job à la minute.
        </p>
        {consumption.byTask.length > 0 && (
          <table aria-label="Consommation par tâche" className="mt-2 text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="pr-4 text-left">Tâche</th>
                <th className="pr-4 text-left">Runs d’agent</th>
                <th className="text-left">Minutes</th>
              </tr>
            </thead>
            <tbody>
              {consumption.byTask.map((t) => (
                <tr key={t.taskId}>
                  <td className="pr-4">{t.taskId}</td>
                  <td className="pr-4">{t.agentRuns}</td>
                  <td>{formatMinutes(t.minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export function Dashboard({ projectId }: { projectId: string }) {
  const dashboard = useDashboard(projectId);
  if (dashboard.error instanceof Error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {dashboard.error.message}
      </p>
    );
  if (!dashboard.data) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  return <DashboardContent dashboard={dashboard.data} />;
}
