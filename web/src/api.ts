// Typed fetch client for the MediaChoice API.

export type ItemStatus = 'active' | 'paused' | 'done';

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  archivedAt: string | null;
}

export interface Item {
  id: string;
  categoryId: string;
  title: string;
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Candidate {
  id: string;
  title: string;
  categoryId: string;
  categoryName: string;
  weight: number;
  probability: number;
}

export type PickResponse =
  | { item: Candidate; candidates: Candidate[]; categoryFirst: boolean }
  | { item: null; reason: 'no_candidates'; candidates: [] };

export interface HistoryEntry {
  id: string;
  itemId: string;
  title: string;
  categoryId: string;
  categoryName: string;
  pickedAt: string;
}

export interface Settings {
  lambda: number;
  k: number;
  floor: number;
  categoryFirst: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---- offline tracking: true when the last GET came from the service worker cache
// or the network is unreachable. Writes are disabled while offline.

const FROM_CACHE_HEADER = 'x-mc-from-cache';
type Listener = (offline: boolean) => void;
const listeners = new Set<Listener>();
let offline = typeof navigator !== 'undefined' && navigator.onLine === false;

function setOffline(value: boolean) {
  if (value === offline) return;
  offline = value;
  listeners.forEach((l) => l(value));
}

export function isOffline() {
  return offline;
}

export function onOfflineChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => setOffline(true));
  // Optimistic: the next GET will flip us back if it is still served from cache.
  window.addEventListener('online', () => setOffline(false));
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    setOffline(true);
    throw new ApiError(0, "Can't reach the server. You appear to be offline.");
  }
  if (method === 'GET') setOffline(res.headers.has(FROM_CACHE_HEADER));
  else if (res.status < 500) setOffline(false);

  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      (data as { error?: string } | undefined)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  return entries.length
    ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`
    : '';
};

export const api = {
  categories: (includeArchived = false) =>
    request<Category[]>(
      'GET',
      `/api/categories${qs({ includeArchived: includeArchived || undefined })}`,
    ),
  createCategory: (name: string) => request<Category>('POST', '/api/categories', { name }),
  updateCategory: (id: string, patch: { name?: string; sortOrder?: number }) =>
    request<Category>('PATCH', `/api/categories/${id}`, patch),
  archiveCategory: (id: string) =>
    request<Category & { archivedItems: number }>('DELETE', `/api/categories/${id}`),
  restoreCategory: (id: string) =>
    request<Category & { restoredItems: number }>('POST', `/api/categories/${id}/restore`),

  items: (params: { category?: string; status?: ItemStatus; includeArchived?: boolean } = {}) =>
    request<Item[]>(
      'GET',
      `/api/items${qs({ ...params, includeArchived: params.includeArchived || undefined })}`,
    ),
  createItem: (categoryId: string, title: string) =>
    request<Item>('POST', '/api/items', { categoryId, title }),
  updateItem: (id: string, patch: { title?: string; categoryId?: string; status?: ItemStatus }) =>
    request<Item>('PATCH', `/api/items/${id}`, patch),
  archiveItem: (id: string) => request<Item>('DELETE', `/api/items/${id}`),
  restoreItem: (id: string) => request<Item>('POST', `/api/items/${id}/restore`),

  pick: (categoryIds: string[]) => request<PickResponse>('POST', '/api/pick', { categoryIds }),
  accept: (itemId: string) =>
    request<{ id: string; itemId: string; pickedAt: string }>('POST', '/api/picks', { itemId }),

  history: (params: { category?: string; limit?: number; before?: string | null } = {}) =>
    request<{ entries: HistoryEntry[]; nextBefore: string | null }>(
      'GET',
      `/api/history${qs(params)}`,
    ),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (s: Settings) => request<Settings>('PUT', '/api/settings', s),

  exportData: () => request<unknown>('GET', '/api/export'),
  importData: (data: unknown) =>
    request<{ ok: true; counts: Record<string, number> }>('POST', '/api/import', data),
};
