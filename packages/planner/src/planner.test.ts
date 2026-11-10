import { FakeGitHub } from 'github';
import {
  CADRAGE_LABEL,
  CONTEXT_INDEX_PATH,
  parseQuestionComment,
  ProjectPlanSchema,
  renderAnswerComment,
  type ProjectType,
} from 'shared';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { renderCadrageBody } from './cadrage.js';
import { FakeClaude } from './claude/fake-claude.js';
import { MAX_ATTEMPTS, PLAN_PATH, runPlanner, T00_NEW, type PlannerDeps } from './planner.js';
import { loadPrompts, renderPrompt, PromptError, type Prompts } from './prompts.js';

interface Reference {
  type: ProjectType;
  brief: string;
  questions: { questions: { blocking: boolean; text: string; options: string[] }[] };
  plan: Record<string, unknown>;
  expectedAgents: number;
}
const reference = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./__fixtures__/references/${name}.json`, import.meta.url), 'utf8'),
  ) as Reference;

const ref = { owner: 'kiamiya', repo: 'projet' };
let prompts: Prompts;
beforeAll(async () => {
  prompts = await loadPrompts();
});

/** Dépôt bootstrappé avec un brief versé, et ses fichiers lus par le planificateur. */
function setup(type: ProjectType, brief: string, maxConcurrentAgents?: number) {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(ref);
  const files: Record<string, string> = {
    '.agentlake/project.yml': stringify({
      type,
      qualityProfile: type === 'script' ? 'tool' : type,
      limits: {
        maxAttempts: 3,
        ...(maxConcurrentAgents !== undefined ? { maxConcurrentAgents } : {}),
      },
      profiles: ['architect', 'reviewer'],
      exclusiveResources: [],
      bridgeRequired: false,
    }),
    [CONTEXT_INDEX_PATH]: JSON.stringify({
      version: 1,
      files: [
        {
          path: '.agentlake/context/brief.md',
          role: 'brief',
          source: 'brief.docx',
          sha256: 'a'.repeat(64),
          size: brief.length,
          importedAt: '2026-11-05T10:00:00.000Z',
          note: 'Version validée',
        },
      ],
    }),
    '.agentlake/context/brief.md': brief,
  };
  const claude = new FakeClaude();
  const deps: PlannerDeps = {
    github,
    claude,
    prompts,
    readFile: (path) => Promise.resolve(files[path] ?? null),
    workspace: '/w',
  };
  return { github, claude, deps, files };
}

const input = { ref, mode: 'auto' as const, model: 'modele-planificateur', maxAgents: 8 };

async function cadrageComments(github: FakeGitHub, issueNumber: number) {
  return (await github.listComments(ref, issueNumber)).map((c) => c.body);
}

describe('prompts', () => {
  it('rend la clarification et la découpe (régression)', () => {
    expect(
      renderPrompt(prompts.clarification, {
        PROJECT: 'kiamiya/projet (web)',
        TYPE_GUIDANCE: prompts.types.web,
        DOCUMENTS: '- `brief.md`',
        REPRISE: '',
      }),
    ).toMatchSnapshot();
    expect(
      renderPrompt(prompts.decoupe, {
        PROJECT: 'kiamiya/projet (unity)',
        TYPE_GUIDANCE: prompts.types.unity,
        DOCUMENTS: '- `gdd.md`',
        ANSWERS: '- **C1** Vue ?\n  → Dessus',
        INSTRUCTION: '_Aucune consigne particulière._',
        TEST_CATEGORIES: 'unit, e2e',
        PROFILES: 'architect, unity',
        FIRST_TASK_RULE: T00_NEW,
        ASSETS: '',
      }),
    ).toMatchSnapshot();
  });

  it('a un complément pour chaque type et refuse un marqueur non fourni', () => {
    for (const type of ['web', 'backend', 'mobile', 'tool', 'script', 'unity', 'unreal'] as const) {
      expect(prompts.types[type].length).toBeGreaterThan(50);
    }
    expect(() => renderPrompt('Bonjour {{NOM}}', {})).toThrow(PromptError);
  });
});

describe.each(['web', 'unity', 'cli'])('brief de référence « %s » (régression)', (name) => {
  it('pose ses questions, puis produit un plan valide sur plan/v1', async () => {
    const r = reference(name);
    const { github, claude, deps } = setup(r.type, r.brief);
    claude.push(FakeClaude.structured(r.questions));
    const blocking = r.questions.questions.some((q) => q.blocking);
    // Sans question bloquante, la découpe suit dans la même exécution.
    if (!blocking) claude.push(FakeClaude.structured(r.plan));

    const first = await runPlanner(input, deps);
    if (blocking) {
      expect(first.phase).toBe('clarification');
      const issueNumber = first.issueNumber;
      const posted = (await cadrageComments(github, issueNumber)).map((b) =>
        parseQuestionComment(b),
      );
      expect(posted.every((p) => p.ok)).toBe(true);
      expect(posted.map((p) => (p.ok ? p.value.id : ''))).toEqual(
        r.questions.questions.map((_, i) => `C${String(i + 1)}`),
      );

      // Sans réponse, le planificateur attend.
      expect(await runPlanner(input, deps)).toMatchObject({ phase: 'waiting', pending: ['C1'] });
      await github.createComment(
        ref,
        issueNumber,
        renderAnswerComment({ id: 'C1', decision: true, text: 'Première option.' }),
      );
    }

    let outcome = first;
    if (blocking) {
      claude.push(FakeClaude.structured(r.plan));
      outcome = await runPlanner(input, deps);
    }
    expect(outcome).toMatchObject({
      phase: 'plan',
      version: 1,
      branch: 'plan/v1',
      agents: r.expectedAgents,
    });

    const plan = ProjectPlanSchema.parse(
      JSON.parse((await github.getFile(ref, PLAN_PATH, 'plan/v1'))?.content ?? ''),
    );
    expect(plan.proposedAgents).toBe(r.expectedAgents);
    expect(await github.getFile(ref, PLAN_PATH)).toBeNull();

    // Claude lit les documents en lecture seule, avec le modèle des réglages.
    const last = claude.requests.at(-1);
    expect(last).toMatchObject({
      model: 'modele-planificateur',
      allowedTools: ['Read', 'Glob', 'Grep'],
      cwd: '/w',
    });
    expect(last?.prompt).toContain(
      '`.agentlake/context/brief.md` (brief, d’après brief.docx — note : Version validée)',
    );
    if (blocking) expect(last?.prompt).toContain('→ Première option.');
  });
});

describe('planificateur', () => {
  const web = reference('web');

  it('crée l’issue Cadrage avec ses réglages et ne repose pas les questions', async () => {
    const { github, claude, deps } = setup('web', web.brief);
    claude.push(FakeClaude.structured(web.questions));
    const first = await runPlanner(input, deps);
    const issue = await github.getIssue(ref, first.issueNumber);
    expect(issue).toMatchObject({ title: 'Cadrage', labels: [CADRAGE_LABEL] });
    expect(issue.body).toContain('"model":"modele-planificateur"');

    // Relance déclenchée par un commentaire : réglages relus dans l'issue.
    expect(await runPlanner({ ref, mode: 'auto' }, deps)).toMatchObject({ phase: 'waiting' });
    expect(claude.requests).toHaveLength(1);
  });

  it('une question ignorée ne bloque plus ; une non bloquante sans réponse prend le choix par défaut', async () => {
    const { github, claude, deps } = setup('web', web.brief);
    claude.push(FakeClaude.structured(web.questions));
    const first = await runPlanner(input, deps);
    await github.createComment(
      ref,
      first.issueNumber,
      renderAnswerComment({ id: 'C1', decision: false, text: 'Question ignorée.', ignored: true }),
    );
    claude.push(FakeClaude.structured(web.plan));
    expect(await runPlanner(input, deps)).toMatchObject({ phase: 'plan' });
    const prompt = claude.requests.at(-1)?.prompt ?? '';
    expect(prompt).toContain('→ _question ignorée_');
    expect(prompt).toContain('→ _sans réponse : appliquer le choix par défaut_');
  });

  it('renvoie les erreurs du validateur à Claude et réussit au deuxième essai', async () => {
    const { claude, deps } = setup('web', web.brief);
    claude.push(FakeClaude.structured({ questions: [] }));
    const tasks = (web.plan.tasks as Record<string, unknown>[]).map((t) => ({ ...t }));
    const broken = {
      ...web.plan,
      tasks: [tasks[0], { ...tasks[1], dependencies: ['T42'] }, ...tasks.slice(2)],
    };
    claude.push(FakeClaude.structured(broken), FakeClaude.structured(web.plan));

    expect(await runPlanner(input, deps)).toMatchObject({ phase: 'plan', version: 1 });
    expect(claude.requests).toHaveLength(3);
    const retry = claude.requests[2]?.prompt ?? '';
    expect(retry).toContain('# Correction du plan');
    expect(retry).toContain('La tâche T01 dépend de T42, qui n’existe pas dans le plan.');
  });

  it('après 3 essais refusés : échec visible dans l’issue avec la sortie brute', async () => {
    const { github, claude, deps } = setup('web', web.brief);
    claude.push(FakeClaude.structured({ questions: [] }));
    for (let i = 0; i < MAX_ATTEMPTS; i += 1)
      claude.push({ text: 'Voici mon plan : pas de JSON', structured: null });
    const outcome = await runPlanner(input, deps);
    expect(outcome.phase).toBe('failed');
    const last = (await cadrageComments(github, outcome.issueNumber)).at(-1) ?? '';
    expect(last).toContain('**Plan refusé après 3 essais.**');
    expect(last).toContain('Voici mon plan : pas de JSON');
    expect(await github.branchExists(ref, 'plan/v1')).toBe(false);
  });

  it('régénère sur plan/v2 avec la consigne de Kia, sans repasser par les questions', async () => {
    const { github, claude, deps } = setup('tool', reference('cli').brief, 1);
    claude.push(
      FakeClaude.structured({ questions: [] }),
      FakeClaude.structured(reference('cli').plan),
    );
    await runPlanner(input, deps);
    claude.push(FakeClaude.structured(reference('cli').plan));
    const outcome = await runPlanner(
      { ...input, mode: 'regenerate', instruction: 'Fusionner T01 et T02.' },
      deps,
    );
    expect(outcome).toMatchObject({ phase: 'plan', version: 2, branch: 'plan/v2' });
    expect(claude.requests.at(-1)?.prompt).toContain('Fusionner T01 et T02.');
    expect(await github.branchExists(ref, 'plan/v1')).toBe(true);
  });

  it('applique le plafond du projet (project.yml)', async () => {
    const { claude, deps } = setup('web', web.brief, 1);
    claude.push(FakeClaude.structured({ questions: [] }), FakeClaude.structured(web.plan));
    expect(await runPlanner(input, deps)).toMatchObject({ phase: 'plan', agents: 1 });
  });

  it('signale une réponse de clarification invalide', async () => {
    const { github, claude, deps } = setup('web', web.brief);
    claude.push(FakeClaude.structured({ questions: [{ blocking: 'oui' }] }));
    const outcome = await runPlanner(input, deps);
    expect(outcome.phase).toBe('failed');
    expect((await cadrageComments(github, outcome.issueNumber)).at(-1)).toContain(
      '**Clarification impossible**',
    );
  });

  it('refuse sans modèle, ou sans project.yml valide', async () => {
    const { deps, files } = setup('web', web.brief);
    await expect(runPlanner({ ref, mode: 'auto' }, deps)).rejects.toThrow(
      'Aucun modèle pour le planificateur',
    );
    files['.agentlake/project.yml'] = 'type: inconnu\n';
    await expect(runPlanner(input, deps)).rejects.toThrow('.agentlake/project.yml invalide');
    delete files['.agentlake/project.yml'];
    await expect(runPlanner(input, deps)).rejects.toThrow('le dépôt n’est pas bootstrappé');
  });

  it('sans document versé, le prompt le signale', async () => {
    const { claude, deps } = setup('web', web.brief);
    const readFile = deps.readFile;
    deps.readFile = (path) =>
      path === CONTEXT_INDEX_PATH ? Promise.resolve(null) : readFile(path);
    claude.push(FakeClaude.structured({ questions: [] }), FakeClaude.structured(web.plan));
    await runPlanner(input, deps);
    expect(claude.requests[0]?.prompt).toContain('Aucun document versé');
    expect(renderCadrageBody({ model: 'm', maxAgents: 2 })).toContain('ignored=true');
  });
});

describe('projet repris', () => {
  const web = reference('web');
  const adopt = (files: Record<string, string>) => {
    files['.agentlake/project.yml'] = `${files['.agentlake/project.yml'] ?? ''}adopted: true\n`;
  };

  it('état des lieux : issues et PR ouvertes données à Claude, document sur etat-des-lieux/v1', async () => {
    const { github, claude, deps, files } = setup('web', web.brief);
    adopt(files);
    await github.createIssue(ref, { title: 'Bug du formulaire', body: '', labels: ['bug'] });
    await github.createIssue(ref, { title: 'T01', body: '', labels: ['agentlake:task'] });
    const markdown = `# État des lieux\n\n${'Le dépôt contient une application React. '.repeat(10)}`;
    claude.push(FakeClaude.structured({ markdown }));
    const outcome = await runPlanner({ ...input, mode: 'inventory' }, deps);
    expect(outcome).toMatchObject({ phase: 'inventory', version: 1, branch: 'etat-des-lieux/v1' });
    const prompt = claude.requests[0]?.prompt ?? '';
    expect(prompt).toContain('Bug du formulaire [bug]');
    expect(prompt).not.toContain('T01');
    expect(claude.requests[0]?.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(
      (await github.getFile(ref, '.agentlake/context/etat-des-lieux.md', 'etat-des-lieux/v1'))
        ?.content,
    ).toBe(`${markdown.trim()}\n`);
    expect((await cadrageComments(github, outcome.issueNumber)).at(-1)).toContain(
      'État des lieux v1 prêt',
    );
    // Réponse trop courte : échec visible.
    claude.push(FakeClaude.structured({ markdown: 'court' }));
    expect((await runPlanner({ ...input, mode: 'inventory' }, deps)).phase).toBe('failed');
  });

  it('pas de plan avant l’état des lieux validé ; ensuite T00 d’audit et brief facultatif', async () => {
    const { claude, deps, files } = setup('web', web.brief);
    adopt(files);
    await expect(runPlanner(input, deps)).rejects.toThrow('lancer l’état des lieux');
    const index = JSON.parse(files[CONTEXT_INDEX_PATH] ?? '{}') as { files: object[] };
    index.files.push({
      path: '.agentlake/context/etat-des-lieux.md',
      role: 'inventory',
      source: 'etat-des-lieux/v1 (planificateur)',
      sha256: 'b'.repeat(64),
      size: 10,
      importedAt: '2026-11-10T10:00:00.000Z',
    });
    files[CONTEXT_INDEX_PATH] = JSON.stringify(index);
    claude.push(FakeClaude.structured({ questions: [] }), FakeClaude.structured(web.plan));
    expect(await runPlanner(input, deps)).toMatchObject({ phase: 'plan' });
    expect(claude.requests[0]?.prompt).toContain('## Projet repris');
    expect(claude.requests[1]?.prompt).toContain('audit et la remise au vert');
    expect(claude.requests[1]?.prompt).not.toContain('bootstrap du dépôt par le profil');
  });

  it('état des lieux refusé pour un projet créé par AgentLake', async () => {
    const { deps } = setup('web', web.brief);
    await expect(runPlanner({ ...input, mode: 'inventory' }, deps)).rejects.toThrow(
      'réservé aux projets repris',
    );
  });
});
