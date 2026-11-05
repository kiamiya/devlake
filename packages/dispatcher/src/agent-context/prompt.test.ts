import { makeAgentProfile, makeTask } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import { buildPrompt, CONTEXT_BUDGET, tail, type PromptInput } from './prompt.js';

const base: PromptInput = {
  task: makeTask({ id: 'T04', title: 'Ajouter une fonction et son test' }),
  issueNumber: 12,
  profile: makeAgentProfile({ id: 'frontend' }),
  branch: 'task/T04-ajouter-une-fonction-et-son-test',
  context: {
    instructions: '# Projet\n\nTypeScript strict.',
    decisions: '- Supabase pour l’authentification.',
    documents: [
      { path: '.agentlake/context/annexes/maquettes.md', role: 'annex', content: '# Maquettes' },
      {
        path: '.agentlake/context/brief.md',
        role: 'brief',
        content: '# Brief\n\nRéservation de créneaux.',
      },
    ],
  },
  resume: { kind: 'none' },
};

describe('construction du prompt', () => {
  it('premier passage : tâche, règles, instructions, décisions et contexte (régression)', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain('# Tâche T04 — Ajouter une fonction et son test');
    expect(prompt).toContain('l’issue #12');
    expect(prompt).toContain('- Unitaires : Validation du formulaire');
    expect(prompt).toContain('- E2E : Parcours de connexion complet');
    expect(prompt).toContain('`task/T04-ajouter-une-fonction-et-son-test`');
    expect(prompt).not.toContain('## Reprise');
    // Le brief passe avant les annexes.
    expect(prompt.indexOf('brief.md')).toBeLessThan(prompt.indexOf('maquettes.md'));
  });

  it('reprise après une réponse : question et réponse de Kia', () => {
    const prompt = buildPrompt({
      ...base,
      resume: {
        kind: 'answer',
        question: {
          id: 'Q-T04-1',
          blocking: true,
          text: 'Faut-il gérer les fuseaux horaires ?',
          options: [],
        },
        answer: { id: 'Q-T04-1', decision: true, text: 'Oui, Europe/Paris seulement.' },
      },
    });
    expect(prompt).toContain('## Reprise après une réponse');
    expect(prompt).toContain('**Question `Q-T04-1`** : Faut-il gérer les fuseaux horaires ?');
    expect(prompt).toContain('**Réponse** : Oui, Europe/Paris seulement.');
  });

  it('reprise après un échec de CI : tentative, lien et fin des journaux', () => {
    const logs = `${'ligne inutile\n'.repeat(3000)}FAIL src/agenda.test.ts > renvoie 3 créneaux`;
    const prompt = buildPrompt({
      ...base,
      resume: {
        kind: 'ci-failure',
        attempt: 2,
        logs,
        runUrl: 'https://github.com/kiamiya/site/actions/runs/7',
      },
    });
    expect(prompt).toContain('## Reprise après un échec de CI (tentative 2)');
    expect(prompt).toContain('Exécution en échec : https://github.com/kiamiya/site/actions/runs/7');
    expect(prompt).toContain('FAIL src/agenda.test.ts > renvoie 3 créneaux');
    expect(prompt).toContain('caractères coupés');
    expect(prompt).toContain('sans désactiver ni affaiblir de test');
  });

  it('sans CLAUDE.md, décisions ni documents', () => {
    const prompt = buildPrompt({
      ...base,
      context: { instructions: null, decisions: null, documents: [] },
    });
    expect(prompt).toContain('_Aucun CLAUDE.md._');
    expect(prompt).toContain('_Aucune décision._');
    expect(prompt).toContain('_Aucun document versé._');
  });

  it('respecte le budget de contexte', () => {
    const big = 'x'.repeat(CONTEXT_BUDGET + 10);
    const prompt = buildPrompt({
      ...base,
      context: {
        ...base.context,
        documents: [
          { path: '.agentlake/context/brief.md', role: 'brief', content: big },
          { path: '.agentlake/context/annexes/a.md', role: 'annex', content: 'annexe' },
        ],
      },
    });
    expect(prompt).toContain('[… suite dans le fichier …]');
    expect(prompt).toContain(
      '_Non inclus (budget de contexte atteint) : lire le fichier dans le dépôt._',
    );
  });

  it('protège les blocs de journaux contenant déjà des ```', () => {
    const prompt = buildPrompt({
      ...base,
      resume: { kind: 'ci-failure', attempt: 1, logs: '```\nboom', runUrl: null },
    });
    expect(prompt).toContain('````\n```\nboom\n````');
    expect(tail('abc', 10)).toBe('abc');
  });
});
