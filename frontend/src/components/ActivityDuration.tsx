import type { ActivityTiming } from '@/lib/types';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

const STEPS: { key: Exclude<keyof ActivityTiming, 'banks'>; label: string }[] = [
  { key: 'sessionMs', label: 'cc session' },
  { key: 'workspaceMs', label: 'cc workspace' },
  { key: 'hindsightMs', label: 'Hindsight' },
  { key: 'acceptMs', label: 'hook answered' },
  { key: 'totalMs', label: 'total' },
];

/** The measured steps of one entry, and each bank's own time; only keys that are present. */
export function TimingBreakdown({ timing, id }: { timing: ActivityTiming; id: string }) {
  return (
    <dl id={id} className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 py-1 text-muted-foreground">
      {STEPS.map(({ key, label }) => (timing[key] === undefined ? null : (
        <div key={key} className="contents"><dt>{label}</dt><dd>{formatDuration(timing[key])}</dd></div>
      )))}
      {(timing.banks ?? []).map((b) => (
        <div key={b.bank} className="contents"><dt>bank {b.bank}</dt><dd>{formatDuration(b.ms)}{b.code ? ` · ${b.code}` : ''}</dd></div>
      ))}
    </dl>
  );
}
