import {
  TEST_CATEGORIES,
  TEST_CATEGORY_LABELS,
  type AgentProfile,
  type Answer,
  type Question,
  type TaskIssue,
} from 'shared';

/** Document du contexte du projet, lu dans `.agentlake/context/`. */
export interface ContextDocument {
  path: string;
  role: string;
  content: string;
}

export interface ProjectContext {
  /** `CLAUDE.md` du projet, s'il existe. */
  instructions: string | null;
  decisions: string | null;
  documents: ContextDocument[];
}

/** Raison d'un lancement : premier passage, reprise après une réponse, reprise après un échec de CI. */
export type Resume =
  | { kind: 'none' }
  | { kind: 'answer'; question: Question; answer: Answer }
  | { kind: 'ci-failure'; attempt: number; logs: string; runUrl: string | null };

export interface PromptInput {
  task: TaskIssue;
  issueNumber: number;
  profile: AgentProfile;
  branch: string;
  context: ProjectContext;
  resume: Resume;
  /** Porte qualité à poser (tâche bootstrap de l'architecte). */
  quality?: QualityGate;
  /** Tâche de jeu en code pur : l'éditeur et le pont ne sont pas disponibles. */
  withoutEditor?: boolean;
}

/** Budget de caractères pour les documents du contexte et les journaux. */
export const CONTEXT_BUDGET = 150_000;
export const LOGS_BUDGET = 20_000;

function list(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : `_${empty}_`;
}

function fence(content: string, language = ''): string {
  const ticks = content.includes('```') ? '````' : '```';
  return `${ticks}${language}\n${content.trimEnd()}\n${ticks}`;
}

/** Garde la fin d'un texte trop long (les journaux d'échec sont utiles par la fin). */
export function tail(text: string, budget: number): string {
  return text.length <= budget
    ? text
    : `[… ${String(text.length - budget)} caractères coupés …]\n${text.slice(-budget)}`;
}

function contextSection(documents: readonly ContextDocument[]): string {
  if (documents.length === 0) return '_Aucun document versé._';
  const order = ['brief', 'gdd', 'inventory', 'annex'];
  const sorted = [...documents].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const parts: string[] = [];
  let used = 0;
  for (const doc of sorted) {
    const remaining = CONTEXT_BUDGET - used;
    if (remaining <= 0) {
      parts.push(
        `### ${doc.path}\n\n_Non inclus (budget de contexte atteint) : lire le fichier dans le dépôt._`,
      );
      continue;
    }
    const content =
      doc.content.length > remaining
        ? `${doc.content.slice(0, remaining)}\n[… suite dans le fichier …]`
        : doc.content;
    used += content.length;
    parts.push(`### ${doc.path} (${doc.role})\n\n${content.trim()}`);
  }
  return parts.join('\n\n');
}

function resumeSection(resume: Resume): string | null {
  switch (resume.kind) {
    case 'none':
      return null;
    case 'answer':
      return [
        '## Reprise après une réponse',
        '',
        'Tu avais posé une question bloquante ; Kia a répondu. Reprends le travail déjà commencé sur la branche en tenant compte de la réponse.',
        '',
        `**Question \`${resume.question.id}\`** : ${resume.question.text}`,
        '',
        `**Réponse** : ${resume.answer.text}`,
      ].join('\n');
    case 'ci-failure':
      return [
        `## Reprise après un échec de CI (tentative ${String(resume.attempt)})`,
        '',
        'La CI de la PR de cette tâche a échoué. Corrige la cause sur la même branche, sans désactiver ni affaiblir de test.',
        ...(resume.runUrl ? ['', `Exécution en échec : ${resume.runUrl}`] : []),
        '',
        'Journaux des jobs en échec :',
        '',
        fence(tail(resume.logs, LOGS_BUDGET)),
      ].join('\n');
  }
}

/** Porte qualité du projet : gabarits du profil qualité à poser dans le dépôt. */
export interface QualityGate {
  profile: string;
  /** Checks de la CI du projet, noms exacts des jobs. */
  checks: readonly string[];
  /** Dossier des gabarits dans le runner (copie de devlake). */
  templatesDir: string;
  /** Projet repris : sa CI existante est gardée, la porte qualité s'y ajoute. */
  adopted?: boolean;
}

