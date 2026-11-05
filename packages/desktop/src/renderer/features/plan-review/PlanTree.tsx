import type { ProjectPlan } from 'shared';
import { cn } from '../../lib/utils.js';
import { PROFILE_COLORS } from './profiles.js';

/** Arborescence : épopées puis tâches, avec profil, complexité et dépendances. */
export function PlanTree({
  plan,
  selected,
  onSelect,
}: {
  plan: ProjectPlan;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const groups = [
    ...plan.epics.map((e) => ({
      key: e.id,
      title: `${e.id} — ${e.title}`,
      tasks: plan.tasks.filter((t) => t.epic === e.id),
    })),
    { key: '', title: 'Sans épopée', tasks: plan.tasks.filter((t) => t.epic === undefined) },
  ].filter((g) => g.tasks.length > 0);

  return (
    <div className="flex flex-col gap-4" aria-label="Arborescence du plan">
      {groups.map((group) => (
        <section key={group.key}>
          <h3 className="mb-2 text-sm font-semibold">{group.title}</h3>
          <ul className="flex flex-col gap-1">
            {group.tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  aria-pressed={selected === task.id}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md border-l-4 px-3 py-2 text-left text-sm hover:bg-muted',
                    selected === task.id && 'bg-muted',
                  )}
                  style={{ borderLeftColor: PROFILE_COLORS[task.profile] }}
                  onClick={() => {
                    onSelect(task.id);
                  }}
                >
                  <span className="font-mono text-xs">{task.id}</span>
                  <span className="flex-1">{task.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {task.profile} · {task.complexity}
                    {task.dependencies.length > 0 ? ` · après ${task.dependencies.join(', ')}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
