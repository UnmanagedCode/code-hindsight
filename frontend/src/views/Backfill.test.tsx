// Memory → Import past sessions (A4: dry run, selection, estimate, confirm; A6: progress, Cancel).
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Backfill } from './Backfill';
import { stubFetch, status } from '@/test/fixtures';
import type { BackfillScan, BackfillSession } from '@/lib/types';

const row = (key: string, over: Partial<BackfillSession> = {}): BackfillSession => ({
  key, handle: key.split(':')[0], backingId: key.split(':')[1], project: 'proj', worktree: 'main', kind: 'worker', stage: 'implement', title: `Session ${key}`,
  modifiedAt: '2026-01-03T00:00:00.000Z', firstAt: '2026-01-01T00:00:00.000Z', lastAt: '2026-01-02T00:00:00.000Z', turns: 10, documents: 1, chars: 3000, bank: 'cc-proj', scope: 'all',
  status: 'ready', cutoffAt: null, untimed: 0, malformed: 0, oversized: 0, stored: 0, outdated: 0, orphans: 0, estimate: { chunks: 1, inputTokens: 1000, outputTokens: 500 }, ...over,
});

const scanOf = (sessions: BackfillSession[], over: Partial<BackfillScan> = {}): BackfillScan => ({
  scanId: 'scan-1', scannedAt: '2026-11-14T10:00:00.000Z', scopesHash: 'h', hindsightChecked: true, llm: { mode: 'manual', model: 'm' },
  basis: { chunkChars: 3000, charsPerToken: 4, promptTokensPerChunk: 1000, outputTokensPerChunk: 500 },
  totals: { files: sessions.length + 1, ready: sessions.filter((s) => s.status === 'ready').length, imported: sessions.filter((s) => s.status === 'imported').length, skipped: 1, cached: 0, resolved: 0, estimate: { chunks: 0, inputTokens: 0, outputTokens: 0 } },
  sessions,
  skipped: [{ key: 'b-x', handle: null, backingId: 'b-x', code: 'BACKFILL_UNPLACEABLE', message: 'cc has no project for it (SESSION_UNLOCATABLE: no project)' }],
  ...over,
});

const standard = () => scanOf([
  row('h1:b1'),
  row('h2:b2', { estimate: { chunks: 2, inputTokens: 2000, outputTokens: 1000 }, cutoffAt: '2026-01-01T12:00:00.000Z', outdated: 1, orphans: 2 }),
  row('h3:b3', { bank: 'cc-other', project: 'other', estimate: { chunks: 4, inputTokens: 4000, outputTokens: 2000 } }),
  row('h4:b4', { bank: 'cc-other', project: 'other', status: 'imported' }),
]);

function stub(scan: BackfillScan | null, post?: (url: string, body: unknown) => { status?: number; body: unknown } | undefined) {
  return stubFetch((url, init) => {
    if (url === '-/api/memory/backfill') return { body: { scan } };
    if (init?.method === 'POST') return post?.(url, JSON.parse(String(init.body)));
    return undefined;
  });
}
const tokens = (kind: 'input' | 'output') => document.querySelector(`[data-backfill] > * [data-estimate] [data-tokens="${kind}"]`)?.textContent;

