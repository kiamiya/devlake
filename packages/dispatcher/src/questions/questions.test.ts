import { FakeGitHub, type Comment } from 'github';
import {
  renderAnswerComment,
  renderQuestionComment,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
  type Question,
} from 'shared';
import { makeProjectConfig, makeTask } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { PROJECT_CONFIG, runDispatch } from '../dispatch/dispatcher.js';
import { planPass } from '../dispatch/plan-pass.js';
import { answerEventFrom, traceIgnoredAnswer } from './answers.js';
import { appendDecision } from './decisions.js';
import { ignoredAnswerReason, readThread, reminderComment, reminderDue } from './thread.js';
import { seedGreenMain } from '../testing/checks.js';

const OWNER = 'kiamiya';
const q = (id: string, blocking = true): Question => ({
  id,
  blocking,
  text: `Question ${id} ?`,
  options: [],
});

let nextId = 1;
const comment = (
  body: string,
  author = 'github-actions[bot]',
  createdAt = '2026-11-05T10:00:00Z',
): Comment => ({
  id: nextId++,
  body,
  author,
  createdAt,
});
const answer = (id: string, author = OWNER, text = 'Oui.') =>
  comment(renderAnswerComment({ id, decision: true, text }), author);

describe('fil de questions', () => {
  it('attend la dernière question bloquante et apparie la réponse du propriétaire', () => {
    const thread = readThread(
      [
        comment(renderQuestionComment(q('a'))),
        answer('a'),
        comment(renderQuestionComment(q('b'))),
        comment(renderQuestionComment(q('info', false))),
        answer('b', 'Kiamiya', 'Non.'),
      ],
      OWNER,
    );
    expect(thread.pending?.question.id).toBe('b');
    expect(thread.answer).toMatchObject({ id: 'b', text: 'Non.' });
  });

  it('ignore une réponse à une ancienne question, d’un autre auteur, ou antérieure à la question', () => {
    const early = answer('b');
    const thread = readThread(
      [
        early,
        comment(renderQuestionComment(q('a'))),
        answer('a'),
        comment(renderQuestionComment(q('b'))),
        answer('a'),
        answer('b', 'pirate'),
      ],
      OWNER,
    );
    expect(thread.pending?.question.id).toBe('b');
    expect(thread.answer).toBeNull();
  });

  it('sans question bloquante : rien en attente', () => {
    expect(readThread([comment(renderQuestionComment(q('x', false))), answer('x')], OWNER)).toEqual(
      {
        pending: null,
        answer: null,
        reminded: false,
        architect: null,
        architectAskedAt: null,
      },
    );
  });

  it('rappel : une seule fois, passé le délai, tant qu’il n’y a pas de réponse', () => {
    const question = comment(renderQuestionComment(q('a')), 'bot', '2026-11-04T10:00:00Z');
    const now = new Date('2026-11-05T10:00:00Z');
    const thread = readThread([question], OWNER);
    expect(reminderDue(thread, now, 24)).toBe(true);
    expect(reminderDue(thread, now, 25)).toBe(false);
    const reminded = readThread([question, comment(reminderComment(OWNER, q('a'), 24))], OWNER);
    expect(reminded.reminded).toBe(true);
    expect(reminderDue(reminded, now, 24)).toBe(false);
    expect(reminderDue(readThread([question, answer('a')], OWNER), now, 24)).toBe(false);
    expect(reminderComment(OWNER, q('a'), 24)).toContain('@kiamiya rappel');
  });

  it('raisons d’ignorer une réponse', () => {
    const base = {
      answer: { id: 'a', decision: true, text: 'x' },
      owner: OWNER,
      awaiting: true,
      pending: q('a'),
    };
    expect(ignoredAnswerReason({ ...base, author: OWNER })).toBeNull();
    expect(ignoredAnswerReason({ ...base, author: 'pirate' })).toContain('seul kiamiya');
    expect(ignoredAnswerReason({ ...base, author: OWNER, awaiting: false })).toContain(
      'n’attend aucune réponse',
    );
    expect(ignoredAnswerReason({ ...base, author: OWNER, pending: q('b') })).toContain(
      'attend la question `b`',
    );
  });
});

