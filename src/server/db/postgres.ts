/**
 * Postgres driver based on Bun's built-in SQL client (no external package).
 */
import { SQL } from 'bun';

export interface PostgresDb {
  readonly sql: SQL;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createPostgresDb(databaseUrl: string): PostgresDb {
  const sql = new SQL(databaseUrl);
  return {
    sql,
    async ping() {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await sql.close({ timeout: 5 });
    },
  };
}
