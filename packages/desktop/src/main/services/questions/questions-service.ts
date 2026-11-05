import type { Comment, GitHubPort, Issue, RepoRef } from 'github';
import {
  CADRAGE_LABEL,
  parseAnswerComment,
  parseQuestionComment,
  renderAnswerComment,
  stateLabel,
  TASK_LABEL,
  type Answer,
} from 'shared';
import type { QuestionView } from '../../../shared/ipc-contract.js';
import type { QuestionRow, Repositories } from '../../db/repositories.js';
import { UnknownProjectError } from '../../projects-service.js';

/** États d'une tâche où une question attend Kia. */
const WAITING = [stateLabel('awaiting-answer'), stateLabel('escalated')];

export interface QuestionNotification {
  projectId: string;
  issueNumber: number;
  title: string;
  body: string;
}

export interface QuestionsDeps {
  repos: Repositories;
  github: () => Promise<GitHubPort>;
  /** Notification système pour une nouvelle question bloquante. */
  notify: (notification: QuestionNotification) => void;
  /** Badge de l'application : nombre de questions bloquantes en attente. */
  badge?: (count: number) => void;
  now?: () => string;
}

export class QuestionNotFoundError extends Error {
  constructor(id: string) {
    super(`Question ${id} introuvable, ou déjà répondue.`);
    this.name = 'QuestionNotFoundError';
  }
}

export interface AnswerInput {
  projectId: string;
  issueNumber: number;
  questionId: string;
  text: string;
  decision: boolean;
  ignore: boolean;
  attachments: string[];
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Réponse du propriétaire à chaque question du fil (la plus récente, postérieure à la question). */
function readIssueQuestions(comments: readonly Comment[], owner: string) {
  const found: {
    question: ReturnType<typeof parseQuestionComment> & { ok: true };
    at: string;
    answer: (Answer & { at: string }) | null;
  }[] = [];
  comments.forEach((comment, index) => {
    const question = parseQuestionComment(comment.body);
    if (!question.ok) return;
    const answer =
      comments
        .slice(index + 1)
        .filter((c) => sameLogin(c.author, owner))
        .map((c) => ({ parsed: parseAnswerComment(c.body), at: c.createdAt }))
        .flatMap(({ parsed, at }) =>
          parsed.ok && parsed.value.id === question.value.id ? [{ ...parsed.value, at }] : [],
        )
        .at(-1) ?? null;
    found.push({ question, at: comment.createdAt, answer });
  });
  return found;
}

/**
 * Boîte de questions : lit les questions des issues en attente (tâches) et de l'issue
 * Cadrage (planificateur), les garde en base pour l'historique, notifie les nouvelles
 * questions bloquantes et publie les réponses au format du protocole.
 */
export class QuestionsService {
  private readonly now: () => string;

