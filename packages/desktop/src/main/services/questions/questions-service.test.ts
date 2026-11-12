import { FakeGitHub } from 'github';
import {
  CADRAGE_LABEL,
  parseAnswerComment,
  renderAnswerComment,
  renderQuestionComment,
  stateLabel,
  TASK_LABEL,
} from 'shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { createRepositories, type Repositories } from '../../db/repositories.js';
import {
  EmptyAnswerError,
  QuestionNotFoundError,
  QuestionsService,
  type QuestionNotification,
} from './questions-service.js';

const ref = { owner: 'kiamiya', repo: 'site' };
const PROJECT = 'kiamiya/site';
const q = (id: string, blocking = true, options: string[] = []) =>
  renderQuestionComment({ id, blocking, text: `Question ${id} ?`, context: 'Contexte.', options });

describe('boîte de questions (service)', () => {
  let github: FakeGitHub;
  let repos: Repositories;
  let service: QuestionsService;
  let notified: QuestionNotification[];
  let badges: number[];

  beforeEach(() => {
    github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    repos = createRepositories(openDatabase(':memory:').db);
    repos.projects.upsert('kiamiya', 'site', '2026-11-06T08:00:00.000Z');
    notified = [];
    badges = [];
    service = new QuestionsService({
      repos,
      github: () => Promise.resolve(github),
      notify: (n) => notified.push(n),
      badge: (count) => badges.push(count),
      now: () => '2026-11-06T12:00:00.000Z',
    });
  });

  async function waiting(title: string, label = stateLabel('awaiting-answer')) {
    return github.createIssue(ref, { title, body: '', labels: [TASK_LABEL, label] });
  }

  it('lit les tâches en attente, escaladées et l’issue Cadrage ; notifie une seule fois', async () => {
    const t1 = await waiting('T01 — Connexion');
    await github.createComment(ref, t1.number, q('fuseau', true, ['Paris', 'UTC']));
    await github.createComment(ref, t1.number, q('nommage', false));
    const t2 = await waiting('T02 — Somme', stateLabel('escalated'));
    await github.createComment(ref, t2.number, q('escalade-T02-3'));
    const cadrage = await github.createIssue(ref, {
      title: 'Cadrage',
      body: '',
      labels: [CADRAGE_LABEL],
    });
    await github.createComment(ref, cadrage.number, q('cible'));
    // Tâche en cours : ses commentaires ne sont pas lus.
    const running = await waiting('T03', stateLabel('running'));
    await github.createComment(ref, running.number, q('ignorée'));

    expect(await service.syncAll()).toEqual({ pending: 4, blocking: 3, newBlocking: 3 });
    expect(badges).toEqual([3]);
    expect(notified.map((n) => n.body).sort()).toEqual([
      'Cadrage : Question cible ?',
      'T01 — Connexion : Question fuseau ?',
      'T02 — Somme : Question escalade-T02-3 ?',
    ]);
    expect(notified[0]?.title).toBe('Question bloquante — site');

    expect(await service.syncAll()).toMatchObject({ newBlocking: 0 });
    expect(notified).toHaveLength(3);

    const pending = service.list({ status: 'pending' });
    expect(pending.find((v) => v.questionId === 'fuseau')).toMatchObject({
      projectId: PROJECT,
      issueTitle: 'T01 — Connexion',
      issueUrl: `https://github.com/kiamiya/site/issues/${String(t1.number)}`,
      source: 'task',
      blocking: true,
      context: 'Contexte.',
      options: ['Paris', 'UTC'],
      answer: null,
    });
    expect(pending.find((v) => v.questionId === 'cible')?.source).toBe('cadrage');
  });

  it('une réponse donnée sur GitHub passe la question dans l’historique', async () => {
    const t1 = await waiting('T01');
    await github.createComment(ref, t1.number, q('fuseau'));
    await service.syncAll();
    await github.createComment(
      ref,
      t1.number,
      renderAnswerComment({ id: 'fuseau', decision: true, text: 'Paris.' }),
    );
    // L'issue est relancée entre deux sondages : elle n'attend plus, la réponse est lue quand même.
    await github.removeLabel(ref, t1.number, stateLabel('awaiting-answer'));
    await github.addLabels(ref, t1.number, [stateLabel('running')]);
    await service.syncAll();
    expect(service.list({ status: 'pending' })).toEqual([]);
    expect(service.list({ status: 'answered' })[0]?.answer).toMatchObject({
      text: 'Paris.',
      decision: true,
    });
  });

  it('question chez l’architecte : pas de notification ; notifiée si elle revient à Kia', async () => {
    const t1 = await waiting('T01');
    await github.createComment(ref, t1.number, q('base'));
    await github.createComment(ref, t1.number, '<!-- agentlake:architect-asked id=base -->');
    await service.syncAll();
    expect(notified).toEqual([]);
    expect(service.list({ status: 'pending' })).toHaveLength(1);
    await github.createComment(ref, t1.number, '<!-- agentlake:architect-escalated id=base -->');
    await service.syncAll();
    expect(notified).toHaveLength(1);
  });

  it('réponse de l’architecte (bot des workflows) : question répondue ; pas depuis un autre compte', async () => {
    const t1 = await waiting('T01');
    await github.createComment(ref, t1.number, q('base'));
    const posted = await github.createComment(
      ref,
      t1.number,
      renderAnswerComment({ id: 'base', decision: false, text: 'Postgres.', by: 'architect' }),
    );
    const replace = (author: string) =>
      github
        .state(ref)
        .comments.get(t1.number)
        ?.splice(-1, 1, { ...posted, author });
    replace('pirate');
    await service.syncAll();
    expect(service.list({ status: 'pending' })).toHaveLength(1);
    replace('github-actions[bot]');
    await service.syncAll();
    expect(service.list({ status: 'answered' })[0]?.answer).toMatchObject({ text: 'Postgres.' });
  });

  it('dépôt d’organisation : la réponse de Kia (compte du jeton) est reconnue', async () => {
    const studio = { owner: 'studio', repo: 'jeu' };
    github.seedRepository(studio, { admin: true });
    repos.projects.upsert('studio', 'jeu', '2026-11-06T08:00:00.000Z');
    const t1 = await github.createIssue(studio, {
      title: 'T01',
      body: '',
      labels: [TASK_LABEL, stateLabel('awaiting-answer')],
    });
    await github.createComment(studio, t1.number, q('fuseau'));
    await github.createComment(
      studio,
      t1.number,
      renderAnswerComment({ id: 'fuseau', decision: true, text: 'Paris.' }),
    );
    await service.syncAll();
    expect(service.list({ projectId: 'studio/jeu', status: 'answered' })).toHaveLength(1);
  });

  it('issue sortie de l’attente sans réponse : question close, sans notification', async () => {
    const t1 = await waiting('T01');
    await github.createComment(ref, t1.number, q('fuseau'));
    await service.syncAll();
    await github.updateIssue(ref, t1.number, { state: 'closed' });
    await service.syncAll();
    const [closed] = service.list({ status: 'answered' });
    expect(closed?.answer).toEqual({ text: null, decision: null, at: '2026-11-06T12:00:00.000Z' });
  });

  it('recherche dans les questions, réponses et titres', async () => {
    const t1 = await waiting('T01 — Agenda');
    await github.createComment(ref, t1.number, q('fuseau'));
    await service.syncAll();
    expect(service.list({ status: 'all', search: 'agenda' })).toHaveLength(1);
    expect(service.list({ status: 'all', search: 'FUSEAU' })).toHaveLength(1);
    expect(service.list({ status: 'all', search: 'inexistant' })).toEqual([]);
    expect(service.list({ status: 'all', projectId: 'kiamiya/autre' })).toEqual([]);
  });

  it('publie la réponse au format du protocole, avec décision et pièces jointes', async () => {
    const t1 = await waiting('T01');
    await github.createComment(ref, t1.number, q('fuseau'));
    await service.syncAll();
    const view = await service.answer({
      projectId: PROJECT,
      issueNumber: t1.number,
      questionId: 'fuseau',
      text: '  Europe/Paris  ',
      decision: true,
      ignore: false,
      attachments: ['.agentlake/context/annexes/fuseaux.md'],
    });
    expect(view.answer).toMatchObject({ decision: true, at: '2026-11-06T12:00:00.000Z' });
    const posted = parseAnswerComment(
      (await github.listComments(ref, t1.number)).at(-1)?.body ?? '',
    );
    expect(posted.ok && posted.value).toEqual({
      id: 'fuseau',
      decision: true,
      text: 'Europe/Paris\n\nPièces jointes versées dans le contexte :\n- `.agentlake/context/annexes/fuseaux.md`',
    });
    // Déjà répondue : refusée.
    await expect(
      service.answer({
        projectId: PROJECT,
        issueNumber: t1.number,
        questionId: 'fuseau',
        text: 'encore',
        decision: false,
        ignore: false,
        attachments: [],
      }),
    ).rejects.toThrow(QuestionNotFoundError);
  });

  it('ignorer : seulement une question du planificateur ; réponse vide refusée', async () => {
    const cadrage = await github.createIssue(ref, {
      title: 'Cadrage',
      body: '',
      labels: [CADRAGE_LABEL],
    });
    await github.createComment(ref, cadrage.number, q('cible'));
    const t1 = await waiting('T01');
    await github.createComment(ref, t1.number, q('fuseau'));
    await service.syncAll();
    const base = { projectId: PROJECT, text: '', decision: true, attachments: [] };
    await expect(
      service.answer({ ...base, issueNumber: t1.number, questionId: 'fuseau', ignore: true }),
    ).rejects.toThrow(EmptyAnswerError);
    await service.answer({
      ...base,
      issueNumber: cadrage.number,
      questionId: 'cible',
      ignore: true,
    });
    const posted = parseAnswerComment(
      (await github.listComments(ref, cadrage.number)).at(-1)?.body ?? '',
    );
    expect(posted.ok && posted.value).toEqual({
      id: 'cible',
      decision: false,
      text: 'Question ignorée.',
      ignored: true,
    });
    await expect(
      service.answer({ ...base, issueNumber: 99, questionId: 'x', ignore: false }),
    ).rejects.toThrow(QuestionNotFoundError);
  });
});
