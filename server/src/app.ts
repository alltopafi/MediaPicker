import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { Pool } from './db.js';
import { HttpError } from './http.js';
import { categoryRoutes } from './routes/categories.js';
import { dataRoutes } from './routes/data.js';
import { historyRoutes } from './routes/history.js';
import { itemRoutes } from './routes/items.js';
import { pickRoutes } from './routes/pick.js';
import { settingsRoutes } from './routes/settings.js';
import type { Rng } from './weighting.js';

export interface AppOptions {
  pool: Pool;
  /** Directory with the built PWA. Static serving is skipped if it doesn't exist. */
  webDist?: string;
  logger?: FastifyServerOptions['logger'];
  rng?: Rng;
}

// Must never be cached, or installed PWAs get stuck on old versions.
const NO_CACHE_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'registerSW.js']);

export async function buildApp({ pool, webDist, logger = false, rng = Math.random }: AppOptions) {
  const app = Fastify({ logger, return503OnClosing: true });

  app.setErrorHandler((err: Error, req, reply) => {
    const pgCode = (err as { code?: unknown }).code;
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (pgCode === '23505') {
      return reply.code(409).send({ error: 'A category with that name already exists' });
    }
    if (pgCode === '23503') return reply.code(409).send({ error: 'Referenced record not found' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal server error' });
  });

  app.get('/healthz', () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('select 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: 'database unavailable' });
    }
  });

  categoryRoutes(app, pool);
  itemRoutes(app, pool);
  pickRoutes(app, pool, rng);
  historyRoutes(app, pool);
  settingsRoutes(app, pool);
  dataRoutes(app, pool);

  const hasWeb = !!webDist && existsSync(path.join(webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      index: 'index.html',
      wildcard: true,
      cacheControl: false,
      setHeaders(res, filePath) {
        const rel = path.relative(webDist, filePath).split(path.sep).join('/');
        if (rel.startsWith('assets/')) {
          // Content-hashed by Vite, safe to cache forever.
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        } else if (NO_CACHE_FILES.has(rel) || rel.startsWith('workbox-')) {
          res.setHeader('cache-control', 'no-cache');
        } else {
          res.setHeader('cache-control', 'public, max-age=3600');
        }
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const urlPath = req.url.split('?')[0] ?? '/';
    const isApi = urlPath === '/api' || urlPath.startsWith('/api/');
    const isPageRequest = (req.method === 'GET' || req.method === 'HEAD') && !path.extname(urlPath);
    if (hasWeb && !isApi && isPageRequest) {
      // SPA fallback so deep links like /library survive a reload.
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  return app;
}
