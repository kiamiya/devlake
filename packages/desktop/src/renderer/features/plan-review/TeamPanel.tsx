import type { AgentProposal, ProjectPlan } from 'shared';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input, Label } from '../../components/ui/primitives.js';
import { PROFILE_COLORS } from './profiles.js';

/** Panneau Équipe : profils retenus, nombre d'agents et détail du calcul, plafond projet. */
export function TeamPanel({
  plan,
  proposal,
  caps,
  onCap,
  saving,
}: {
  plan: ProjectPlan;
  proposal: AgentProposal;
  caps: { runners: number; global: number; project: number | null };
  onCap: (cap: number | null) => void;
  saving: boolean;
}) {
  const [cap, setCap] = useState(caps.project === null ? '' : String(caps.project));
  const parsed = cap.trim() === '' ? null : Number(cap);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1);

  return (
    <div className="flex flex-col gap-6" aria-label="Équipe">
      <section>
        <h3 className="mb-2 text-sm font-semibold">Profils retenus</h3>
        <ul className="flex flex-col gap-2 text-sm">
          {plan.profiles.map((p) => (
            <li key={p.profile} className="flex gap-3">
              <span className="w-24 font-medium" style={{ color: PROFILE_COLORS[p.profile] }}>
                {p.profile}
              </span>
              <span className="text-muted-foreground">{p.justification}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Agents en parallèle</h3>
        <p data-testid="agents-proposed" className="text-2xl font-semibold">
          {proposal.agents}
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:w-1/2">
          <dt className="text-muted-foreground">Largeur du graphe (L_DAG)</dt>
          <dd>{proposal.width}</dd>
          <dt className="text-muted-foreground">Runners GitHub (C_runners)</dt>
          <dd>{caps.runners}</dd>
          <dt className="text-muted-foreground">Plafond global (C_global)</dt>
          <dd>{caps.global}</dd>
          <dt className="text-muted-foreground">Plafond du projet (C_projet)</dt>
          <dd>{caps.project ?? 'aucun'}</dd>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          N = min(L_DAG, C_runners, C_global, C_projet). Tâches indépendantes retenues :{' '}
          {proposal.antichain.join(', ') || '—'} ; celles qui partagent une ressource exclusive
          comptent pour une.
        </p>
      </section>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onCap(parsed);
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-cap">Plafond d’agents du projet</Label>
          <Input
            id="project-cap"
            type="number"
            min={1}
            placeholder="aucun"
            value={cap}
            onChange={(e) => {
              setCap(e.target.value);
            }}
            className="w-32"
          />
        </div>
        <Button type="submit" variant="outline" disabled={!valid || saving}>
          Enregistrer le plafond
        </Button>
      </form>
    </div>
  );
}
