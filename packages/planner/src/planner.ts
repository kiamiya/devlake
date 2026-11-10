import type { GitHubPort, RepoRef } from 'github';
import {
  ASSET_LIBRARY_PATH,
  AssetLibrarySchema,
  renderAssetLibrary,
  CADRAGE_LABEL,
  DEFAULT_RUNNER_CAP,
  INVENTORY_BRANCH_PREFIX,
  INVENTORY_PATH,
  TASK_LABEL,
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
  /**
   * `auto` : questions puis plan quand tout est répondu ; `regenerate` : nouveau plan tout de
   * suite ; `inventory` : état des lieux d'un projet repris, sur `etat-des-lieux/vN`.
   */
  mode: 'auto' | 'regenerate' | 'inventory';
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
  | { phase: 'inventory'; issueNumber: number; version: number; branch: string }
  | { phase: 'failed'; issueNumber: number; errors: string };

export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerError';
  }
}

const InventoryOutputSchema = z.object({
  markdown: z.string().min(200, 'État des lieux trop court.'),
});

/** Première tâche d'un nouveau projet, ou d'un projet repris (audit et remise au vert). */
export const T00_NEW =
  '- La première tâche (`T00`) est le bootstrap du dépôt par le profil `architect`, sans dépendance : structure, conventions, CI complète.';
export const T00_ADOPTED = [
  "- Projet repris : la première tâche (`T00`), profil `architect`, sans dépendance, est l'audit et la remise au vert du dépôt, sans réécrire l'existant : CI du projet qui passe sur `main`, checks de la porte qualité ajoutés, conventions constatées notées dans `decisions.md`.",
  "- Les tâches suivantes ne planifient que ce qui reste à faire, d'après l'état des lieux, le brief s'il existe et les réponses du cadrage. Elles respectent la structure et les conventions existantes et ne refont pas ce qui marche.",
  '- Une issue ou une PR ouverte reprise par une tâche est citée (#numéro) dans sa description.',
].join('\n');
export const REPRISE = [
  '## Projet repris',
  '',
  "Le dépôt contient déjà du code : l'état des lieux (`" +
    INVENTORY_PATH +
    "`) décrit ce qui existe. Le brief est facultatif : sans brief, pose tes questions sur la suite (objectifs restants, priorités, ce qui ne doit pas changer). Ne pose pas de question dont la réponse figure dans l'état des lieux ou dans le code.",
  '',
  '',
].join('\n');

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

/** Bibliothèque d'assets du projet (jeu), en section de prompt ; vide sans `assets.json`. */
async function assetsSection(readFile: PlannerDeps['readFile']): Promise<string> {
  const text = await readFile(ASSET_LIBRARY_PATH);
  if (text === null) return '';
  try {
    const library = AssetLibrarySchema.safeParse(JSON.parse(text));
    if (!library.success) return '';
    return `## Bibliothèque d'assets du projet\n\nAssets choisis par Kia ; les tâches qui en ont besoin s'appuient dessus (chemins versés), et un asset « à acquérir » n'est pas encore dans le dépôt.\n\n${renderAssetLibrary(library.data)}\n\n`;
  } catch {
    return '';
  }
}

