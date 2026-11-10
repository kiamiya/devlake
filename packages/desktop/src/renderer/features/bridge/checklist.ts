import type { BridgeViewData, TunnelStateView } from '../../../shared/ipc-contract.js';

/** `ok` : fait ; `todo` : à faire ; `manual` : à faire et à vérifier soi-même (invisible ici). */
export type CheckStatus = 'ok' | 'todo' | 'manual';

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  /** Ce qu'il reste à faire, ou l'état constaté. */
  hint: string;
}

/**
 * Étapes pour brancher un serveur MCP à un pont, cochées d'après l'état réel : configuration,
 * pont, serveurs, outils autorisés, clones, éditeur, tunnel.
 */
export function bridgeChecklist(
  bridge: BridgeViewData,
  context: { clonesDir: string | null; tunnel: TunnelStateView | null },
): CheckItem[] {
  const blender = bridge.editor === 'blender';
  const failing = bridge.servers.filter((s) => !s.connected);
  const tunnel = context.tunnel;
  return [
    {
      id: 'config',
      label: 'Configuration MCP collée',
      status: bridge.configured ? 'ok' : 'todo',
      hint: bridge.configured
        ? 'Serveur principal ou autre serveur MCP renseigné.'
        : 'Plus haut : coller le bloc JSON du serveur, puis « Enregistrer les réglages ».',
    },
    {
      id: 'running',
      label: 'Pont démarré',
      status: bridge.running ? 'ok' : 'todo',
      hint: bridge.running
        ? `Écoute sur 127.0.0.1:${String(bridge.port ?? bridge.configuredPort)}.`
        : '« Démarrer le pont » ci-dessus.',
    },
    {
      id: 'servers',
      label: 'Serveurs MCP connectés',
      status: bridge.running && bridge.servers.length > 0 && failing.length === 0 ? 'ok' : 'todo',
      hint: !bridge.running
        ? 'Visible une fois le pont démarré.'
        : failing.length > 0
          ? `Injoignable : ${failing.map((s) => `${s.name}${s.error ? ` (${s.error})` : ''}`).join(', ')}. Vérifier que le serveur tourne sur le poste et que sa configuration est juste.`
          : bridge.servers.length === 0
            ? 'Aucun serveur relayé.'
            : `Connectés : ${bridge.servers.map((s) => s.name).join(', ')}.`,
    },
    {
      id: 'tools',
      label: 'Outils autorisés aux agents',
      status: bridge.allowedTools.length > 0 ? 'ok' : 'todo',
      hint:
        bridge.allowedTools.length > 0
          ? `${String(bridge.allowedTools.length)} outil(s) autorisé(s).`
          : 'Aucun outil n’est ouvert par défaut : cocher ceux que les agents peuvent utiliser.',
    },
    {
      id: 'clones',
      label: 'Dossier des clones réglé',
      status: context.clonesDir !== null ? 'ok' : 'todo',
      hint:
        context.clonesDir !== null
          ? context.clonesDir
          : 'Réglages → Éditeurs et Aura → « Dossier des clones d’éditeur ».',
    },
    {
      id: 'editor',
      label: blender ? 'Blender ouvert sur le clone Blender' : 'Éditeur ouvert sur le clone dédié',
      status: 'manual',
      hint: blender
        ? 'Dans chaque projet de jeu : « Préparer le clone Blender », puis ouvrir Blender sur ce clone (vérifié par le pont au lancement des tâches).'
        : 'Dans chaque projet de jeu : « Préparer le clone de l’éditeur », puis ouvrir l’éditeur sur ce clone (vérifié par le pont au lancement des tâches).',
    },
    {
      id: 'tunnel',
      label: 'Tunnel vers les agents',
      status:
        tunnel === null || tunnel.killed
          ? 'todo'
          : tunnel.open || tunnel.autoExpose
            ? 'ok'
            : 'todo',
      hint:
        tunnel === null
          ? 'État du tunnel inconnu.'
          : tunnel.killed
            ? 'Interrupteur actionné : rouvrir le tunnel à la main.'
            : tunnel.open
              ? `Ouvert : ${tunnel.url ?? ''}`
              : tunnel.autoExpose
                ? 'Fermé : il s’ouvrira seul dès qu’une tâche de jeu sera prête.'
                : 'Fermé, ouverture manuelle : « Ouvrir le tunnel ».',
    },
  ];
}
