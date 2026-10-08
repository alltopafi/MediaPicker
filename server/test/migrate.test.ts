import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate, type Pool } from '../src/db.js';
import { MIGRATIONS_DIR, TEST_DB_NAMES, testDatabaseUrl, urlForDb } from './helpers.js';

describe('migrations', () => {
  let pool: Pool;

  beforeAll(() => {
    const scratch = TEST_DB_NAMES(new URL(testDatabaseUrl()))[1]!;
    pool = createPool(urlForDb(scratch));
  });
  afterAll(() => pool.end());

  it('seeds once and never re-seeds deleted defaults', async () => {
    const first = await migrate(pool, MIGRATIONS_DIR);
    expect(first).toContain('001_init.sql');

    const cats = await pool.query('select name from categories order by sort_order');
    expect(cats.rows.map((r) => r.name)).toEqual(['Movies', 'Shows', 'Books', 'Games']);
    const settings = await pool.query('select key, value from settings order by key');
    expect(Object.fromEntries(settings.rows.map((r) => [r.key, r.value]))).toEqual({
      categoryFirst: false,
      floor: 0.03,
      k: 4,
      lambda: 0.7,
    });

    // "Delete" a seeded category (even hard-delete) and migrate again, as on reboot.
    await pool.query(`delete from categories where name = 'Games'`);
    const second = await migrate(pool, MIGRATIONS_DIR);
    expect(second).toEqual([]);
    const after = await pool.query('select name from categories');
    expect(after.rows.map((r) => r.name)).not.toContain('Games');
    expect(after.rowCount).toBe(3);
  });

  it('concurrent migrators do not race (advisory lock)', async () => {
    const results = await Promise.all([
      migrate(pool, MIGRATIONS_DIR),
      migrate(pool, MIGRATIONS_DIR),
      migrate(pool, MIGRATIONS_DIR),
    ]);
    expect(results.flat()).toEqual([]);
    const { rows } = await pool.query('select count(*)::int as n from schema_migrations');
    expect(rows[0].n).toBe(1);
  });
});