async function hasInventory(readFile: PlannerDeps['readFile']): Promise<boolean> {
  const text = await readFile(CONTEXT_INDEX_PATH);
  if (text === null) return false;
  const index = ContextIndexSchema.safeParse(JSON.parse(text));
  return index.success && index.data.files.some((f) => f.role === 'inventory');
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
  if (input.mode === 'inventory') {
    if (config.adopted !== true)
      throw new PlannerError('L’état des lieux est réservé aux projets repris.');
    return runInventory(input, deps, config);
  }
  if (config.adopted === true && !(await hasInventory(deps.readFile)))
    throw new PlannerError(
      'Projet repris : lancer l’état des lieux et le valider dans le cockpit avant le planificateur.',
    );
  const { issueNumber, settings } = await cadrage(input, github);
  let issue = await github.getIssue(ref, issueNumber);

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
        REPRISE: `${config.adopted === true ? REPRISE : ''}${await assetsSection(deps.readFile)}`,
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
    FIRST_TASK_RULE: ctx.config.adopted === true ? T00_ADOPTED : T00_NEW,
    ASSETS: await assetsSection(deps.readFile),
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

/** Issue Cadrage du projet (créée au besoin) et réglages du planificateur. */
async function cadrage(
  input: PlannerInput,
  github: GitHubPort,
): Promise<{ issueNumber: number; settings: CadrageSettings }> {
  let issue = await findCadrageIssue(github, input.ref);
  const settings = resolveSettings(input, issue ? readCadrageSettings(issue) : null);
  if (!issue) {
    issue = await github.createIssue(input.ref, {
      title: 'Cadrage',
      body: renderCadrageBody(settings),
      labels: [CADRAGE_LABEL],
    });
  } else if (JSON.stringify(readCadrageSettings(issue)) !== JSON.stringify(settings)) {
    issue = await github.updateIssue(input.ref, issue.number, {
      body: renderCadrageBody(settings),
    });
  }
  return { issueNumber: issue.number, settings };
}

const listing = (items: readonly string[], none: string) =>
  items.length === 0 ? none : items.join('\n');

/**
 * État des lieux d'un projet repris : Claude parcourt le dépôt (lecture seule), le document
 * est proposé sur `etat-des-lieux/vN` ; Kia le relit et le valide dans le cockpit.
 */
async function runInventory(
  input: PlannerInput,
  deps: PlannerDeps,
  config: ProjectConfig,
): Promise<PlannerOutcome> {
  const { github, ref } = { github: deps.github, ref: input.ref };
  const { issueNumber, settings } = await cadrage(input, github);
  const issues = (await github.listIssues(ref, { state: 'open' })).filter(
    (i) => !i.labels.includes(TASK_LABEL) && !i.labels.includes(CADRAGE_LABEL),
  );
  const pulls = await github.listPullRequests(ref, { state: 'open' });
  const response = await deps.claude.run({
    prompt: renderPrompt(deps.prompts.inventaire, {
      PROJECT: `${ref.owner}/${ref.repo} (${config.type})`,
      TYPE_GUIDANCE: deps.prompts.types[config.type],
      ISSUES: listing(
        issues.map(
          (i) =>
            `- #${String(i.number)} ${i.title}${i.labels.length > 0 ? ` [${i.labels.join(', ')}]` : ''}`,
        ),
        '_Aucune._',
      ),
      PULLS: listing(
        pulls.map((p) => `- #${String(p.number)} ${p.title} (${p.head} → ${p.base})`),
        '_Aucune._',
      ),
      INSTRUCTION: input.instruction?.trim() || '_Aucune consigne particulière._',
    }),
    systemPrompt: deps.prompts.system,
    model: settings.model,
    jsonSchema: z.toJSONSchema(InventoryOutputSchema, { io: 'input' }),
    allowedTools: READ_ONLY_TOOLS,
    cwd: deps.workspace,
  });
  const parsed = InventoryOutputSchema.safeParse(response.structured);
  if (!parsed.success) {
    const errors = formatZodError(parsed.error);
    await github.createComment(
      ref,
      issueNumber,
      `**État des lieux impossible** : réponse invalide.\n\n${errors}`,
    );
    return { phase: 'failed', issueNumber, errors };
  }
  let version = 1;
  while (await github.branchExists(ref, `${INVENTORY_BRANCH_PREFIX}${String(version)}`))
    version += 1;
  const branch = `${INVENTORY_BRANCH_PREFIX}${String(version)}`;
  await github.commitFiles(ref, {
    branch,
    baseBranch: 'main',
    message: `docs(context): état des lieux v${String(version)}`,
    changes: [{ path: INVENTORY_PATH, content: `${parsed.data.markdown.trim()}\n` }],
  });
  await github.createComment(
    ref,
    issueNumber,
    `**État des lieux v${String(version)} prêt** sur la branche \`${branch}\`. À relire et valider dans le cockpit, avant de lancer le planificateur.`,
  );
  return { phase: 'inventory', issueNumber, version, branch };
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
