import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { catalogError, status, stubFetch } from '@/test/fixtures';

const at = (search: string) => history.replaceState(null, '', `/plugins/code-hindsight/${search}`);

describe('App shell', () => {
  it('has the plugin heading and a status pill', async () => {
    at('');
    stubFetch((url) => (url.startsWith('-/api/status') ? { body: status() } : undefined));
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Code Hindsight' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-pill="ready"]')?.textContent).toMatch(/sudo docker/));
  });

  // Spec 6: when ready, the control plane opens in the nested frame, at the deep-linked path if any.
  it('shows the CP frame when ready, at its dashboard or the deep-linked path', async () => {
    at('');
    stubFetch((url) => (url.startsWith('-/api/status') ? { body: status() } : undefined));
    const { unmount } = render(<App />);
    await waitFor(() => expect(document.querySelector('iframe[data-cp-frame]')?.getAttribute('src')).toBe('dashboard'));
    unmount();
    at('?view=cp&cp=%2Fbanks%2Fgate-bank');
    render(<App />);
    await waitFor(() => expect(document.querySelector('iframe[data-cp-frame]')?.getAttribute('src')).toBe('./banks/gate-bank'));
  });

  it('never frames a CP path that leaves the mount', async () => {
    at('?view=cp&cp=%2F%2Fevil.example%2Fx');
    stubFetch((url) => (url.startsWith('-/api/status') ? { body: status() } : undefined));
    render(<App />);
    await waitFor(() => expect(document.querySelector('iframe[data-cp-frame]')?.getAttribute('src')).toBe('dashboard'));
  });

  it('opens on Status with the error card when Hindsight is not running; its action calls the backend', async () => {
    at('');
    const calls = stubFetch((url) => {
      if (url.startsWith('-/api/status')) return { body: status({ state: 'error', error: catalogError('IMAGE_MISSING', 'pull'), variant: 'slim' }) };
      if (url === '-/api/jobs/pull') return { body: { id: 'j1', kind: 'pull', state: 'running' } };
      return undefined;
    });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Pull image' }));
    const post = calls.find((c) => c.url === '-/api/jobs/pull')!;
    expect(post.init?.method).toBe('POST');
    expect(JSON.parse(String(post.init?.body))).toEqual({ variant: 'slim' });
    expect(document.querySelector('iframe')).toBeNull();
    for (const c of calls) expect(c.url.startsWith('/')).toBe(false);
  });

  it('switches views through the query string', async () => {
    at('');
    stubFetch((url) => (url.startsWith('-/api/status') ? { body: status() } : url === '-/api/settings' ? { body: { settings: null } } : undefined));
    render(<App />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Status' }));
    expect(location.search).toBe('?view=status');
    expect(screen.getByRole('tab', { name: 'Status' }).getAttribute('aria-selected')).toBe('true');
  });
});
