import {
  DEFAULT_RUNNER_CAP,
  formatZodError,
  proposeAgents,
  ProjectPlanSchema,
  type PlanTask,
  type ProjectPlan,
} from 'shared';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Card, CardDescription, CardTitle } from '../../components/ui/primitives.js';
import {
  usePlan,
  usePlanVersions,
  useSavePlan,
  useSetProjectCap,
  useValidatePlan,
} from '../../hooks/plan.js';
import { useSettings } from '../../hooks/queries.js';
import { cn } from '../../lib/utils.js';
import { PlanCompare } from './PlanCompare.js';
import { PlanGraph } from './PlanGraph.js';
import { PlanTree } from './PlanTree.js';
import { TaskEditor } from './TaskEditor.js';
import { TeamPanel } from './TeamPanel.js';

const VIEWS = [
  ['tree', 'Arborescence'],
  ['graph', 'Graphe'],
  ['team', 'Équipe'],
  ['compare', 'Comparer'],
] as const;
type View = (typeof VIEWS)[number][0];

/** Revue du plan : lecture, ajustements revalidés, équipe, comparaison, validation. */
export function PlanReview({ projectId }: { projectId: string }) {
  const versions = usePlanVersions(projectId);
  const list = (versions.data ?? []).map((v) => v.version);
  const [version, setVersion] = useState<number | null>(null);
  const current = version ?? list.at(-1) ?? null;
  const loaded = usePlan(projectId, current);
  const settings = useSettings();
  const save = useSavePlan(projectId);
  const setCap = useSetProjectCap(projectId);
  const validate = useValidatePlan(projectId);

  const [view, setView] = useState<View>('tree');
  const [draft, setDraft] = useState<ProjectPlan | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setDraft(loaded.data?.plan ?? null);
    setSelected(null);
  }, [loaded.data]);

  const caps = {
    runners: DEFAULT_RUNNER_CAP,
    global: settings.data?.maxConcurrentAgents ?? DEFAULT_RUNNER_CAP,
    project: loaded.data?.config?.limits.maxConcurrentAgents ?? null,
  };
  const proposal = useMemo(
    () =>
      draft
        ? proposeAgents(draft.tasks, {
            runners: caps.runners,
            global: caps.global,
            ...(caps.project !== null ? { project: caps.project } : {}),
          })
        : null,
    [draft, caps.runners, caps.global, caps.project],
  );
  const edited = draft && proposal ? { ...draft, proposedAgents: proposal.agents } : null;
  const check = edited ? ProjectPlanSchema.safeParse(edited) : null;
  const errors = check && !check.success ? formatZodError(check.error) : null;
  const dirty =
    edited !== null &&
    loaded.data !== undefined &&
    JSON.stringify(edited) !== JSON.stringify(loaded.data.plan);

  if (versions.isPending)
    return <p className="text-sm text-muted-foreground">Recherche des plans…</p>;
  if (list.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucun plan proposé pour l’instant : lancer le planificateur.
      </p>
    );
  }

  const task = edited?.tasks.find((t) => t.id === selected) ?? null;
  const updateTask = (next: PlanTask) => {
    setDraft((plan) =>
      plan ? { ...plan, tasks: plan.tasks.map((t) => (t.id === next.id ? next : t)) } : plan,
    );
  };

  return (
    <Card>
      <CardTitle>Revue du plan</CardTitle>
      <CardDescription>
        {edited
          ? `${String(edited.tasks.length)} tâches. ${edited.summary}`
          : 'Chargement du plan…'}
      </CardDescription>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Version
          <select
            aria-label="Version du plan"
            className="h-8 rounded-md border border-input bg-transparent px-2"
            value={current ?? ''}
            onChange={(e) => {
              setVersion(Number(e.target.value));
            }}
          >
            {list.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </label>
        <div role="tablist" aria-label="Vues du plan" className="flex gap-1">
          {VIEWS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={view === id}
              className={cn(
                'rounded-md px-3 py-1 text-sm',
                view === id ? 'bg-muted font-medium' : 'hover:bg-muted',
              )}
              onClick={() => {
                setView(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {edited && proposal && (
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="min-w-0 flex-1">
            {view === 'tree' && (
              <PlanTree plan={edited} selected={selected} onSelect={setSelected} />
            )}
            {view === 'graph' && <PlanGraph tasks={edited.tasks} onSelect={setSelected} />}
            {view === 'team' && (
              <TeamPanel
                key={String(caps.project)}
                plan={edited}
                proposal={proposal}
                caps={caps}
                saving={setCap.isPending}
                onCap={(cap) => {
                  setCap.mutate(cap);
                }}
              />
            )}
            {view === 'compare' && <PlanCompare projectId={projectId} versions={list} />}
          </div>
          {task && view !== 'team' && view !== 'compare' && (
            <aside className="lg:w-96">
              <TaskEditor key={task.id} task={task} allTasks={edited.tasks} onChange={updateTask} />
            </aside>
          )}
        </div>
      )}

      {errors && (
        <pre role="alert" className="mt-4 whitespace-pre-wrap text-sm text-destructive">
          {errors}
        </pre>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={!dirty || errors !== null || save.isPending || current === null}
          onClick={() => {
            if (edited && current !== null) save.mutate({ version: current, plan: edited });
          }}
        >
          Enregistrer les modifications
        </Button>
        {confirming ? (
          <>
            <Button
              disabled={validate.isPending || current === null}
              onClick={() => {
                setConfirming(false);
                if (current !== null) validate.mutate(current);
              }}
            >
              Confirmer la validation
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Annuler
            </Button>
          </>
        ) : (
          <Button
            disabled={dirty || errors !== null || validate.isPending}
            title={dirty ? 'Enregistrer les modifications avant de valider' : undefined}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Valider le plan
          </Button>
        )}
      </div>

      {validate.data && (
        <div role="status" className="mt-4 text-sm">
          <p>
            Plan validé : {validate.data.issues.filter((i) => i.created).length} issue(s) créée(s),{' '}
            {validate.data.issues.filter((i) => !i.created).length} déjà existante(s),{' '}
            {validate.data.dependencies} dépendance(s).
          </p>
          {validate.data.warnings.map((w) => (
            <p key={w} className="text-warning">
              {w}
            </p>
          ))}
        </div>
      )}
      {(save.error ?? validate.error ?? setCap.error ?? loaded.error) instanceof Error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {(save.error ?? validate.error ?? setCap.error ?? loaded.error)?.message}
        </p>
      )}
    </Card>
  );
}
