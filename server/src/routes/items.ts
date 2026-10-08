import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, type Pool, type PoolClient } from '../db.js';
import {
  conflict,
  idParams,
  ITEM_STATUSES,
  nameSchema,
  notFound,
  parse,
  queryBool,
  toItem,
  type ItemRow,
} from '../http.js';

const COLUMNS = 'id, category_id, title, status, created_at, updated_at, archived_at';

async function requireActiveCategory(db: Pool | PoolClient, categoryId: string) {
  const { rows } = await db.query<{ archived_at: Date | null }>(
    'select archived_at from categories where id = $1',
    [categoryId],
  );
  if (!rows[0]) throw notFound('category');
  if (rows[0].archived_at) throw conflict('That category is archived');
}

export function itemRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/api/items', async (req) => {
    const q = parse(
      z.object({
        category: z.string().uuid().optional(),
        status: z.enum(ITEM_STATUSES).optional(),
        includeArchived: queryBool,
      }),
      req.query,
    );
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.category) where.push(`category_id = $${params.push(q.category)}`);
    if (q.status) where.push(`status = $${params.push(q.status)}`);
    if (!q.includeArchived) where.push('archived_at is null');
    const { rows } = await pool.query<ItemRow>(
      `select ${COLUMNS} from items
       ${where.length ? `where ${where.join(' and ')}` : ''}
       order by created_at, id`,
      params,
    );
    return rows.map(toItem);
  });

  app.post('/api/items', async (req, reply) => {
    const body = parse(z.object({ categoryId: z.string().uuid(), title: nameSchema }), req.body);
    await requireActiveCategory(pool, body.categoryId);
    const { rows } = await pool.query<ItemRow>(
      `insert into items (category_id, title) values ($1, $2) returning ${COLUMNS}`,
      [body.categoryId, body.title],
    );
    reply.code(201);
    return toItem(rows[0]!);
  });

  app.patch('/api/items/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        title: nameSchema.optional(),
        categoryId: z.string().uuid().optional(),
        status: z.enum(ITEM_STATUSES).optional(),
      }),
      req.body,
    );
    return withTransaction(pool, async (client) => {
      if (body.categoryId) await requireActiveCategory(client, body.categoryId);
      const { rows } = await client.query<ItemRow>(
        `update items set
           title = coalesce($2, title),
           category_id = coalesce($3, category_id),
           status = coalesce($4, status),
           updated_at = now()
         where id = $1
         returning ${COLUMNS}`,
        [id, body.title ?? null, body.categoryId ?? null, body.status ?? null],
      );
      if (!rows[0]) throw notFound('item');
      return toItem(rows[0]);
    });
  });

  app.delete('/api/items/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { rows } = await pool.query<ItemRow>(
      `update items set
         archived_at = coalesce(archived_at, now()),
         updated_at = case when archived_at is null then now() else updated_at end
       where id = $1
       returning ${COLUMNS}`,
      [id],
    );
    if (!rows[0]) throw notFound('item');
    return toItem(rows[0]);
  });

  app.post('/api/items/:id/restore', async (req) => {
    const { id } = parse(idParams, req.params);
    return withTransaction(pool, async (client) => {
      const existing = await client.query<ItemRow>(
        `select ${COLUMNS} from items where id = $1 for update`,
        [id],
      );
      const item = existing.rows[0];
      if (!item) throw notFound('item');
      if (!item.archived_at) return toItem(item);
      const cat = await client.query<{ archived_at: Date | null }>(
        'select archived_at from categories where id = $1',
        [item.category_id],
      );
      if (cat.rows[0]?.archived_at) {
        throw conflict('Its category is archived. Restore the category or move the item first.');
      }
      const { rows } = await client.query<ItemRow>(
        `update items set archived_at = null, updated_at = now() where id = $1 returning ${COLUMNS}`,
        [id],
      );
      return toItem(rows[0]!);
    });
  });
}
