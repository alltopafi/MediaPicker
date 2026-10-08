import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Settings } from '../api';
import { useAction, useApp } from '../app';
import { downloadJson, percent } from '../util';

const justPickedWeight = (s: Settings) => Math.max(s.floor, 1 / (1 + s.k));

function varietyLabel(k: number) {
  if (k === 0) return 'Off: pure random';
  if (k <= 1) return 'Low';
  if (k <= 4) return 'Medium';
  if (k <= 10) return 'High';
  return 'Very high';
}

export function SettingsPage() {
  const { offline, toast, confirm } = useApp();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, run] = useAction();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void run(async () => {
      const s = await api.settings();
      setSaved(s);
      setDraft(s);
    });
  }, [run]);

  if (!draft || !saved) return <p class="muted">Loading…</p>;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft({ ...draft, [key]: value });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const lambdaOk = draft.lambda > 0 && draft.lambda < 1;
  const floorOk = draft.floor > 0 && draft.floor <= 1;
  const valid = lambdaOk && floorOk && draft.k >= 0;
  const disabled = busy || offline;

  const save = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      const s = await api.saveSettings(draft);
      setSaved(s);
      setDraft(s);
      toast('Settings saved', 'success');
    });
  };

  const exportAll = () =>
    run(async () => {
      const data = await api.exportData();
      downloadJson(data, `mediachoice-${new Date().toISOString().slice(0, 10)}.json`);
    });

  const importFile = (file: File) =>
    run(async () => {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('That file is not valid JSON');
      }
      const ok = await confirm({
        title: 'Replace everything?',
        message: `Importing “${file.name}” will REPLACE all categories, items, history and settings with the file's contents. Consider exporting first.`,
        confirmLabel: 'Replace everything',
        danger: true,
      });
      if (!ok) return;
      const res = await api.importData(data);
      toast(
        `Imported ${res.counts.categories} categories, ${res.counts.items} items, ${res.counts.picks} picks`,
        'success',
      );
      const s = await api.settings();
      setSaved(s);
      setDraft(s);
    });

  return (
    <section class="settings">
      <h1>Settings</h1>

      <form class="card stack" onSubmit={save} noValidate>
        <h2>Picking</h2>

        <label class="field">
          <span>
            Variety <strong>{varietyLabel(draft.k)}</strong>
          </span>
          <input
            type="range"
            min={0}
            max={20}
            step={0.5}
            value={draft.k}
            onInput={(e) => set('k', Number(e.currentTarget.value))}
            aria-describedby="variety-help"
          />
          <span id="variety-help" class="muted small">
            How strongly recent picks are avoided. Something you just accepted gets{' '}
            <strong>{percent(justPickedWeight(draft))}</strong> of a fresh item's chance (k ={' '}
            {draft.k}).
          </span>
        </label>

        <label class="switch">
          <input
            type="checkbox"
            checked={draft.categoryFirst}
            onChange={(e) => set('categoryFirst', e.currentTarget.checked)}
            aria-describedby="catfirst-help"
          />
          <span>Pick a category first, then an item</span>
        </label>
        <p id="catfirst-help" class="muted small">
          Each category gets a roughly equal chance, no matter how many items it has. A category
          with one item will be picked as often as one with fifty.
        </p>

        <details class="advanced">
          <summary>Advanced</summary>
          <label class="field">
            <span>Memory (λ, between 0 and 1)</span>
            <input
              type="number"
              min={0.01}
              max={0.99}
              step="any"
              value={draft.lambda}
              onInput={(e) => set('lambda', Number(e.currentTarget.value))}
              aria-invalid={!lambdaOk}
            />
            <span class="muted small">
              How quickly a past pick is forgotten, per later pick. Higher remembers longer.
            </span>
          </label>
          <label class="field">
            <span>Minimum weight (floor, above 0 and up to 1)</span>
            <input
              type="number"
              min={0.001}
              max={1}
              step="any"
              value={draft.floor}
              onInput={(e) => set('floor', Number(e.currentTarget.value))}
              aria-invalid={!floorOk}
            />
            <span class="muted small">No item's weight ever drops below this.</span>
          </label>
        </details>

        {!valid && <p class="warning small">λ must be between 0 and 1, and the floor in (0, 1].</p>}
        <div class="row-actions">
          <button class="btn btn-primary" disabled={disabled || !dirty || !valid}>
            Save
          </button>
          <button
            type="button"
            class="btn"
            disabled={busy || !dirty}
            onClick={() => setDraft(saved)}
          >
            Reset
          </button>
        </div>
      </form>

      <section class="card stack">
        <h2>Backup</h2>
        <p class="muted small">
          Export everything as JSON. Import replaces all current data with the file's contents.
        </p>
        <div class="row-actions">
          <button class="btn" onClick={exportAll} disabled={disabled}>
            Export JSON
          </button>
          <button
            class="btn btn-danger-outline"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
          >
            Import JSON…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            class="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) void importFile(file);
            }}
          />
        </div>
      </section>

      <section class="card stack">
        <h2>About</h2>
        <p class="muted small">
          MediaChoice has no login: anyone who can reach this address can see and change everything.
        </p>
      </section>
    </section>
  );
}
