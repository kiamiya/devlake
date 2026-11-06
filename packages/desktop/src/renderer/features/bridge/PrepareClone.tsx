import { Button } from '../../components/ui/button.js';
import { usePrepareClone } from '../../hooks/bridge.js';

const OPEN_IN = { unity: 'Unity', unreal: 'Unreal', blender: 'Blender' } as const;

/**
 * Clones dédiés d'un projet de jeu, que Kia ouvre ensuite dans l'éditeur : celui du moteur, et
 * celui de Blender (agents Artiste 3D), distinct pour travailler en parallèle.
 */
export function PrepareClone({ projectId }: { projectId: string }) {
  const prepare = usePrepareClone();
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={prepare.isPending}
        onClick={() => {
          prepare.mutate({ projectId, target: 'engine' });
        }}
      >
        Préparer le clone de l’éditeur
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={prepare.isPending}
        onClick={() => {
          prepare.mutate({ projectId, target: 'blender' });
        }}
      >
        Préparer le clone Blender
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
            {prepare.data.editor === 'blender'
              ? ' Lance Blender avec son extension MCP : les agents Artiste 3D y travaillent.'
              : ` Ouvre ce dossier dans ${OPEN_IN[prepare.data.editor]}.`}
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
