import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PROFILE_IDS, type ProfileId } from 'shared';
import { useState, type FormEvent } from 'react';
import type { AdhocTaskInput } from '../../../shared/ipc-contract.js';
import { Button } from '../../components/ui/button.js';
import { Input, Label, Textarea } from '../../components/ui/primitives.js';
import { useDashboard } from '../../hooks/dashboard.js';
import { invoke } from '../../lib/ipc.js';

const SELECT = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';
const TEST_CATEGORIES: { value: AdhocTaskInput['testCategory']; label: string }[] = [
  { value: 'unit', label: 'Unitaires' },
  { value: 'integration', label: 'Intégration' },
  { value: 'contract', label: 'Contrat' },
  { value: 'e2e', label: 'Bout en bout' },
  { value: 'regression', label: 'Régression' },
];

/** Création d'une tâche ad hoc : issue, dépendances, puis dispatcher déclenché. */
export function useCreateAdhocTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (task: AdhocTaskInput) => invoke('tasks:create', task),
    onSuccess: async (_result, task) => {
      await client.invalidateQueries({ queryKey: ['dashboard', task.projectId] });
      await client.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** Dépendances possibles : les tâches du projet choisi (tableau de bord). */
function Dependencies({
  projectId,
  selected,
  onChange,
}: {
  projectId: string;
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const dashboard = useDashboard(projectId);
  const tasks = dashboard.data?.tasks ?? [];
  if (tasks.length === 0)
    return <p className="text-xs text-muted-foreground">Aucune tâche existante.</p>;
  return (
    <ul aria-label="Dépendances possibles" className="flex max-h-40 flex-col gap-1 overflow-auto">
      {tasks.map((task) => (
        <li key={task.id}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(task.id)}
              onChange={(e) => {
                onChange(
                  e.target.checked
                    ? [...selected, task.id]
                    : selected.filter((id) => id !== task.id),
                );
              }}
            />
            {task.id} — {task.title}
          </label>
        </li>
      ))}
    </ul>
  );
}

/**
 * Formulaire « Nouvelle tâche » (hors plan). Dans un projet, `projectId` est fixé ; depuis
 * l'Accueil, `projects` propose le choix du projet.
 */
export function AdhocTaskForm({
  projectId: fixed,
  projects = [],
  onClose,
}: {
  projectId?: string;
  projects?: readonly string[];
  onClose?: () => void;
}) {
  const create = useCreateAdhocTask();
  const [projectId, setProjectId] = useState(fixed ?? projects[0] ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<AdhocTaskInput['kind']>('code');
  const [profile, setProfile] = useState<ProfileId>('backend');
  const [complexity, setComplexity] = useState<AdhocTaskInput['complexity']>('S');
  const [criteria, setCriteria] = useState('');
  const [tests, setTests] = useState('');
  const [testCategory, setTestCategory] = useState<AdhocTaskInput['testCategory']>('unit');
  const [codeZones, setCodeZones] = useState('');
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [priority, setPriority] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({
      projectId,
      title,
      description,
      kind,
      profile,
      complexity,
      acceptanceCriteria: criteria,
      tests,
      testCategory,
      codeZones,
      dependencies,
      priority,
    });
  };

  return (
    <form aria-label="Nouvelle tâche" className="flex flex-col gap-3" onSubmit={submit}>
      {fixed === undefined && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="adhoc-project">Projet</Label>
          <select
            id="adhoc-project"
            className={SELECT}
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setDependencies([]);
            }}
          >
            {projects.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor="adhoc-title">Titre</Label>
        <Input
          id="adhoc-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="adhoc-description">Description</Label>
        <Textarea
          id="adhoc-description"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="adhoc-kind">Type</Label>
          <select
            id="adhoc-kind"
            className={SELECT}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as AdhocTaskInput['kind']);
            }}
          >
            <option value="code">Code</option>
            <option value="docs">Documentation</option>
            <option value="config">Configuration</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="adhoc-profile">Profil d’agent</Label>
          <select
            id="adhoc-profile"
            className={SELECT}
            value={profile}
            onChange={(e) => {
              setProfile(e.target.value as ProfileId);
            }}
          >
            {PROFILE_IDS.filter((p) => p !== 'reviewer').map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="adhoc-size">Taille</Label>
          <select
            id="adhoc-size"
            className={SELECT}
            value={complexity}
            onChange={(e) => {
              setComplexity(e.target.value as AdhocTaskInput['complexity']);
            }}
          >
            <option value="S">S</option>
            <option value="M">M</option>
            <option value="L">L</option>
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="adhoc-criteria">Critères d’acceptation (un par ligne)</Label>
        <Textarea
          id="adhoc-criteria"
          value={criteria}
          onChange={(e) => {
            setCriteria(e.target.value);
          }}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="adhoc-tests">
            Tests exigés (un par ligne{kind === 'code' ? ', obligatoire pour du code' : ''})
          </Label>
          <Textarea
            id="adhoc-tests"
            value={tests}
            onChange={(e) => {
              setTests(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="adhoc-test-category">Catégorie des tests</Label>
          <select
            id="adhoc-test-category"
            className={SELECT}
            value={testCategory}
            onChange={(e) => {
              setTestCategory(e.target.value as AdhocTaskInput['testCategory']);
            }}
          >
            {TEST_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="adhoc-zones">Zones de code (une par ligne, facultatif)</Label>
        <Textarea
          id="adhoc-zones"
          value={codeZones}
          onChange={(e) => {
            setCodeZones(e.target.value);
          }}
        />
      </div>
      {projectId !== '' && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">Dépend de (facultatif)</legend>
          <Dependencies projectId={projectId} selected={dependencies} onChange={setDependencies} />
        </fieldset>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={priority}
          onChange={(e) => {
            setPriority(e.target.checked);
          }}
        />
        Prioritaire : lancée avant les tâches du plan
      </label>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={create.isPending || projectId === ''}>
          Créer la tâche
        </Button>
        {onClose && (
          <Button type="button" variant="outline" onClick={onClose}>
            Fermer
          </Button>
        )}
      </div>
      {create.error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {create.error.message}
        </p>
      )}
      {create.data && (
        <p role="status" className="text-sm text-success">
          Tâche {create.data.taskId} créée (issue #{create.data.issueNumber})
          {create.data.dispatched
            ? ' : le dispatcher la lance dès qu’une place se libère.'
            : ` : ${create.data.warnings.join(' ')}`}
        </p>
      )}
    </form>
  );
}
