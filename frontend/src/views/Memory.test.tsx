import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Memory } from './Memory';
import { stubFetch, status } from '@/test/fixtures';
import type { ActivityEntry, CcProjectsView, Scope } from '@/lib/types';

const choices = { actions: ['recall', 'retain'], kinds: ['conductor', 'worker'], placeholders: ['project', 'worktree', 'kind'], limits: { maxScopes: 50, nameMax: 60, templateMax: 100 } };
const scope = (name: string, over: Partial<Scope> = {}): Scope => ({ name, match: {}, bank: 'cc-{project}', actions: ['recall', 'retain'], ...over });

const ccLists: CcProjectsView = {
  projects: [{ name: 'code-hindsight', workspace: 'CC-Dev' }, { name: 'code-wiki', workspace: 'CC-Dev' }, { name: 'notes', workspace: null }],
  workspaces: [{ name: 'CC-Dev', projectCount: 2 }, { name: 'HOME', projectCount: 0 }],
  error: null,
};

function stub({ scopes = [] as Scope[], stages = { stages: [{ name: 'plan', playbooks: ['solo'] }, { name: 'implement', playbooks: ['relay'] }], error: null as string | null }, ccProjects = ccLists as CcProjectsView | null, activity = [] as ActivityEntry[], put }: { scopes?: Scope[]; stages?: { stages: { name: string; playbooks: string[] }[]; error: string | null }; ccProjects?: CcProjectsView | null; activity?: ActivityEntry[]; put?: (body: { scopes: Scope[] }) => { status?: number; body: unknown } } = {}) {
  return stubFetch((url, init) => {
    if (url === '-/api/scopes' && !init) return { body: { scopes, choices } };
    if (url === '-/api/scopes' && init?.method === 'PUT') return put ? put(JSON.parse(String(init.body))) : { body: { scopes: JSON.parse(String(init.body)).scopes } };
    if (url === '-/api/memory/stages') return { body: stages };
    if (url === '-/api/memory/cc-projects') return ccProjects ? { body: ccProjects } : { status: 502, body: { code: 'INTERNAL', message: 'down' } };
    if (url === '-/api/memory/activity') return { body: { entries: activity } };
    if (url === '-/api/memory/preview-bank') return { body: { bank: 'cc-example' } };
    return undefined;
  });
}
const putBody = (calls: { url: string; init?: RequestInit }[]) => JSON.parse(String(calls.find((c) => c.init?.method === 'PUT')!.init!.body)) as { scopes: Scope[] };