describe('décisions', () => {
  const entry = {
    issueNumber: 4,
    taskId: 'T04',
    question: q('a'),
    answer: { id: 'a', decision: true, text: 'Paris.' },
    date: '2026-11-05',
  };

  it('crée le fichier, ajoute à la suite, et n’ajoute jamais deux fois', () => {
    const first = appendDecision(null, entry);
    expect(first).toContain('# Décisions du projet');
    expect(first).toContain('**Décision** : Paris.');
    expect(appendDecision(first, entry)).toBeNull();
    const second = appendDecision(first, { ...entry, question: q('b') });
    expect(second?.match(/agentlake:decision/g)).toHaveLength(2);
  });
});

describe('dispatcher et questions', () => {
  const ref = { owner: OWNER, repo: 'site' };

  async function setup(project = makeProjectConfig()) {
    const github = new FakeGitHub({ actor: OWNER });
    github.seedRepository(ref);
    seedGreenMain(github, ref);
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'p',
      changes: [{ path: PROJECT_CONFIG, content: stringify(project) }],
    });
    const issue = await github.createIssue(ref, {
      title: 'T01',
      body: `${renderTaskIssueBody(makeTask({ id: 'T01' }))}\n<!-- agentlake:dispatch {"attempts":1,"launchedAt":"2026-11-05T08:00:00.000Z"} -->\n`,
      labels: [TASK_LABEL, stateLabel('awaiting-answer')],
    });
    const log: string[] = [];
    const deps = (now: string) => ({
      github,
      globalCap: () => Promise.resolve({ cap: 3 }),
      bridgeHealthy: () => Promise.resolve(true),
      minutesRemaining: () => Promise.resolve({ minutes: null }),
      now: () => new Date(now),
      log: (l: string) => log.push(l),
    });
    return { github, issue, deps, log };
  }

  it('réponse valide : reprise avec resume_reason=answer, sans compter d’échec', async () => {
    const { github, issue, deps } = await setup();
    await github.createComment(ref, issue.number, renderQuestionComment(q('a')));
    await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'a', decision: true, text: 'Oui.' }),
    );
    const result = await runDispatch(ref, deps('2026-11-05T09:00:00Z'));
    expect(result.applied).toEqual([
      expect.objectContaining({
        kind: 'launch',
        resume: 'answer',
        attempt: 2,
        from: 'awaiting-answer',
      }),
    ]);
    const after = await github.getIssue(ref, issue.number);
    expect(after.labels).toContain(stateLabel('running'));
    expect(after.body).toContain('"resumes":1');
    expect(github.state(ref).dispatches[0]?.inputs?.resume_reason).toBe('answer');
    // Rejouée : la tâche tourne déjà, rien de plus.
    expect((await runDispatch(ref, deps('2026-11-05T09:01:00Z'))).applied).toEqual([]);
  });

  it('question technique : transmise à l’architecte une fois ; sa réponse relance la tâche', async () => {
    const { github, issue, deps } = await setup();
    await github.createComment(ref, issue.number, renderQuestionComment(q('a')));
    const now = new Date().toISOString();
    await runDispatch(ref, deps(now));
    await runDispatch(ref, deps(now));
    expect(
      github.state(ref).dispatches.filter((d) => d.workflow === 'agentlake-architect.yml'),
    ).toEqual([
      expect.objectContaining({ inputs: { issue_number: String(issue.number), question_id: 'a' } }),
    ]);
    // Une réponse « by=architect » d'un autre compte que le bot des workflows ne compte pas.
    const forged = await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'a', decision: false, text: 'Oui', by: 'architect' }),
    );
    github
      .state(ref)
      .comments.get(issue.number)
      ?.splice(-1, 1, { ...forged, author: 'pirate' });
    expect(readThread(await github.listComments(ref, issue.number), OWNER).answer).toBeNull();
    const real = await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'a', decision: false, text: 'Oui, Postgres.', by: 'architect' }),
    );
    github
      .state(ref)
      .comments.get(issue.number)
      ?.splice(-1, 1, { ...real, author: 'github-actions[bot]' });
    expect(readThread(await github.listComments(ref, issue.number), OWNER).answer).toMatchObject({
      text: 'Oui, Postgres.',
      by: 'architect',
    });
  });

  it('architecte sans réponse au bout de 2 h : question rendue à Kia', async () => {
    const { github, issue, deps } = await setup();
    await github.createComment(ref, issue.number, renderQuestionComment(q('a')));
    const createdAt = (await github.listComments(ref, issue.number))[0]?.createdAt ?? '';
    await runDispatch(ref, deps(createdAt));
    const later = new Date(Date.parse(createdAt) + 3 * 3_600_000).toISOString();
    await runDispatch(ref, deps(later));
    const thread = readThread(await github.listComments(ref, issue.number), OWNER);
    expect(thread.architect).toBe('escalated');
  });

  it('sans réponse : rappel unique au bout du délai du projet, sans autre action', async () => {
    const project = makeProjectConfig();
    const { github, issue, deps } = await setup({
      ...project,
      limits: { ...project.limits, answerReminderHours: 2 },
    });
    await github.createComment(ref, issue.number, renderQuestionComment(q('a')));
    // Question rendue à Kia par l'architecte.
    await github.createComment(ref, issue.number, '<!-- agentlake:architect-asked id=a -->');
    await github.createComment(ref, issue.number, '<!-- agentlake:architect-escalated id=a -->');
    const createdAt = (await github.listComments(ref, issue.number))[0]?.createdAt ?? '';
    const later = new Date(Date.parse(createdAt) + 3 * 3_600_000).toISOString();
    expect((await runDispatch(ref, deps(later))).applied).toEqual([]);
    await runDispatch(ref, deps(later));
    const comments = await github.listComments(ref, issue.number);
    expect(comments.filter((c) => c.body.includes('agentlake:reminder'))).toHaveLength(1);
    expect((await github.getIssue(ref, issue.number)).labels).toContain(
      stateLabel('awaiting-answer'),
    );
  });

  it('les reprises ne comptent pas comme des échecs pour l’escalade', () => {
    const plan = planPass({
      tasks: [
        {
          number: 1,
          task: makeTask({ id: 'T01' }),
          open: true,
          state: 'fixing',
          meta: { attempts: 3, launchedAt: null, resumes: 1 },
        },
      ],
      mergedTaskIds: new Set(),
      runs: [],
      now: new Date(),
      limits: { projectCap: null, globalCap: 3, runnerCap: 20, maxAttempts: 3 },
      bridgeHealthy: null,
      minutesRemaining: null,
      estimateMinutes: () => 10,
    });
    expect(plan.actions[0]).toMatchObject({ kind: 'launch', attempt: 4, resume: 'ci-failure' });
  });

  it('trace une réponse ignorée une seule fois ; rien pour une réponse valide ou hors tâche', async () => {
    const { github, issue } = await setup();
    await github.createComment(ref, issue.number, renderQuestionComment(q('b')));
    const old = await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'a', decision: true, text: 'x' }),
    );
    const event = { issueNumber: issue.number, commentId: old.id, author: OWNER, body: old.body };
    expect(await traceIgnoredAnswer(github, ref, event)).toContain('attend la question `b`');
    expect(await traceIgnoredAnswer(github, ref, event)).toContain('attend la question `b`');
    const traces = (await github.listComments(ref, issue.number)).filter((c) =>
      c.body.includes('answer-ignored'),
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]?.body).toContain('_Réponse à `a` ignorée');

    const good = await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'b', decision: false, text: 'ok' }),
    );
    expect(
      await traceIgnoredAnswer(github, ref, { ...event, commentId: good.id, body: good.body }),
    ).toBeNull();
    // Une seconde réponse à la même question, alors qu'une réponse valide existe déjà.
    const late = await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'b', decision: false, text: 'autre' }),
    );
    await github.updateIssue(ref, issue.number, { state: 'closed' });
    expect(
      await traceIgnoredAnswer(github, ref, { ...event, commentId: good.id, body: good.body }),
    ).toContain('n’attend aucune réponse');
    expect(late.id).toBeGreaterThan(good.id);

    expect(await traceIgnoredAnswer(github, ref, { ...event, body: 'pas une réponse' })).toBeNull();
    const cadrage = await github.createIssue(ref, {
      title: 'Cadrage',
      body: '',
      labels: ['agentlake:cadrage'],
    });
    expect(
      await traceIgnoredAnswer(github, ref, { ...event, issueNumber: cadrage.number }),
    ).toBeNull();
  });

  it('extrait le commentaire d’un événement issue_comment', () => {
    expect(
      answerEventFrom({
        issue: { number: 3 },
        comment: { id: 9, body: 'b', user: { login: 'k' } },
      }),
    ).toEqual({
      issueNumber: 3,
      commentId: 9,
      author: 'k',
      body: 'b',
    });
    expect(answerEventFrom({ issue: { number: 3 } })).toBeNull();
    expect(answerEventFrom(null)).toBeNull();
  });
});
