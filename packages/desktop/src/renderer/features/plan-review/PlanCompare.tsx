import { useState } from 'react';
import { planDiff } from '../../../shared/plan-diff.js';
import { usePlan } from '../../hooks/plan.js';

/** Comparaison de deux versions du plan. */
export function PlanCompare({
  projectId,
  versions,
}: {
  projectId: string;
  versions: readonly number[];
}) {
  const [before, setBefore] = useState<number>(versions.at(-2) ?? versions[0] ?? 1);
  const [after, setAfter] = useState<number>(versions.at(-1) ?? 1);
  const a = usePlan(projectId, before);
  const b = usePlan(projectId, after);
  const diff = a.data && b.data ? planDiff(a.data.plan, b.data.plan) : null;

  const select = (label: string, value: number, onChange: (v: number) => void) => (
    <label className="flex items-center gap-2 text-sm">
      {label}
      <select
        aria-label={label}
        className="h-8 rounded-md border border-input bg-transparent px-2"
        value={value}
        onChange={(e) => {
          onChange(Number(e.target.value));
        }}
      >
        {versions.map((v) => (
          <option key={v} value={v}>
            v{v}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-col gap-4" aria-label="Comparaison des versions">
      <div className="flex gap-4">
        {select('Version de départ', before, setBefore)}
        {select('Version comparée', after, setAfter)}
      </div>
      {diff && (
        <ul className="flex flex-col gap-1 text-sm">
          {diff.added.map((id) => (
            <li key={`+${id}`} className="text-success">
              + {id} ajoutée
            </li>
          ))}
          {diff.removed.map((id) => (
            <li key={`-${id}`} className="text-destructive">
              − {id} retirée
            </li>
          ))}
          {diff.changed.map((c) => (
            <li key={`~${c.id}`}>
              ~ {c.id} modifiée : {c.fields.join(', ')}
            </li>
          ))}
          {diff.agents && (
            <li>
              Agents proposés : {diff.agents.before} → {diff.agents.after}
            </li>
          )}
          {diff.added.length + diff.removed.length + diff.changed.length === 0 && !diff.agents && (
            <li className="text-muted-foreground">Aucune différence.</li>
          )}
        </ul>
      )}
    </div>
  );
}
