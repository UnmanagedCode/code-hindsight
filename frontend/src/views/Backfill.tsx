import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { JobPanel } from '@/components/JobPanel';
import { api, send } from '@/lib/api';
import type { BackfillEstimate, BackfillScan, BackfillSession, Job, Status } from '@/lib/types';

const ZERO: BackfillEstimate = { chunks: 0, inputTokens: 0, outputTokens: 0 };
const num = (n: number) => n.toLocaleString('en-US');
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '?');
const sum = (rows: BackfillSession[]) => rows.reduce((a, r) => ({ chunks: a.chunks + r.estimate.chunks, inputTokens: a.inputTokens + r.estimate.inputTokens, outputTokens: a.outputTokens + r.estimate.outputTokens }), ZERO);
/** A price the user typed, or null while it is not a non-negative number. */
const price = (v: string) => (v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

/** Banks in order of first appearance, each with its sessions. */
function byBank(sessions: BackfillSession[]) {
  const groups = new Map<string, BackfillSession[]>();
  for (const s of sessions) groups.set(s.bank, [...(groups.get(s.bank) ?? []), s]);
  return [...groups];
}

/** The selection's estimate; `setPrices` (the card's copy only) adds the price inputs. */
function Estimate({ scan, rows, prices, setPrices }: { scan: BackfillScan; rows: BackfillSession[]; prices: { input: string; output: string }; setPrices?: (p: { input: string; output: string }) => void }) {
  const e = sum(rows);
  const none = scan.llm.mode === 'none';
  const pIn = price(prices.input);
  const pOut = price(prices.output);
  const cost = pIn !== null && pOut !== null ? (e.inputTokens / 1e6) * pIn + (e.outputTokens / 1e6) * pOut : null;
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" data-estimate>
      <p>
        LLM mode <strong>{scan.llm.mode}</strong>{scan.llm.model ? <> (<code>{scan.llm.model}</code>)</> : null}: {num(rows.reduce((a, r) => a + r.documents, 0))} documents, {num(e.chunks)} chunks,
        {' '}<span data-tokens="input">{num(e.inputTokens)}</span> input and <span data-tokens="output">{num(e.outputTokens)}</span> output tokens.
        {cost !== null && <> Cost about <strong data-cost>${cost.toFixed(2)}</strong>.</>}
      </p>
      {!none && setPrices && (
        <div className="flex flex-wrap gap-3">
          <div className="space-y-1">
            <Label htmlFor="backfill-price-in">$ per million input tokens</Label>
            <Input id="backfill-price-in" className="w-32" inputMode="decimal" value={prices.input} onChange={(ev) => setPrices({ ...prices, input: ev.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="backfill-price-out">$ per million output tokens</Label>
            <Input id="backfill-price-out" className="w-32" inputMode="decimal" value={prices.output} onChange={(ev) => setPrices({ ...prices, output: ev.target.value })} />
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Rough estimate (±50% or worse): Hindsight's chunking and extraction prompt decide the real token use. LLM mode none costs no LLM tokens.</p>
    </div>
  );
}

/** Memory → Import past sessions: scan saved transcripts (a dry run), pick, confirm, import. */
export function Backfill({ status }: { status: Status }) {
  const [scan, setScan] = useState<BackfillScan | null>(null);
  const [jobId, setJobId] = useState<string | null>(status.job?.kind.startsWith('backfill-') ? status.job.id : null);
  const [running, setRunning] = useState(!!status.job && status.job.kind.startsWith('backfill-'));
  const [fresh, setFresh] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prices, setPrices] = useState({ input: '', output: '' });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ scan: BackfillScan | null }>('-/api/memory/backfill').then((r) => setScan(r.scan), () => {});
  }, []);
  useEffect(load, [load]);
  // A new scan selects every ready session: the confirm step is the safeguard.
  useEffect(() => { setSelected(new Set((scan?.sessions ?? []).filter((s) => s.status === 'ready').map((s) => s.key))); }, [scan?.scanId]);

  const busy = running || !!status.job;
  const start = async (kind: 'backfill-scan' | 'backfill-import', body: unknown) => {
    setError(null);
    try {
      const job = await send<Job>(`-/api/jobs/${kind}`, 'POST', body);
      setJobId(job.id);
      setRunning(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const chosen = useMemo(() => (scan?.sessions ?? []).filter((s) => selected.has(s.key)), [scan, selected]);
  const groups = useMemo(() => byBank(scan?.sessions ?? []), [scan]);
  const skippedByCode = useMemo(() => {
    const m = new Map<string, { message: string; rows: BackfillScan['skipped'] }>();
    for (const k of scan?.skipped ?? []) {
      const g = m.get(k.code) ?? { message: k.message, rows: [] };
      g.rows.push(k);
      m.set(k.code, g);
    }
    return [...m];
  }, [scan]);
  const hindsightReady = status.state === 'ready' && !!scan?.hindsightChecked;
  const toggle = (keys: string[], on: boolean) => {
    const next = new Set(selected);
    for (const k of keys) { if (on) next.add(k); else next.delete(k); }
    setSelected(next);
  };
  const perBank = byBank(chosen).map(([bank, rows]) => [bank, rows.length] as const);

  return (
    <Card data-backfill>
      <CardHeader>
        <CardTitle>Import past sessions</CardTitle>
        <CardDescription>
          Live memory starts at a session's first matching turn. This imports what came before, from the transcripts Claude Code saved: cc places each one (its project, worktree and last stage), the scopes choose its bank as they would for live retain, and turns live memory already holds are left out. A scan only looks; nothing is sent until you confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" disabled={busy} onClick={() => void start('backfill-scan', { fresh })}>Scan transcripts</Button>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> Resolve every transcript again (ignore cached placements)
          </label>
        </div>
        {error && <p className="text-destructive" role="alert">{error}</p>}
        {jobId && <JobPanel key={jobId} jobId={jobId} onEnd={() => { setRunning(false); load(); }} />}

        {scan && (
          <div className="space-y-3" data-scan={scan.scanId}>
            <p data-totals>
              Scanned {day(scan.scannedAt)}: {num(scan.totals.files)} transcripts — {num(scan.totals.ready)} ready, {num(scan.totals.imported)} already imported, {num(scan.totals.skipped)} skipped.
            </p>
            {!scan.hindsightChecked && <p className="text-warning" role="status">Hindsight is not ready: already-imported sessions and live overlap were not checked; Import is disabled.</p>}

            {groups.map(([bank, rows]) => {
              const ready = rows.filter((r) => r.status === 'ready');
              const on = ready.filter((r) => selected.has(r.key)).length;
              return (
                <fieldset key={bank} className="space-y-1 rounded-md border p-2" data-bank={bank}>
                  <legend className="px-1">
                    <label className="inline-flex items-center gap-2 font-medium">
                      <input
                        type="checkbox" disabled={!ready.length} checked={ready.length > 0 && on === ready.length}
                        ref={(el) => { if (el) el.indeterminate = on > 0 && on < ready.length; }}
                        onChange={(e) => toggle(ready.map((r) => r.key), e.target.checked)}
                      />
                      Bank <code>{bank}</code> ({rows.length} sessions)
                    </label>
                  </legend>
                  <ul className="space-y-1">
                    {rows.map((r) => (
                      <li key={r.key} data-session={r.key} data-status={r.status}>
                        <label className="flex min-w-0 items-baseline gap-2">
                          <input type="checkbox" disabled={r.status !== 'ready'} checked={r.status === 'ready' && selected.has(r.key)} onChange={(e) => toggle([r.key], e.target.checked)} />
                          <span className="max-w-[24rem] truncate font-medium">{r.title ?? r.backingId}</span>
                          <span className="text-xs text-muted-foreground">
                            {[r.project, r.worktree, r.stage].filter(Boolean).join(' · ')} · {day(r.firstAt)} – {day(r.lastAt)} · {num(r.turns)} turns
                            {r.cutoffAt && <> · only before {r.cutoffAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}</>}
                          </span>
                          {r.status === 'imported' && <Badge variant="secondary">already imported</Badge>}
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              );
            })}

            {scan.sessions.length > 0 && <Estimate scan={scan} rows={chosen} prices={prices} setPrices={setPrices} />}

            {skippedByCode.length > 0 && (
              <div className="space-y-1" data-skipped>
                <p className="font-medium">Skipped</p>
                {skippedByCode.map(([code, g]) => (
                  <details key={code} data-skip-code={code}>
                    <summary>{g.rows.length} × {code}: {g.message}</summary>
                    <ul className="ml-4 list-disc text-xs">
                      {g.rows.map((k) => <li key={`${k.key}-${k.backingId}`}>{[k.backingId, k.project, k.worktree, k.stage].filter(Boolean).join(' · ')}{k.message !== g.message ? ` — ${k.message}` : ''}</li>)}
                    </ul>
                  </details>
                ))}
              </div>
            )}

            <Button type="button" size="sm" disabled={!chosen.length || !hindsightReady || busy} onClick={() => setConfirming(true)}>Import selected…</Button>
          </div>
        )}

        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Import {chosen.length} sessions?</DialogTitle>
              <DialogDescription>
                Their transcripts are sent to Hindsight{scan?.llm.mode === 'none' ? '' : ' and extracted with its LLM'}. A session already imported is not sent again.
              </DialogDescription>
            </DialogHeader>
            <ul className="text-sm" aria-label="Banks">
              {perBank.map(([bank, n]) => <li key={bank}><code>{bank}</code>: {n} sessions</li>)}
            </ul>
            {scan && <Estimate scan={scan} rows={chosen} prices={prices} />}
            <DialogFooter>
              <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
              <Button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  void start('backfill-import', { scanId: scan?.scanId, sessions: chosen.map((s) => s.key), confirm: true });
                }}
              >
                Import {chosen.length} sessions
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
