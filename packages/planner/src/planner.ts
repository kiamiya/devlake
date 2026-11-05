import type { GitHubPort, RepoRef } from 'github';
import {
  CADRAGE_LABEL,
  DEFAULT_RUNNER_CAP,
  proposeAgents,
  CONTEXT_INDEX_PATH,
  ContextIndexSchema,
  formatZodError,
  PlanDraftSchema,
  PROFILE_IDS,
  ProjectConfigSchema,
  ProjectPlanSchema,
  QuestionSchema,
  renderQuestionComment,
  TEST_CATEGORIES,
  type ProjectConfig,
  type ProjectPlan,
  type Question,
} from 'shared';
import { parse } from 'yaml';
import { z } from 'zod';

import {
  findCadrageIssue,
  pendingBlocking,
  readCadrageSettings,
  readQuestions,
  renderCadrageBody,
  type CadrageSettings,
  type QuestionStatus,
} from './cadrage.js';
import type { ClaudePort } from './claude/port.js';
import { renderPrompt, type Prompts } from './prompts.js';

export const PLAN_PATH = '.agentlake/plan.json';
export const PROJECT_CONFIG_PATH = '.agentlake/project.yml';
export const MAX_ATTEMPTS = 3;
/** Outils de Claude pour le planificateur : lecture seule. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

export interface PlannerInput {
  ref: RepoRef;
  /** `auto` : questions puis plan quand tout est répondu ; `regenerate` : nouveau plan tout de suite. */
  mode: 'auto' | 'regenerate';
  /** Modèle et plafond global : fournis par le cockpit, sinon relus dans l'issue Cadrage. */
  model?: string | undefined;
  maxAgents?: number | undefined;
  /** Consigne libre de Kia pour (re)générer le plan. */
  instruction?: string | undefined;
}

export interface PlannerDeps {
  github: GitHubPort;
  claude: ClaudePort;
  prompts: Prompts;
  /** Lecture d'un fichier de la copie de travail du projet. */
  readFile: (path: string) => Promise<string | null>;
  /** Dossier de la copie de travail, où Claude lit les documents. */
  workspace: string;
}

export type PlannerOutcome =
  | { phase: 'clarification'; issueNumber: number; questions: string[] }
  | { phase: 'waiting'; issueNumber: number; pending: string[] }
  | {
      phase: 'plan';
      issueNumber: number;
      version: number;
      branch: string;
      agents: number;
      tasks: number;
    }
  | { phase: 'failed'; issueNumber: number; errors: string };

export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerError';
  }
}

const QuestionsOutputSchema = z.object({
  questions: z.array(QuestionSchema.omit({ id: true })),
});

async function projectConfig(readFile: PlannerDeps['readFile']): Promise<ProjectConfig> {
  const text = await readFile(PROJECT_CONFIG_PATH);
  if (text === null)
    throw new PlannerError(`${PROJECT_CONFIG_PATH} absent : le dépôt n’est pas bootstrappé.`);
  const parsed = ProjectConfigSchema.safeParse(parse(text));
  if (!parsed.success)
    throw new PlannerError(`${PROJECT_CONFIG_PATH} invalide :\n${formatZodError(parsed.error)}`);
  return parsed.data;
}

async function documentsList(readFile: PlannerDeps['readFile']): Promise<string> {
  const text = await readFile(CONTEXT_INDEX_PATH);
  if (text === null) return '_Aucun document versé : demander le brief en question bloquante._';
  const index = ContextIndexSchema.safeParse(JSON.parse(text));
  if (!index.success) throw new PlannerError(`${CONTEXT_INDEX_PATH} invalide.`);
  const docs = index.data.files.filter((f) => f.role !== 'asset');
  if (docs.length === 0) return '_Aucun document versé : demander le brief en question bloquante._';
  return docs
    .map(
      (d) =>
        `- \`${d.path}\` (${d.role}, d’après ${d.source}${d.note ? ` — note : ${d.note}` : ''})`,
    )
    .join('\n');
}

function answersText(statuses: readonly QuestionStatus[]): string {
  if (statuses.length === 0) return '_Aucune question posée._';
  return statuses
    .map(({ question, answer }) => {
      const reply =
        answer === null
          ? '_sans réponse : appliquer le choix par défaut_'
          : answer.ignored
            ? '_question ignorée_'
            : answer.text;
      return `- **${question.id}** ${question.text}\n  → ${reply}`;
    })
    .join('\n');
}

