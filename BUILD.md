# MediaChoice: Build Instructions

A self-hosted PWA that keeps a list of the media we're currently consuming, organised into user-defined categories, and randomly picks one on demand. Recently picked items are down-weighted so the same thing doesn't come up repeatedly.

This document is the spec and build order. Follow the phases in order; each has acceptance criteria.

---

## 1. Scope and decisions already made

| Topic                 | Decision                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Hosting               | Local Kubernetes, managed by the owner. **Out of scope here**: manifests, ingress, HTTPS, routing. |
| Deployment path       | Served at `/` (no sub-path).                                                                       |
| Database              | PostgreSQL. All state lives there; the app is stateless.                                           |
| Local dev             | Docker Compose (app + Postgres).                                                                   |
| Users                 | Single household, **no auth**. Document this in the README.                                        |
| Categories            | User-created and removable (Movies, Shows, Books, ...). Items live in exactly one category.        |
| Recency weighting     | **Global** across all categories (not per-category).                                               |
| Category-first toggle | **In v1.** Setting: pick a category first, then an item.                                           |
| Offline               | Read-only from cache, with an "offline" banner. Picks and edits require the server.                |

Deliverables:

1. One Docker image serving the PWA and the API on a single port.
2. `docker-compose.yml` for development.
3. A README covering run, config, backup and restore, and the no-auth caveat.

---

## 2. Tech stack

- **Runtime:** Node 22 LTS, TypeScript (strict).
- **API:** Fastify, `pg` (node-postgres), plain numbered SQL migration files, and `zod` for request validation. No ORM.
- **Frontend:** Vite, Preact, `vite-plugin-pwa` (Workbox), plain CSS (mobile-first).
- **Tests:** Vitest. Integration tests run against a real Postgres (the compose one). Do not mock the database.
- **Pin versions:** `postgres:17` (a specific major) and `node:22-alpine`. Never `latest`.

Repo layout:

```
MediaChoice/
  BUILD.md
  README.md
  docker-compose.yml
  Dockerfile
  server/
    src/
      index.ts          # boot, graceful shutdown
      app.ts            # fastify instance, routes, static serving
      db.ts             # pool, migrate runner
      weighting.ts      # PURE functions, no I/O
      routes/           # categories, items, pick, history, settings, data
    migrations/         # 001_init.sql, 002_...
    test/
  web/
    src/
      pages/            # Pick, Library, History, Settings
      api.ts            # typed fetch client
    public/             # icons
    vite.config.ts
```

---

## 3. Data model

Migration `001_init.sql`:

```sql
create extension if not exists pgcrypto;  -- gen_random_uuid()

create table categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
-- case-insensitive uniqueness among non-archived categories
create unique index categories_name_active_uq
  on categories (lower(name)) where archived_at is null;

create table items (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id),
  title       text not null,
  status      text not null default 'active'
              check (status in ('active','paused','done')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index items_category_idx on items (category_id);

create table picks (
  id        uuid primary key default gen_random_uuid(),
  item_id   uuid not null references items(id),
  picked_at timestamptz not null default now()
);
create index picks_picked_at_idx on picks (picked_at desc);

create table settings (
  key   text primary key,
  value jsonb not null
);
```

Seed (in the same migration, so it runs **once**, never on every boot, otherwise deleted defaults would reappear):

- Categories: Movies, Shows, Books, Games.
- Settings: `lambda=0.7`, `k=4`, `floor=0.03`, `categoryFirst=false`.

### Rules

- **Remove = archive.** Never hard-delete from the UI. This keeps pick history intact.
- **Archiving a category** archives its non-archived items **with the same timestamp** as the category's `archived_at`.
- **Restoring a category** restores only items whose `archived_at` equals the category's old `archived_at`. Items the user archived individually beforehand stay archived.
- **Restoring** a category whose name now collides with an active one returns `409`; the UI asks for a rename.
- **Adding an item** into an archived category is rejected (`409`).
- Moving an item between categories is a plain `PATCH`; history follows the item.
- Titles and names: trim, 1–200 chars, reject empty.
- Duplicate item titles within a category: allow but warn in the UI (the same show can legitimately recur).

---

## 4. Weighting algorithm (`server/src/weighting.ts`)

Keep this a **pure module** with no database access. It takes data in and returns weights, so it can be unit tested and simulated.

### Inputs

