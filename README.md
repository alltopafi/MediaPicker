# MediaChoice

A small self-hosted PWA that keeps a list of the media you're currently working through (movies, shows, books, games, anything else) and **picks one at random** when you can't decide. Items you accepted recently are down-weighted, so the same thing doesn't keep coming up.

- One Docker image serves both the app and the JSON API on one port.
- All state lives in PostgreSQL. The app itself is stateless.
- Installable on phones (Add to Home Screen). Saved data stays readable offline.

> [!WARNING]
> **There is no authentication.** Anyone who can reach the URL can read, change, import over or wipe everything.
> Only expose it on a trusted network, or put an authenticating reverse proxy in front of it
> (for example oauth2-proxy, Authelia, or basic auth on your ingress).

---

## Quick start (Docker Compose)

Requirements: Docker with Compose v2.

```bash
git clone <this repo> MediaChoice && cd MediaChoice
docker compose up -d --build
```

Open <http://localhost:3000>. The first boot migrates the database and seeds four categories (Movies, Shows, Books, Games) and default settings. Seeding runs exactly once, so deleted defaults never come back.

```bash
docker compose logs -f app     # JSON logs
docker compose down            # stop (data is kept in the `pgdata` volume)
docker compose down -v         # stop AND delete all data
```

## Using it

| Page         | What it does                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pick**     | Choose categories (or All), tap **Pick**. **Accept** records the pick; **Re-roll** draws again and is _not_ recorded, so it doesn't affect future weights. "Why this?" shows every candidate's weight and chance.                                                                |
| **Library**  | Add, rename, reorder and archive categories. Add items quickly: type a title and press Enter, and focus stays in the field. Set an item to active, paused or done, or move it to another category. "Show archived" lets you restore things. Only **active** items can be picked. |
| **History**  | Accepted picks, newest first, filterable by category.                                                                                                                                                                                                                            |
| **Settings** | Variety (how hard recent picks are avoided), category-first mode, advanced tuning, and JSON export and import.                                                                                                                                                                   |

Removing something always **archives** it and never deletes it, so pick history stays intact. Archiving a category archives its items too. Restoring the category brings back only those items, not ones you had archived individually before.

## Configuration

Configuration comes **only** from environment variables:

| Variable       | Required | Default | Description                                                                    |
| -------------- | -------- | ------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL` | yes      | none    | e.g. `postgres://user:pass@host:5432/mediachoice`. Boot fails fast if missing. |
| `PORT`         | no       | `3000`  | HTTP port, bound on `0.0.0.0`.                                                 |
| `LOG_LEVEL`    | no       | `info`  | pino level (`debug`, `info`, `warn`, ...).                                     |

The PostgreSQL user needs permission to create tables and to `create extension pgcrypto` (or pgcrypto must already be installed), for the first migration.

## Container contract (for Kubernetes or any other orchestrator)

- **Image:** built from `Dockerfile` (final stage `runtime`, `node:22-alpine`), runs as the non-root `node` user (uid 1000), `EXPOSE 3000`.
- **Probes:**
  - `GET /healthz` returns 200 whenever the process is up (liveness).
  - `GET /readyz` returns 200 only if `select 1` succeeds against the DB, otherwise 503 (readiness).
- **Startup:** retries the DB connection with exponential backoff (0.5s, doubling, capped at 10s, about 30 attempts) so the app and DB can start in any order. It then runs pending migrations under a Postgres **advisory lock**, so several replicas can start at once safely. Each migration runs in its own transaction and is recorded in `schema_migrations`.
- **Shutdown:** on `SIGTERM` or `SIGINT` it stops accepting connections, finishes in-flight requests, closes the pool and exits 0 (forced exit after 10s).
- **Logs:** JSON to stdout.
- **Routing:** everything is served at `/`. Unknown `/api/*` paths return a JSON 404, and other GETs without a file extension fall back to `index.html` (SPA deep links).
- **Caching:** `/assets/*` (content-hashed) is `immutable, max-age=1y`. `index.html`, `sw.js` and `manifest.webmanifest` are `no-cache`. If a proxy or CDN sits in front, it must keep these headers, or installed PWAs can get stuck on old versions.
- **HTTPS:** service workers (offline and install) need HTTPS, or `localhost`. The app works unchanged behind a TLS-terminating proxy.

## Backup and restore

### Option A: app-level JSON (no Postgres tooling needed)

```bash
curl -fsS http://localhost:3000/api/export -o mediachoice-backup.json
# restore (REPLACES all data, in one transaction; ids are preserved)
curl -fsS -X POST http://localhost:3000/api/import \
  -H 'content-type: application/json' --data-binary @mediachoice-backup.json
```

The same is available in **Settings → Backup**. The export carries a `"version"` field, and an unknown version is rejected. The import validates the whole payload first, and a bad file leaves existing data untouched. This is also the easiest way through a **Postgres major-version upgrade**: export, start with a fresh volume, import.

### Option B: `pg_dump` / `pg_restore`

```bash
# backup (custom format)
docker compose exec -T db pg_dump -U mediachoice -Fc mediachoice > mediachoice.dump

# restore into an empty database (stop the app first)
docker compose stop app
docker compose exec -T db dropdb -U mediachoice mediachoice
docker compose exec -T db createdb -U mediachoice mediachoice
docker compose exec -T db pg_restore -U mediachoice -d mediachoice --no-owner < mediachoice.dump
docker compose start app
```

