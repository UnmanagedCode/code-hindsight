import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Images } from './Images';
import { status, stubFetch } from '@/test/fixtures';

const CP_ID = `sha256:${'c'.repeat(64)}`;
const untrusted = () => status({
  state: 'error',
  images: {
    api: { ref: 'ghcr.io/vectorize-io/hindsight:1.2.1', present: true, ok: true },
    cp: { ref: 'code-hindsight-cp:1.2.1', present: true, ok: false, built: true, trusted: false, id: CP_ID },
  },
});

describe('Images & data', () => {
  // S2: an untrusted CP image is shown with its ID and runs only after the user confirms that ID.
  it('shows an untrusted CP image ID and confirms exactly that ID', async () => {
    const calls = stubFetch((url) => (url === '-/api/jobs/trust-cp' ? { body: { id: 'j1', kind: 'trust-cp', state: 'running' } } : url.startsWith('-/api/jobs/') ? { body: { id: 'j1', kind: 'trust-cp', state: 'done', result: null, error: null } } : undefined));
    render(<Images status={untrusted()} onChanged={vi.fn()} />);
    const card = document.querySelector<HTMLElement>('[data-card="trust-cp"]')!;
    expect(within(card).getByLabelText('Control-plane image ID').textContent).toBe(CP_ID);
    await userEvent.click(within(card).getByRole('button', { name: 'Trust this image…' }));
    expect(screen.getByRole('dialog').textContent).toContain(CP_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Trust image' }));
    await waitFor(() => expect(calls.some((c) => c.url === '-/api/jobs/trust-cp')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url === '-/api/jobs/trust-cp')!.init!.body))).toEqual({ confirm: CP_ID });
  });

  it('has no trust card for a trusted CP image', () => {
    render(<Images status={status()} onChanged={vi.fn()} />);
    expect(document.querySelector('[data-card="trust-cp"]')).toBeNull();
  });

  it('shows what an import loaded, with each image ID and whether it will run', async () => {
    stubFetch((url) => (url === '-/api/jobs/j9' ? { body: { id: 'j9', kind: 'import', state: 'done', error: null, tail: 'Loaded image: x', result: { loaded: [
      { ref: 'ghcr.io/vectorize-io/hindsight:1.2.1', id: 'sha256:aaa', status: 'pinned' },
      { ref: 'code-hindsight-cp:1.2.1', id: CP_ID, status: 'needs-confirmation' },
    ] } } } : undefined));
    render(<Images status={status({ job: { id: 'j9', kind: 'import', state: 'running', startedAt: '', endedAt: null, result: null, error: null } })} onChanged={vi.fn()} />);
    const list = await screen.findByLabelText('Loaded images');
    expect(list.querySelector('[data-standing="needs-confirmation"]')?.textContent).toContain(CP_ID);
    expect(list.querySelector('[data-standing="pinned"]')).not.toBeNull();
  });
});
