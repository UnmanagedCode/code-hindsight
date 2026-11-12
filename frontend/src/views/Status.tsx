import { useState } from 'react';
import { InfoIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ErrorCard';
import { JobPanel } from '@/components/JobPanel';
import { api } from '@/lib/api';
import type { ErrorAction, Status as StatusT } from '@/lib/types';

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[10rem_1fr] gap-2 py-1 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="min-w-0 break-words">{children}</span>
  </div>
);

function imageText(i: { present: boolean; ok: boolean } | undefined) {
  if (!i) return 'unknown';
  if (!i.present) return 'missing';
  return i.ok ? 'present' : 'present, wrong release';
}

export function Status({ status, onAction, busy }: { status: StatusT; onAction: (a: ErrorAction) => void; busy: boolean }) {
  const [log, setLog] = useState<{ role: string; text: string } | null>(null);
  const running = status.state === 'ready' || status.state === 'starting' || status.state === 'checking';
  const showLog = async (role: 'api' | 'cp') => {
    try {
      const r = await api<{ log: string }>(`-/api/logs/${role}`);
      setLog({ role, text: r.log });
    } catch (e) {
      setLog({ role, text: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="space-y-4">
      {status.error && <ErrorCard error={status.error} onAction={onAction} busy={busy} />}
      {status.lastShutdownFailure && (
        <Alert variant="warning" data-hint="shutdown-failed">
          <InfoIcon />
          <AlertTitle>The plugin could not stop Hindsight when it was last stopped</AlertTitle>
          <AlertDescription>
            <p className="font-mono text-xs whitespace-pre-wrap break-words">{status.lastShutdownFailure.error}</p>
            The containers may have kept running until this start.
          </AlertDescription>
        </Alert>
      )}
      {status.autoStart === false && (
        <Alert variant="info" data-hint="autostart">
          <InfoIcon />
          <AlertTitle>Hindsight runs only while this plugin's backend runs</AlertTitle>
          <AlertDescription>
            The backend starts when you open this page or a tool uses it. To have Hindsight up after every cc start, switch on Settings → Plugins → Code Hindsight → Auto-start.
          </AlertDescription>
        </Alert>
      )}
      {status.pendingRestart && (
        <Alert variant="warning">
          <InfoIcon />
          <AlertTitle>Settings changed</AlertTitle>
          <AlertDescription>
            The running containers use the previous settings.
            <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => onAction('start')}>Apply &amp; restart</Button>
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader><CardTitle>Hindsight</CardTitle></CardHeader>
        <CardContent>
          <Row label="State"><span data-state={status.state}>{status.state}</span></Row>
          <Row label="Docker">{status.docker.mode ? `${status.docker.mode === 'sudo' ? 'sudo -n docker' : 'docker'} (daemon ${status.docker.serverVersion ?? '?'})` : 'not resolved'}</Row>
          <Row label="Image">{status.variant}</Row>
          <Row label="Published on">{status.bindAddress}{status.bindAuto ? ' (automatic)' : ''} — API {status.ports.api}, control plane {status.ports.cp}</Row>
          <Row label="LLM">{status.llmMode === 'none' ? 'none (memories are stored as chunks; reflect is unavailable)' : status.llmMode}</Row>
          {status.startedAt && <Row label="Ready since">{status.startedAt}</Row>}
          <div className="flex flex-wrap gap-2 pt-3">
            {!running && <Button size="sm" disabled={busy} onClick={() => onAction('start')}>Start Hindsight</Button>}
            {status.state !== 'stopped' && <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('restart')}>Restart Hindsight</Button>}
            {status.state !== 'stopped' && <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('stop')}>Stop Hindsight</Button>}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Images and containers</CardTitle></CardHeader>
        <CardContent>
          <Row label="API image">{status.images?.api.ref ?? '—'} <Badge variant={status.images?.api.ok ? 'success' : 'outline'}>{imageText(status.images?.api)}</Badge></Row>
          <Row label="Control-plane image">{status.images?.cp.ref ?? '—'} <Badge variant={status.images?.cp.ok ? 'success' : 'outline'}>{imageText(status.images?.cp)}</Badge></Row>
          <Row label="API container">{status.containers?.api.state ?? '—'}</Row>
          <Row label="CP container">{status.containers?.cp.state ?? '—'}</Row>
          <div className="flex gap-2 pt-3">
            <Button size="sm" variant="outline" onClick={() => void showLog('api')}>API log</Button>
            <Button size="sm" variant="outline" onClick={() => void showLog('cp')}>CP log</Button>
          </div>
          {log && <pre aria-label={`${log.role} log`} className="mt-3 max-h-80 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-words">{log.text}</pre>}
        </CardContent>
      </Card>
      {status.job && <JobPanel key={status.job.id} jobId={status.job.id} />}
    </div>
  );
}