- `candidates`: eligible items (`status='active'`, item not archived, category not archived, and in the selected categories).
- `recentPicks`: item ids from the last **N=50** accepted picks, ordered most recent first. (Fetch with `order by picked_at desc limit 50`.)
- `settings`: `{ lambda, k, floor, categoryFirst }`.
- `rng`: `() => number` in `[0,1)`. Injectable for tests; default `Math.random`.

### Per-item weight

```
score(item)  = Σ over recentPicks[r] == item of  lambda^r        (r = 0 for the most recent pick)
weight(item) = max(floor, 1 / (1 + k * score(item)))
```

Never-picked items score 0 and have weight 1.

With the defaults (λ=0.7, k=4, floor=0.03):

| Situation                     | Weight     |
| ----------------------------- | ---------- |
| Never picked / not in last 50 | 1.00       |
| Picked last time              | 0.20       |
| Picked last two times         | 0.13       |
| Picked 3 picks ago            | about 0.34 |
| Picked 6 picks ago            | about 0.70 |

**Decay is measured in picks, not time**, so a week of not using the app doesn't reset anything.

### Selection

- **Item mode (default):** weighted random draw across all candidates. Sum the weights, draw `rng() * total`, and walk the list.
- **Category-first mode** (`categoryFirst=true`):
  1. Group candidates by category (only categories with at least one candidate).
  2. Category weight = **mean of its items' weights**. This keeps size from dominating while still letting a "cooled down" category be less likely.
  3. Weighted draw a category, then a weighted draw an item within it.

### Edge cases (all must be tested)

- Zero candidates returns `null`; the API responds `200 { item: null, reason: "no_candidates" }`.
- One candidate returns that candidate (even at the floor weight).
- All weights equal gives a uniform choice.
- Floating-point: guard the walk so rounding can't fall off the end (fall back to the last candidate).
- `lambda`/`k`/`floor` validated on write: `0<lambda<1`, `k>=0`, `0<floor<=1`.

### Tests

- Hand-computed weights for small cases (above table).
- Seeded RNG determinism.
- **Simulation:** 6 equal items, 10,000 accepted picks. Assert that no item is ever picked N times in a row beyond a loose bound, and that long-run shares stay within a tolerance of uniform.
- Simulation for category-first: a 1-item category vs a 20-item category should see roughly equal category share.

---

## 5. API

All JSON under `/api`. Validate with zod. Errors: `{ error: string }` with proper status codes (400 validation, 404, 409 conflict).

```
GET    /api/categories?includeArchived=
POST   /api/categories                {name}
PATCH  /api/categories/:id            {name?, sortOrder?}
DELETE /api/categories/:id            archives category + its items
POST   /api/categories/:id/restore

GET    /api/items?category=&status=&includeArchived=
POST   /api/items                     {categoryId, title}
PATCH  /api/items/:id                 {title?, categoryId?, status?}
DELETE /api/items/:id                 archives
POST   /api/items/:id/restore

POST   /api/pick                      {categoryIds?: uuid[]}
         -> {item, candidates:[{id,title,categoryId,weight}]} ; records NOTHING
POST   /api/picks                     {itemId}
         -> records an accepted pick ; validates the item is currently eligible
GET    /api/history?category=&limit=&before=   paginated, newest first (includes item title + category name)

GET    /api/settings
PUT    /api/settings                  {lambda,k,floor,categoryFirst}

GET    /api/export                    full JSON dump, with a "version" field
POST   /api/import                    replaces data inside ONE transaction

GET    /healthz                       always 200 if process is up
GET    /readyz                        200 only if `select 1` succeeds
```

**Why `/pick` and `/picks` are separate:** Re-rolling must not affect the weights. Only an _accepted_ pick is recorded. `/pick` is read-only and returns the candidate list with weights, which also powers a "why did I get this?" view.

Notes:

- `/api/pick` with an empty or omitted `categoryIds` means "all".
- Archived categories passed in `categoryIds` are ignored.
- Import: validate the whole payload first, then `truncate` + insert inside one transaction. Preserve ids so history relationships hold. Reject unknown `version`.

---

## 6. Server requirements (container contract)

The owner is handling Kubernetes, so these are the guarantees the image must provide:

