import { OctokitGitHub, systemClock } from 'github';
import { renderTaskIssueBody, stateLabel, TASK_LABEL } from 'shared';
import { describe, expect, it } from 'vitest';
import { taskBranch } from './context.js';

/**
 * @live (jamais en CI) : une tâche de jeu Unity de bout en bout — agent cloud, éditeur local via
 * le pont Aura, CI GameCI, merge automatique (critère d'acceptation de T20).
 *
 * Prérequis :
 *   - projet Unity minimal bootstrappé (profil qualité unity, CI verte sur main, protection de main) ;
 *   - secrets UNITY_LICENSE, UNITY_EMAIL, UNITY_PASSWORD, CLAUDE_CODE_OAUTH_TOKEN, AURA_BRIDGE_SECRET ;
 *   - sur le poste : cockpit ouvert, pont Unity démarré (liste blanche Aura choisie), tunnel actif,
 *     Unity ouvert sur le clone dédié préparé depuis le cockpit.
 *
 * GITHUB_TOKEN=… AGENTLAKE_UNITY_SANDBOX_REPO=kiamiya/devlake-sandbox-unity npm run test:live
 */
const token = process.env.GITHUB_TOKEN;
const [owner, repo] = (process.env.AGENTLAKE_UNITY_SANDBOX_REPO ?? '').split('/');
const enabled = Boolean(token && owner && repo);

describe.skipIf(!enabled)('@live tâche Unity — bac à sable', () => {
  const ref = { owner: owner ?? '', repo: repo ?? '' };
  const github = new OctokitGitHub({ token: token ?? '' });
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);

  it(
    '« contrôleur de personnage + tests EditMode + scène de test » aboutit à une PR mergée',
    async () => {
      const id = `T${stamp.slice(-4)}`;
      const title = `Contrôleur de personnage ${stamp}`;
      const issue = await github.createIssue(ref, {
        title: `${id} — ${title}`,
        body: renderTaskIssueBody({
          id,
          title,
          description:
            'Contrôleur de personnage (déplacement et saut) en C#, ses tests EditMode, et une scène de test `Assets/Scenes/TestControleur.unity` avec le personnage, créée dans l’éditeur via le pont.',
          kind: 'code',
          profile: 'unity',
          complexity: 'M',
          acceptanceCriteria: [
            'Le personnage avance selon l’entrée horizontale',
            'Le saut n’est possible qu’au sol',
            'La scène de test contient le personnage et un sol',
          ],
          requiredTests: {
            unit: ['déplacement horizontal', 'saut seulement au sol'],
          },
          codeZones: ['Assets/Scripts/', 'Assets/Tests/', 'Assets/Scenes/'],
          exclusiveResources: ['unity-editor'],
          dependencies: [],
        }),
        // Le dispatcher (événement « issues ») prend la tâche prête.
        labels: [TASK_LABEL, stateLabel('ready')],
      });

      // Agent, éditeur, CI et merge automatique : au plus deux heures.
      const branch = taskBranch(id, title);
      const deadline = Date.now() + 120 * 60_000;
      let merged = false;
      let number: number | null = null;
      while (Date.now() < deadline && !merged) {
        await systemClock.sleep(60_000);
        const [pr] = await github.listPullRequests(ref, { head: branch, state: 'all' });
        number = pr?.number ?? null;
        merged = pr?.state === 'merged';
      }
      expect(merged).toBe(true);

      const files = (await github.listPullRequestFiles(ref, number ?? 0)).map((f) => f.filename);
      expect(files.some((f) => /^Assets\/Scripts\/.+\.cs$/.test(f))).toBe(true);
      expect(files.some((f) => /^Assets\/Tests\/.+\.cs$/.test(f))).toBe(true);
      // Scène créée dans l'éditeur, poussée par le pont avec son .meta.
      expect(files).toContain('Assets/Scenes/TestControleur.unity');
      expect(files).toContain('Assets/Scenes/TestControleur.unity.meta');
      expect((await github.getIssue(ref, issue.number)).state).toBe('closed');
    },
    125 * 60_000,
  );
});
