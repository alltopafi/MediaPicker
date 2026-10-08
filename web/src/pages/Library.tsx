import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type Category, type Item, type ItemStatus } from '../api';
import { useAction, useApp } from '../app';
import { storage } from '../util';

const COLLAPSED_KEY = 'mc.library.collapsed';
const STATUSES: { value: ItemStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
];

export function LibraryPage() {
  const { offline, toast } = useApp();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>(() => storage.get(COLLAPSED_KEY) ?? []);
  const [busy, run] = useAction();
  const [newCategory, setNewCategory] = useState('');

  const reload = useCallback(
    () =>
      run(async () => {
        const [cats, its] = await Promise.all([
          api.categories(showArchived),
          api.items({ includeArchived: showArchived }),
        ]);
        setCategories(cats);
        setItems(its);
      }),
    [run, showArchived],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const active = categories?.filter((c) => !c.archivedAt) ?? [];
  const archived = categories?.filter((c) => c.archivedAt) ?? [];

  const toggleCollapsed = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id];
    setCollapsed(next);
    storage.set(COLLAPSED_KEY, next);
  };

  const addCategory = (e: Event) => {
    e.preventDefault();
    const name = newCategory.trim();
    if (!name) return;
    void run(async () => {
      await api.createCategory(name);
      setNewCategory('');
      toast(`Added “${name}”`, 'success');
      await reload();
    });
  };

  const move = (index: number, delta: number) =>
    run(async () => {
      const order = [...active];
      const [moved] = order.splice(index, 1);
      order.splice(index + delta, 0, moved!);
      await Promise.all(
        order.map((c, i) =>
          c.sortOrder === i ? null : api.updateCategory(c.id, { sortOrder: i }),
        ),
      );
      await reload();
    });

  const disabled = busy || offline;

  return (
    <section class="library">
      <header class="page-header">
        <h1>Library</h1>
        <label class="switch">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.currentTarget.checked)}
          />
          <span>Show archived</span>
        </label>
      </header>

      <form class="inline-form" onSubmit={addCategory}>
        <label class="visually-hidden" for="new-category">
          New category name
        </label>
        <input
          id="new-category"
          placeholder="New category (e.g. Podcasts)"
          value={newCategory}
          maxLength={200}
          onInput={(e) => setNewCategory(e.currentTarget.value)}
          disabled={offline}
        />
        <button class="btn btn-primary" disabled={disabled || !newCategory.trim()}>
          Add
        </button>
      </form>

      {categories && active.length === 0 && (
        <div class="card empty-card">
          <h2>No categories yet</h2>
          <p>Add one above, e.g. Movies, Shows, Books or Games.</p>
        </div>
      )}

      {active.map((cat, i) => (
        <CategorySection
          key={cat.id}
          category={cat}
          items={items.filter((it) => it.categoryId === cat.id)}
          categories={active}
          collapsed={collapsed.includes(cat.id)}
          onToggle={() => toggleCollapsed(cat.id)}
          onMove={(d) => void move(i, d)}
          canMoveUp={i > 0}
          canMoveDown={i < active.length - 1}
          reload={reload}
          pageBusy={busy}
        />
      ))}

      {showArchived && archived.length > 0 && (
        <section class="archived-categories">
          <h2>Archived categories</h2>
          <ul class="list">
            {archived.map((cat) => (
              <ArchivedCategoryRow key={cat.id} category={cat} reload={reload} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function ArchivedCategoryRow({
  category,
  reload,
}: {
  category: Category;
  reload: () => Promise<unknown>;
}) {
  const { offline, toast, prompt } = useApp();
  const [busy, run] = useAction();

  const restore = () =>
    run(async () => {
      try {
        const res = await api.restoreCategory(category.id);
        toast(`Restored “${res.name}” and ${res.restoredItems} item(s)`, 'success');
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        const name = await prompt({
          title: 'Name already in use',
          message: `An active category is already called “${category.name}”. Pick a new name to restore this one.`,
          input: { label: 'New name', value: `${category.name} (old)` },
          confirmLabel: 'Rename & restore',
        });
        if (!name) return;
        await api.updateCategory(category.id, { name });
        const res = await api.restoreCategory(category.id);
        toast(`Restored as “${res.name}” with ${res.restoredItems} item(s)`, 'success');
      }
      await reload();
    });

  return (
    <li class="row archived">
      <span class="row-title">{category.name}</span>
      <button class="btn btn-small" onClick={restore} disabled={busy || offline}>
        Restore
      </button>
    </li>
  );
}

interface SectionProps {
  category: Category;
  items: Item[];
  categories: Category[];
  collapsed: boolean;
  onToggle: () => void;
  onMove: (delta: number) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  reload: () => Promise<unknown>;
  pageBusy: boolean;
}

function CategorySection(props: SectionProps) {
  const { category, items, collapsed, reload } = props;
  const { offline, toast, confirm, prompt } = useApp();
  const [busy, run] = useAction();
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const disabled = busy || offline || props.pageBusy;

  const live = items.filter((i) => !i.archivedAt);
  const archivedItems = items.filter((i) => i.archivedAt);
  const activeCount = live.filter((i) => i.status === 'active').length;
  const trimmed = title.trim();
  const duplicate =
    trimmed !== '' && live.some((i) => i.title.toLowerCase() === trimmed.toLowerCase());

  const addItem = (e: Event) => {
    e.preventDefault();
    if (!trimmed) return;
    // Clear immediately so the next title can be typed while this one saves.
    setTitle('');
    inputRef.current?.focus();
    void run(async () => {
      try {
        await api.createItem(category.id, trimmed);
      } catch (err) {
        setTitle((current) => current || trimmed);
        throw err;
      }
      await reload();
    });
  };

  const rename = () =>
    run(async () => {
      const name = await prompt({
        title: 'Rename category',
        input: { label: 'Name', value: category.name },
        confirmLabel: 'Rename',
      });
      if (!name || name === category.name) return;
      await api.updateCategory(category.id, { name });
      await reload();
    });

  const archive = () =>
    run(async () => {
      if (live.length > 0) {
        const ok = await confirm({
          title: `Archive “${category.name}”?`,
          message: `Its ${live.length} item${live.length === 1 ? '' : 's'} will be archived too. Pick history is kept, and you can restore it later from “Show archived”.`,
          confirmLabel: 'Archive',
          danger: true,
        });
        if (!ok) return;
      }
      await api.archiveCategory(category.id);
      toast(`Archived “${category.name}”`);
      await reload();
    });

  const bodyId = `cat-${category.id}`;
  return (
    <section class="card category">
      <header class="category-header">
        <button
          class="collapse-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={props.onToggle}
        >
          <span class="chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          <h2>{category.name}</h2>
          <span class="badge" title="active / total">
            {activeCount}/{live.length}
          </span>
        </button>
        <div class="category-actions">
          <button
            class="icon-btn"
            onClick={() => props.onMove(-1)}
            disabled={disabled || !props.canMoveUp}
            aria-label={`Move ${category.name} up`}
          >
            ↑
          </button>
          <button
            class="icon-btn"
            onClick={() => props.onMove(1)}
            disabled={disabled || !props.canMoveDown}
            aria-label={`Move ${category.name} down`}
          >
            ↓
          </button>
          <button class="btn btn-small" onClick={rename} disabled={disabled}>
            Rename
          </button>
          <button class="btn btn-small btn-danger-outline" onClick={archive} disabled={disabled}>
            Archive
          </button>
        </div>
      </header>

      {!collapsed && (
        <div id={bodyId}>
          {live.length === 0 && <p class="muted small">No items yet.</p>}
          <ul class="list">
            {live.map((item) => (
              <ItemRow key={item.id} item={item} categories={props.categories} reload={reload} />
            ))}
            {archivedItems.map((item) => (
              <ItemRow key={item.id} item={item} categories={props.categories} reload={reload} />
            ))}
          </ul>
          <form class="inline-form add-item" onSubmit={addItem}>
            <label class="visually-hidden" for={`add-${category.id}`}>
              Add item to {category.name}
            </label>
            <input
              id={`add-${category.id}`}
              ref={inputRef}
              placeholder={`Add to ${category.name}…`}
              value={title}
              maxLength={200}
              onInput={(e) => setTitle(e.currentTarget.value)}
              disabled={offline}
              aria-describedby={duplicate ? `dup-${category.id}` : undefined}
            />
            <button class="btn" disabled={offline || !trimmed}>
              Add
            </button>
          </form>
          {duplicate && (
            <p id={`dup-${category.id}`} class="warning small" role="status">
              “{trimmed}” is already in {category.name}. You can still add it.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ItemRow({
  item,
  categories,
  reload,
}: {
  item: Item;
  categories: Category[];
  reload: () => Promise<unknown>;
}) {
  const { offline, toast } = useApp();
  const [busy, run] = useAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const disabled = busy || offline;

  const save = (patch: Parameters<typeof api.updateItem>[1]) =>
    run(async () => {
      await api.updateItem(item.id, patch);
      await reload();
    });

  const commitTitle = async () => {
    const t = draft.trim();
    setEditing(false);
    if (t && t !== item.title) await save({ title: t });
    else setDraft(item.title);
  };

  if (item.archivedAt) {
    return (
      <li class="row archived">
        <span class="row-title">{item.title}</span>
        <button
          class="btn btn-small"
          disabled={disabled}
          onClick={() =>
            run(async () => {
              await api.restoreItem(item.id);
              toast(`Restored “${item.title}”`, 'success');
              await reload();
            })
          }
        >
          Restore
        </button>
      </li>
    );
  }

  return (
    <li class={`row status-${item.status}`}>
      {editing ? (
        <input
          class="row-edit"
          value={draft}
          maxLength={200}
          aria-label="Item title"
          autoFocus
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setDraft(item.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          class="row-title link-btn"
          onClick={() => {
            setDraft(item.title);
            setEditing(true);
          }}
          disabled={offline}
          aria-label={`Edit title: ${item.title}`}
        >
          {item.title}
        </button>
      )}
      <div class="row-controls">
        <select
          aria-label={`Status of ${item.title}`}
          value={item.status}
          disabled={disabled}
          onChange={(e) => void save({ status: e.currentTarget.value as ItemStatus })}
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {categories.length > 1 && (
          <select
            aria-label={`Move ${item.title} to category`}
            value={item.categoryId}
            disabled={disabled}
            onChange={(e) => void save({ categoryId: e.currentTarget.value })}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id === item.categoryId ? c.name : `→ ${c.name}`}
              </option>
            ))}
          </select>
        )}
        <button
          class="icon-btn"
          aria-label={`Archive ${item.title}`}
          title="Archive"
          disabled={disabled}
          onClick={() =>
            run(async () => {
              await api.archiveItem(item.id);
              toast(`Archived “${item.title}”`);
              await reload();
            })
          }
        >
          🗄
        </button>
      </div>
    </li>
  );
}
