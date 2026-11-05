import {
  PROFILE_IDS,
  TEST_CATEGORIES,
  TEST_CATEGORY_LABELS,
  type PlanTask,
  type ProfileId,
  type RequiredTests,
} from 'shared';
import { useState } from 'react';
import { Input, Label, Textarea } from '../../components/ui/primitives.js';

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

/**
 * Zone « un élément par ligne » : le texte tapé est gardé tel quel (lignes vides comprises),
 * la liste nettoyée est transmise à chaque frappe pour la revalidation.
 */
function LinesField({
  id,
  className,
  value,
  onCommit,
}: {
  id: string;
  className: string;
  value: readonly string[];
  onCommit: (list: string[]) => void;
}) {
  const [text, setText] = useState(value.join('\n'));
  return (
    <Textarea
      id={id}
      className={className}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(lines(e.target.value));
      }}
    />
  );
}

/** Édition d'une tâche ; chaque changement est revalidé par le plan entier. */
export function TaskEditor({
  task,
  allTasks,
  onChange,
}: {
  task: PlanTask;
  allTasks: readonly PlanTask[];
  onChange: (task: PlanTask) => void;
}) {
  const set = <K extends keyof PlanTask>(key: K, value: PlanTask[K]) => {
    onChange({ ...task, [key]: value });
  };
  const setTests = (category: (typeof TEST_CATEGORIES)[number], list: string[]) => {
    const next: RequiredTests = Object.fromEntries(
      TEST_CATEGORIES.flatMap((c) => {
        const tests = c === category ? list : (task.requiredTests[c] ?? []);
        return tests.length > 0 ? [[c, tests]] : [];
      }),
    );
    set('requiredTests', next);
  };

  return (
    <form
      aria-label={`Édition de ${task.id}`}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="task-title">Titre</Label>
        <Input
          id="task-title"
          value={task.title}
          onChange={(e) => {
            set('title', e.target.value);
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="task-profile">Profil</Label>
        <select
          id="task-profile"
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          value={task.profile}
          onChange={(e) => {
            set('profile', e.target.value as ProfileId);
          }}
        >
          {PROFILE_IDS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="task-criteria">Critères d’acceptation (un par ligne)</Label>
        <LinesField
          id="task-criteria"
          className="font-sans text-sm"
          value={task.acceptanceCriteria}
          onCommit={(list) => {
            set('acceptanceCriteria', list);
          }}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Tests exigés (un par ligne)</legend>
        {TEST_CATEGORIES.map((category) => (
          <div key={category} className="flex flex-col gap-1">
            <Label htmlFor={`task-tests-${category}`} className="text-xs">
              {TEST_CATEGORY_LABELS[category]}
            </Label>
            <LinesField
              id={`task-tests-${category}`}
              className="min-h-12 font-sans text-sm"
              value={task.requiredTests[category] ?? []}
              onCommit={(list) => {
                setTests(category, list);
              }}
            />
          </div>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">Dépend de</legend>
        {allTasks
          .filter((t) => t.id !== task.id)
          .map((other) => (
            <label key={other.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={task.dependencies.includes(other.id)}
                onChange={(e) => {
                  set(
                    'dependencies',
                    e.target.checked
                      ? [...task.dependencies, other.id]
                      : task.dependencies.filter((d) => d !== other.id),
                  );
                }}
              />
              {other.id} — {other.title}
            </label>
          ))}
      </fieldset>
    </form>
  );
}
