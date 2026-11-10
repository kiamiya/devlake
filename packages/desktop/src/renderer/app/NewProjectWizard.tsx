import {
  DEFAULT_QUALITY_PROFILE,
  PROJECT_TYPES,
  QUALITY_PROFILES,
  type ProjectType,
  type QualityProfile,
} from 'shared';
import { useState, type FormEvent } from 'react';
import type { BootstrapReportView } from '../../shared/ipc-contract.js';
import { Button } from '../components/ui/button.js';
import { Card, CardDescription, CardTitle, Input, Label } from '../components/ui/primitives.js';
import { useTabs } from '../features/tabs/store.js';
import { useCreateProject } from '../hooks/projects.js';

export const TYPE_LABELS: Record<ProjectType, string> = {
  web: 'Web (React, Supabase, Vercel)',
  backend: 'Backend',
  mobile: 'Mobile',
  tool: 'Outil interne',
  script: 'Script',
  unity: 'Jeu Unity',
  unreal: 'Jeu Unreal',
};

const STEP_LABELS: Record<string, string> = {
  repository: 'Dépôt',
  'merge-settings': 'Merge squash et auto-merge',
  'actions-permissions': 'Permissions Actions',
  labels: 'Labels agentlake:*',
  files: 'project.yml, workflows d’appel, Git LFS',
  'branch-protection': 'Protection de main',
  secrets: 'Secrets',
  variables: 'Variable AGENTLAKE_OWNER (ton compte)',
};

const STATUS_LABELS = { created: 'créé', updated: 'complété', unchanged: 'déjà en place' } as const;

export function BootstrapSteps({ report }: { report: BootstrapReportView }) {
  return (
    <ul aria-label="Étapes du bootstrap" className="flex flex-col gap-1 text-sm">
      {report.steps.map((s) => (
        <li key={s.step} className="flex justify-between gap-4">
          <span>{STEP_LABELS[s.step] ?? s.step}</span>
          <span className="text-muted-foreground">{STATUS_LABELS[s.status]}</span>
        </li>
      ))}
    </ul>
  );
}

/** Assistant de création : nom, type, visibilité, profil qualité, puis bootstrap sur GitHub. */
export function NewProjectWizard({ onClose }: { onClose: () => void }) {
  const create = useCreateProject();
  const openTab = useTabs((s) => s.open);
  const [name, setName] = useState('');
  const [type, setType] = useState<ProjectType>('web');
  const [quality, setQuality] = useState<QualityProfile>(DEFAULT_QUALITY_PROFILE.web);
  const [isPrivate, setPrivate] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), type, private: isPrivate, qualityProfile: quality },
      {
        onSuccess: ({ project }) => {
          openTab(project.id);
        },
      },
    );
  };

  return (
    <Card>
      <CardTitle>Nouveau projet</CardTitle>
      <CardDescription>
        Crée le dépôt sur GitHub et le prépare pour le planificateur et les agents.
      </CardDescription>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-name">Nom du dépôt</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-type">Type</Label>
            <select
              id="project-type"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              value={type}
              onChange={(e) => {
                const next = e.target.value as ProjectType;
                setType(next);
                setQuality(DEFAULT_QUALITY_PROFILE[next]);
              }}
            >
              {PROJECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-quality">Profil qualité</Label>
            <select
              id="project-quality"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              value={quality}
              onChange={(e) => {
                setQuality(e.target.value as QualityProfile);
              }}
            >
              {QUALITY_PROFILES.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Visibilité du dépôt</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="visibility"
                checked={!isPrivate}
                onChange={() => {
                  setPrivate(false);
                }}
              />
              Public (minutes Actions gratuites et illimitées)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="visibility"
                checked={isPrivate}
                onChange={() => {
                  setPrivate(true);
                }}
              />
              Privé
            </label>
          </fieldset>
        </div>

        {isPrivate ? (
          <p role="note" className="rounded-md bg-muted p-3 text-sm">
            Dépôt privé : 2 000 minutes GitHub Actions par mois sont incluses ; au-delà, les agents
            s’arrêtent ou deviennent payants.
          </p>
        ) : (
          <p role="note" className="rounded-md bg-warning/15 p-3 text-sm">
            Dépôt public : tout ce qui y sera versé (brief, GDD, maquettes) sera visible de tous. Un
            avertissement sera de nouveau affiché avant chaque versement de brief.
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={name.trim() === '' || create.isPending}>
            {create.isPending ? 'Création en cours…' : 'Créer le projet'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Fermer
          </Button>
        </div>
      </form>

      {create.error instanceof Error && (
        <div className="mt-4 flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {create.error.message}
          </p>
        </div>
      )}
      {create.data && (
        <div className="mt-4 flex flex-col gap-2">
          <p role="status" className="text-sm text-success">
            Projet {create.data.project.id} prêt.
          </p>
          <BootstrapSteps report={create.data.report} />
        </div>
      )}
    </Card>
  );
}
