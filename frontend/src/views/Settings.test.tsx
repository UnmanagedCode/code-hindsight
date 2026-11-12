import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from './Settings';
import { settingsView, stubFetch } from '@/test/fixtures';

const putBody = (calls: { url: string; init?: RequestInit }[]) => JSON.parse(String(calls.find((c) => c.init?.method === 'PUT')!.init!.body));

describe('Settings', () => {
  // Spec 2: the slim refusal comes back by code and shows on its field.
  it('shows the slim refusals inline on their fields', async () => {
    stubFetch((url, init) => {
      if (url === '-/api/settings' && !init) return { body: settingsView() };
      if (url === '-/api/settings' && init?.method === 'PUT') {
        return { status: 400, body: { code: 'SETTINGS_INVALID', message: 'x', params: { fields: [
          { field: 'embeddings.provider', code: 'SLIM_NEEDS_REMOTE_EMBEDDINGS', message: 'the slim image needs remote embeddings' },
          { field: 'reranker.provider', code: 'SLIM_NEEDS_RERANKER', message: 'the slim image needs a reranker without a local model' },
        ] } } };
      }
      return undefined;
    });
    render(<Settings onSaved={() => {}} onApply={() => {}} busy={false} />);
    await userEvent.selectOptions(await screen.findByLabelText('Image'), 'slim');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(document.querySelector('[data-field="embeddings.provider"] [data-error-code="SLIM_NEEDS_REMOTE_EMBEDDINGS"]')).not.toBeNull());
    expect(document.querySelector('[data-field="reranker.provider"] [data-error-code="SLIM_NEEDS_RERANKER"]')).not.toBeNull();
  });

  // Decision 15: keys are write-only — never shown, sent only when typed, cleared only on request.
  it('never shows a stored key and sends one only when typed', async () => {
    const view = settingsView({ secrets: { llmApiKey: true, embeddingsApiKey: false } });
    view.settings.llm = { mode: 'manual', provider: 'openai', model: 'gpt', baseUrl: null, backendId: null };
    const calls = stubFetch((url, init) => (url === '-/api/settings' ? { body: init ? { ...view } : view } : undefined));
    const onSaved = vi.fn();
    render(<Settings onSaved={onSaved} onApply={() => {}} busy={false} />);
    const key = (await screen.findByLabelText('API key')) as HTMLInputElement;
    expect(key.value).toBe('');
    expect(key.type).toBe('password');
    expect(screen.getByText(/A key is stored/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(putBody(calls).secrets).toEqual({});

    calls.length = 0;
    await userEvent.type(screen.getByLabelText('API key'), 'sk-new');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(putBody(calls).secrets).toEqual({ llmApiKey: 'sk-new' });
  });

  // S4: the embeddings key refusal shows on the key field; a cleared key is reported.
  it('shows EMBEDDINGS_NEEDS_KEY on the key field and reports keys removed by an endpoint change', async () => {
    const view = settingsView({ secrets: { llmApiKey: true, embeddingsApiKey: false } });
    view.settings.embeddings = { provider: 'openai', model: 'e', baseUrl: null };
    let attempt = 0;
    stubFetch((url, init) => {
      if (url !== '-/api/settings') return undefined;
      if (!init) return { body: view };
      attempt++;
      if (attempt === 1) return { status: 400, body: { code: 'SETTINGS_INVALID', message: 'x', params: { fields: [{ field: 'embeddings.key', code: 'EMBEDDINGS_NEEDS_KEY', message: 'remote embeddings need their own API key' }] } } };
      return { body: { ...view, secrets: { llmApiKey: false, embeddingsApiKey: true }, cleared: ['llmApiKey'] } };
    });
    render(<Settings onSaved={() => {}} onApply={() => {}} busy={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(document.querySelector('[data-field="embeddings.key"] [data-error-code="EMBEDDINGS_NEEDS_KEY"]')).not.toBeNull());
    await userEvent.type(screen.getByLabelText('Embeddings API key'), 'ek');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Removed the stored LLM key/);
  });

  // Spec 7: the cc-backend picker lists cc's backends; loopback ones are disabled with the reason.
  it('lists cc backends and disables unusable ones', async () => {
    const view = settingsView();
    view.settings.llm = { mode: 'cc-backend', provider: null, model: null, baseUrl: null, backendId: null };
    stubFetch((url) => {
      if (url === '-/api/settings') return { body: view };
      if (url === '-/api/cc-backends') return { body: { backends: [
        { id: 'r', label: 'Remote', host: 'llm.example.com', usable: true, refusal: null, models: [{ model: 'glm', label: 'GLM' }] },
        { id: 'l', label: 'Local', host: '127.0.0.1', usable: false, refusal: 'CC_BACKEND_LOOPBACK', models: [] },
      ] } };
      return undefined;
    });
    render(<Settings onSaved={() => {}} onApply={() => {}} busy={false} />);
    const select = (await screen.findByLabelText('cc backend')) as HTMLSelectElement;
    const local = [...select.options].find((o) => o.value === 'l')!;
    expect(local.disabled).toBe(true);
    expect(local.textContent).toMatch(/loopback/);
    await userEvent.selectOptions(select, 'r');
    expect(await screen.findByRole('option', { name: 'GLM' })).toBeTruthy();
  });
});
