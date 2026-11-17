import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Memory } from './Memory';
import { stubFetch, status } from '@/test/fixtures';
import type { ActivityEntry } from '@/lib/types';

const choices = { actions: ['recall', 'retain'], kinds: ['conductor', 'worker'], placeholders: ['project', 'worktree', 'kind'], limits: { maxScopes: 50, nameMax: 60, templateMax: 100 } };

/** The four URLs Memory fetches; the activity list is read on every call, so a test can change it. */
function stub(activity: () => ActivityEntry[]) {
  return stubFetch((url) => {
    if (url === '-/api/scopes') return { body: { scopes: [], choices } };
    if (url === '-/api/memory/stages') return { body: { stages: [], error: null } };
    if (url === '-/api/memory/cc-projects') return { body: { projects: [], workspaces: [], error: null } };
    if (url === '-/api/memory/activity') return { body: { entries: activity() } };
    return undefined;
  });
}
const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({ at: '2026-11-12T20:00:00.000Z', event: 'recall', outcome: 'ok', sessionId: 's1', ...over });
const timed = entry({
  durationMs: 4200,
  banks: ['fast', 'slow'],
  timing: { totalMs: 4200, sessionMs: 120, hindsightMs: 4000, banks: [{ bank: 'fast', ms: 300 }, { bank: 'slow', ms: 4000, code: 'RECALL_FAILED' }] },
});

afterEach(() => { vi.useRealTimers(); });

describe('Memory activity durations', () => {
  it('renders an entry without a duration (an older log line) as a row with no duration control', async () => {
    stub(() => [entry({ event: 'retain' })]);
    render(<Memory status={status()} />);
    const row = (await screen.findByText('retain')).closest('tr')!;
    expect(row.querySelector('button')).toBeNull();
  });

  it('shows a timed entry\'s duration and reveals the step and per-bank breakdown only when asked', async () => {
    stub(() => [timed]);
    render(<Memory status={status()} />);
    const button = await screen.findByRole('button', { name: /4\.2 s/ });
    expect(screen.queryByText(/bank slow/)).toBeNull();
    await userEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(panel.textContent).toMatch(/bank fast/);
    expect(panel.textContent).toMatch(/bank slow.*RECALL_FAILED/);
    expect(panel.textContent).toMatch(/cc session/);
  });

  it('keeps an open breakdown with its entry when a refresh adds newer entries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let list = [timed];
    stub(() => list);
    render(<Memory status={status()} />);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(await screen.findByRole('button', { name: /4\.2 s/ }));
    const newer = entry({ at: '2026-11-12T20:05:00.000Z', event: 'retain', durationMs: 90, timing: { totalMs: 90 } });
    list = [newer, timed];
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    const fresh = await screen.findByRole('button', { name: /90 ms/ });
    expect(fresh.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: /4\.2 s/ }).getAttribute('aria-expanded')).toBe('true');
  });
});
