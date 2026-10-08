import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

// Arbitrary constant key for pg_advisory_lock; any replica migrating holds it.
const MIGRATION_LOCK_KEY = 728_412_019;

interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
}

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client erroring (e.g. DB restarted) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

/** Retry `select 1` with exponential backoff so app and DB can start in any order. */
export async function waitForDb(
  pool: pg.Pool,
  log: Logger,
  { attempts = 30, initialDelayMs = 500, maxDelayMs = 10_000 } = {},
): Promise<void> {
  let delay = initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('select 1');
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      log.warn(
        { attempt, retryInMs: delay, err: (err as Error).message },
        'database not reachable yet',
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

/**
 * Apply pending numbered .sql migrations in order. Guarded by an advisory lock so
 * replicas booting together don't race; each migration runs in its own transaction.
 */
export async function migrate(
  pool: pg.Pool,
  migrationsDir: string,
  log?: Logger,
): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`
        create table if not exists schema_migrations (
          name       text primary key,
          applied_at timestamptz not null default now()
        )`);
      const done = new Set(
        (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
          (r) => r.name,
        ),
      );
      for (const file of files) {
        if (done.has(file)) continue;
        const sql = await readFile(path.join(migrationsDir, file), 'utf8');
        await client.query('begin');
        try {
          await client.query(sql);
          await client.query('insert into schema_migrations (name) values ($1)', [file]);
          await client.query('commit');
        } catch (err) {
          await client.query('rollback');
          throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }
        applied.push(file);
        log?.info({ migration: file }, 'applied migration');
      }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return applied;
}

/** Run `fn` inside a transaction on a dedicated client. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
