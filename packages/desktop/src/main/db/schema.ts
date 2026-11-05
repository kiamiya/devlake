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
