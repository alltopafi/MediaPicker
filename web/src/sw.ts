/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string })[] };

const API_CACHE = 'mc-api-v1';
const NETWORK_TIMEOUT_MS = 3000;
/** Header the app checks to know it's looking at saved (possibly stale) data. */
const FROM_CACHE_HEADER = 'x-mc-from-cache';

// App shell + static assets.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigations fall back to index.html, but never for /api.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api/],
  }),
);

// /api GETs: network-first with a short timeout, falling back to the last cached copy.
// Only GETs are routed here; writes always go straight to the network and are never cached.
registerRoute(
  ({ url, request }) =>
    url.origin === self.location.origin &&
    url.pathname.startsWith('/api/') &&
    url.pathname !== '/api/export' &&
    request.method === 'GET',
  async ({ request }) => {
    const cache = await caches.open(API_CACHE);
    let serverError: Response | null = null;
    try {
      const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
      if (response.ok) await cache.put(request, response.clone());
      // Server reachable but broken (e.g. DB down): prefer saved data if we have it.
      if (response.status < 500) return response;
      serverError = response;
    } catch {
      // Network error or timeout: fall through to the cache.
    }

    const cached = await cache.match(request);
    if (!cached && serverError) return serverError;
    const headers = new Headers(cached?.headers);
    headers.set(FROM_CACHE_HEADER, cached ? 'hit' : 'miss');
    if (!cached) {
      headers.set('content-type', 'application/json');
      return new Response(JSON.stringify({ error: 'Offline and no saved copy of this data' }), {
        status: 503,
        headers,
      });
    }
    return new Response(await cached.blob(), {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  },
);

async function fetchWithTimeout(request: Request, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// registerType 'prompt': only activate when the user clicks "Reload".
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
clientsClaim();
