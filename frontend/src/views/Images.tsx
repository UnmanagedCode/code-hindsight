import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { JobPanel } from '@/components/JobPanel';
import { api, ApiError, send } from '@/lib/api';
import type { Job, Status, Variant } from '@/lib/types';

export function Images({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const [jobId, setJobId] = useState<string | null>(status.job?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [exportVariant, setExportVariant] = useState<Variant>(status.variant);
  const [hostPath, setHostPath] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirm, setConfirm] = useState<'remove-images' | 'delete-volume' | 'trust-cp' | null>(null);
  const [typed, setTyped] = useState('');
  const busy = !!status.job || uploading;

  const start = async (kind: string, body: unknown = {}) => {
    setError(null);
    try {
      const job = await send<Job>(`-/api/jobs/${kind}`, 'POST', body);
      setJobId(job.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const job = await api<Job>('-/api/jobs/import', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
      setJobId(job.id);
      if (job.error) setError(`${job.error.title}: ${job.error.message}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUploading(false);
      onChanged();
    }
  };

  const volume = status.volume;
  const cp = status.images?.cp;
  const exportName = status.bundleNames[exportVariant];
  const exported = status.bundles.find((b) => b.name === exportName);
  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {jobId && <JobPanel key={jobId} jobId={jobId} onEnd={() => onChanged()} />}

      <Card>
        <CardHeader>
          <CardTitle>Get the images</CardTitle>
          <CardDescription>Nothing is pulled or built automatically. Pull and Build need network access; Import works offline.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>API image</span>
            <Badge variant={status.images?.api.ok ? 'success' : 'outline'}>{status.images?.api.ok ? 'present' : 'missing or wrong release'}</Badge>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void start('pull', { variant: 'full' })}>Pull full image</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void start('pull', { variant: 'slim' })}>Pull slim image</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span>Control-plane image</span>
            <Badge variant={status.images?.cp.ok ? 'success' : 'outline'}>{status.images?.cp.ok ? 'present' : 'missing or wrong build'}</Badge>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void start('build-cp')}>Build CP image</Button>
          </div>
        </CardContent>
      </Card>

      {cp?.present && !cp.trusted && cp.id && (
        <Card data-card="trust-cp">
          <CardHeader>
            <CardTitle>Control-plane image not trusted</CardTitle>
            <CardDescription>
              This control-plane image was not built here, or was replaced (an import, a retag). It runs inside cc's page with your memories, so it runs only after you confirm this exact image ID — or build it here instead.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{cp.ref}</p>
            <code className="block break-all rounded bg-muted p-2 text-xs" aria-label="Control-plane image ID">{cp.id}</code>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm('trust-cp')}>Trust this image…</Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Offline bundles</CardTitle>
          <CardDescription>Export the images on a machine with network access, carry the file over, and import it here.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-1">
            <Label htmlFor="import-file">Import a bundle file</Label>
            <div className="flex flex-wrap gap-2">
              <Input id="import-file" type="file" accept=".tar,application/x-tar" className="max-w-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <Button size="sm" variant="outline" disabled={busy || !file} onClick={() => void upload()}>{uploading ? 'Uploading…' : 'Upload and import'}</Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="import-path">Import from a path on cc's machine</Label>
            <div className="flex flex-wrap gap-2">
              <Input id="import-path" className="max-w-sm" placeholder="/absolute/path/code-hindsight-bundle.tar" value={hostPath} onChange={(e) => setHostPath(e.target.value)} />
              <Button size="sm" variant="outline" disabled={busy || !hostPath} onClick={() => void start('import', { path: hostPath })}>Import</Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="export-variant">Export a bundle (API image + control-plane image)</Label>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect id="export-variant" value={exportVariant} onChange={(e) => setExportVariant(e.target.value as Variant)}>
                <option value="full">full</option>
                <option value="slim">slim</option>
              </NativeSelect>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void start('export', { variant: exportVariant })}>Export</Button>
              {exported && <a className="text-primary underline" href={`-/api/bundles/${encodeURIComponent(exported.name)}`} download>Download {exported.name} ({Math.round(exported.size / 1e6)} MB)</a>}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Remove</CardTitle>
          <CardDescription>Stop Hindsight first. Deleting the data volume erases every memory.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { setTyped(''); setConfirm('remove-images'); }}>Remove images</Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setTyped(''); setConfirm('delete-volume'); }}>Delete data volume</Button>
        </CardContent>
      </Card>

      <Dialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === 'delete-volume' ? 'Delete all memories?' : confirm === 'trust-cp' ? 'Trust this control-plane image?' : 'Remove the Hindsight images?'}</DialogTitle>
            <DialogDescription>
              {confirm === 'delete-volume'
                ? `This deletes the Docker volume ${volume} and every memory in it. Type its name to confirm.`
                : confirm === 'trust-cp'
                  ? `Only trust it if you know where it came from, e.g. a bundle you exported yourself (compare the ID with the export's). Image ID: ${cp?.id ?? ''}`
                  : 'This removes the pinned API images and the control-plane image. You will need to pull, build or import them again.'}
            </DialogDescription>
          </DialogHeader>
          {confirm === 'delete-volume' && <Input aria-label="Volume name" value={typed} onChange={(e) => setTyped(e.target.value)} />}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
            <Button
              variant={confirm === 'trust-cp' ? 'default' : 'destructive'}
              disabled={confirm === 'delete-volume' && typed !== volume}
              onClick={() => {
                const kind = confirm;
                setConfirm(null);
                if (kind === 'delete-volume') void start('delete-volume', { confirm: typed });
                else if (kind === 'trust-cp') void start('trust-cp', { confirm: cp?.id });
                else if (kind) void start('remove-images', { confirm: true });
              }}
            >
              {confirm === 'delete-volume' ? 'Delete volume' : confirm === 'trust-cp' ? 'Trust image' : 'Remove images'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
