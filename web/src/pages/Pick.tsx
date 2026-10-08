import { useEffect, useState } from 'preact/hooks';
import { api, type Candidate, type Category } from '../api';
import { Link, useAction, useApp } from '../app';
import { percent, storage } from '../util';

const SELECTION_KEY = 'mc.pick.categories';

interface Result {
  item: Candidate | null;
  candidates: Candidate[];
  categoryFirst: boolean;
  accepted: boolean;
}

export function PickPage() {
  const { offline, toast } = useApp();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [selected, setSelected] = useState<string[]>(
    () => storage.get<string[]>(SELECTION_KEY) ?? [],
  );
  const [result, setResult] = useState<Result | null>(null);
  const [busy, run] = useAction();

  useEffect(() => {
    void run(async () => setCategories(await api.categories()));
  }, [run]);

  // Drop selections for categories that no longer exist / are archived.
  const activeIds = new Set(categories?.map((c) => c.id));
  const effective = categories ? selected.filter((id) => activeIds.has(id)) : selected;

  const updateSelection = (next: string[]) => {
    setSelected(next);
    storage.set(SELECTION_KEY, next);
    setResult(null);
  };
  const toggle = (id: string) =>
    updateSelection(
      effective.includes(id) ? effective.filter((x) => x !== id) : [...effective, id],
    );

  const doPick = () =>
    run(async () => {
      const res = await api.pick(effective);
      setResult({
        item: res.item,
        candidates: res.candidates,
        categoryFirst: res.item ? res.categoryFirst : false,
        accepted: false,
      });
    });

  const accept = () =>
    run(async () => {
      if (!result?.item) return;
      await api.accept(result.item.id);
      setResult({ ...result, accepted: true });
      toast(`Enjoy “${result.item.title}”!`, 'success');
    });

  if (categories && categories.length === 0) {
    return (
      <section class="empty">
        <h1>Nothing to pick from yet</h1>
        <p>Create a category and add a few things you're watching, reading or playing.</p>
        <Link href="/library" class="btn btn-primary">
          Go to Library
        </Link>
      </section>
    );
  }

  return (
    <section class="pick">
      <h1 class="visually-hidden">Pick something</h1>
      <div class="chips" role="group" aria-label="Categories to pick from">
        <button
          class="chip"
          aria-pressed={effective.length === 0}
          onClick={() => updateSelection([])}
        >
          All
        </button>
        {categories?.map((c) => (
          <button
            key={c.id}
            class="chip"
            aria-pressed={effective.includes(c.id)}
            onClick={() => toggle(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>

      <button
        class="btn btn-primary btn-huge"
        onClick={doPick}
        disabled={busy || offline || !categories}
      >
        Pick
      </button>
      {offline && <p class="muted center">Picking needs a connection to the server.</p>}

      {result && !result.item && (
        <div class="card empty-card">
          <h2>Nothing eligible</h2>
          <p>
            There are no active items in{' '}
            {effective.length ? 'the selected categories' : 'any category'}. Paused, done and
            archived items are skipped.
          </p>
          <Link href="/library" class="btn">
            Add items in Library
          </Link>
        </div>
      )}

      {result?.item && (
        <article class={`card result ${result.accepted ? 'accepted' : ''}`} aria-live="polite">
          <p class="result-category">{result.item.categoryName}</p>
          <h2 class="result-title">{result.item.title}</h2>
          {result.accepted ? (
            <p class="result-accepted">✓ Accepted. Have fun!</p>
          ) : (
            <div class="result-actions">
              <button class="btn btn-primary" onClick={accept} disabled={busy || offline}>
                Accept
              </button>
              <button class="btn" onClick={doPick} disabled={busy || offline}>
                Re-roll
              </button>
            </div>
          )}
          <details class="why">
            <summary>Why this?</summary>
            <p class="muted small">
              {result.categoryFirst
                ? 'Category-first mode: a category is drawn first (each roughly equally likely), then an item within it.'
                : 'Every eligible item is in one draw.'}{' '}
              Recently accepted picks get a lower weight. Re-rolls don't count.
            </p>
            <table class="why-table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" class="num">
                    Weight
                  </th>
                  <th scope="col" class="num">
                    Chance
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...result.candidates]
                  .sort((a, b) => b.probability - a.probability)
                  .map((c) => (
                    <tr key={c.id} class={c.id === result.item?.id ? 'current' : ''}>
                      <td>
                        {c.title}
                        <span class="muted small"> · {c.categoryName}</span>
                      </td>
                      <td class="num">{c.weight.toFixed(2)}</td>
                      <td class="num">{percent(c.probability)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        </article>
      )}
    </section>
  );
}