## Tuning the weighting

Each eligible item gets a weight from the last 50 **accepted** picks (across all categories):

```
score(item)  = Σ λ^r   over every position r where the item appears (r = 0 is the most recent pick)
weight(item) = max(floor, 1 / (1 + k · score))
```

Decay is counted in **picks, not time**, so leaving the app alone for a week doesn't reset anything.

| Setting                | Default | Effect                                                                                                                                                                              |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `k` ("Variety")        | 4       | How hard recent picks are avoided. `0` = pure random. With k=4, the item you just accepted has 20% of a fresh item's chance.                                                        |
| `lambda` (λ, "Memory") | 0.7     | How fast a pick is forgotten, per later pick (0 < λ < 1). Higher remembers longer.                                                                                                  |
| `floor`                | 0.03    | No item's weight drops below this (0 < floor ≤ 1).                                                                                                                                  |
| `categoryFirst`        | off     | Draw a category first (weight = mean of its items' weights), then an item. **Every category gets a roughly equal chance**, so a 1-item category comes up as often as a 50-item one. |

With the defaults: never or not-recently picked = 1.00; picked last time = 0.20; picked the last two times ≈ 0.13; third most recent pick ≈ 0.34; sixth most recent ≈ 0.60.

> BUILD.md's table lists "picked 6 picks ago ≈ 0.70". The formula gives ≈ 0.60 for the sixth most recent pick (r = 5) and ≈ 0.68 for r = 6. The code follows the formula, and the tests document both values.

Change these in **Settings** or with `PUT /api/settings`.

## API

All JSON under `/api`. Errors look like `{ "error": "..." }` with 400 (validation), 404, or 409 (conflict).

```
GET    /api/categories?includeArchived=true
POST   /api/categories                {name}
PATCH  /api/categories/:id            {name?, sortOrder?}
DELETE /api/categories/:id            archive category + its items
POST   /api/categories/:id/restore    409 if the name now collides

GET    /api/items?category=&status=&includeArchived=
POST   /api/items                     {categoryId, title}   409 if category archived
PATCH  /api/items/:id                 {title?, categoryId?, status?}
DELETE /api/items/:id                 archive
POST   /api/items/:id/restore

POST   /api/pick                      {categoryIds?: uuid[]}  read-only, records nothing
                                      -> {item, candidates:[{id,title,categoryId,categoryName,weight,probability}]}
                                      -> {item:null, reason:"no_candidates"} when nothing is eligible
POST   /api/picks                     {itemId}  records an accepted pick (409 if not eligible)
GET    /api/history?category=&limit=&before=   newest first; pass `nextBefore` back as `before`

GET    /api/settings
PUT    /api/settings                  {lambda, k, floor, categoryFirst}

GET    /api/export
POST   /api/import

GET    /healthz   GET /readyz
```

## Development

### Fast loop (Node 22 on your machine)

```bash
npm install
docker compose up -d db                       # Postgres on localhost:5432
DATABASE_URL=postgres://mediachoice:mediachoice@localhost:5432/mediachoice npm run dev:server   # tsx watch on :3000
npm run dev:web                               # Vite on :5173, proxies /api to :3000
```

Open <http://localhost:5173>. The service worker is disabled in Vite dev mode. To test PWA behaviour, use the production build (`docker compose up --build`).

### Everything in Docker (no local Node)

```bash
docker compose up -d --build            # app on :3000
docker compose run --rm --build test    # full test suite against the compose db
```

### Tests

```bash
npm run test:unit   # weighting module only, no DB needed
npm test            # unit + integration tests against a real Postgres
```

Integration tests never mock the database. They use `TEST_DATABASE_URL` (default `postgres://mediachoice:mediachoice@localhost:5432/mediachoice_test`), which is **dropped and recreated on every run**. For safety, the database name must contain `test`.

They cover the archive cascade and selective restore, the name-collision 409, pick eligibility (paused, done and archived excluded), `/pick` recording nothing, `/picks` rejecting ineligible items, the import/export round-trip, bad imports leaving data untouched, migration seeding once, concurrent migrators, and static serving and cache headers. They also include weighting simulations: 10,000 picks over 6 items, and a 1-item vs 20-item category in category-first mode.

### Other scripts

```bash
npm run lint && npm run format:check && npm run typecheck
npm run icons -w web    # regenerate PWA icons into web/public (no dependencies)
```

### Adding a migration

Add `server/migrations/NNN_description.sql` with the next number. Never edit a migration that has already been applied anywhere.

## Installing on a phone

- **Android / Chrome:** open the HTTPS URL, then use the install prompt or ⋮ → _Install app_.
- **iOS / Safari:** Share → _Add to Home Screen_. iOS has no install prompt and no background sync.
- When a new version is deployed, an **"Update available, Reload"** banner appears. The app never reloads itself mid-use.
- **Offline:** previously loaded lists stay readable, with an "Offline: showing saved data" banner. Picking and all edits need the server and are disabled until you're back online.

## Project layout

```
server/   Fastify API + static serving (src/), SQL migrations, Vitest tests
web/      Vite + Preact PWA (src/pages, src/api.ts, src/sw.ts), icons in public/
Dockerfile, docker-compose.yml, BUILD.md (original spec)
```