- Single port, `PORT` env var (default `3000`), bound to `0.0.0.0`.
- Config **only via env**: `DATABASE_URL` (required). Fail fast with a clear message if it's missing.
- `GET /healthz` (liveness) and `GET /readyz` (readiness; checks DB).
- **Migrations run on startup**, guarded by `pg_advisory_lock` so several replicas starting at once don't race. Track applied migrations in a `schema_migrations` table. Each migration runs in a transaction.
- **Retry the DB connection** with backoff at boot (cluster restarts bring app and DB up in any order). Don't crash-loop instantly.
- Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting connections, finish in-flight requests, close the pool.
- Runs as a **non-root** user. Logs to stdout (JSON, e.g. pino).
- Serves the built PWA statically and falls back to `index.html` for non-`/api` GET routes (SPA routing). Unknown `/api/*` paths return JSON 404, not `index.html`.
- Cache headers: hashed assets are `immutable, max-age=1y`; `index.html`, `sw.js`, `manifest.webmanifest` are `no-cache`. **This matters for PWA updates**, see section 8.

---

## 7. Frontend

Mobile-first, thumb-friendly, dark-mode aware (`prefers-color-scheme`).

### Pick page

- Category chips across the top: **All** plus one per active category, multi-select. Persist the selection in `localStorage` (wrapped in try/catch).
- Big **Pick** button, which calls `/api/pick`.
- Result card showing title and category, with **Accept** (`/api/picks`) and **Re-roll** (`/api/pick` again).
- A small "why?" disclosure listing candidates and their weights.
- Empty states: no categories, selection has no eligible items (link to Library).

### Library page

- Categories as collapsible sections or tabs, each listing its items.
- Add/rename/archive categories. Archiving a non-empty category shows a confirm dialog with the item count.
- Add/edit/archive items inline. Change status (active/paused/done), move between categories.
- "Show archived" toggle with Restore actions.
- Add-item field should be fast: type and press Enter, stay focused for the next entry.

### History page

- Newest-first list, filterable by category, with "load more".

### Settings page

- "Variety" control mapping to `k` (and showing the resulting "just-picked weight" percentage).
- `categoryFirst` toggle with a one-line explanation: _"Each category gets a roughly equal chance, no matter how many items it has. A category with one item will be picked as often as one with fifty."_
- Export (download JSON) and Import (file upload, with confirm because it **replaces everything**).
- Advanced: `lambda`, `floor`.

### Cross-cutting

- Optimistic UI is optional; keep it simple and refetch after mutations.
- Show errors visibly (toast). Disable buttons while a request is in flight.
- Accessible: real `<button>`s, labels, focus states, adequate contrast.

---

## 8. PWA specifics

- `vite-plugin-pwa` with `registerType: 'prompt'`. Show an "Update available, reload" banner when a new service worker is waiting. Don't silently auto-update mid-use.
- Manifest: `name`, `short_name`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, `theme_color`, `background_color`.
- Icons: 192 and 512 PNG, a **maskable** 512, and a 180×180 `apple-touch-icon` for iOS.
- Workbox strategy:
  - Precache the app shell and static assets.
  - **`/api/*`: network-first** (short timeout, fall back to cache for GETs only). Never cache `POST/PUT/PATCH/DELETE`. Exclude `/api` from `navigateFallback` (`navigateFallbackDenylist: [/^\/api/]`).
  - Cached API data must not make the list look current when it isn't. On fallback, show the "offline / showing saved data" banner and disable write actions.
- `sw.js` must be served `no-cache` or installs get stuck on old versions.
- Service workers need HTTPS (or localhost). The owner's routing layer handles HTTPS; the app should work unchanged behind it. Test installability on a real phone once deployed.

---

## 9. Docker and Compose

### Dockerfile (multi-stage)

1. **web-build:** install and `vite build` to `web/dist`.
2. **server-build:** install and `tsc` to `server/dist`.
3. **runtime:** `node:22-alpine`, production deps only, copy `server/dist`, `server/migrations`, and `web/dist`; `USER node`; `EXPOSE 3000`; `CMD ["node","server/dist/index.js"]`.

- Add `.dockerignore` (`node_modules`, `.git`, `dist`).
- Add a `HEALTHCHECK` hitting `/healthz` (optional; K8s uses its own probes).

### docker-compose.yml

