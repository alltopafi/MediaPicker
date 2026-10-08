import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, type Pool } from '../db.js';
import { HttpError, ITEM_STATUSES, parse } from '../http.js';
import { loadSettings, saveSettings, settingsSchema } from './settings.js';

export const EXPORT_VERSION = 1;

const timestamp = z.string().datetime({ offset: true });
const text = z.string().trim().min(1).max(200);

const exportSchema = z.object({
  version: z.literal(EXPORT_VERSION, {
    errorMap: () => ({ message: `unsupported export version (expected ${EXPORT_VERSION})` }),
  }),
  exportedAt: timestamp.optional(),
  categories: z.array(
    z.object({
      id: z.string().uuid(),
      name: text,
      sortOrder: z.number().int(),
      createdAt: timestamp,
      archivedAt: timestamp.nullable(),
    }),
  ),
  items: z.array(
    z.object({
      id: z.string().uuid(),
      categoryId: z.string().uuid(),
      title: text,
      status: z.enum(ITEM_STATUSES),
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: timestamp.nullable(),
    }),
  ),
  picks: z.array(
    z.object({
      id: z.string().uuid(),
      itemId: z.string().uuid(),
      pickedAt: timestamp,
    }),
  ),
  settings: settingsSchema,
});

export type ExportData = z.infer<typeof exportSchema>;

// Timestamps are exported as text straight from Postgres so they round-trip losslessly.
const iso = (col: string) => `to_json(${col}) #>> '{}'`;

export async function exportData(pool: Pool) {
  const [categories, items, picks, settings] = await Promise.all([
    pool.query(
      `select id, name, sort_order as "sortOrder", ${iso('created_at')} as "createdAt",
              ${iso('archived_at')} as "archivedAt"
       from categories order by sort_order, created_at, id`,
    ),
    pool.query(
      `select id, category_id as "categoryId", title, status,
              ${iso('created_at')} as "createdAt", ${iso('updated_at')} as "updatedAt",
              ${iso('archived_at')} as "archivedAt"
       from items order by created_at, id`,
    ),
    pool.query(
      `select id, item_id as "itemId", ${iso('picked_at')} as "pickedAt"
       from picks order by picked_at, id`,
    ),
    loadSettings(pool),
  ]);
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    categories: categories.rows,
    items: items.rows,
    picks: picks.rows,
    settings,
  };
}

function checkReferences(data: ExportData) {
  const unique = (ids: string[], what: string) => {
    if (new Set(ids).size !== ids.length) throw new HttpError(400, `duplicate ${what} id`);
  };
  unique(
    data.categories.map((c) => c.id),
    'category',
  );
  unique(
    data.items.map((i) => i.id),
    'item',
  );
  unique(
    data.picks.map((p) => p.id),
    'pick',
  );

  const categoryIds = new Set(data.categories.map((c) => c.id));
  const itemIds = new Set(data.items.map((i) => i.id));
  const badItem = data.items.find((i) => !categoryIds.has(i.categoryId));
  if (badItem) throw new HttpError(400, `item ${badItem.id} references an unknown category`);
  const badPick = data.picks.find((p) => !itemIds.has(p.itemId));
  if (badPick) throw new HttpError(400, `pick ${badPick.id} references an unknown item`);

  const active = data.categories.filter((c) => !c.archivedAt).map((c) => c.name.toLowerCase());
  if (new Set(active).size !== active.length) {
    throw new HttpError(400, 'two active categories share the same name');
  }
}

export function dataRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/api/export', async (_req, reply) => {
    const date = new Date().toISOString().slice(0, 10);
    reply.header('content-disposition', `attachment; filename="mediachoice-${date}.json"`);
    return exportData(pool);
  });

  // Validate everything up front, then replace all data inside ONE transaction.
  app.post('/api/import', { bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const data = parse(exportSchema, req.body);
    checkReferences(data);
    await withTransaction(pool, async (client) => {
      await client.query('truncate picks, items, categories, settings');
      await client.query(
        `insert into categories (id, name, sort_order, created_at, archived_at)
         select id, name, "sortOrder", "createdAt", "archivedAt"
         from jsonb_to_recordset($1::jsonb) as x(
           id uuid, name text, "sortOrder" int, "createdAt" timestamptz, "archivedAt" timestamptz)`,
        [JSON.stringify(data.categories)],
      );
      await client.query(
        `insert into items (id, category_id, title, status, created_at, updated_at, archived_at)
         select id, "categoryId", title, status, "createdAt", "updatedAt", "archivedAt"
         from jsonb_to_recordset($1::jsonb) as x(
           id uuid, "categoryId" uuid, title text, status text,
           "createdAt" timestamptz, "updatedAt" timestamptz, "archivedAt" timestamptz)`,
        [JSON.stringify(data.items)],
      );
      await client.query(
        `insert into picks (id, item_id, picked_at)
         select id, "itemId", "pickedAt"
         from jsonb_to_recordset($1::jsonb) as x(id uuid, "itemId" uuid, "pickedAt" timestamptz)`,
        [JSON.stringify(data.picks)],
      );
      await saveSettings(client, data.settings);
    });
    return {
      ok: true,
      counts: {
        categories: data.categories.length,
        items: data.items.length,
        picks: data.picks.length,
      },
    };
  });
}