  constructor(private readonly deps: QuestionsDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private view(row: QuestionRow): QuestionView {
    const [owner = '', repo = ''] = row.projectId.split('/');
    return {
      projectId: row.projectId,
      issueNumber: row.issueNumber,
      issueTitle: row.issueTitle,
      issueUrl: `https://github.com/${owner}/${repo}/issues/${String(row.issueNumber)}`,
      questionId: row.questionId,
      source: row.source,
      blocking: row.blocking,
      text: row.text,
      context: row.context,
      options: row.options,
      askedAt: row.askedAt,
      answer:
        row.answeredAt === null
          ? null
          : { text: row.answerText, decision: row.answerDecision, at: row.answeredAt },
    };
  }

  list(filter: {
    projectId?: string | undefined;
    status: 'pending' | 'answered' | 'all';
    search?: string | undefined;
  }): QuestionView[] {
    const needle = filter.search?.toLowerCase() ?? '';
    return this.deps.repos.questions
      .list(filter.projectId)
      .filter((q) =>
        filter.status === 'all'
          ? true
          : filter.status === 'pending'
            ? q.answeredAt === null
            : q.answeredAt !== null,
      )
      .filter(
        (q) =>
          needle === '' ||
          [q.text, q.context ?? '', q.answerText ?? '', q.issueTitle, q.questionId, q.projectId]
            .join('\n')
            .toLowerCase()
            .includes(needle),
      )
      .map((q) => this.view(q));
  }

  /** Sondage de tous les projets connus ; renvoie les compteurs pour les badges. */
  async syncAll(): Promise<{ pending: number; blocking: number; newBlocking: number }> {
    const github = await this.deps.github();
    let newBlocking = 0;
    for (const project of this.deps.repos.projects.list())
      newBlocking += await this.syncProject({ owner: project.owner, repo: project.repo }, github);
    const pending = this.deps.repos.questions.list().filter((q) => q.answeredAt === null);
    const blocking = pending.filter((q) => q.blocking).length;
    this.deps.badge?.(blocking);
    return { pending: pending.length, blocking, newBlocking };
  }

  /**
   * Lit les fils des issues qui attendent Kia, plus ceux des questions encore en attente
   * en base (réponse donnée sur GitHub entre deux sondages). Renvoie le nombre de
   * nouvelles questions bloquantes notifiées.
   */
  async syncProject(ref: RepoRef, github: GitHubPort): Promise<number> {
    const projectId = `${ref.owner}/${ref.repo}`;
    const issues = await github.listIssues(ref, { state: 'open' });
    const pendingIssues = new Set(
      this.deps.repos.questions
        .list(projectId)
        .filter((q) => q.answeredAt === null)
        .map((q) => q.issueNumber),
    );
    const relevant = new Map<number, { issue: Issue | null; source: 'task' | 'cadrage' }>();
    for (const issue of issues) {
      if (issue.labels.includes(CADRAGE_LABEL))
        relevant.set(issue.number, { issue, source: 'cadrage' });
      else if (issue.labels.includes(TASK_LABEL) && issue.labels.some((l) => WAITING.includes(l)))
        relevant.set(issue.number, { issue, source: 'task' });
    }
    for (const number of pendingIssues) {
      if (relevant.has(number)) continue;
      const known = this.deps.repos.questions.list(projectId).find((q) => q.issueNumber === number);
      relevant.set(number, { issue: null, source: known?.source ?? 'task' });
    }

    let notified = 0;
    for (const [number, { issue, source }] of relevant) {
      const comments = await github.listComments(ref, number);
      const title = issue?.title ?? (await github.getIssue(ref, number)).title;
      for (const { question, at, answer } of readIssueQuestions(comments, ref.owner)) {
        const q = question.value;
        const key = { projectId, issueNumber: number, questionId: q.id };
        this.deps.repos.questions.insertIfMissing({
          ...key,
          source,
          issueTitle: title,
          blocking: q.blocking,
          text: q.text,
          context: q.context ?? null,
          options: q.options,
          askedAt: at,
          answerText: null,
          answerDecision: null,
          answeredAt: null,
          // Une question non bloquante ne déclenche pas de notification.
          notified: !q.blocking,
        });
        const row = this.deps.repos.questions.get(projectId, number, q.id);
        if (row === undefined) continue;
        if (answer && row.answeredAt === null) {
          this.deps.repos.questions.update(key, {
            answerText: answer.ignored ? null : answer.text,
            answerDecision: answer.decision,
            answeredAt: answer.at,
          });
        } else if (
          issue !== null &&
          !answer &&
          row.answeredAt === null &&
          row.blocking &&
          !row.notified
        ) {
          this.deps.notify({
            projectId,
            issueNumber: number,
            title: `Question bloquante — ${ref.repo}`,
            body: `${title} : ${q.text}`.slice(0, 240),
          });
          this.deps.repos.questions.update(key, { notified: true });
          notified += 1;
        }
      }
      // Issue sortie de l'attente sans réponse visible (fermée, relancée à la main…) :
      // ses questions restantes sont closes, pour ne pas rester en attente pour toujours.
      if (issue === null)
        for (const row of this.deps.repos.questions.list(projectId))
          if (row.issueNumber === number && row.answeredAt === null)
            this.deps.repos.questions.update(
              { projectId, issueNumber: number, questionId: row.questionId },
              { answeredAt: this.now() },
            );
    }
    return notified;
  }

  /** Publie la réponse au format du protocole ; l'issue repart (dispatcher ou planificateur). */
  async answer(input: AnswerInput): Promise<QuestionView> {
    const row = this.deps.repos.questions.get(input.projectId, input.issueNumber, input.questionId);
    if (!row || row.answeredAt !== null)
      throw new QuestionNotFoundError(
        `${input.projectId}#${String(input.issueNumber)}/${input.questionId}`,
      );
    const project = this.deps.repos.projects.list().find((p) => p.id === input.projectId);
    if (!project) throw new UnknownProjectError(input.projectId);
    const ignore = input.ignore && row.source === 'cadrage';
    const attachments =
      input.attachments.length > 0
        ? `\n\nPièces jointes versées dans le contexte :\n${input.attachments.map((p) => `- \`${p}\``).join('\n')}`
        : '';
    const text = `${input.text.trim()}${attachments}`.trim();
    if (!ignore && text === '') throw new EmptyAnswerError();
    const github = await this.deps.github();
    await github.createComment(
      { owner: project.owner, repo: project.repo },
      input.issueNumber,
      renderAnswerComment({
        id: input.questionId,
        decision: ignore ? false : input.decision,
        text: ignore ? text || 'Question ignorée.' : text,
        ...(ignore ? { ignored: true as const } : {}),
      }),
    );
    const key = {
      projectId: input.projectId,
      issueNumber: input.issueNumber,
      questionId: input.questionId,
    };
    this.deps.repos.questions.update(key, {
      answerText: ignore ? null : text,
      answerDecision: ignore ? false : input.decision,
      answeredAt: this.now(),
    });
    const updated = this.deps.repos.questions.get(
      input.projectId,
      input.issueNumber,
      input.questionId,
    );
    /* c8 ignore next -- la ligne vient d'être lue */
    if (!updated) throw new QuestionNotFoundError(input.questionId);
    return this.view(updated);
  }
}

export class EmptyAnswerError extends Error {
  constructor() {
    super('La réponse est vide : choisis une option ou écris une réponse.');
    this.name = 'EmptyAnswerError';
  }
}