- `db`: `postgres:17`, named volume for `/var/lib/postgresql/data`, a `pg_isready` healthcheck, and dev credentials in env.
- `app`: builds the Dockerfile, `DATABASE_URL` pointing at `db`, `depends_on: db: condition: service_healthy`, port `3000:3000`.
- Optional `dev` workflow: run Vite (`npm run dev` in `web/`) with a proxy for `/api` to `localhost:3000`, and run the server with `tsx watch`, for fast iteration. Document both flows.
- Tests need a database: provide a way to run integration tests against the compose `db` (separate database name, e.g. `mediachoice_test`, created fresh per run).

---

## 10. Build order

Complete each phase and its acceptance criteria before moving on.

**Phase 1: Foundation**

- Scaffold repo, TypeScript configs, lint/format, compose with Postgres, migration runner with advisory lock, `001_init.sql` with seeds.
- ✅ `docker compose up` brings up a DB; the server boots, migrates, `/healthz` and `/readyz` work. Running twice doesn't re-seed or error. Deleting a seeded category and restarting does **not** bring it back.

**Phase 2: Weighting module**

- Implement `weighting.ts` and all unit tests plus simulations from section 4.
- ✅ All tests pass, including edge cases and both selection modes.

**Phase 3: API**

- Categories, items, archive/restore rules, pick/picks, history, settings, export/import.
- Integration tests against real Postgres covering: archive cascade and selective restore, name-collision 409, pick excludes paused/done/archived, `/pick` records nothing, `/picks` rejects ineligible items, import round-trip equals export, import with a bad payload leaves data untouched.
- ✅ Suite green; manual `curl` walkthrough works.

**Phase 4: Frontend**

- Library first (so there's data to pick from), then Pick, History, Settings.
- ✅ Full flow works in the browser against the compose stack: add category, add items, pick, accept, see history, flip `categoryFirst`, export and re-import.

**Phase 5: Container**

- Multi-stage Dockerfile, static serving with SPA fallback and cache headers, non-root user.
- ✅ `docker compose up --build` serves everything from one port; deep link reload (e.g. `/library`) works; `/api/nope` returns JSON 404; `SIGTERM` exits cleanly; data survives `docker compose down` and `up` (volume retained).

**Phase 6: PWA**

- Manifest, icons, service worker, update prompt, offline banner.
- ✅ Lighthouse PWA/installability passes on localhost; going offline shows cached lists read-only with writes disabled; shipping a new build shows the update prompt.

**Phase 7: Docs**

- README: run with compose, env vars, the container contract, backup/restore (`pg_dump`/`pg_restore` example and `/api/export`), the **no-auth warning**, and tuning the weighting.
- ✅ A fresh clone can be running in under five minutes by following the README.

---

## 11. Gotchas checklist

- **Re-roll vs. accept:** only accepted picks are recorded. Never record in `/pick`.
- **Seed once:** seeds belong in the migration, not in boot code.
- **Soft delete everywhere:** the history table references items; never hard-delete from the UI.
- **Archive cascade uses a shared timestamp:** this is what makes selective restore work. Don't use `now()` separately per row; compute once and reuse.
- **Case-insensitive unique names** only among non-archived categories (partial index), so archived names can be reused.
- **Floating-point in the weighted draw:** fall back to the last candidate.
- **Empty states** at every level (no categories, no items, nothing eligible) need defined UI and API responses.
- **Category-first fairness:** tiny categories get a big boost. Say so in the UI.
- **Service worker staleness:** `sw.js`/`index.html` must be `no-cache`; use the update prompt.
- **Never cache API writes**; exclude `/api` from the SPA navigation fallback.
- **iOS PWA:** needs `apple-touch-icon`; no install prompt (users use Share → Add to Home Screen); no background sync, which is another reason offline is read-only.
- **Postgres major upgrades** require dump/restore; keep `/api/export` working as a backup that needs no pg tooling.
- **Migrations + replicas:** advisory lock, one transaction per migration, never edit an applied migration (add a new file).
- **DB not ready at boot:** retry with backoff rather than crashing.
- **No auth:** anyone who can reach the URL can read and edit everything. Document it; auth can be added later via a proxy.
- **Timezones:** store `timestamptz`, render in the user's local time on the client.

---

## 12. Out of scope for v1 (possible later)

Auth/multi-user, per-category recency decay, ratings/notes/links per item, "snooze for N days", TV season/episode tracking, metadata lookup (TMDB/OpenLibrary), push notifications, write queueing while offline.
