import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool, PoolClient } from '../db.js';
import { parse } from '../http.js';
import { DEFAULT_SETTINGS, type WeightSettings } from '../weighting.js';

export const settingsSchema = z
  .object({
    lambda: z.number().gt(0, 'lambda must be > 0').lt(1, 'lambda must be < 1'),
    k: z.number().min(0, 'k must be >= 0').finite(),
    floor: z.number().gt(0, 'floor must be > 0').max(1, 'floor must be <= 1'),
    categoryFirst: z.boolean(),
  })
  .strict();

/** Read settings, filling any missing key with its default. */
export async function loadSettings(db: Pool | PoolClient): Promise<WeightSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    'select key, value from settings',
  );
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const merged = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof WeightSettings)[]) {
    const v = stored[key];
    if (typeof v === typeof DEFAULT_SETTINGS[key]) (merged as Record<string, unknown>)[key] = v;
  }
  return merged;
}

export async function saveSettings(db: Pool | PoolClient, s: WeightSettings): Promise<void> {
  await db.query(
    `insert into settings (key, value)
     select key, value from jsonb_each($1::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(s)],
  );
}

export function settingsRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/api/settings', () => loadSettings(pool));

  app.put('/api/settings', async (req) => {
    const body = parse(settingsSchema, req.body);
    await saveSettings(pool, body);
    return loadSettings(pool);
  });
}
