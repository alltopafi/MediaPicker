import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { parse } from '../http.js';

interface HistoryRow {
  id: string;
  itemId: string;
  title: string;
  categoryId: string;
  categoryName: string;
  pickedAt: Date;
}

export function historyRoutes(app: FastifyInstance, pool: Pool) {
  // Newest first. `before` is the cursor returned as `nextBefore` (a pick id);
  // an ISO timestamp is also accepted.
  app.get('/api/history', async (req) => {
    const q = parse(
      z.object({
        category: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        before: z.union([z.string().uuid(), z.string().datetime({ offset: true })]).optional(),
      }),
      req.query,
    );
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.category) where.push(`i.category_id = $${params.push(q.category)}`);
    if (q.before) {
      if (z.string().uuid().safeParse(q.before).success) {
        const p = params.push(q.before);
        where.push(`(p.picked_at, p.id) < (select picked_at, id from picks where id = $${p})`);
      } else {
        where.push(`p.picked_at < $${params.push(q.before)}::timestamptz`);
      }
    }
    const limit = params.push(q.limit + 1);
    const { rows } = await pool.query<HistoryRow>(
      `select p.id, p.item_id as "itemId", i.title, i.category_id as "categoryId",
              c.name as "categoryName", p.picked_at as "pickedAt"
       from picks p
       join items i on i.id = p.item_id
       join categories c on c.id = i.category_id
       ${where.length ? `where ${where.join(' and ')}` : ''}
       order by p.picked_at desc, p.id desc
       limit $${limit}`,
      params,
    );
    const hasMore = rows.length > q.limit;
    const entries = rows.slice(0, q.limit);
    return { entries, nextBefore: hasMore ? (entries.at(-1)?.id ?? null) : null };
  });
}
