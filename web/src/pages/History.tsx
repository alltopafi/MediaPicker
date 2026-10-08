import { useEffect, useState } from 'preact/hooks';
import { api, type Category, type HistoryEntry } from '../api';
import { Link, useAction } from '../app';
import { formatDateTime } from '../util';

const PAGE_SIZE = 25;

export function HistoryPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState('');
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, run] = useAction();

  useEffect(() => {
    void run(async () => setCategories(await api.categories(true)));
  }, [run]);

  useEffect(() => {
    setEntries(null);
    void run(async () => {
      const page = await api.history({ category: category || undefined, limit: PAGE_SIZE });
      setEntries(page.entries);
      setNext(page.nextBefore);
    });
  }, [run, category]);

  const loadMore = () =>
    run(async () => {
      const page = await api.history({
        category: category || undefined,
        limit: PAGE_SIZE,
        before: next,
      });
      setEntries((e) => [...(e ?? []), ...page.entries]);
      setNext(page.nextBefore);
    });

  return (
    <section class="history">
      <header class="page-header">
        <h1>History</h1>
        <label class="field-inline">
          <span class="visually-hidden">Filter by category</span>
          <select value={category} onChange={(e) => setCategory(e.currentTarget.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
      </header>

      {entries && entries.length === 0 && (
        <div class="card empty-card">
          <h2>No picks yet</h2>
          <p>Accepted picks show up here, newest first.</p>
          <Link href="/" class="btn btn-primary">
            Pick something
          </Link>
        </div>
      )}

      {entries && entries.length > 0 && (
        <ol class="list card">
          {entries.map((e) => (
            <li key={e.id} class="row history-row">
              <div>
                <div class="row-title">{e.title}</div>
                <div class="muted small">{e.categoryName}</div>
              </div>
              <time class="muted small" dateTime={e.pickedAt}>
                {formatDateTime(e.pickedAt)}
              </time>
            </li>
          ))}
        </ol>
      )}

      {next && (
        <button class="btn btn-block" onClick={loadMore} disabled={busy}>
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
