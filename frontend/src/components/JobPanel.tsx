import { useEffect, useRef, useState } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { api } from '@/lib/api';
import type { Job, LoadedImage } from '@/lib/types';
import { Badge } from '@/components/ui/badge';

const STATE_BADGE = { running: 'info', done: 'success', failed: 'destructive' } as const;
const STANDING: Record<LoadedImage['status'], string> = {
  pinned: 'pinned release',
  'not-pinned': 'not the pinned release — will not run',
  trusted: 'trusted',
  'needs-confirmation': 'needs your confirmation before it runs',
  unused: 'not used by this plugin',
};

/** Image IDs a bundle carries: the export's result, or an import's bundle manifest. */
function BundleIds({ label, images }: { label: string; images: { ref: string; id: string }[] }) {
  return (
    <div className="space-y-1 text-xs">
      <p className="font-medium">{label}</p>
      <ul className="space-y-1" aria-label={label}>
        {images.map((i) => (
          <li key={`${i.ref}${i.id}`}>
            <span>{i.ref}</span> <code className="break-all">{i.id}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

const imageList = (v: unknown): { ref: string; id: string }[] | null =>
  Array.isArray(v) ? v.filter((i): i is { ref: string; id: string } => typeof i?.ref === 'string' && typeof i?.id === 'string') : null;

/** What an import loaded: each image's ID and whether it will run. */
function Loaded({ loaded }: { loaded: LoadedImage[] }) {
  return (
    <ul className="space-y-1 text-xs" aria-label="Loaded images">
      {loaded.map((l) => (
        <li key={`${l.ref}${l.id}`} data-standing={l.status}>
          <span className="font-medium">{l.ref}</span> <code className="break-all">{l.id}</code> — {STANDING[l.status]}
        </li>
      ))}
    </ul>
  );
}

/** One job's progress, polled until it ends; `onEnd` fires once when it does. */
export function JobPanel({ jobId, onEnd, intervalMs = 1000 }: { jobId: string; onEnd?: (j: Job) => void; intervalMs?: number }) {
  const [job, setJob] = useState<Job | null>(null);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    let stop = false;
    let ended = false;
    const tick = async () => {
      try {
        const j = await api<Job>(`-/api/jobs/${encodeURIComponent(jobId)}`);
        if (stop) return;
        setJob(j);
        if (j.state !== 'running' && !ended) { ended = true; endRef.current?.(j); return; }
      } catch { /* the backend may be restarting; keep polling */ }
      if (!stop) setTimeout(tick, intervalMs);
    };
    void tick();
    return () => { stop = true; };
  }, [jobId, intervalMs]);
  if (!job) return null;
  return (
    <div className="space-y-2 rounded-md border p-3" data-job={job.kind}>
      <div className="flex items-center gap-2 text-sm">
        {job.state === 'running' && <LoaderCircleIcon className="size-4 animate-spin" />}
        <span className="font-medium">{job.kind}</span>
        <Badge variant={STATE_BADGE[job.state]}>{job.state}</Badge>
      </div>
      {Array.isArray(job.result?.loaded) && <Loaded loaded={job.result.loaded as LoadedImage[]} />}
      {job.kind === 'import' && imageList((job.result?.manifest as { images?: unknown } | null)?.images) && (
        <BundleIds label="Image IDs listed in the bundle (from its export)" images={imageList((job.result!.manifest as { images: unknown }).images)!} />
      )}
      {job.kind === 'export' && imageList(job.result?.images) && (
        <BundleIds label="Image IDs in this bundle (compare them after importing it)" images={imageList(job.result!.images)!} />
      )}
      {job.error && <p className="text-sm text-destructive">{job.error.title}: {job.error.message}</p>}
      {job.tail && <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-words">{job.tail}</pre>}
    </div>
  );
}
