import { Button } from '../../components/ui/button.js';
import { usePrepareClone } from '../../hooks/bridge.js';

/** Clone dédié d'un projet de jeu, que Kia ouvre ensuite dans l'éditeur. */
export function PrepareClone({ projectId }: { projectId: string }) {
  const prepare = usePrepareClone();
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={prepare.isPending}
        onClick={() => {
          prepare.mutate(projectId);
        }}
      >
        Préparer le clone de l’éditeur
      </Button>
      {prepare.error instanceof Error && (
        <p role="alert" className="text-xs text-destructive">
          {prepare.error.message}
        </p>
      )}
      {prepare.data && (
        <div role="status" className="text-xs">
          <p>
            Clone {prepare.data.created ? 'créé' : 'mis à jour'} : <code>{prepare.data.dir}</code>.
            Ouvre ce dossier dans {prepare.data.editor === 'unity' ? 'Unity' : 'Unreal'}.
          </p>
          {prepare.data.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-warning">
              {prepare.data.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
