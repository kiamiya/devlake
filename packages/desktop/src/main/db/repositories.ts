import { and, asc, desc, eq } from 'drizzle-orm';
import type { Issue, WorkflowRun } from 'github';
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  type Settings,
  type SettingsPatch,
} from '../../shared/settings.js';
import type { CockpitDb } from './database.js';
import { issues, projects, questions, runs, settings, tabs } from './schema.js';

export interface ProjectRow {
  id: string;
  owner: string;
  repo: string;
  addedAt: string;
  lastSyncedAt: string | null;
}

export interface TabRow {
  projectId: string;
  position: number;
  active: boolean;
}

export type MirroredIssue = Omit<Issue, 'id'>;

export function projectId(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export class ProjectsRepository {
  constructor(private readonly db: CockpitDb) {}

  list(): ProjectRow[] {
    return this.db.select().from(projects).orderBy(asc(projects.id)).all();
  }

  upsert(owner: string, repo: string, now: string): ProjectRow {
    const id = projectId(owner, repo);
    this.db.insert(projects).values({ id, owner, repo, addedAt: now }).onConflictDoNothing().run();
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw new Error(`Projet ${id} introuvable après insertion.`);
    return row;
  }

  markSynced(id: string, at: string): void {
    this.db.update(projects).set({ lastSyncedAt: at }).where(eq(projects.id, id)).run();
  }

  remove(id: string): void {
    this.db.delete(projects).where(eq(projects.id, id)).run();
  }
}

export class TabsRepository {
  constructor(private readonly db: CockpitDb) {}

  list(): TabRow[] {
    return this.db.select().from(tabs).orderBy(asc(tabs.position)).all();
  }

  /** Remplace l'ensemble des onglets (ordre et onglet actif). */
  save(rows: TabRow[]): void {
    this.db.transaction((tx) => {
      tx.delete(tabs).run();
      if (rows.length > 0) tx.insert(tabs).values(rows).run();
    });
  }
}

export class SettingsRepository {
  constructor(private readonly db: CockpitDb) {}

  /** Réglages enregistrés, complétés par les valeurs par défaut. */
  get(): Settings {
    const stored: Record<string, unknown> = {};
    for (const row of this.db.select().from(settings).all()) {
      stored[row.key] = JSON.parse(row.value) as unknown;
    }
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    const parsed = SettingsSchema.safeParse(merged);
    // Une valeur devenue invalide (ancienne version) retombe sur les valeurs par défaut.
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  update(patch: SettingsPatch): Settings {
    const next = SettingsSchema.parse({ ...this.get(), ...patch });
    this.db.transaction((tx) => {
      for (const [key, value] of Object.entries(patch)) {
        tx.insert(settings)
          .values({ key, value: JSON.stringify(value) })
          .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value) } })
          .run();
      }
    });
    return next;
  }
}

/** Miroir des issues et runs d'un projet, remplacé en bloc à chaque synchronisation. */
export class MirrorRepository {
  constructor(private readonly db: CockpitDb) {}

  replaceIssues(id: string, items: readonly MirroredIssue[]): void {
    this.db.transaction((tx) => {
      tx.delete(issues).where(eq(issues.projectId, id)).run();
      if (items.length > 0) {
        tx.insert(issues)
          .values(
            items.map((i) => ({
              projectId: id,
              number: i.number,
              title: i.title,
              body: i.body,
              state: i.state,
              labels: i.labels,
              author: i.author,
            })),
          )
          .run();
      }
    });
  }

  listIssues(id: string): MirroredIssue[] {
    return this.db
      .select({
        number: issues.number,
        title: issues.title,
        body: issues.body,
        state: issues.state,
        labels: issues.labels,
        author: issues.author,
      })
      .from(issues)
      .where(eq(issues.projectId, id))
      .orderBy(asc(issues.number))
      .all();
  }

  replaceRuns(id: string, items: readonly WorkflowRun[]): void {
    this.db.transaction((tx) => {
      tx.delete(runs).where(eq(runs.projectId, id)).run();
      if (items.length > 0)
        tx.insert(runs)
          .values(items.map((r) => ({ projectId: id, ...r })))
          .run();
    });
  }

  listRuns(id: string): WorkflowRun[] {
    return this.db
      .select({
        id: runs.id,
        name: runs.name,
        workflow: runs.workflow,
        status: runs.status,
        conclusion: runs.conclusion,
        headBranch: runs.headBranch,
        event: runs.event,
        createdAt: runs.createdAt,
        url: runs.url,
        title: runs.title,
        updatedAt: runs.updatedAt,
      })
      .from(runs)
      .where(eq(runs.projectId, id))
      .orderBy(asc(runs.id))
      .all()
      .map(({ title, updatedAt, ...run }) => ({
        ...run,
        ...(title === null ? {} : { title }),
        ...(updatedAt === null ? {} : { updatedAt }),
      }));
  }
}

export type QuestionRow = typeof questions.$inferSelect;
export type NewQuestionRow = typeof questions.$inferInsert;

/** Questions lues sur GitHub ; jamais supprimées (historique), seulement complétées. */
export class QuestionsRepository {
  constructor(private readonly db: CockpitDb) {}

  list(projectId?: string): QuestionRow[] {
    const query = this.db.select().from(questions);
    return (projectId === undefined ? query : query.where(eq(questions.projectId, projectId)))
      .orderBy(desc(questions.askedAt))
      .all();
  }

  get(projectId: string, issueNumber: number, questionId: string): QuestionRow | undefined {
    return this.db
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.projectId, projectId),
          eq(questions.issueNumber, issueNumber),
          eq(questions.questionId, questionId),
        ),
      )
      .get();
  }

  /** Ajoute une question nouvelle ; une question connue garde ses champs (notification comprise). */
  insertIfMissing(row: NewQuestionRow): boolean {
    const result = this.db.insert(questions).values(row).onConflictDoNothing().run();
    return result.changes > 0;
  }

  update(
    key: { projectId: string; issueNumber: number; questionId: string },
    patch: Partial<
      Pick<QuestionRow, 'answerText' | 'answerDecision' | 'answeredAt' | 'notified' | 'issueTitle'>
    >,
  ): void {
    this.db
      .update(questions)
      .set(patch)
      .where(
        and(
          eq(questions.projectId, key.projectId),
          eq(questions.issueNumber, key.issueNumber),
          eq(questions.questionId, key.questionId),
        ),
      )
      .run();
  }
}

export interface Repositories {
  projects: ProjectsRepository;
  tabs: TabsRepository;
  settings: SettingsRepository;
  mirror: MirrorRepository;
  questions: QuestionsRepository;
}

export function createRepositories(db: CockpitDb): Repositories {
  return {
    projects: new ProjectsRepository(db),
    tabs: new TabsRepository(db),
    settings: new SettingsRepository(db),
    mirror: new MirrorRepository(db),
    questions: new QuestionsRepository(db),
  };
}
