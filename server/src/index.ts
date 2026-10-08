import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createPool, migrate, waitForDb } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Both src/ (tsx) and dist/ (built) sit one level below server/.
const serverRoot = path.resolve(here, '..');
const migrationsDir = process.env.MIGRATIONS_DIR ?? path.join(serverRoot, 'migrations');
const webDist = process.env.WEB_DIST ?? path.resolve(serverRoot, '..', 'web', 'dist');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'FATAL: DATABASE_URL is not set. Example: postgres://user:pass@host:5432/mediachoice',
  );
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`FATAL: PORT must be a positive integer, got "${process.env.PORT}"`);
  process.exit(1);
}

const pool = createPool(databaseUrl);
const app = await buildApp({
  pool,
  webDist,
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    app.log.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();
  try {
    await app.close(); // stops accepting, waits for in-flight requests
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await waitForDb(pool, app.log);
  const applied = await migrate(pool, migrationsDir, app.log);
  app.log.info({ applied: applied.length }, 'migrations up to date');
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  await pool.end().catch(() => {});
  process.exit(1);
}
