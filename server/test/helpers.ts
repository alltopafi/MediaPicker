import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createPool, migrate, type Pool } from '../src/db.js';
import type { Rng } from '../src/weighting.js';

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export function testDatabaseUrl(): string {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgres://mediachoice:mediachoice@localhost:5432/mediachoice_test';
  const name = new URL(url).pathname.slice(1);
  // globalSetup DROPs this database, so refuse anything that doesn't look like a test DB.
  if (!/test/i.test(name)) {
    throw new Error(`TEST_DATABASE_URL database name must contain "test" (got "${name}")`);
  }
  return url;
}

/** Same server, maintenance database, for CREATE/DROP DATABASE. */
export function adminUrl(url: URL): string {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return admin.toString();
}

/** Main test DB plus a scratch one for migration/seed tests. */
export const TEST_DB_NAMES = (url: URL) => {
  const name = url.pathname.slice(1);
  return [name, `${name}_migrate`];
};

export function urlForDb(name: string): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

export async function setupTestApp(rng?: Rng): Promise<{ app: FastifyInstance; pool: Pool }> {
  const pool = createPool(testDatabaseUrl());
  await migrate(pool, MIGRATIONS_DIR);
  const app = await buildApp({ pool, rng });
  await app.ready();
  return { app, pool };
}

/** Empty all tables and restore default settings. */
export async function resetDb(pool: Pool) {
  await pool.query('truncate picks, items, categories, settings');
  await pool.query(
    `insert into settings (key, value) values
       ('lambda', '0.7'), ('k', '4'), ('floor', '0.03'), ('categoryFirst', 'false')`,
  );
}

export function api(app: FastifyInstance) {
  async function call<T = any>(method: string, url: string, body?: unknown) {
    const res = await app.inject({
      method: method as 'GET',
      url,
      ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: res.statusCode, body: res.json() as T, headers: res.headers };
  }
  return {
    get: <T = any>(url: string) => call<T>('GET', url),
    post: <T = any>(url: string, body?: unknown) => call<T>('POST', url, body),
    patch: <T = any>(url: string, body: unknown) => call<T>('PATCH', url, body),
    put: <T = any>(url: string, body: unknown) => call<T>('PUT', url, body),
    del: <T = any>(url: string) => call<T>('DELETE', url),
  };
}
