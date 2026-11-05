import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

/** Migrations SQL versionnées, intégrées au bundle (générées par drizzle-kit). */
const MIGRATIONS = import.meta.glob<string>('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export type CockpitDb = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  sqlite: Database.Database;
  db: CockpitDb;
  /** Vrai si la base vient d'être créée (aucune migration appliquée avant). */
  created: boolean;
}

export interface Migration {
  name: string;
  sql: string;
}

export function bundledMigrations(): Migration[] {
  return Object.entries(MIGRATIONS)
    .map(([path, sql]) => ({ name: path.split('/').pop() ?? path, sql }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Applique dans l'ordre les migrations non encore appliquées, chacune dans une transaction. */
export function runMigrations(sqlite: Database.Database, migrations: Migration[]): number {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS __agentlake_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    sqlite
      .prepare<[], { name: string }>('SELECT name FROM __agentlake_migrations')
      .all()
      .map((row) => row.name),
  );
  const record = sqlite.prepare(
    'INSERT INTO __agentlake_migrations (name, applied_at) VALUES (?, ?)',
  );
  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    sqlite.transaction(() => {
      for (const statement of migration.sql.split('--> statement-breakpoint')) {
        if (statement.trim()) sqlite.exec(statement);
      }
      record.run(migration.name, new Date().toISOString());
    })();
    count += 1;
  }
  return count;
}

/** Ouvre (ou crée) la base du cockpit : WAL, clés étrangères, migrations. */
export function openDatabase(
  file: string,
  migrations: Migration[] = bundledMigrations(),
): OpenedDatabase {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const fresh =
    sqlite
      .prepare<[], { n: number }>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '__agentlake_migrations'",
      )
      .get()?.n === 0;
  runMigrations(sqlite, migrations);
  return { sqlite, db: drizzle(sqlite, { schema }), created: fresh };
}
