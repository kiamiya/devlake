import type { FakeGitHub } from 'github';
import { z } from 'zod';
import { loadScenario, SimulatedWorld } from './world.js';

/**
 * Configuration du monde simulé, passée par AGENTLAKE_WORLD (JSON) : un scénario de la
 * bibliothèque par dépôt, et la cadence des pas.
 */
export const WorldConfigSchema = z.object({
  projects: z.record(z.string().regex(/^[^/\s]+$/), z.string().min(1)),
  tickMs: z.number().int().min(50).default(300),
});

/**
 * Démarre le monde simulé dans le processus principal (E2E seulement). Le monde est exposé
 * dans `globalThis.__agentlakeWorld` pour que Playwright lise ses statistiques.
 */
export async function startWorld(fake: FakeGitHub, json: string): Promise<SimulatedWorld> {
  const config = WorldConfigSchema.parse(JSON.parse(json));
  const world = new SimulatedWorld(fake);
  for (const [repo, path] of Object.entries(config.projects))
    world.register({ owner: fake.actor, repo }, await loadScenario(path), 'web');
  (globalThis as { __agentlakeWorld?: SimulatedWorld }).__agentlakeWorld = world;
  const timer = setInterval(() => {
    world.tick().catch((error: unknown) => {
      console.error('Monde simulé :', error);
    });
  }, config.tickMs);
  timer.unref();
  return world;
}
