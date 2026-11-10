import type { EditorId } from 'shared';
import type { BridgeViewData, TunnelStateView } from '../../../shared/ipc-contract.js';
import { EDITOR_LABELS } from '../../hooks/bridge.js';
import { cn } from '../../lib/utils.js';
import { bridgeChecklist, type CheckStatus } from './checklist.js';

const STDIO_EXAMPLE = `{
  "command": "uvx",
  "args": ["nom-du-serveur-mcp"]
}`;
const MCP_SERVERS_EXAMPLE = `{
  "mcpServers": {
    "unity": { "command": "…", "args": ["…"] }
  }
}`;
const HTTP_EXAMPLE = `{
  "url": "http://127.0.0.1:<port>/mcp"
}`;

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{children}</pre>
  );
}

/** Marche à suivre pour brancher un serveur MCP (Aura, Unity MCP, Unreal MCP, Blender…). */
export function McpGuide({ editor }: { editor: EditorId }) {
  const label = EDITOR_LABELS[editor];
  const blender = editor === 'blender';
  const main = blender
    ? 'Configuration MCP Blender (blender-mcp)'
    : `Configuration MCP Aura — ${label}`;
  return (
    <details className="rounded-md border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Comment brancher un serveur MCP ({label})
      </summary>
      <ol className="mt-2 ml-5 flex list-decimal flex-col gap-2">
        <li>
          Sur ce poste, installe et démarre le serveur MCP {blender ? 'de Blender' : `de ${label}`}{' '}
          (Aura, ou un autre serveur MCP de l’éditeur), en suivant sa documentation.
        </li>
        <li>
          Copie sa configuration MCP (le bloc JSON de sa documentation) et colle-la :
          <ul className="ml-5 list-disc">
            <li>
              dans « {main} » pour le serveur principal{blender ? '' : ' (Aura)'} ;
            </li>
            <li>
              ou, pour un serveur de plus, « Ajouter un serveur MCP » sous « Autres serveurs MCP —{' '}
              {label} » : un nom en minuscules (ex. <code>{blender ? 'outils' : editor}</code>),
              puis le bloc. Le nom « aura » est réservé.
            </li>
          </ul>
        </li>
        <li>
          Formes acceptées : une commande lancée par le pont,
          <Code>{STDIO_EXAMPLE}</Code>
          un bloc « mcpServers » copié tel quel (le premier serveur est pris),
          <Code>{MCP_SERVERS_EXAMPLE}</Code>
          ou l’adresse d’un serveur HTTP déjà lancé sur ce poste. Une adresse distante est refusée :
          le pont ne relaie que des outils du poste.
          <Code>{HTTP_EXAMPLE}</Code>
        </li>
        <li>« Enregistrer les réglages ».</li>
        <li>
          Plus bas, panneau « Pont Aura », pont {label} : « Démarrer le pont », vérifier que chaque
          serveur est « connecté » (sinon l’erreur s’affiche), puis cocher les outils que les agents
          peuvent utiliser. Ils sont nommés <code>serveur__outil</code> ; aucun n’est ouvert par
          défaut.
        </li>
        <li>
          Dans chaque projet de jeu : «{' '}
          {blender ? 'Préparer le clone Blender' : 'Préparer le clone de l’éditeur'} », puis ouvrir{' '}
          {blender ? 'Blender' : 'l’éditeur'} sur ce clone.
        </li>
        <li>
          Le tunnel s’ouvre seul dès qu’une tâche de jeu est prête (sauf exposition manuelle). Pour
          essayer : une tâche ad hoc de profil <code>{editor}</code> très simple, puis suivre son
          run.
        </li>
      </ol>
    </details>
  );
}

const STATUS_STYLE: Record<CheckStatus, { mark: string; className: string; label: string }> = {
  ok: { mark: '✓', className: 'text-success', label: 'fait' },
  todo: { mark: '○', className: 'text-muted-foreground', label: 'à faire' },
  manual: { mark: '◐', className: 'text-warning', label: 'à vérifier toi-même' },
};

/** Étapes du branchement cochées d'après l'état réel du pont, du tunnel et des réglages. */
export function BridgeChecklist({
  bridge,
  clonesDir,
  tunnel,
}: {
  bridge: BridgeViewData;
  clonesDir: string | null;
  tunnel: TunnelStateView | null;
}) {
  const items = bridgeChecklist(bridge, { clonesDir, tunnel });
  const done = items.filter((i) => i.status === 'ok').length;
  return (
    <details className="text-sm" open={done < items.length - 1}>
      <summary className="cursor-pointer font-medium">
        Vérification du branchement ({String(done)}/{String(items.length)})
      </summary>
      <ul
        aria-label={`Vérification du pont ${EDITOR_LABELS[bridge.editor]}`}
        className="mt-2 flex flex-col gap-1"
      >
        {items.map((item) => {
          const style = STATUS_STYLE[item.status];
          return (
            <li key={item.id} className="flex gap-2">
              <span aria-label={style.label} className={cn('w-4 shrink-0', style.className)}>
                {style.mark}
              </span>
              <span>
                <span className="font-medium">{item.label}</span>
                <span className="text-xs text-muted-foreground"> — {item.hint}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
