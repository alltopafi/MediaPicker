import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { api, resetDb, setupTestApp } from './helpers.js';

let app: FastifyInstance;
let pool: Pool;
let http: ReturnType<typeof api>;

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  http = api(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => resetDb(pool));

async function category(name: string) {
  const res = await http.post('/api/categories', { name });
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string };
}
async function item(categoryId: string, title: string) {
  const res = await http.post('/api/items', { categoryId, title });
  expect(res.status).toBe(201);
  return res.body as { id: string; title: string; categoryId: string };
}
const count = async (table: string) =>
  (await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

describe('health', () => {
  it('/healthz and /readyz', async () => {
    expect((await http.get('/healthz')).status).toBe(200);
    expect((await http.get('/readyz')).status).toBe(200);
  });

  it('unknown /api path is a JSON 404', async () => {
    const res = await http.get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('categories', () => {
  it('creates, lists, renames, validates', async () => {
    const movies = await category('  Movies  ');
    expect(movies.name).toBe('Movies');
    await category('Books');
    const list = await http.get('/api/categories');
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(['Movies', 'Books']);

    const renamed = await http.patch(`/api/categories/${movies.id}`, { name: 'Films' });
    expect(renamed.body.name).toBe('Films');

    expect((await http.post('/api/categories', { name: '   ' })).status).toBe(400);
    expect((await http.post('/api/categories', { name: 'x'.repeat(201) })).status).toBe(400);
    expect((await http.patch(`/api/categories/${crypto.randomUUID()}`, { name: 'Q' })).status).toBe(
      404,
    );
  });

  it('names are unique case-insensitively among active categories', async () => {
    await category('Movies');
    const dup = await http.post('/api/categories', { name: 'movies' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBeTruthy();
  });

  it('archive cascades with a shared timestamp; restore is selective', async () => {
    const cat = await category('Shows');
    const keep1 = await item(cat.id, 'Severance');
    const keep2 = await item(cat.id, 'Andor');
    const solo = await item(cat.id, 'Lost');
    // Archived individually BEFORE the category is archived.
    expect((await http.del(`/api/items/${solo.id}`)).status).toBe(200);

    const archived = await http.del(`/api/categories/${cat.id}`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedItems).toBe(2);

    const { rows } = await pool.query(
      `select count(distinct i.archived_at)::int as n,
              bool_and(i.archived_at = c.archived_at) as same
       from items i join categories c on c.id = i.category_id
       where i.id = any($1)`,
      [[keep1.id, keep2.id]],
    );
    expect(rows[0]).toEqual({ n: 1, same: true });

    // Hidden from default lists, visible with includeArchived.
    expect((await http.get('/api/categories')).body).toHaveLength(0);
    expect((await http.get('/api/categories?includeArchived=true')).body).toHaveLength(1);
    expect((await http.get('/api/items')).body).toHaveLength(0);

    // Adding into an archived category is rejected.
    expect((await http.post('/api/items', { categoryId: cat.id, title: 'X' })).status).toBe(409);

    const restored = await http.post(`/api/categories/${cat.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.restoredItems).toBe(2);
    const active = (await http.get('/api/items')).body.map((i: { id: string }) => i.id).sort();
    expect(active).toEqual([keep1.id, keep2.id].sort());
  });

  it('restoring into a name collision returns 409', async () => {
    const old = await category('Games');
    await http.del(`/api/categories/${old.id}`);
    await category('games'); // archived names can be reused
    const res = await http.post(`/api/categories/${old.id}/restore`);
    expect(res.status).toBe(409);

    // Rename the archived one, then restore works.
    expect((await http.patch(`/api/categories/${old.id}`, { name: 'Old games' })).status).toBe(200);
    expect((await http.post(`/api/categories/${old.id}/restore`)).status).toBe(200);
  });
});

describe('items', () => {
  it('creates, filters, updates, moves, archives, restores', async () => {
    const a = await category('A');
    const b = await category('B');
    const x = await item(a.id, 'X');
    await item(a.id, 'X'); // duplicate titles allowed
    await item(b.id, 'Y');

    expect((await http.get(`/api/items?category=${a.id}`)).body).toHaveLength(2);

    const paused = await http.patch(`/api/items/${x.id}`, { status: 'paused' });
    expect(paused.body.status).toBe('paused');
    expect((await http.get('/api/items?status=paused')).body).toHaveLength(1);
    expect((await http.patch(`/api/items/${x.id}`, { status: 'nope' })).status).toBe(400);

    const moved = await http.patch(`/api/items/${x.id}`, { categoryId: b.id, title: ' X2 ' });
    expect(moved.body).toMatchObject({ categoryId: b.id, title: 'X2' });

    expect((await http.del(`/api/items/${x.id}`)).body.archivedAt).toBeTruthy();
    expect((await http.post(`/api/items/${x.id}/restore`)).body.archivedAt).toBeNull();

    expect(
      (await http.post('/api/items', { categoryId: crypto.randomUUID(), title: 'Z' })).status,
    ).toBe(404);
    expect((await http.post('/api/items', { categoryId: a.id, title: '' })).status).toBe(400);
  });

  it('cannot move into an archived category', async () => {
    const a = await category('A');
    const b = await category('B');
    const x = await item(a.id, 'X');
    await http.del(`/api/categories/${b.id}`);
    expect((await http.patch(`/api/items/${x.id}`, { categoryId: b.id })).status).toBe(409);
  });
});

describe('pick / picks', () => {
  it('excludes paused, done, archived items and archived categories', async () => {
    const a = await category('A');
    const b = await category('B');
    const good = await item(a.id, 'good');
    const paused = await item(a.id, 'paused');
    const done = await item(a.id, 'done');
    const gone = await item(a.id, 'gone');
    await item(b.id, 'in archived cat');
    await http.patch(`/api/items/${paused.id}`, { status: 'paused' });
    await http.patch(`/api/items/${done.id}`, { status: 'done' });
    await http.del(`/api/items/${gone.id}`);
    await http.del(`/api/categories/${b.id}`);

    for (let i = 0; i < 10; i++) {
      const res = await http.post('/api/pick', {});
      expect(res.status).toBe(200);
      expect(res.body.item.id).toBe(good.id);
      expect(res.body.candidates.map((c: { id: string }) => c.id)).toEqual([good.id]);
    }
    // Archived categories in categoryIds are ignored.
    const onlyArchived = await http.post('/api/pick', { categoryIds: [b.id] });
    expect(onlyArchived.body).toEqual({ item: null, reason: 'no_candidates', candidates: [] });
  });

  it('filters by categoryIds; empty means all', async () => {
    const a = await category('A');
    const b = await category('B');
    await item(a.id, 'a1');
    const b1 = await item(b.id, 'b1');
    const onlyB = await http.post('/api/pick', { categoryIds: [b.id] });
    expect(onlyB.body.item.id).toBe(b1.id);
    expect((await http.post('/api/pick', { categoryIds: [] })).body.candidates).toHaveLength(2);
    expect((await http.post('/api/pick')).body.candidates).toHaveLength(2);
  });

  it('no candidates → 200 with item null', async () => {
    const res = await http.post('/api/pick', {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ item: null, reason: 'no_candidates', candidates: [] });
  });

  it('/pick records nothing; /picks records an accepted pick', async () => {
    const a = await category('A');
    const x = await item(a.id, 'x');
    await item(a.id, 'y');
    for (let i = 0; i < 5; i++) await http.post('/api/pick', {});
    expect(await count('picks')).toBe(0);

    const accepted = await http.post('/api/picks', { itemId: x.id });
    expect(accepted.status).toBe(201);
    expect(await count('picks')).toBe(1);

    // The accepted item is now down-weighted.
    const next = await http.post('/api/pick', {});
    const weights = Object.fromEntries(
      next.body.candidates.map((c: { id: string; weight: number }) => [c.id, c.weight]),
    );
    expect(weights[x.id]).toBeCloseTo(0.2, 10);
  });

  it('/picks rejects ineligible items', async () => {
    const a = await category('A');
    const x = await item(a.id, 'x');
    await http.patch(`/api/items/${x.id}`, { status: 'done' });
    expect((await http.post('/api/picks', { itemId: x.id })).status).toBe(409);
    await http.patch(`/api/items/${x.id}`, { status: 'active' });
    await http.del(`/api/categories/${a.id}`);
    expect((await http.post('/api/picks', { itemId: x.id })).status).toBe(409);
    expect((await http.post('/api/picks', { itemId: crypto.randomUUID() })).status).toBe(404);
    expect(await count('picks')).toBe(0);
  });
});

describe('history', () => {
  it('is newest first, filterable, and paginates', async () => {
    const a = await category('A');
    const b = await category('B');
    const x = await item(a.id, 'x');
    const y = await item(b.id, 'y');
    for (const id of [x.id, y.id, x.id, y.id, x.id]) {
      await http.post('/api/picks', { itemId: id });
    }
    const page1 = await http.get('/api/history?limit=2');
    expect(page1.body.entries.map((e: { title: string }) => e.title)).toEqual(['x', 'y']);
    expect(page1.body.entries[0]).toMatchObject({ categoryName: 'A', itemId: x.id });
    expect(page1.body.nextBefore).toBeTruthy();

    const page2 = await http.get(`/api/history?limit=2&before=${page1.body.nextBefore}`);
    expect(page2.body.entries.map((e: { title: string }) => e.title)).toEqual(['x', 'y']);
    const page3 = await http.get(`/api/history?limit=2&before=${page2.body.nextBefore}`);
    expect(page3.body.entries.map((e: { title: string }) => e.title)).toEqual(['x']);
    expect(page3.body.nextBefore).toBeNull();

    const onlyB = await http.get(`/api/history?category=${b.id}`);
    expect(onlyB.body.entries).toHaveLength(2);
  });
});

describe('settings', () => {
  it('reads defaults and validates writes', async () => {
    expect((await http.get('/api/settings')).body).toEqual({
      lambda: 0.7,
      k: 4,
      floor: 0.03,
      categoryFirst: false,
    });
    const next = { lambda: 0.5, k: 2, floor: 0.1, categoryFirst: true };
    expect((await http.put('/api/settings', next)).body).toEqual(next);
    expect((await http.get('/api/settings')).body).toEqual(next);

    for (const bad of [
      { ...next, lambda: 1 },
      { ...next, lambda: 0 },
      { ...next, k: -1 },
      { ...next, floor: 0 },
      { ...next, floor: 1.1 },
      { lambda: 0.5 },
    ]) {
      expect((await http.put('/api/settings', bad)).status).toBe(400);
    }
  });
});

describe('export / import', () => {
  async function seedData() {
    const a = await category('A');
    const b = await category('B');
    const x = await item(a.id, 'x');
    const y = await item(b.id, 'y');
    await item(a.id, 'z');
    await http.post('/api/picks', { itemId: x.id });
    await http.post('/api/picks', { itemId: y.id });
    await http.del(`/api/categories/${b.id}`);
    await http.put('/api/settings', { lambda: 0.6, k: 3, floor: 0.05, categoryFirst: true });
  }

  it('round-trips: import(export) == export', async () => {
    await seedData();
    const exported = (await http.get('/api/export')).body;
    expect(exported.version).toBe(1);

    await resetDb(pool);
    const res = await http.post('/api/import', exported);
    expect(res.status).toBe(200);

    const again = (await http.get('/api/export')).body;
    const strip = ({ exportedAt: _e, ...rest }: Record<string, unknown>) => rest;
    expect(strip(again)).toEqual(strip(exported));

    // Selective restore still works after import (timestamps preserved exactly).
    const archived = exported.categories.find((c: { name: string }) => c.name === 'B');
    const restored = await http.post(`/api/categories/${archived.id}/restore`);
    expect(restored.body.restoredItems).toBe(1);
  });

  it('a bad payload leaves data untouched', async () => {
    await seedData();
    const before = (await http.get('/api/export')).body;

    const badVersion = await http.post('/api/import', { ...before, version: 99 });
    expect(badVersion.status).toBe(400);

    const danglingPick = {
      ...before,
      picks: [
        ...before.picks,
        {
          id: crypto.randomUUID(),
          itemId: crypto.randomUUID(),
          pickedAt: new Date().toISOString(),
        },
      ],
    };
    expect((await http.post('/api/import', danglingPick)).status).toBe(400);

    const badItem = { ...before, items: [{ ...before.items[0], status: 'weird' }] };
    expect((await http.post('/api/import', badItem)).status).toBe(400);

    expect((await http.post('/api/import', { nope: true })).status).toBe(400);

    const after = (await http.get('/api/export')).body;
    const strip = ({ exportedAt: _e, ...rest }: Record<string, unknown>) => rest;
    expect(strip(after)).toEqual(strip(before));
  });
});
