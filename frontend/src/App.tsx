import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorCard } from '@/components/ErrorCard';
import { send } from '@/lib/api';
import { readRoute, routeSearch, type Route, type View } from '@/lib/route';
import type { ErrorAction, HindsightState, Status as StatusT } from '@/lib/types';
import { useStatus } from '@/lib/useStatus';
import { ControlPlane } from '@/views/ControlPlane';
import { Images } from '@/views/Images';
import { Settings } from '@/views/Settings';
import { Status } from '@/views/Status';

const TABS: { view: View; label: string }[] = [
  { view: 'cp', label: 'Control plane' },
  { view: 'status', label: 'Status' },
  { view: 'settings', label: 'Settings' },
  { view: 'images', label: 'Images & data' },
];

const PILL: Record<HindsightState, 'success' | 'info' | 'warning' | 'destructive' | 'outline'> = {
  ready: 'success', checking: 'info', starting: 'info', stopping: 'warning', stopped: 'outline', error: 'destructive',
};

/** Not running: why, and the action that fixes it. */
function NotRunning({ status, onAction, busy }: { status: StatusT; onAction: (a: ErrorAction) => void; busy: boolean }) {
  if (status.error) return <div className="p-4"><ErrorCard error={status.error} onAction={onAction} busy={busy} /></div>;
  return (
    <div className="space-y-3 p-4 text-sm">
      <p>Hindsight is {status.state}.</p>
      {status.state === 'stopped' && <Button size="sm" disabled={busy} onClick={() => onAction('start')}>Start Hindsight</Button>}
    </div>
  );
}

export function App() {
  const { status, error, refresh } = useStatus();
  const [route, setRoute] = useState<Route>(() => readRoute());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((next: Route) => {
    setRoute(next);
    history.pushState(null, '', routeSearch(next));
  }, []);
  const onCpPath = useCallback((cp: string) => {
    history.replaceState(null, '', routeSearch({ view: 'cp', cp }));
  }, []);

  const onAction = useCallback(async (action: ErrorAction) => {
    if (action === 'settings') return go({ view: 'settings', cp: null });
    if (action === 'import' || action === 'trust-cp') return go({ view: 'images', cp: null });
    setBusy(true);
    try {
      if (action === 'pull') await send('-/api/jobs/pull', 'POST', { variant: status?.variant ?? 'full' });
      else if (action === 'build-cp') await send('-/api/jobs/build-cp', 'POST');
      else await send(`-/api/${action}`, 'POST');
    } catch {
      // The refusal shows up in status.
    } finally {
      setBusy(false);
      await refresh(true);
    }
  }, [go, refresh, status?.variant]);

  const view: View = route.view ?? (status?.state === 'ready' ? 'cp' : 'status');
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <h1 className="text-base font-semibold">Code Hindsight</h1>
        {status && (
          <Badge variant={PILL[status.state]} data-pill={status.state}>
            {status.state}{status.docker.mode === 'sudo' ? ' · sudo docker' : ''}
          </Badge>
        )}
        <nav role="tablist" aria-label="Views" className="ml-auto flex flex-wrap gap-1">
          {TABS.map((t) => (
            <Button key={t.view} role="tab" aria-selected={view === t.view} size="sm" variant={view === t.view ? 'secondary' : 'ghost'} onClick={() => go({ view: t.view, cp: null })}>
              {t.label}
            </Button>
          ))}
        </nav>
      </header>
      {error && !status && <p className="p-4 text-sm text-destructive" role="alert">The plugin backend is not answering: {error}</p>}
      {status && (
        <main className={view === 'cp' && status.state === 'ready' ? 'min-h-0 flex-1' : 'mx-auto w-full max-w-[var(--cc-session-width,56rem)] flex-1 overflow-auto p-4'}>
          {view === 'cp' && (status.state === 'ready' ? <ControlPlane cp={route.cp} onCpPath={onCpPath} /> : <NotRunning status={status} onAction={onAction} busy={busy} />)}
          {view === 'status' && <Status status={status} onAction={onAction} busy={busy} />}
          {view === 'settings' && <Settings busy={busy} onSaved={() => void refresh(false)} onApply={() => void onAction('start')} />}
          {view === 'images' && <Images status={status} onChanged={() => void refresh(true)} />}
        </main>
      )}
    </div>
  );
}
