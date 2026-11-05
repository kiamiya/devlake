import { isGitHubError, type GitHubPort } from 'github';
import {
  GLOBAL_CONFIG_PATH,
  GLOBAL_CONFIG_REPOSITORY,
  renderGlobalConfig,
  type GlobalConfig,
} from 'shared';

export class GlobalConfigSyncError extends Error {
  constructor(cause: unknown) {
    super(
      `Réglage enregistré dans le cockpit, mais pas dans ${GLOBAL_CONFIG_REPOSITORY} : ${cause instanceof Error ? cause.message : String(cause)} Les dispatchers gardent l’ancien plafond.`,
      { cause },
    );
    this.name = 'GlobalConfigSyncError';
  }
}

/**
 * Publie la configuration globale dans le dépôt privé `<login>/devlake-config`, créé au
 * premier besoin. Rien n'est commité si le fichier est déjà à jour.
 */
export async function publishGlobalConfig(
  github: GitHubPort,
  config: GlobalConfig,
): Promise<'created' | 'updated' | 'unchanged'> {
  const owner = (await github.getAuthenticatedUser()).login;
  const ref = { owner, repo: GLOBAL_CONFIG_REPOSITORY };
  let created = false;
  try {
    await github.getRepository(ref);
  } catch (error) {
    if (!isGitHubError(error, 'not-found')) throw error;
    await github.createRepository({
      name: GLOBAL_CONFIG_REPOSITORY,
      private: true,
      description: 'Configuration globale d’AgentLake (plafond d’agents), écrite par le cockpit',
    });
    created = true;
  }
  const content = renderGlobalConfig(config);
  if ((await github.getFile(ref, GLOBAL_CONFIG_PATH))?.content === content) return 'unchanged';
  await github.commitFiles(ref, {
    branch: 'main',
    message: `chore: plafond global de ${String(config.maxConcurrentAgents)} agents`,
    changes: [{ path: GLOBAL_CONFIG_PATH, content }],
  });
  return created ? 'created' : 'updated';
}
