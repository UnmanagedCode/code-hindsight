import { useEffect, useRef, useState } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { api } from '@/lib/api';
import type { Job } from '@/lib/types';
import { Badge } from '@/components/ui/badge';

const STATE_BADGE = { running: 'info', done: 'success', failed: 'destructive' } as const;

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
      {job.error && <p className="text-sm text-destructive">{job.error.title}: {job.error.message}</p>}
      {job.tail && <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-words">{job.tail}</pre>}
    </div>
  );
}