/** Identifiants C1, C2… à la suite des questions déjà posées. */
function nextQuestionIds(existing: readonly QuestionStatus[], count: number): string[] {
  const max = Math.max(0, ...existing.map((s) => Number(/^C(\d+)$/.exec(s.question.id)?.[1] ?? 0)));
  return Array.from({ length: count }, (_, i) => `C${String(max + i + 1)}`);
}

function resolveSettings(
  input: PlannerInput,
  issueSettings: CadrageSettings | null,
): CadrageSettings {
  const model = input.model ?? issueSettings?.model;
  if (model === undefined || model === '') {
    throw new PlannerError(
      'Aucun modèle pour le planificateur : le régler dans le cockpit puis relancer.',
    );
  }
  return { model, maxAgents: input.maxAgents ?? issueSettings?.maxAgents ?? DEFAULT_RUNNER_CAP };
}

/**
 * Exécution du planificateur : questions dans l'issue Cadrage (phase 1), puis plan validé
 * sur `plan/vN` quand toutes les questions bloquantes ont une réponse (phase 2).
 */
export async function runPlanner(input: PlannerInput, deps: PlannerDeps): Promise<PlannerOutcome> {
  const { github, ref } = { github: deps.github, ref: input.ref };
  const config = await projectConfig(deps.readFile);
  let issue = await findCadrageIssue(github, ref);
  const settings = resolveSettings(input, issue ? readCadrageSettings(issue) : null);

  if (!issue) {
    issue = await github.createIssue(ref, {
      title: 'Cadrage',
      body: renderCadrageBody(settings),
      labels: [CADRAGE_LABEL],
    });
  } else if (JSON.stringify(readCadrageSettings(issue)) !== JSON.stringify(settings)) {
    issue = await github.updateIssue(ref, issue.number, { body: renderCadrageBody(settings) });
  }

  const typeGuidance = deps.prompts.types[config.type];
  const documents = await documentsList(deps.readFile);
  const project = `${ref.owner}/${ref.repo} (${config.type})`;
  let statuses = await readQuestions(github, ref, issue.number);

  // Phase 1 : une seule fois par issue Cadrage, sauf régénération.
  if (
    statuses.length === 0 &&
    input.mode === 'auto' &&
    !issue.body.includes('<!-- agentlake:cadrage-clarified -->')
  ) {
    const response = await deps.claude.run({
      prompt: renderPrompt(deps.prompts.clarification, {
        PROJECT: project,
        TYPE_GUIDANCE: typeGuidance,
        DOCUMENTS: documents,
      }),
      systemPrompt: deps.prompts.system,
      model: settings.model,
      jsonSchema: z.toJSONSchema(QuestionsOutputSchema, { io: 'input' }),
      allowedTools: READ_ONLY_TOOLS,
      cwd: deps.workspace,
    });
    const parsed = QuestionsOutputSchema.safeParse(response.structured);
    if (!parsed.success) {
      await github.createComment(
        ref,
        issue.number,
        `**Clarification impossible** : réponse invalide.\n\n${formatZodError(parsed.error)}`,
      );
      return { phase: 'failed', issueNumber: issue.number, errors: formatZodError(parsed.error) };
    }
    const ids = nextQuestionIds(statuses, parsed.data.questions.length);
    const questions: Question[] = parsed.data.questions.map((q, i) => ({
      ...q,
      id: ids[i] ?? `C${String(i + 1)}`,
    }));
    for (const question of questions)
      await github.createComment(ref, issue.number, renderQuestionComment(question));
    issue = await github.updateIssue(ref, issue.number, {
      body: `${issue.body.trimEnd()}\n\n<!-- agentlake:cadrage-clarified -->\n`,
    });
    if (questions.some((q) => q.blocking)) {
      return {
        phase: 'clarification',
        issueNumber: issue.number,
        questions: questions.map((q) => q.id),
      };
    }
    statuses = await readQuestions(github, ref, issue.number);
  }

  const pending = pendingBlocking(statuses);
  if (pending.length > 0 && input.mode === 'auto') {
    return { phase: 'waiting', issueNumber: issue.number, pending };
  }
  return decoupe(input, deps, {
    issueNumber: issue.number,
    settings,
    config,
    typeGuidance,
    documents,
    project,
    statuses,
  });
}