function qualitySection(gate: QualityGate): string {
  return [
    `## Porte qualité (profil \`${gate.profile}\`)`,
    '',
    `Les gabarits sont dans \`${gate.templatesDir}\` (copie de devlake, hors du dépôt) : lis son \`README.md\`.`,
    gate.adopted === true
      ? '- Projet repris : sa CI existante reste en place et ses checks restent obligatoires. Ne la remplace pas et ne réécris pas le code existant. Ajoute les jobs manquants de `ci.yml` (adaptés à la stack réelle du projet) dans `.github/workflows/ci.yml` s’il n’existe pas, sinon dans `.github/workflows/qualite.yml`. Commence par remettre au vert ce qui échoue déjà sur `main`, et note les conventions constatées dans `.agentlake/decisions.md`.'
      : `- Copie \`ci.yml\` dans \`.github/workflows/ci.yml\` et adapte les commandes à la stack du projet (scripts \`package.json\`, configurations de lint, de types et de couverture à 80 % des lignes).`,
    `- Garde exactement ces noms de jobs, ce sont les checks obligatoires de \`main\` : ${gate.checks.map((c) => `\`${c}\``).join(', ')}.`,
    '- Aucun job vide, sauté ou non bloquant. Chaque check doit passer au vert sur ta PR : tant qu’ils ne sont pas tous verts sur `main`, aucune autre tâche du plan ne démarre.',
  ].join('\n');
}

/** Prompt complet d'un agent : tâche, règles, reprise éventuelle, instructions et contexte du projet. */
export function buildPrompt(input: PromptInput): string {
  const { task, profile } = input;
  const tests = TEST_CATEGORIES.flatMap((c) =>
    (task.requiredTests[c] ?? []).map((t) => `${TEST_CATEGORY_LABELS[c]} : ${t}`),
  );
  const sections = [
    `# Tâche ${task.id} — ${task.title}`,
    `Tu es l’agent « ${profile.id} » d’AgentLake. Tu travailles sur l’issue #${String(input.issueNumber)} de ce dépôt.`,
    `## Objectif\n\n${task.description}`,
    `## Critères d’acceptation\n\n${list(task.acceptanceCriteria, 'Aucun.')}`,
    `## Tests exigés\n\n${list(tests, 'Aucun test exigé.')}`,
    `## Zones de code\n\n${list(task.codeZones, 'Non précisées.')}`,
    ...(task.exclusiveResources.length > 0
      ? [`## Ressources exclusives\n\n${list(task.exclusiveResources, '')}`]
      : []),
    [
      '## Règles',
      '',
      `- La branche \`${input.branch}\` est déjà extraite : travaille dessus et commite avec des messages Conventional Commits. Ne pousse pas et n’ouvre pas de PR : le workflow s’en charge.`,
      '- Livre le code et ses tests dans le même changement ; fais passer les tests localement avant de terminer.',
      '- Ne désactive, ne saute et n’affaiblis jamais un test existant.',
      '- Reste dans le périmètre de la tâche ; respecte le `CLAUDE.md` et les décisions du projet.',
      '- S’il manque une information indispensable, pose une question bloquante : termine avec `outcome = blocked` et une question `blocking = true` dans `questions`. Ton travail en cours est poussé sur la branche ; tu reprendras avec la réponse de Kia.',
      '- Un choix mineur que tu tranches toi-même se signale par une question non bloquante (`blocking = false`) ; continue alors normalement.',
      '- Termine en remplissant la sortie structurée : `pr_title` (titre court) et `pr_summary` (ce qui a été fait, les choix, comment tester).',
    ].join('\n'),
    resumeSection(input.resume),
    input.quality ? qualitySection(input.quality) : null,
    input.withoutEditor
      ? '## Sans éditeur\n\nCette tâche est du code pur, testable sans éditeur : le pont Aura et les outils `editor_*` ne sont pas disponibles. Écris le code et ses tests dans le dépôt, et lance-les dans le runner.'
      : null,
    `## Instructions du projet (CLAUDE.md)\n\n${input.context.instructions?.trim() || '_Aucun CLAUDE.md._'}`,
    `## Décisions du projet\n\n${input.context.decisions?.trim() || '_Aucune décision._'}`,
    `## Contexte du projet\n\n${contextSection(input.context.documents)}`,
  ];
  return `${sections.filter((s): s is string => s !== null).join('\n\n')}\n`;
}