describe('Backfill', () => {
  // A6: a scan is a job with progress and Cancel.
  it('Scan transcripts starts a backfill-scan job and shows its progress and a Cancel button', async () => {
    const calls = stubFetch((url, init) => {
      if (url === '-/api/memory/backfill') return { body: { scan: null } };
      if (url === '-/api/jobs/backfill-scan') return { body: { id: 'j1', kind: 'backfill-scan', state: 'running', progress: null, cancellable: true } };
      if (url === '-/api/jobs/j1') return { body: { id: 'j1', kind: 'backfill-scan', state: 'running', progress: { done: 2, total: 5, unit: 'files' }, cancellable: true, result: null, error: null, tail: '' } };
      if (url === '-/api/jobs/j1/cancel') return { body: { id: 'j1', kind: 'backfill-scan', state: 'running', progress: { done: 2, total: 5, unit: 'files' }, cancellable: true, result: null, error: null, tail: '' } };
      return undefined;
    });
    render(<Backfill status={status()} />);
    await userEvent.click(screen.getByLabelText(/Resolve every transcript again/));
    await userEvent.click(screen.getByRole('button', { name: 'Scan transcripts' }));
    expect(JSON.parse(String(calls.find((c) => c.url === '-/api/jobs/backfill-scan')!.init!.body))).toEqual({ fresh: true });
    const bar = await screen.findByRole('progressbar', { name: 'Progress' });
    expect([bar.getAttribute('value'), bar.getAttribute('max')]).toEqual(['2', '5']);
    expect(screen.getByText('2 / 5 files')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Scan transcripts' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls.some((c) => c.url === '-/api/jobs/j1/cancel' && c.init?.method === 'POST')).toBe(true));
  });

  it('banks and sessions render in scan order: a bank sits where its newest session is', async () => {
    stub(scanOf([
      row('h9:b9', { bank: 'cc-zed' }), row('h2:b2', { bank: 'cc-alpha' }), row('h8:b8', { bank: 'cc-zed' }), row('h1:b1', { bank: 'cc-alpha' }),
    ]));
    render(<Backfill status={status()} />);
    await waitFor(() => { if (!document.querySelector('[data-bank]')) throw new Error('no group'); });
    const attr = (root: ParentNode, sel: string, name: string) => [...root.querySelectorAll(sel)].map((e) => e.getAttribute(name));
    expect(attr(document, '[data-bank]', 'data-bank')).toEqual(['cc-zed', 'cc-alpha']);
    expect(attr(document.querySelector('[data-bank="cc-zed"]')!, '[data-session]', 'data-session')).toEqual(['h9:b9', 'h8:b8']);
    expect(attr(document.querySelector('[data-bank="cc-alpha"]')!, '[data-session]', 'data-session')).toEqual(['h2:b2', 'h1:b1']);
  });

  // A4: the dry run's default selection is every ready session; imported ones cannot be picked.
  it('the scan result groups sessions by bank with every ready session ticked and imported ones disabled', async () => {
    stub(standard());
    render(<Backfill status={status()} />);
    const proj = await waitFor(() => { const g = document.querySelector('[data-bank="cc-proj"]'); if (!g) throw new Error('no group'); return g as HTMLElement; });
    const other = document.querySelector('[data-bank="cc-other"]') as HTMLElement;
    const box = (key: string) => document.querySelector(`[data-session="${key}"] input`) as HTMLInputElement;
    expect(['h1:b1', 'h2:b2', 'h3:b3'].map((k) => box(k).checked)).toEqual([true, true, true]);
    expect([box('h4:b4').checked, box('h4:b4').disabled]).toEqual([false, true]);
    expect(within(other).getByText('already imported')).toBeTruthy();
    expect(within(proj).getByText(/only before 2026-01-01 12:00:00Z/)).toBeTruthy();
    // A5: a session whose stored parts no longer match is offered again, saying what the import changes.
    expect(within(proj).getByText(/replaces 1 outdated stored parts · deletes 2 stored parts no longer needed/)).toBeTruthy();
    expect((within(proj).getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true);
    expect(within(document.querySelector('[data-skip-code="BACKFILL_UNPLACEABLE"]') as HTMLElement).getByText(/1 × BACKFILL_UNPLACEABLE: cc has no project/)).toBeTruthy();
  });

  // A4: the estimate follows the selection; prices are optional; LLM none has none.
  it('unticking a bank changes the estimate; prices turn tokens into a cost; LLM none hides prices', async () => {
    stub(standard());
    const { unmount } = render(<Backfill status={status()} />);
    await screen.findByText(/Session h1:b1/);
    expect([tokens('input'), tokens('output')]).toEqual(['7,000', '3,500']);
    const otherGroup = within(document.querySelector('[data-bank="cc-other"]') as HTMLElement).getAllByRole('checkbox')[0];
    await userEvent.click(otherGroup);
    expect([tokens('input'), tokens('output')]).toEqual(['3,000', '1,500']);
    await userEvent.click(document.querySelector('[data-session="h1:b1"] input') as HTMLInputElement);
    const projGroup = within(document.querySelector('[data-bank="cc-proj"]') as HTMLElement).getAllByRole('checkbox')[0] as HTMLInputElement;
    expect([projGroup.checked, projGroup.indeterminate]).toEqual([false, true]);
    expect(document.querySelector('[data-cost]')).toBeNull();
    await userEvent.type(screen.getByLabelText('$ per million input tokens'), '3');
    await userEvent.type(screen.getByLabelText('$ per million output tokens'), '15');
    // h2 only: 2000 × 3 / 1e6 + 1000 × 15 / 1e6 = 0.021
    expect(document.querySelector('[data-cost]')!.textContent).toBe('$0.02');
    expect(screen.getByText(/Rough estimate/)).toBeTruthy();
    unmount();
    stub(scanOf([row('h1:b1', { estimate: { chunks: 1, inputTokens: 0, outputTokens: 0 } })], { llm: { mode: 'none', model: null } }));
    render(<Backfill status={status()} />);
    await screen.findByText(/Session h1:b1/);
    expect(screen.queryByLabelText('$ per million input tokens')).toBeNull();
    expect(tokens('input')).toBe('0');
  });

  // A4: the confirm step repeats what will be sent; only its button posts confirm:true.
  it('Import opens a confirmation repeating the count, banks and estimate; only Import N sessions posts confirm:true with the selected keys', async () => {
    const calls = stub(standard(), (url) => (url === '-/api/jobs/backfill-import' ? { body: { id: 'j2', kind: 'backfill-import', state: 'running', progress: null, cancellable: true } } : undefined));
    render(<Backfill status={status()} />);
    await screen.findByText(/Session h1:b1/);
    await userEvent.click(document.querySelector('[data-session="h3:b3"] input') as HTMLInputElement);
    await userEvent.click(screen.getByRole('button', { name: 'Import selected…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Import 2 sessions?')).toBeTruthy();
    expect(within(within(dialog).getByRole('list', { name: 'Banks' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['cc-proj: 2 sessions']);
    expect(within(dialog).getByText('3,000')).toBeTruthy();
    expect(calls.some((c) => c.url === '-/api/jobs/backfill-import')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.url === '-/api/jobs/backfill-import')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Import selected…' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Import 2 sessions' }));
    await waitFor(() => expect(calls.some((c) => c.url === '-/api/jobs/backfill-import')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url === '-/api/jobs/backfill-import')!.init!.body))).toEqual({ scanId: 'scan-1', sessions: ['h1:b1', 'h2:b2'], confirm: true });
  });

  // A4: nothing can be imported against an unchecked or unavailable Hindsight.
  it('Import is disabled while Hindsight is not ready', async () => {
    stub(standard());
    const { unmount } = render(<Backfill status={status({ state: 'stopped' })} />);
    await screen.findByText(/Session h1:b1/);
    expect((screen.getByRole('button', { name: 'Import selected…' }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    stub(scanOf([row('h1:b1')], { hindsightChecked: false }));
    render(<Backfill status={status()} />);
    expect(await screen.findByText(/already-imported sessions and live overlap were not checked; Import is disabled/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Import selected…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  // A4: an import of an out-of-date scan is refused and says to scan again.
  it('a BACKFILL_STALE refusal asks for a new scan', async () => {
    stub(standard(), (url) => (url === '-/api/jobs/backfill-import' ? { status: 409, body: { code: 'BACKFILL_STALE', message: 'Scopes changed since the scan, or a newer scan replaced it; scan again.' } } : undefined));
    render(<Backfill status={status()} />);
    await screen.findByText(/Session h1:b1/);
    await userEvent.click(screen.getByRole('button', { name: 'Import selected…' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Import 3 sessions' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/scan again/);
  });

  // A4 / XSS invariant: transcript- and cc-derived strings are text, never markup.
  it('a title like <img src=x onerror=…> renders as text and creates no element', async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    stub(scanOf([row('h1:b1', { title: hostile, project: hostile, stage: hostile, bank: hostile })], { skipped: [{ key: 'b-x', handle: null, backingId: 'b-x', project: hostile, code: 'BACKFILL_UNPLACEABLE', message: hostile }] }));
    render(<Backfill status={status()} />);
    await screen.findAllByText(hostile);
    const card = document.querySelector('[data-backfill]') as HTMLElement;
    expect(card.querySelector('img, script')).toBeNull();
    expect(card.textContent).toContain(hostile);
  });
});
