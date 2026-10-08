import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { useRegisterSW } from 'virtual:pwa-register/preact';
import { isOffline, onOfflineChange } from './api';
import { HistoryPage } from './pages/History';
import { LibraryPage } from './pages/Library';
import { PickPage } from './pages/Pick';
import { SettingsPage } from './pages/Settings';

// ---------- routing (tiny history-API router)

const ROUTES = [
  { path: '/', label: 'Pick', icon: '🎲', Page: PickPage },
  { path: '/library', label: 'Library', icon: '📚', Page: LibraryPage },
  { path: '/history', label: 'History', icon: '🕘', Page: HistoryPage },
  { path: '/settings', label: 'Settings', icon: '⚙️', Page: SettingsPage },
] as const;

export function navigate(path: string) {
  if (path === location.pathname) return;
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export function Link(props: { href: string; class?: string; children: ComponentChildren }) {
  return (
    <a
      href={props.href}
      class={props.class}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(props.href);
      }}
    >
      {props.children}
    </a>
  );
}

// ---------- app-wide context: offline flag, toasts, dialogs

type ToastKind = 'info' | 'error' | 'success';
interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface DialogOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the dialog shows a text input and resolves to its value. */
  input?: { label: string; value: string };
}
type DialogState = DialogOptions & { resolve: (v: string | boolean | null) => void };

interface AppContext {
  offline: boolean;
  toast: (message: string, kind?: ToastKind) => void;
  confirm: (opts: DialogOptions) => Promise<boolean>;
  prompt: (
    opts: DialogOptions & { input: { label: string; value: string } },
  ) => Promise<string | null>;
}

const Ctx = createContext<AppContext>(null as unknown as AppContext);
export const useApp = () => useContext(Ctx);

/** Run an async action with a busy flag; errors become toasts. */
export function useAction() {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      try {
        return await fn();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return [busy, run] as const;
}

function Dialog({
  state,
  close,
}: {
  state: DialogState;
  close: (v: string | boolean | null) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(state.input?.value ?? '');
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const cancel = () => close(state.input ? null : false);
  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (state.input) {
            if (value.trim()) close(value.trim());
          } else close(true);
        }}
      >
        <h2 id="dialog-title">{state.title}</h2>
        {state.message && <p>{state.message}</p>}
        {state.input && (
          <label class="field">
            <span>{state.input.label}</span>
            <input
              value={value}
              onInput={(e) => setValue(e.currentTarget.value)}
              maxLength={200}
              autoFocus
            />
          </label>
        )}
        <div class="dialog-actions">
          <button type="button" class="btn" onClick={cancel}>
            Cancel
          </button>
          <button
            type="submit"
            class={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`}
            autoFocus={!state.input}
          >
            {state.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function UpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Check for a new version hourly while the app stays open.
      if (registration) setInterval(() => void registration.update(), 60 * 60 * 1000);
    },
  });
  if (!needRefresh) return null;
  return (
    <div class="banner banner-update" role="status">
      <span>Update available.</span>
      <button class="btn btn-small btn-primary" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
      <button class="btn btn-small" onClick={() => (setNeedRefresh as (v: boolean) => void)(false)}>
        Later
      </button>
    </div>
  );
}

export function App() {
  const path = usePath();
  const [offline, setOffline] = useState(isOffline());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const nextToast = useRef(1);

  useEffect(() => onOfflineChange(setOffline), []);

  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextToast.current++;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      kind === 'error' ? 6000 : 3500,
    );
  }, []);

  const confirm = useCallback(
    (opts: DialogOptions) =>
      new Promise<boolean>((resolve) =>
        setDialog({ ...opts, input: undefined, resolve: (v) => resolve(v === true) }),
      ),
    [],
  );
  const prompt = useCallback(
    (opts: DialogOptions & { input: { label: string; value: string } }) =>
      new Promise<string | null>((resolve) =>
        setDialog({ ...opts, resolve: (v) => resolve(typeof v === 'string' ? v : null) }),
      ),
    [],
  );

  const route = ROUTES.find((r) => r.path === path) ?? null;
  useEffect(() => {
    document.title = route ? `${route.label} · MediaChoice` : 'MediaChoice';
  }, [route]);

  return (
    <Ctx.Provider value={{ offline, toast, confirm, prompt }}>
      <div class="app">
        <UpdateBanner />
        {offline && (
          <div class="banner banner-offline" role="status">
            Offline: showing saved data. Changes are disabled until you're back online.
          </div>
        )}
        <main class="page">
          {route ? (
            <route.Page />
          ) : (
            <section class="empty">
              <h1>Page not found</h1>
              <Link href="/" class="btn btn-primary">
                Go to Pick
              </Link>
            </section>
          )}
        </main>
        <nav class="tabbar" aria-label="Main">
          {ROUTES.map((r) => (
            <Link key={r.path} href={r.path} class={`tab ${r.path === path ? 'active' : ''}`}>
              <span class="tab-icon" aria-hidden="true">
                {r.icon}
              </span>
              <span>{r.label}</span>
            </Link>
          ))}
        </nav>
        <div class="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              class={`toast toast-${t.kind}`}
              role={t.kind === 'error' ? 'alert' : 'status'}
            >
              {t.message}
            </div>
          ))}
        </div>
        {dialog && (
          <Dialog
            state={dialog}
            close={(v) => {
              dialog.resolve(v);
              setDialog(null);
            }}
          />
        )}
      </div>
    </Ctx.Provider>
  );
}
