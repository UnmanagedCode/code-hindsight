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
/** Open a saved scope's card (they load collapsed) and return its element. */
async function expand(name: string): Promise<HTMLElement> {
  const toggle = await screen.findByRole('button', { name: new RegExp(`^${name}`) });
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
  return toggle.closest('[data-scope]') as HTMLElement;
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
    await expand('a');
    await userEvent.type(await screen.findByLabelText(/Projects/), 'code-*{Enter}proj{Enter}');
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
    expect(screen.getByRole('button', { name: /^scope 2/ }).getAttribute('aria-expanded')).toBe('true');
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
    for (const n of ['a', 'b']) expect(screen.getByRole('button', { name: new RegExp(`^${n}`) }).getAttribute('aria-expanded')).toBe('true');
    expect(within(document.querySelector('[data-scope="1"]') as HTMLElement).getByText('unknown placeholder')).toBeTruthy();
    expect(within(document.querySelector('[data-scope="0"]') as HTMLElement).getByText('must be a non-empty list')).toBeTruthy();
  });

  it('warns about a stage cc does not know but still saves it', async () => {
    const calls = stub({ scopes: [scope('a', { match: { stages: ['plan', 'bogus'] } })] });
    render(<Memory status={status()} />);
    await expand('a');
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
    await expand('a');
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
    await expand('a');
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

  // spec 2/3: one autocomplete list input serves Projects, Workspaces and Stages; the pickers are gone.
  it('Projects, Workspaces and Stages each use the same combobox and Add button, with no "from cc" pickers', async () => {
    stub({ scopes: [scope('a')] });
    render(<Memory status={status()} />);
    const card = within(await expand('a'));
    for (const noun of ['project', 'workspace', 'stage']) expect(card.getByRole('button', { name: `Add ${noun}` })).toBeTruthy();
    expect(card.getAllByRole('combobox')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /from cc/ })).toBeNull();
    expect(document.querySelector('textarea, datalist')).toBeNull();
  });

  // spec 2: a typed glob and a suggestion both land in the saved list.
  it('saves a typed project glob together with a picked cc project, never twice', async () => {
    const calls = stub({ scopes: [scope('a')] });
    render(<Memory status={status()} />);
    await expand('a');
    const projects = screen.getByLabelText(/Projects/);
    await userEvent.type(projects, 'code-*{Enter}hind');
    await userEvent.click(screen.getByRole('option', { name: /code-hindsight/ }));
    await userEvent.type(projects, 'code-hind');
    expect(screen.queryByRole('option', { name: /code-hindsight/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes[0].match.projects).toEqual(['code-*', 'code-hindsight', 'code-hind']);
  });

  // spec 2, cost: suggestions come from the page's one mount-time read.
  it('typing in several Projects inputs makes exactly one cc-projects request', async () => {
    const calls = stub({ scopes: [scope('a'), scope('b')] });
    render(<Memory status={status()} />);
    for (const n of ['a', 'b']) {
      const card = within(await expand(n));
      await userEvent.type(card.getByLabelText(/Projects/), 'code');
    }
    expect(calls.filter((c) => c.url === '-/api/memory/cc-projects')).toHaveLength(1);
  });

  // compat: the stored format is unchanged.
  it('round-trips saved match.projects unchanged', async () => {
    const calls = stub({ scopes: [scope('a', { match: { projects: ['a', 'b*'] } })] });
    render(<Memory status={status()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes[0].match.projects).toEqual(['a', 'b*']);
  });

  // spec 1
  it('loads saved scopes collapsed with a summary of what they narrow, and expands on demand', async () => {
    stub({ scopes: [scope('narrow', { match: { projects: ['a', 'b', 'c', 'd', 'e'], workspaces: ['CC-Dev'], sessions: ['worker'] } }), scope('open-ended')] });
    render(<Memory status={status()} />);
    const toggle = await screen.findByRole('button', { name: /^narrow/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toMatch(/projects a, b \+3/);
    expect(toggle.textContent).toMatch(/workspaces CC-Dev/);
    expect(toggle.textContent).toMatch(/worker only/);
    expect(toggle.textContent).not.toMatch(/stages/);
    expect(screen.getByRole('button', { name: /^open-ended/ }).textContent).toMatch(/any session/);
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)!.hidden).toBe(true);
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)!.hidden).toBe(false);
  });

  // cc's list_projects never lists the conductor's project, which scopes legitimately name.
  it('never flags .conduct as unknown to cc, and offers it as a project suggestion', async () => {
    stub({ scopes: [scope('a', { match: { projects: ['.conduct', 'gone'] } }), scope('b')] });
    render(<Memory status={status()} />);
    await expand('a');
    await waitFor(() => expect(document.querySelector('[data-project="gone"]')?.textContent).toMatch(/unknown to cc/));
    expect(document.querySelector('[data-project=".conduct"]')!.textContent).not.toMatch(/unknown to cc/);
    await userEvent.type(within(await expand('b')).getByLabelText(/Projects/), '.con');
    expect(screen.getByRole('option').textContent).toMatch(/^\.conduct/);
  });

  // spec 1
  it('moves and deletes a scope while it is collapsed', async () => {
    const calls = stub({ scopes: [scope('alpha'), scope('beta')] });
    render(<Memory status={status()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move beta up' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete alpha' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes.map((x) => x.name)).toEqual(['beta']);
  });

  // spec 1: a hidden error is never silent.
  it('opens the collapsed scope a refusal names, marks it invalid, and shows the error', async () => {
    stub({
      scopes: [scope('a'), scope('b')],
      put: () => ({ status: 400, body: { code: 'SCOPES_INVALID', message: 'x', params: { fields: [{ field: 'scopes[1].bank', message: 'unknown placeholder' }] } } }),
    });
    render(<Memory status={status()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    const b = await screen.findByRole('button', { name: /^b/ });
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(b.textContent).toMatch(/invalid/);
    expect(screen.getByRole('button', { name: /^a/ }).getAttribute('aria-expanded')).toBe('false');
    expect((await screen.findByText('unknown placeholder')).closest('[hidden]')).toBeNull();
  });

  // spec 1
  it('keeps each card open or collapsed across Save', async () => {
    stub({ scopes: [scope('a'), scope('b')] });
    render(<Memory status={status()} />);
    await expand('a');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('status');
    expect(screen.getByRole('button', { name: /^a/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /^b/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('saves a workspace picked from cc and a typed workspace glob; a scope with none sends no workspaces key', async () => {
    const calls = stub({ scopes: [scope('a'), scope('b')] });
    render(<Memory status={status()} />);
    const first = within(await expand('a'));
    await userEvent.click(first.getByLabelText(/Workspaces/));
    expect(first.getByRole('option', { name: /HOME/ })).toBeTruthy();
    await userEvent.click(first.getByRole('option', { name: /CC-Dev/ }));
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
    await expand('a');
    await waitFor(() => expect(document.querySelector('[data-workspace="Gone"]')?.textContent).toMatch(/unknown to cc/));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await expand('a');
    const alert = await waitFor(() => { const el = document.querySelector('[data-field-error="scopes[0].match.workspaces"]'); if (!el) throw new Error('no alert'); return el; });
    expect(alert.getAttribute('role')).toBe('alert');
  });

  it('without cc\'s lists there are no suggestions, typed projects and workspaces still save', async () => {
    const calls = stub({ scopes: [scope('a')], ccProjects: null });
    render(<Memory status={status()} />);
    await expand('a');
    expect(await screen.findByText(/project and workspace lists could not be read/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Projects/), 'proj{Enter}');
    expect(screen.queryByRole('listbox')).toBeNull();
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
    const card = within(await expand('a'));
    await userEvent.click(card.getByLabelText(/Projects/));
    expect(card.getAllByRole('option').map((o) => o.textContent)).toContain(hostile + hostile);
    await userEvent.click(card.getByLabelText(/Workspaces/));
    expect(card.getByRole('option').textContent).toBe(hostile + '1 projects');
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('Memory scope switch', () => {
  const sw = (name: string) => screen.findByRole('switch', { name: `${name} enabled` });

  it('loads a disabled scope with its switch off and marked disabled', async () => {
    stub({ scopes: [scope('alpha', { enabled: false }), scope('beta')] });
    render(<Memory status={status()} />);
    expect((await sw('alpha')).getAttribute('aria-checked')).toBe('false');
    expect((await sw('beta')).getAttribute('aria-checked')).toBe('true');
    const card = (await sw('alpha')).closest('[data-scope]') as HTMLElement;
    expect(within(card).getByText('disabled')).toBeTruthy();
    expect(within((await sw('beta')).closest('[data-scope]') as HTMLElement).queryByText('disabled')).toBeNull();
  });

  it('one click on a clean editor saves at once, with only that scope flipped and no confirm', async () => {
    const calls = stub({ scopes: [scope('alpha'), scope('beta')] });
    render(<Memory status={status()} />);
    await userEvent.click(await sw('alpha'));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).scopes.map((s) => s.enabled)).toEqual([false, undefined]);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'alpha enabled' }).getAttribute('aria-checked')).toBe('false'));
    expect((await screen.findByRole('status')).textContent).toMatch(/"alpha" disabled/);
  });

  it('enabling a disabled scope sends no enabled key', async () => {
    const calls = stub({ scopes: [scope('alpha', { enabled: false })] });
    render(<Memory status={status()} />);
    await userEvent.click(await sw('alpha'));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect('enabled' in putBody(calls).scopes[0]).toBe(false);
  });

  it('with other unsaved edits the toggle asks first: Cancel saves nothing and keeps the flag; Save all saves the edits and the flip', async () => {
    const calls = stub({ scopes: [scope('alpha'), scope('beta')] });
    render(<Memory status={status()} />);
    const card = await expand('beta');
    await userEvent.clear(within(card).getByLabelText('Bank template'));
    await userEvent.type(within(card).getByLabelText('Bank template'), 'edited');
    await userEvent.click(await sw('alpha'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.init?.method === 'PUT')).toBe(false);
    expect((await sw('alpha')).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(await sw('alpha'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save all' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    const sent = putBody(calls).scopes;
    expect([sent[0].enabled, sent[1].bank]).toEqual([false, 'edited']);
  });

  it('a refused toggle keeps the scope\'s previous state and shows the field error on its card', async () => {
    stub({
      scopes: [scope('alpha')],
      put: () => ({ status: 400, body: { code: 'SCOPES_INVALID', message: 'bad', params: { fields: [{ field: 'scopes[0].bank', message: 'refused here' }] } } }),
    });
    render(<Memory status={status()} />);
    await userEvent.click(await sw('alpha'));
    await waitFor(() => expect(screen.getByText('refused here')).toBeTruthy());
    expect((await sw('alpha')).getAttribute('aria-checked')).toBe('true');
    expect((await screen.findByRole('status')).textContent).toMatch(/not switched/);
  });

  it('says memory is off when every scope is disabled', async () => {
    stub({ scopes: [scope('alpha', { enabled: false }), scope('beta', { enabled: false })] });
    render(<Memory status={status()} />);
    expect((await screen.findByText(/Memory is off/)).textContent).toMatch(/every scope is disabled/);
  });
});