describe('Memory', () => {
  it('says memory is off when there are no scopes', async () => {
    stub();
    render(<Memory status={status()} />);
    expect((await screen.findByText(/Memory is off/)).textContent).toMatch(/every session is memoryless/);
  });

  it('warns when Hindsight is not ready and when the LLM mode is none', async () => {
    stub();
    render(<Memory status={status({ state: 'stopped', llmMode: 'none' })} />);
    expect(await screen.findByText(/Hindsight is stopped: sessions are memoryless/)).toBeTruthy();
    expect(screen.getByText(/without fact extraction/)).toBeTruthy();
  });

  it('saves the scopes in their new order after a reorder, and the saved list replaces the form', async () => {
    const calls = stub({ scopes: [scope('alpha'), scope('beta')] });
    render(<Memory status={status()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move alpha down' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes.map((s) => s.name)).toEqual(['beta', 'alpha']);
    expect((await screen.findByRole('status')).textContent).toMatch(/Saved/);
  });

  it('sends an omitted match key for "any" and a list only for what was narrowed', async () => {
    const calls = stub({ scopes: [scope('a')] });
    render(<Memory status={status()} />);
    await userEvent.type(await screen.findByLabelText(/Projects/), 'code-*{Enter}proj');
    await userEvent.click(screen.getByLabelText('conductor'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes[0].match).toEqual({ projects: ['code-*', 'proj'], sessions: ['worker'] });
    expect(putBody(calls).scopes[0].match).not.toHaveProperty('stages');
  });

  it('adds a scope that matches anything until narrowed, and deletes one', async () => {
    const calls = stub({ scopes: [scope('old')] });
    render(<Memory status={status()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add scope' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete old' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes).toEqual([{ name: 'scope 2', match: {}, bank: 'cc-{project}', actions: ['recall', 'retain'] }]);
  });

  it('shows SCOPES_INVALID errors against the field they name', async () => {
    stub({
      scopes: [scope('a'), scope('b')],
      put: () => ({ status: 400, body: { code: 'SCOPES_INVALID', message: 'x', params: { fields: [
        { field: 'scopes[1].bank', message: 'unknown placeholder' },
        { field: 'scopes[0].match.projects', message: 'must be a non-empty list' },
      ] } } }),
    });
    render(<Memory status={status()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(document.querySelector('[data-field-error="scopes[1].bank"]')).not.toBeNull());
    expect(within(document.querySelector('[data-scope="1"]') as HTMLElement).getByText('unknown placeholder')).toBeTruthy();
    expect(within(document.querySelector('[data-scope="0"]') as HTMLElement).getByText('must be a non-empty list')).toBeTruthy();
  });

  it('warns about a stage cc does not know but still saves it', async () => {
    const calls = stub({ scopes: [scope('a', { match: { stages: ['plan', 'bogus'] } })] });
    render(<Memory status={status()} />);
    await screen.findByText('bogus');
    expect(document.querySelector('[data-stage="bogus"]')!.textContent).toMatch(/unknown to cc/);
    expect(document.querySelector('[data-stage="plan"]')!.textContent).not.toMatch(/unknown to cc/);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes[0].match.stages).toEqual(['plan', 'bogus']);
  });

  it('says when cc\'s stage names could not be read, and flags nothing as unknown', async () => {
    stub({ scopes: [scope('a', { match: { stages: ['whatever'] } })], stages: { stages: [], error: 'cc is down' } });
    render(<Memory status={status()} />);
    expect(await screen.findByText(/stage names could not be read/)).toBeTruthy();
    expect(document.querySelector('[data-stage="whatever"]')!.textContent).not.toMatch(/unknown to cc/);
  });

  it('renders a hostile activity string as text, creating no element', async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    stub({ activity: [{ at: '2026-11-13T07:00:00.000Z', event: 'retain', outcome: 'error', sessionId: 's1', project: hostile, stage: 'plan', banks: ['b'], code: 'RETAIN_FAILED', message: hostile }] });
    render(<Memory status={status()} />);
    const row = await waitFor(() => { const r = document.querySelector('tr[data-outcome="error"]'); if (!r) throw new Error('no row'); return r; });
    expect(row.querySelector('img, script')).toBeNull();
    expect(row.textContent).toContain(hostile);
    expect(row.textContent).toContain('RETAIN_FAILED');
  });

  it('never lets both session kinds be cleared, and says what the ticks mean', async () => {
    const calls = stub({ scopes: [scope('a')] });
    render(<Memory status={status()} />);
    const conductor = (await screen.findByLabelText('conductor')) as HTMLInputElement;
    const worker = screen.getByLabelText('worker') as HTMLInputElement;
    expect(screen.getByText(/Both ticked: any session/)).toBeTruthy();
    await userEvent.click(conductor);
    expect(worker.disabled).toBe(true);
    expect(screen.getByText(/Only these sessions/)).toBeTruthy();
    await userEvent.click(worker);
    expect(worker.checked).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes[0].match.sessions).toEqual(['worker']);
  });

  it('adds a picked cc project as its exact name on a new line, keeps typed globs, and never adds it twice', async () => {
    const calls = stub({ scopes: [scope('a')] });
    render(<Memory status={status()} />);
    await userEvent.type(await screen.findByLabelText(/Projects/), 'code-*');
    await userEvent.click(screen.getByRole('button', { name: 'Pick projects from cc' }));
    await userEvent.type(screen.getByLabelText('Search cc projects'), 'hind');
    expect(screen.queryByRole('button', { name: 'Add project code-wiki' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add project code-hindsight' }));
    expect((screen.getByRole('button', { name: 'Add project code-hindsight' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(screen.getByLabelText('Search cc projects'));
    await userEvent.type(screen.getByLabelText('Search cc projects'), 'no workspace');
    expect(screen.getByRole('button', { name: 'Add project notes' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes[0].match.projects).toEqual(['code-*', 'code-hindsight']);
  });

  it('saves a workspace picked from cc and a typed workspace glob; a scope with none sends no workspaces key', async () => {
    const calls = stub({ scopes: [scope('a'), scope('b')] });
    render(<Memory status={status()} />);
    const first = within(await waitFor(() => { const el = document.querySelector('[data-scope="0"]'); if (!el) throw new Error('no scope'); return el as HTMLElement; }));
    await userEvent.click(first.getByRole('button', { name: 'Pick workspaces from cc' }));
    expect(first.getByRole('button', { name: 'Add workspace HOME' })).toBeTruthy();
    await userEvent.click(first.getByRole('button', { name: 'Add workspace CC-Dev' }));
    await userEvent.type(first.getByLabelText(/Workspaces/), 'TT*{Enter}');
    expect(document.querySelector('[data-workspace="TT*"]')!.textContent).not.toMatch(/unknown to cc/);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    const [a, b] = putBody(calls).scopes;
    expect(a.match.workspaces).toEqual(['CC-Dev', 'TT*']);
    expect(b.match).not.toHaveProperty('workspaces');
  });

  it('flags a literal workspace cc does not list, and shows a workspaces refusal against its field', async () => {
    stub({
      scopes: [scope('a', { match: { workspaces: ['Gone'] } })],
      put: () => ({ status: 400, body: { code: 'SCOPES_INVALID', message: 'x', params: { fields: [{ field: 'scopes[0].match.workspaces', message: '"a/b" is not a glob' }] } } }),
    });
    render(<Memory status={status()} />);
    await waitFor(() => expect(document.querySelector('[data-workspace="Gone"]')?.textContent).toMatch(/unknown to cc/));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await waitFor(() => { const el = document.querySelector('[data-field-error="scopes[0].match.workspaces"]'); if (!el) throw new Error('no alert'); return el; });
    expect(alert.getAttribute('role')).toBe('alert');
  });

  it('without cc\'s lists there are no pickers, typed projects and workspaces still save', async () => {
    const calls = stub({ scopes: [scope('a')], ccProjects: null });
    render(<Memory status={status()} />);
    expect(await screen.findByText(/project and workspace lists could not be read/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /from cc/ })).toBeNull();
    await userEvent.type(screen.getByLabelText(/Projects/), 'proj');
    await userEvent.type(screen.getByLabelText(/Workspaces/), 'CC-Dev{Enter}');
    expect(document.querySelector('[data-workspace="CC-Dev"]')!.textContent).not.toMatch(/unknown to cc/);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes[0].match).toEqual({ projects: ['proj'], workspaces: ['CC-Dev'] });
  });

  it('renders hostile cc project and workspace names as text, creating no element', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    stub({ scopes: [scope('a')], ccProjects: { projects: [{ name: hostile, workspace: hostile }], workspaces: [{ name: hostile, projectCount: 1 }], error: null } });
    render(<Memory status={status()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Pick projects from cc' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pick workspaces from cc' }));
    expect(screen.getByRole('button', { name: `Add project ${hostile}` }).textContent).toContain(hostile);
    expect(screen.getByRole('button', { name: `Add workspace ${hostile}` }).textContent).toContain(hostile);
    expect(document.querySelector('img')).toBeNull();
  });
});
