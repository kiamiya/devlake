import { z } from 'zod';
import {
  cleanLine,
  cleanText,
  normalizeNewlines,
  parseAttributes,
  safeParseWith,
  type ParseResult,
} from './common.js';
import { QuestionIdSchema } from './ids.js';

export const QuestionSchema = z.object({
  id: QuestionIdSchema,
  blocking: z.boolean({ error: 'blocking doit valoir true ou false.' }),
  text: cleanText('Le texte de la question'),
  context: cleanText('Le contexte').optional(),
  options: z.array(cleanLine('Une option')),
});
export type Question = z.infer<typeof QuestionSchema>;

export const AnswerSchema = z.object({
  id: QuestionIdSchema,
  /** Promue dans `.agentlake/decisions.md` (case cochée par défaut). */
  decision: z.boolean({ error: 'decision doit valoir true ou false.' }),
  text: cleanText('La réponse'),
  /** Question écartée par Kia : elle ne bloque plus le planificateur. */
  ignored: z.literal(true).optional(),
  /** Réponse de l'agent architecte (et non de Kia). */
  by: z.literal('architect').optional(),
});
export type Answer = z.infer<typeof AnswerSchema>;

const QUESTION_HEADER = /^\s*<!-- agentlake:question ([^>]*) -->\n?/;
const ANSWER_HEADER = /^\s*<!-- agentlake:answer ([^>]*) -->\n?/;
const SECTION_MARKER = /^<!-- agentlake:(text|context|options) -->$/;

const SECTION_HEADINGS = {
  text: (q: Question) => `**Question ${q.blocking ? 'bloquante' : 'non bloquante'} \`${q.id}\`**`,
  context: () => '**Contexte**',
  options: () => '**Options proposées**',
} as const;

function parseBoolean(value: string | undefined, name: string): ParseResult<boolean | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  return { ok: false, error: `${name} doit valoir true ou false (reçu « ${value} »).` };
}

export function renderQuestionComment(question: Question): string {
  const parts = [
    `<!-- agentlake:question id=${question.id} blocking=${String(question.blocking)} -->\n<!-- agentlake:text -->\n${SECTION_HEADINGS.text(question)}\n\n${question.text}`,
  ];
  if (question.context !== undefined) {
    parts.push(`<!-- agentlake:context -->\n${SECTION_HEADINGS.context()}\n\n${question.context}`);
  }
  if (question.options.length > 0) {
    const list = question.options.map((option, i) => `${String(i + 1)}. ${option}`).join('\n');
    parts.push(`<!-- agentlake:options -->\n${SECTION_HEADINGS.options()}\n\n${list}`);
  }
  return `${parts.join('\n\n')}\n`;
}

/** Découpe le corps en sections repérées par leurs marqueurs cachés. */
function splitSections(content: string): Map<string, string> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of content.split('\n')) {
    const marker = SECTION_MARKER.exec(line)?.[1];
    if (marker !== undefined) {
      current = [];
      sections.set(marker, current);
    } else {
      current?.push(line);
    }
  }
  const result = new Map<string, string>();
  for (const [name, lines] of sections) {
    // Première ligne : intitulé visible ; on le retire.
    result.set(name, lines.slice(1).join('\n').trim());
  }
  return result;
}

export function parseQuestionComment(body: string): ParseResult<Question> {
  const text = normalizeNewlines(body);
  const header = QUESTION_HEADER.exec(text);
  if (!header) {
    return { ok: false, error: 'En-tête « <!-- agentlake:question … --> » absent.' };
  }
  const attributes = parseAttributes(header[1] ?? '');
  const blocking = parseBoolean(attributes.get('blocking'), 'blocking');
  if (!blocking.ok) return blocking;

  const sections = splitSections(text.slice(header[0].length));
  const optionsText = sections.get('options');
  const options =
    optionsText === undefined
      ? []
      : optionsText
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => line.replace(/^\d+\.\s/, ''));

  const context = sections.get('context');
  return safeParseWith(QuestionSchema, {
    id: attributes.get('id'),
    blocking: blocking.value,
    text: sections.get('text'),
    ...(context !== undefined ? { context } : {}),
    options,
  });
}

/** Question transmise à l'architecte (une fois par question). */
export const ARCHITECT_ASKED_MARKER = (id: string) => `<!-- agentlake:architect-asked id=${id} -->`;
/** L'architecte n'a pas tranché : la question revient à Kia. */
export const ARCHITECT_ESCALATED_MARKER = (id: string) =>
  `<!-- agentlake:architect-escalated id=${id} -->`;

export function renderAnswerComment(answer: Answer): string {
  const ignored = answer.ignored ? ' ignored=true' : '';
  const by = answer.by ? ` by=${answer.by}` : '';
  return `<!-- agentlake:answer id=${answer.id} decision=${String(answer.decision)}${ignored}${by} -->\n${answer.text}\n`;
}

/**
 * Relit une réponse. Sans attribut decision (réponse écrite à la main),
 * la réponse est promue en décision, comme la case cochée par défaut du cockpit.
 */
export function parseAnswerComment(body: string): ParseResult<Answer> {
  const text = normalizeNewlines(body);
  const header = ANSWER_HEADER.exec(text);
  if (!header) {
    return { ok: false, error: 'En-tête « <!-- agentlake:answer … --> » absent.' };
  }
  const attributes = parseAttributes(header[1] ?? '');
  const decision = parseBoolean(attributes.get('decision'), 'decision');
  if (!decision.ok) return decision;
  const ignored = parseBoolean(attributes.get('ignored'), 'ignored');
  if (!ignored.ok) return ignored;
  const content = text.slice(header[0].length).trim();
  return safeParseWith(AnswerSchema, {
    id: attributes.get('id'),
    decision: decision.value ?? true,
    // Une question ignorée n'a pas forcément de texte de réponse.
    text: content === '' && ignored.value === true ? 'Question ignorée.' : content,
    ...(ignored.value === true ? { ignored: true } : {}),
    ...(attributes.get('by') === 'architect' ? { by: 'architect' } : {}),
  });
}
