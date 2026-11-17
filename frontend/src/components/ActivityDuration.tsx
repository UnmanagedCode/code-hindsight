import type { ActivityTiming } from '@/lib/types';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
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
