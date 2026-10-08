import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, type Pool } from '../db.js';
import {
  conflict,
  idParams,
  nameSchema,
  notFound,
  parse,
  queryBool,
  toCategory,
  type CategoryRow,
} from '../http.js';

const COLUMNS = 'id, name, sort_order, created_at, archived_at';

export function categoryRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/api/categories', async (req) => {
    const q = parse(z.object({ includeArchived: queryBool }), req.query);
    const { rows } = await pool.query<CategoryRow>(
      `select ${COLUMNS} from categories
       ${q.includeArchived ? '' : 'where archived_at is null'}
       order by sort_order, lower(name)`,
    );
    return rows.map(toCategory);
  });

  app.post('/api/categories', async (req, reply) => {
    const body = parse(z.object({ name: nameSchema }), req.body);
    const { rows } = await pool.query<CategoryRow>(
      `insert into categories (name, sort_order)
       values ($1, coalesce((select max(sort_order) + 1 from categories where archived_at is null), 0))
       returning ${COLUMNS}`,
      [body.name],
    );
    reply.code(201);
    return toCategory(rows[0]!);
  });

  app.patch('/api/categories/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({ name: nameSchema.optional(), sortOrder: z.number().int().optional() }),
      req.body,
    );
    const { rows } = await pool.query<CategoryRow>(
      `update categories set
         name = coalesce($2, name),
         sort_order = coalesce($3, sort_order)
       where id = $1
       returning ${COLUMNS}`,
      [id, body.name ?? null, body.sortOrder ?? null],
    );
    if (!rows[0]) throw notFound('category');
    return toCategory(rows[0]);
  });

  // Archive the category and its non-archived items with ONE shared timestamp,
  // so restore can tell cascade-archived items from individually archived ones.
  app.delete('/api/categories/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return withTransaction(pool, async (client) => {
      const existing = await client.query<CategoryRow>(
        `select ${COLUMNS} from categories where id = $1 for update`,
        [id],
      );
      const cat = existing.rows[0];
      if (!cat) throw notFound('category');
      if (cat.archived_at) return { ...toCategory(cat), archivedItems: 0 };

      const { rows } = await client.query<CategoryRow>(
        `update categories set archived_at = now() where id = $1 returning ${COLUMNS}`,
        [id],
      );
      const archived = rows[0]!;
      // Copy the category's stored timestamp in SQL; a JS Date would drop microseconds.
      const items = await client.query(
        `update items i set archived_at = c.archived_at, updated_at = now()
         from categories c
         where c.id = $1 and i.category_id = c.id and i.archived_at is null`,
        [id],
      );
      return { ...toCategory(archived), archivedItems: items.rowCount ?? 0 };
    });
  });

  app.post('/api/categories/:id/restore', async (req) => {
    const { id } = parse(idParams, req.params);
    return withTransaction(pool, async (client) => {
      const existing = await client.query<CategoryRow>(
        `select ${COLUMNS} from categories where id = $1 for update`,
        [id],
      );
      const cat = existing.rows[0];
      if (!cat) throw notFound('category');
      if (!cat.archived_at) return { ...toCategory(cat), restoredItems: 0 };

      const clash = await client.query(
        `select 1 from categories
         where archived_at is null and lower(name) = lower($1) and id <> $2`,
        [cat.name, id],
      );
      if (clash.rowCount) {
        throw conflict(`An active category named "${cat.name}" already exists. Rename it first.`);
      }

      // Compare in SQL against the stored value so timestamp precision is exact.
      const items = await client.query(
        `update items i set archived_at = null, updated_at = now()
         from categories c
         where c.id = $1 and i.category_id = c.id and i.archived_at = c.archived_at`,
        [id],
      );
      const { rows } = await client.query<CategoryRow>(
        `update categories set archived_at = null where id = $1 returning ${COLUMNS}`,
        [id],
      );
      return { ...toCategory(rows[0]!), restoredItems: items.rowCount ?? 0 };
    });
  });
}
