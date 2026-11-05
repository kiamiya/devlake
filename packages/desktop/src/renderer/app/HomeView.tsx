import { useState } from 'react';
import type { ProjectSummary } from '../../shared/ipc-contract.js';
import { Button } from '../components/ui/button.js';
import { Card, CardDescription, CardTitle } from '../components/ui/primitives.js';
import { useTabs } from '../features/tabs/store.js';
import { ActivityIndicator, QuestionsBadge } from '../features/tabs/TabBar.js';
import { useDiscoverProjects, useOpenProject } from '../hooks/projects.js';
import { NewProjectWizard } from './NewProjectWizard.js';

function ExistingRepositories() {
  const [shown, setShown] = useState(false);
  const discover = useDiscoverProjects(shown);
  const openProject = useOpenProject();
  const openTab = useTabs((s) => s.open);

  if (!shown) {
    return (
      <Button
        variant="outline"
        onClick={() => {
          setShown(true);
        }}
      >
        Ouvrir un dépôt existant
      </Button>
    );
  }

  const error = discover.error ?? openProject.error;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Dépôts déjà bootstrappés sur le compte</p>
      {discover.isPending && <p className="text-sm text-muted-foreground">Recherche sur GitHub…</p>}
      {discover.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucun autre projet AgentLake trouvé.</p>
      )}
      <ul aria-label="Dépôts à ouvrir" className="flex flex-col gap-1">
        {discover.data?.map((ref) => (
          <li
            key={`${ref.owner}/${ref.repo}`}
            className="flex items-center justify-between rounded-md border border-border px-3 py-2"
          >
            <span className="font-mono text-sm">
              {ref.owner}/{ref.repo}
            </span>
            <Button
              size="sm"
              disabled={openProject.isPending}
              onClick={() => {
                openProject.mutate(ref, {
                  onSuccess: (summary) => {
                    openTab(summary.id);
                    void discover.refetch();
                  },
                });
              }}
            >
              Ouvrir {ref.repo}
            </Button>
          </li>
        ))}
      </ul>
      {error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
    </div>
  );
}

export function HomeView({ projects }: { projects: readonly ProjectSummary[] }) {
  const openTab = useTabs((s) => s.open);
  const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">Accueil</h1>
      <Card>
        <CardTitle>Projets</CardTitle>
        <CardDescription>
          Fermer un onglet ou le cockpit n’arrête rien : les projets continuent d’avancer sur
          GitHub.
        </CardDescription>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun projet pour l’instant.</p>
        ) : (
          <ul aria-label="Projets connus" className="mb-4 flex flex-col gap-1">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    openTab(project.id);
                  }}
                >
                  <ActivityIndicator active={project.activeAgents} />
                  <span className="font-mono">{project.id}</span>
                  <QuestionsBadge count={project.pendingQuestions} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-col gap-4">
          {creating ? (
            <NewProjectWizard
              onClose={() => {
                setCreating(false);
              }}
            />
          ) : (
            <div>
              <Button
                onClick={() => {
                  setCreating(true);
                }}
              >
                Nouveau projet
              </Button>
            </div>
          )}
          <ExistingRepositories />
        </div>
      </Card>
    </div>
  );
}
