import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { conflict, notFound, parse } from '../http.js';
import { pick, RECENT_PICKS_LIMIT, type Rng } from '../weighting.js';
import { loadSettings } from './settings.js';

interface CandidateRow {
  id: string;
  title: string;
  categoryId: string;
  categoryName: string;
}

// Eligible = active status, item not archived, category not archived.
const ELIGIBLE = `
  select i.id, i.title, i.category_id as "categoryId", c.name as "categoryName"
  from items i join categories c on c.id = i.category_id
  where i.status = 'active' and i.archived_at is null and c.archived_at is null`;

export function pickRoutes(app: FastifyInstance, pool: Pool, rng: Rng) {
  // Read-only: computes a pick but records NOTHING, so re-rolls don't affect weights.
  app.post('/api/pick', async (req) => {
    const body = parse(
      z.object({ categoryIds: z.array(z.string().uuid()).optional() }).optional(),
      req.body ?? undefined,
    );
    const categoryIds = body?.categoryIds?.length ? body.categoryIds : null;
    const [candidates, recent, settings] = await Promise.all([
      pool.query<CandidateRow>(
        `${ELIGIBLE} ${categoryIds ? 'and c.id = any($1::uuid[])' : ''}
         order by c.sort_order, lower(c.name), i.created_at, i.id`,
        categoryIds ? [categoryIds] : [],
      ),
      pool.query<{ item_id: string }>(
        'select item_id from picks order by picked_at desc, id desc limit $1',
        [RECENT_PICKS_LIMIT],
      ),
      loadSettings(pool),
    ]);
    const result = pick(
      candidates.rows,
      recent.rows.map((r) => r.item_id),
      settings,
      rng,
    );
    if (!result.item) return { item: null, reason: 'no_candidates', candidates: [] };
    return {
      item: result.item,
      candidates: result.candidates,
      categoryFirst: settings.categoryFirst,
    };
  });

  // Records an accepted pick. Only eligible items can be accepted.
  app.post('/api/picks', async (req, reply) => {
    const body = parse(z.object({ itemId: z.string().uuid() }), req.body);
    const exists = await pool.query('select 1 from items where id = $1', [body.itemId]);
    if (!exists.rowCount) throw notFound('item');
    const { rows } = await pool.query<{ id: string; item_id: string; picked_at: Date }>(
      `insert into picks (item_id)
       select e.id from (${ELIGIBLE}) e where e.id = $1
       returning id, item_id, picked_at`,
      [body.itemId],
    );
    if (!rows[0]) throw conflict('That item is not currently eligible to be picked');
    reply.code(201);
    return { id: rows[0].id, itemId: rows[0].item_id, pickedAt: rows[0].picked_at };
  });
}