interface DecoupeContext {
  issueNumber: number;
  settings: CadrageSettings;
  config: ProjectConfig;
  typeGuidance: string;
  documents: string;
  project: string;
  statuses: QuestionStatus[];
}

/** Phase 2 : plan produit par Claude, validé ici, erreurs renvoyées à Claude (3 essais au plus). */
async function decoupe(
  input: PlannerInput,
  deps: PlannerDeps,
  ctx: DecoupeContext,
): Promise<PlannerOutcome> {
  const { github } = deps;
  const ref = input.ref;
  const basePrompt = renderPrompt(deps.prompts.decoupe, {
    PROJECT: ctx.project,
    TYPE_GUIDANCE: ctx.typeGuidance,
    DOCUMENTS: ctx.documents,
    ANSWERS: answersText(ctx.statuses),
    INSTRUCTION: input.instruction?.trim() || '_Aucune consigne particulière._',
    TEST_CATEGORIES: TEST_CATEGORIES.join(', '),
    PROFILES: PROFILE_IDS.join(', '),
  });
  const schema = z.toJSONSchema(PlanDraftSchema, { io: 'input' }) as Record<string, unknown>;

  let errors = '';
  let raw = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n${renderPrompt(deps.prompts.correction, {
            ATTEMPT: String(attempt - 1),
            MAX_ATTEMPTS: String(MAX_ATTEMPTS),
            ERRORS: errors,
          })}`;
    const response = await deps.claude.run({
      prompt,
      systemPrompt: deps.prompts.system,
      model: ctx.settings.model,
      jsonSchema: schema,
      allowedTools: READ_ONLY_TOOLS,
      cwd: deps.workspace,
    });
    raw = response.text;
    const draft = PlanDraftSchema.safeParse(response.structured);
    if (!draft.success) {
      errors = formatZodError(draft.error);
      continue;
    }
    const proposal = proposeAgents(draft.data.tasks, {
      runners: DEFAULT_RUNNER_CAP,
      global: ctx.settings.maxAgents,
      ...(ctx.config.limits.maxConcurrentAgents !== undefined
        ? { project: ctx.config.limits.maxConcurrentAgents }
        : {}),
    });
    const plan = ProjectPlanSchema.safeParse({ ...draft.data, proposedAgents: proposal.agents });
    if (!plan.success) {
      errors = formatZodError(plan.error);
      continue;
    }
    return publish(deps, ref, ctx.issueNumber, plan.data, proposal.width);
  }

  const shown = raw.length > 20_000 ? `${raw.slice(0, 20_000)}\n[… coupé …]` : raw;
  await github.createComment(
    ref,
    ctx.issueNumber,
    [
      `**Plan refusé après ${String(MAX_ATTEMPTS)} essais.** Dernières erreurs du validateur :`,
      '',
      '```',
      errors,
      '```',
      '',
      '<details><summary>Sortie brute de Claude</summary>',
      '',
      '```',
      shown,
      '```',
      '',
      '</details>',
    ].join('\n'),
  );
  return { phase: 'failed', issueNumber: ctx.issueNumber, errors };
}

async function publish(
  deps: PlannerDeps,
  ref: RepoRef,
  issueNumber: number,
  plan: ProjectPlan,
  width: number,
): Promise<PlannerOutcome> {
  let version = 1;
  while (await deps.github.branchExists(ref, `plan/v${String(version)}`)) version += 1;
  const branch = `plan/v${String(version)}`;
  await deps.github.commitFiles(ref, {
    branch,
    baseBranch: 'main',
    message: `docs(plan): plan v${String(version)}`,
    changes: [{ path: PLAN_PATH, content: `${JSON.stringify(plan, null, 2)}\n` }],
  });
  await deps.github.createComment(
    ref,
    issueNumber,
    `**Plan v${String(version)} prêt** sur la branche \`${branch}\` : ${String(plan.tasks.length)} tâches, ${String(plan.proposedAgents)} agent(s) proposé(s) (largeur du graphe : ${String(width)}). À relire et valider dans le cockpit.`,
  );
  return {
    phase: 'plan',
    issueNumber,
    version,
    branch,
    agents: plan.proposedAgents,
    tasks: plan.tasks.length,
  };
}
