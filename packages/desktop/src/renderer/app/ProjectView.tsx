import { Button } from '../components/ui/button.js';
import { ContextSection } from '../features/context/ContextSection.js';
import { PlanSection } from '../features/plan/PlanSection.js';
import { QuestionsInbox } from '../features/questions/QuestionsInbox.js';
import { useRebootstrap } from '../hooks/projects.js';
import { cn } from '../lib/utils.js';
import { BootstrapSteps } from './NewProjectWizard.js';
import { PROJECT_SECTIONS, useTabs, type ProjectSection } from '../features/tabs/store.js';

const SECTION_LABELS: Record<ProjectSection, string> = {
  context: 'Contexte',
  plan: 'Plan',
  execution: 'Exécution',
  questions: 'Questions',
  runs: 'Runs',
};

/** Coque d'un projet : barre latérale ; le contenu des vues arrive avec les tâches suivantes. */
export function ProjectView({ projectId }: { projectId: string }) {
  const section = useTabs((s) => s.sections[projectId] ?? 'context');
  const setSection = useTabs((s) => s.setSection);
  const rebootstrap = useRebootstrap();
  return (
    <div className="flex h-full">
      <aside aria-label="Sections du projet" className="w-56 border-r border-border p-2">
        <p className="mb-2 truncate px-2 font-mono text-xs text-muted-foreground" title={projectId}>
          {projectId}
        </p>
        <ul className="flex flex-col gap-1">
          {PROJECT_SECTIONS.map((s) => (
            <li key={s}>
              <button
                type="button"
                aria-current={section === s ? 'page' : undefined}
                className={cn(
                  'w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
                  section === s && 'bg-muted font-medium',
                )}
                onClick={() => {
                  setSection(projectId, s);
                }}
              >
                {SECTION_LABELS[s]}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-col gap-2 border-t border-border pt-4">
          <Button
            size="sm"
            variant="outline"
            disabled={rebootstrap.isPending}
            onClick={() => {
              rebootstrap.mutate(projectId);
            }}
          >
            Relancer le bootstrap
          </Button>
          {rebootstrap.error instanceof Error && (
            <p role="alert" className="text-xs text-destructive">
              {rebootstrap.error.message}
            </p>
          )}
          {rebootstrap.data && <BootstrapSteps report={rebootstrap.data} />}
        </div>
      </aside>
      <section className="flex-1 overflow-auto p-6">
        <h1 className="mb-2 text-xl font-semibold">{SECTION_LABELS[section]}</h1>
        {section === 'context' ? (
          <ContextSection projectId={projectId} />
        ) : section === 'plan' ? (
          <PlanSection projectId={projectId} />
        ) : section === 'questions' ? (
          <QuestionsInbox projectId={projectId} />
        ) : (
          <p className="text-sm text-muted-foreground">Vue à venir.</p>
        )}
      </section>
    </div>
  );
}
