import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Images } from './Images';
import { status, stubFetch } from '@/test/fixtures';

const CP_ID = `sha256:${'c'.repeat(64)}`;
describe('Images & data', () => {
  // Round 2: the import shows each loaded image's ID and standing next to the IDs the bundle's
  // manifest lists (information only).
  it('shows what an import loaded, with each image ID, its standing, and the bundle manifest IDs', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    stubFetch((url) => (url === '-/api/jobs/j9' ? { body: { id: 'j9', kind: 'import', state: 'done', error: null, tail: 'Loaded image: x', result: {
      loaded: [
        { ref: 'ghcr.io/vectorize-io/hindsight:1.2.1', id: 'sha256:aaa', status: 'pinned' },
        { ref: 'code-hindsight-cp:1.2.1', id: CP_ID, status: 'wrong-build' },
      ],
      manifest: { format: 1, images: [{ ref: 'code-hindsight-cp:1.2.1', id: CP_ID }, { ref: evil, id: 'sha256:bbb' }] },
    } } } : undefined));
    render(<Images status={status({ job: { id: 'j9', kind: 'import', state: 'running', startedAt: '', endedAt: null, result: null, error: null, progress: null, cancellable: false } })} onChanged={vi.fn()} />);
    const list = await screen.findByLabelText('Loaded images');
    expect(list.querySelector('[data-standing="wrong-build"]')?.textContent).toContain(CP_ID);
    expect(list.querySelector('[data-standing="pinned"]')).not.toBeNull();
    const manifest = screen.getByLabelText('Image IDs listed in the bundle (from its export)');
    expect(manifest.textContent).toContain(CP_ID);
    expect(manifest.textContent).toContain(evil);
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows the image IDs an export wrote into its bundle', async () => {
    stubFetch((url) => (url === '-/api/jobs/e1' ? { body: { id: 'e1', kind: 'export', state: 'done', error: null, tail: 'wrote', result: {
      name: 'code-hindsight-1.2.1-full.tar', size: 1, sha256: 'x', images: [{ ref: 'ghcr.io/vectorize-io/hindsight:1.2.1', id: 'sha256:aaa' }, { ref: 'code-hindsight-cp:1.2.1', id: CP_ID }],
    } } } : undefined));
    render(<Images status={status({ job: { id: 'e1', kind: 'export', state: 'running', startedAt: '', endedAt: null, result: null, error: null, progress: null, cancellable: false } })} onChanged={vi.fn()} />);
    const ids = await screen.findByLabelText('Image IDs in this bundle');
    expect(ids.textContent).toContain(CP_ID);
    expect(ids.textContent).toContain('sha256:aaa');
  });

  // GPU10: the GPU image row starts the build-gpu job.
  it('GPU10: the GPU image row shows its state and Build GPU image starts build-gpu', async () => {
    const calls = stubFetch((url) => (url === '-/api/jobs/build-gpu' ? { body: { id: 'g1', kind: 'build-gpu', state: 'running', tail: '' } } : undefined));
    render(<Images status={status()} onChanged={() => {}} />);
    expect(document.querySelector('[data-image="gpu"]')?.textContent).toContain('missing');
    await userEvent.click(screen.getByRole('button', { name: 'Build GPU image' }));
    const post = calls.find((c) => c.url === '-/api/jobs/build-gpu');
    expect(post?.init?.method).toBe('POST');
  });
});
