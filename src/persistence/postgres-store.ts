import pg from "pg";
import type { StateStore } from "./state-store.js";

const { Pool } = pg;

/**
 * Postgres-backed `StateStore` — the production-database swap CLAUDE.md's
 * "Not yet built" section used to flag. Deliberately not a normalized
 * relational schema: `system-state.ts` already reduces the whole app to
 * one JSON snapshot via each domain object's `toSnapshot()`, so this
 * stores that single blob in a `JSONB` column keyed by an opaque string
 * (one row per deployment, in practice). A real per-table schema would be
 * a much bigger redesign for very little benefit at this scale — the
 * point of `StateStore` is that `system-state.ts` and everything upstream
 * of it never has to know or care which one is in use.
 */
export interface PostgresStateStoreOptions {
  connectionString: string;
  /** Row key within the state table — only matters if you ever run more than one Docket deployment against the same database. */
  key?: string;
}

export interface PostgresStateStore extends StateStore {
  close(): Promise<void>;
}

const DEFAULT_KEY = "system-state";

export async function createPostgresStateStore(options: PostgresStateStoreOptions): Promise<PostgresStateStore> {
  const pool = new Pool({ connectionString: options.connectionString });
  const key = options.key ?? DEFAULT_KEY;

  // Idempotent: safe to run on every boot, including against an existing table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docket_state (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  return {
    async read<T>(defaultValue: T): Promise<T> {
      const result = await pool.query<{ data: T }>("SELECT data FROM docket_state WHERE key = $1", [key]);
      return result.rows[0]?.data ?? defaultValue;
    },

    async write(data: unknown): Promise<void> {
      await pool.query(
        `INSERT INTO docket_state (key, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [key, data],
      );
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
