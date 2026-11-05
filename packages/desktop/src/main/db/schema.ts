import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Cache local du cockpit. Tout est reconstructible depuis GitHub ;
 * les tables n'existent que par migrations (npm run db:generate -w desktop).
 */

export const projects = sqliteTable('projects', {
  /** « owner/repo ». */
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  addedAt: text('added_at').notNull(),
  lastSyncedAt: text('last_synced_at'),
});

export const tabs = sqliteTable('tabs', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
});

/** Réglages : une ligne par clé, valeur JSON. Le jeton GitHub n'y est jamais. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const issues = sqliteTable(
  'issues',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    state: text('state', { enum: ['open', 'closed'] }).notNull(),
    labels: text('labels', { mode: 'json' }).$type<string[]>().notNull(),
    author: text('author').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.number] })],
);

export const runs = sqliteTable(
  'runs',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    id: integer('id').notNull(),
    name: text('name').notNull(),
    workflow: text('workflow').notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    headBranch: text('head_branch').notNull(),
    event: text('event').notNull(),
    createdAt: text('created_at').notNull(),
    url: text('url').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.id] })],
);

/**
 * Questions des agents et du planificateur, lues dans les commentaires des issues.
 * Gardées après la réponse et la fermeture de l'issue : c'est l'historique.
 */
export const questions = sqliteTable(
  'questions',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueNumber: integer('issue_number').notNull(),
    questionId: text('question_id').notNull(),
    /** Issue de tâche, ou issue « Cadrage » du planificateur. */
    source: text('source', { enum: ['task', 'cadrage'] }).notNull(),
    issueTitle: text('issue_title').notNull(),
    blocking: integer('blocking', { mode: 'boolean' }).notNull(),
    text: text('text').notNull(),
    context: text('context'),
    options: text('options', { mode: 'json' }).$type<string[]>().notNull(),
    askedAt: text('asked_at').notNull(),
    answerText: text('answer_text'),
    answerDecision: integer('answer_decision', { mode: 'boolean' }),
    answeredAt: text('answered_at'),
    /** Notification système déjà émise pour cette question. */
    notified: integer('notified', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.issueNumber, t.questionId] })],
);
