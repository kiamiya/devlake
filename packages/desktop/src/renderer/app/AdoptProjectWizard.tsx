import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_QUALITY_PROFILE,
  PROJECT_TYPES,
  QUALITY_PROFILES,
  type ProjectType,
  type QualityProfile,
} from 'shared';
import { useEffect, useState } from 'react';
import type { AdoptableRepository, AdoptionReport } from '../../shared/ipc-contract.js';
import { Button } from '../components/ui/button.js';
import { Card, CardDescription, CardTitle, Label } from '../components/ui/primitives.js';
import { useTabs } from '../features/tabs/store.js';
import { invoke } from '../lib/ipc.js';
import { BootstrapSteps, TYPE_LABELS } from './NewProjectWizard.js';

const formatSize = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} Mo`
    : `${String(Math.ceil(bytes / 1024))} Ko`;

function List({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <ul aria-label={label} className="ml-4 list-disc text-sm">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

const configured = (value: boolean | null, what: string) =>
  value === null
    ? null
    : value
      ? `${what} : configuré dans le cockpit.`
      : `${what} : à configurer dans Réglages avant les tâches qui en ont besoin.`;

/** Rapport de détection : ce qui sera gardé, ce qui va changer, ce qui bloque. */
function Report({ report }: { report: AdoptionReport }) {
  const facts = [
    report.workflows.length > 0
      ? `Workflows gardés : ${report.workflows.map((w) => w.replace('.github/workflows/', '')).join(', ')}.`
      : 'Aucun workflow existant.',
    report.requiredChecks.length > 0
      ? `Checks déjà exigés, gardés : ${report.requiredChecks.join(', ')}.`
      : null,
    `${String(report.openIssues)} issue(s) et ${String(report.openPullRequests)} PR ouvertes : prises en compte par l’état des lieux, jamais modifiées.`,
    report.blendFiles > 0
      ? `${String(report.blendFiles)} fichier(s) .blend : agents Artiste 3D possibles.`
      : null,
    configured(
      report.engineConfigured,
      `MCP ${report.type === 'unreal' ? 'Unreal' : 'Unity'} (Aura…)`,
    ),
    configured(report.blenderConfigured, 'MCP Blender'),
  ].filter((f): f is string => f !== null);
  return (
    <div className="flex flex-col gap-3">
      {report.blockers.length > 0 && (
        <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <p className="font-medium">Reprise impossible en l’état :</p>
          <List label="Blocages" items={report.blockers} />
        </div>
      )}
      {report.changes.length > 0 && (
        <div className="rounded-md bg-warning/15 p-3">
          <p className="text-sm font-medium">Réglages du dépôt qui vont changer :</p>
          <List label="Changements" items={report.changes} />
        </div>
      )}
      {report.warnings.length > 0 && <List label="Avertissements" items={report.warnings} />}
      {report.heavyOutsideLfs.length > 0 && (
        <details className="text-sm">
          <summary>Fichiers lourds hors Git LFS ({String(report.heavyOutsideLfsCount)})</summary>
          <ul className="ml-4 font-mono text-xs">
            {report.heavyOutsideLfs.map((f) => (
              <li key={f.path}>
                {f.path} — {formatSize(f.size)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <List label="Ce qui est gardé" items={facts} />
    </div>
  );
}

/**
 * Reprise d'un projet existant : choix du dépôt (perso ou organisation), détection, réglages
 * à confirmer, puis bootstrap en mode reprise. Rien n'est modifié avant la confirmation.
 */
export function AdoptProjectWizard({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const openTab = useTabs((s) => s.open);
  const [selected, setSelected] = useState<AdoptableRepository | null>(null);
  const [type, setType] = useState<ProjectType | null>(null);
  const [quality, setQuality] = useState<QualityProfile | null>(null);
  const [accepted, setAccepted] = useState(false);

  const candidates = useQuery({
    queryKey: ['projects', 'adoptable'],
    queryFn: () => invoke('projects:adoptable'),
  });
  const detection = useQuery({
    queryKey: ['projects', 'detect', selected?.owner, selected?.repo, type],
    queryFn: () =>
      invoke('projects:detect', {
        owner: selected?.owner ?? '',
        repo: selected?.repo ?? '',
        ...(type !== null ? { type } : {}),
      }),
    enabled: selected !== null,
    retry: false,
  });
  const report = detection.data;
  useEffect(() => {
    if (report && type === null) setType(report.detectedType);
    if (report && quality === null) setQuality(report.qualityProfile);
  }, [report, type, quality]);

  const adopt = useMutation({
    mutationFn: () =>
      invoke('projects:adopt', {
        owner: selected?.owner ?? '',
        repo: selected?.repo ?? '',
        type: type ?? 'tool',
        qualityProfile: quality ?? 'tool',
        acceptChanges: accepted,
      }),
    onSuccess: async ({ project }) => {
      await client.invalidateQueries({ queryKey: ['projects'] });
      await client.invalidateQueries({ queryKey: ['activity'] });
      openTab(project.id);
    },
  });

  const choose = (repo: AdoptableRepository | null) => {
    setSelected(repo);
    setType(null);
    setQuality(null);
    setAccepted(false);
    adopt.reset();
  };

  const blocked = report !== undefined && report.blockers.length > 0;
  const needsConsent = report !== undefined && report.changes.length > 0 && !accepted;
  const error = candidates.error ?? detection.error ?? adopt.error;

  return (
    <Card>
      <CardTitle>Reprendre un projet existant</CardTitle>
      <CardDescription>
        Un dépôt que tu administres (ton compte ou une organisation). Le cockpit l’analyse, te
        montre ce qui va changer, puis le prépare pour les agents sans toucher au code existant.
      </CardDescription>

      {selected === null ? (
        <div className="flex flex-col gap-2">
          {candidates.isPending && (
            <p className="text-sm text-muted-foreground">Recherche des dépôts sur GitHub…</p>
          )}
          {candidates.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">Aucun autre dépôt administré.</p>
          )}
          <ul
            aria-label="Dépôts à reprendre"
            className="flex max-h-80 flex-col gap-1 overflow-y-auto"
          >
            {candidates.data?.map((repo) => (
              <li
                key={`${repo.owner}/${repo.repo}`}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <span className="font-mono text-sm">
                  {repo.owner}/{repo.repo}
                  {repo.private ? ' · privé' : ''}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    choose(repo);
                  }}
                >
                  Analyser {repo.repo}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="font-mono text-sm">
            {selected.owner}/{selected.repo}
          </p>
          {detection.isFetching && (
            <p className="text-sm text-muted-foreground">Analyse du dépôt…</p>
          )}
          {report?.alreadyAgentLake === true && (
            <p role="note" className="rounded-md bg-muted p-3 text-sm">
              Ce dépôt est déjà un projet AgentLake : la reprise l’ouvre simplement.
            </p>
          )}
          {report && type !== null && quality !== null && (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="adopt-type">
                    Type (détecté : {TYPE_LABELS[report.detectedType]})
                  </Label>
                  <select
                    id="adopt-type"
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                    value={type}
                    onChange={(e) => {
                      const next = e.target.value as ProjectType;
                      setType(next);
                      setQuality(DEFAULT_QUALITY_PROFILE[next]);
                      setAccepted(false);
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
                  <Label htmlFor="adopt-quality">Profil qualité</Label>
                  <select
                    id="adopt-quality"
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
              </div>
              <Report report={report} />
              {report.changes.length > 0 && !blocked && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => {
                      setAccepted(e.target.checked);
                    }}
                  />
                  J’accepte ces changements de réglages
                </label>
              )}
            </>
          )}
          <div className="flex items-center gap-2">
            <Button
              disabled={
                report === undefined ||
                blocked ||
                needsConsent ||
                adopt.isPending ||
                adopt.isSuccess
              }
              onClick={() => {
                adopt.mutate();
              }}
            >
              {adopt.isPending ? 'Reprise en cours…' : 'Reprendre le projet'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                choose(null);
              }}
            >
              Autre dépôt
            </Button>
          </div>
        </div>
      )}

      {error instanceof Error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error.message}
        </p>
      )}
      {adopt.data && (
        <div className="mt-4 flex flex-col gap-2">
          <p role="status" className="text-sm text-success">
            Projet {adopt.data.project.id} repris.
            {adopt.data.renamedBranch !== null &&
              ` Branche « ${adopt.data.renamedBranch} » renommée en « main ».`}{' '}
            Étape suivante : section Plan, « Lancer l’état des lieux ».
          </p>
          {adopt.data.report && <BootstrapSteps report={adopt.data.report} />}
        </div>
      )}
      <div className="mt-4">
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
      </div>
    </Card>
  );
}
