import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPool, type Pool } from '../src/db.js';
import { testDatabaseUrl } from './helpers.js';

describe('static PWA serving', () => {
  let dir: string;
  let app: FastifyInstance;
  let pool: Pool;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mc-web-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>MC</title>');
    writeFileSync(path.join(dir, 'sw.js'), '// sw');
    writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
    writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    pool = createPool(testDatabaseUrl());
    app = await buildApp({ pool, webDist: dir });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['/', '/library', '/history?x=1'])('%s serves index.html, no-cache', async (url) => {
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('sw.js and manifest are no-cache', async () => {
    for (const url of ['/sw.js', '/manifest.webmanifest']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('hashed assets are immutable', async () => {
    const res = await app.inject({ url: '/assets/index-abc123.js' });
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('unknown /api paths and missing files are JSON 404s, not index.html', async () => {
    for (const [method, url] of [
      ['GET', '/api/nope'],
      ['POST', '/api/nope'],
      ['GET', '/missing.png'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found' });
    }
  });
});
