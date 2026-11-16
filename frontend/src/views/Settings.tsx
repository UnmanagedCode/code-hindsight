import { useEffect, useState } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api, ApiError, send } from '@/lib/api';
import type { CcBackend, FieldError, Settings as SettingsT, SettingsView } from '@/lib/types';

type KeyName = 'llmApiKey' | 'embeddingsApiKey';

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: FieldError; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1" data-field={id}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive" role="alert" data-error-code={error.code}>{error.message}</p>}
    </div>
  );
}

/** A write-only key: never shown, only replaced or cleared. */
function KeyField({ id, label, isSet, value, clear, onValue, onClear, error }: { id: string; label: string; isSet: boolean; value: string; clear: boolean; onValue: (v: string) => void; onClear: (c: boolean) => void; error?: FieldError }) {
  return (
    <Field id={id} label={label} error={error} hint={isSet ? 'A key is stored. Type a new one to replace it. Changing the provider or URL removes it unless you enter it again.' : 'No key stored.'}>
      <Input id={id} type="password" autoComplete="off" value={value} placeholder={isSet ? '••••••••' : ''} onChange={(e) => onValue(e.target.value)} />
      {isSet && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={clear} onChange={(e) => onClear(e.target.checked)} /> Remove the stored key
        </label>
      )}
    </Field>
  );
}

const nul = (s: string) => (s.trim() === '' ? null : s.trim());
const OTHER_MODEL = '__other__';

export function Settings({ onSaved, onApply, busy }: { onSaved: () => void; onApply: () => void; busy: boolean }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [form, setForm] = useState<SettingsT | null>(null);
  const [keys, setKeys] = useState<Record<KeyName, string>>({ llmApiKey: '', embeddingsApiKey: '' });
  const [clear, setClear] = useState<Record<KeyName, boolean>>({ llmApiKey: false, embeddingsApiKey: false });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [backends, setBackends] = useState<CcBackend[] | null>(null);
  const [backendsError, setBackendsError] = useState<string | null>(null);
  const [otherModel, setOtherModel] = useState(false);

  useEffect(() => {
    api<SettingsView>('-/api/settings').then((v) => { setView(v); setForm(v.settings); }, (e) => setMessage(String(e.message ?? e)));
  }, []);

  const mode = form?.llm.mode;
  useEffect(() => {
    if (mode !== 'cc-backend' || backends) return;
    api<{ backends: CcBackend[] }>('-/api/cc-backends').then((r) => setBackends(r.backends), (e) => setBackendsError(e instanceof ApiError ? e.message : String(e)));
  }, [mode, backends]);

  if (!view || !form) return <p className="text-sm text-muted-foreground">{message ?? 'Loading settings…'}</p>;

  const err = (field: string) => errors.find((e) => e.field === field);
  const set = <K extends keyof SettingsT>(k: K, patch: Partial<SettingsT[K]> | SettingsT[K]) =>
    setForm({ ...form, [k]: typeof patch === 'object' && patch !== null ? { ...(form[k] as object), ...patch } : patch });

  const save = async (apply: boolean) => {
    setSaving(true);
    setErrors([]);
    setMessage(null);
    const secrets: Partial<Record<KeyName, string | null>> = {};
    for (const k of ['llmApiKey', 'embeddingsApiKey'] as KeyName[]) {
      if (keys[k]) secrets[k] = keys[k];
      else if (clear[k]) secrets[k] = null;
    }
    try {
      const v = await send<SettingsView>('-/api/settings', 'PUT', { settings: form, secrets });
      setView(v);
      setForm(v.settings);
      setKeys({ llmApiKey: '', embeddingsApiKey: '' });
      setClear({ llmApiKey: false, embeddingsApiKey: false });
      const cleared = v.cleared ?? [];
      const note = cleared.length ? ` Removed the stored ${cleared.map((k) => (k === 'llmApiKey' ? 'LLM' : 'embeddings')).join(' and ')} key: its provider or URL changed.` : '';
      setMessage((apply ? 'Saved. Restarting Hindsight with the new settings…' : 'Saved. Apply & restart to use them.') + note);
      onSaved();
      if (apply) onApply();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SETTINGS_INVALID') {
        const fields = ((e.body as { params?: { fields?: FieldError[] } })?.params?.fields) ?? [];
        setErrors(fields);
        setMessage('Some settings are not valid.');
      } else {
        setMessage(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const backend = backends?.find((b) => b.id === form.llm.backendId);
  const chosen = backend?.models.find((m) => m.model === form.llm.model);
  const listed = !!chosen;
  // A free-text model id: picked through "Other…", or saved earlier and not in the list.
  const showOther = !!backend?.freeModel && backend.models.length > 0 && (otherModel || (!!form.llm.model && !listed));
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(true); }}>
      <Card>
        <CardHeader>
          <CardTitle>Image and Docker</CardTitle>
          <CardDescription>The slim image is smaller but has no local models: it needs remote embeddings and a non-local reranker.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field id="variant" label="Image" error={err('variant')}>
            <NativeSelect id="variant" value={form.variant} onChange={(e) => set('variant', e.target.value as SettingsT['variant'])}>
              {view.choices.variants.map((v) => <option key={v} value={v}>{v} — {view.images.api[v].ref}</option>)}
            </NativeSelect>
          </Field>
          <Field
            id="compute"
            label="Compute"
            error={err('compute')}
            hint={`Where the local embedding and reranker models run. GPU needs an NVIDIA GPU, its driver and the NVIDIA Container Toolkit on the Docker host, the full image, and the GPU image (${view.images.gpu}), built once on Images & data. Applying recreates the API container; memories stay.`}
          >
            <NativeSelect id="compute" value={form.compute} onChange={(e) => set('compute', e.target.value as SettingsT['compute'])}>
              {view.choices.computeModes.map((m) => <option key={m} value={m}>{m === 'gpu' ? 'GPU (NVIDIA)' : 'CPU'}</option>)}
            </NativeSelect>
          </Field>
          <label className="flex items-center gap-2 text-sm" data-field="docker.allowSudo">
            <input type="checkbox" checked={form.docker.allowSudo} onChange={(e) => set('docker', { allowSudo: e.target.checked })} />
            Use <code>sudo -n docker</code> when docker is refused (sudo docker is root on the host)
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Network</CardTitle>
          <CardDescription>The API and control-plane ports are published on one host address and both need a key. With an Ollama or loopback backend, the relay port is published there too and also needs a key.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <Field id="network.bindAddress" label="Bind address" error={err('network.bindAddress')} hint={`Empty = automatic (${view.detectedBindAddress})`}>
            <Input id="network.bindAddress" value={form.network.bindAddress ?? ''} placeholder={view.detectedBindAddress} onChange={(e) => set('network', { bindAddress: nul(e.target.value) })} />
          </Field>
          <Field id="network.apiPort" label="API port" error={err('network.apiPort')}>
            <Input id="network.apiPort" type="number" value={form.network.apiPort} onChange={(e) => set('network', { apiPort: Number(e.target.value) })} />
          </Field>
          <Field id="network.cpPort" label="Control-plane port" error={err('network.cpPort')}>
            <Input id="network.cpPort" type="number" value={form.network.cpPort} onChange={(e) => set('network', { cpPort: Number(e.target.value) })} />
          </Field>
          <Field id="network.relayPort" label="Relay port" error={err('network.relayPort')} hint="Used only with an Ollama or loopback backend">
            <Input id="network.relayPort" type="number" value={form.network.relayPort} onChange={(e) => set('network', { relayPort: Number(e.target.value) })} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>LLM</CardTitle>
          <CardDescription>Without an LLM, Hindsight stores memories as chunks and cannot reflect.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field id="llm.mode" label="Mode" error={err('llm.mode')}>
            <NativeSelect id="llm.mode" value={form.llm.mode} onChange={(e) => set('llm', { mode: e.target.value as SettingsT['llm']['mode'] })}>
              <option value="none">None</option>
              <option value="manual">Manual</option>
              <option value="cc-backend">Linked to a cc backend</option>
            </NativeSelect>
          </Field>
          {form.llm.mode === 'manual' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="llm.provider" label="Provider" error={err('llm.provider')} hint="A Hindsight provider name, e.g. openai, anthropic, ollama">
                <Input id="llm.provider" value={form.llm.provider ?? ''} onChange={(e) => set('llm', { provider: nul(e.target.value) })} />
              </Field>
              <Field id="llm.model" label="Model" error={err('llm.model')}>
                <Input id="llm.model" value={form.llm.model ?? ''} onChange={(e) => set('llm', { model: nul(e.target.value) })} />
              </Field>
              <Field id="llm.baseUrl" label="Base URL" error={err('llm.baseUrl')} hint="Optional">
                <Input id="llm.baseUrl" value={form.llm.baseUrl ?? ''} onChange={(e) => set('llm', { baseUrl: nul(e.target.value) })} />
              </Field>
              <KeyField id="llm.key" label="API key" error={err('llm.key')} isSet={view.secrets.llmApiKey} value={keys.llmApiKey} clear={clear.llmApiKey}
                onValue={(v) => setKeys({ ...keys, llmApiKey: v })} onClear={(c) => setClear({ ...clear, llmApiKey: c })} />
            </div>
          )}
          {form.llm.mode === 'cc-backend' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="llm.backendId" label="cc backend" error={err('llm.backendId')} hint="Its URL and token are read from cc each time the container is created; they are not stored here.">
                {backendsError ? <p className="text-sm text-destructive">{backendsError}</p> : !backends ? <LoaderCircleIcon className="size-4 animate-spin" /> : (
                  <NativeSelect id="llm.backendId" value={form.llm.backendId ?? ''} onChange={(e) => { setOtherModel(false); set('llm', { backendId: nul(e.target.value), model: null }); }}>
                    <option value="">Choose…</option>
                    {backends.map((b) => (
                      <option key={b.id} value={b.id} disabled={!b.usable}>
                        {b.label}{b.kind === 'ollama' ? ' (cc\'s Ollama daemon, via relay)' : b.loopback ? ` (${b.host}${b.usable ? ', via relay' : ''})` : b.host ? ` (${b.host})` : ''}{b.usable ? '' : b.refusal === 'CC_BACKEND_LOOPBACK' ? ' — loopback over https, not relayed' : ' — no Anthropic URL and token'}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field id="llm.model" label="Model" error={err('llm.model')}>
                {backend && backend.models.length > 0 ? (
                  <NativeSelect id="llm.model" value={showOther ? OTHER_MODEL : form.llm.model ?? ''} onChange={(e) => {
                    const other = e.target.value === OTHER_MODEL;
                    setOtherModel(other);
                    set('llm', { model: other ? (listed ? null : form.llm.model) : nul(e.target.value) });
                  }}>
                    <option value="">Choose…</option>
                    {backend.kind === 'ollama' ? (
                      (['cc', 'daemon'] as const).map((source) => {
                        const group = backend.models.filter((m) => m.source === source);
                        return group.length > 0 && (
                          <optgroup key={source} label={source === 'cc' ? 'Configured in cc' : 'Other models on the daemon'}>
                            {group.map((m) => <option key={m.model} value={m.model}>{m.label}{m.label === m.model ? '' : ` — ${m.model}`} ({m.cloud ? 'cloud' : 'local'})</option>)}
                          </optgroup>
                        );
                      })
                    ) : backend.models.map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}
                    {backend.freeModel && <option value={OTHER_MODEL}>Other… (type a model id)</option>}
                  </NativeSelect>
                ) : (
                  <Input id="llm.model" value={form.llm.model ?? ''} onChange={(e) => set('llm', { model: nul(e.target.value) })} />
                )}
              </Field>
              {showOther && (
                <Field id="llm.modelOther" label="Model id" hint="Sent to the backend as written">
                  <Input id="llm.modelOther" value={form.llm.model ?? ''} onChange={(e) => set('llm', { model: nul(e.target.value) })} />
                </Field>
              )}
              {backend?.loopback && backend.usable && (
                <p className="text-xs text-destructive sm:col-span-2" role="alert" data-hint="loopback-route">
                  This backend is a local endpoint in cc's container ({backend.host}). Retained, imported and recall text goes wherever it routes it, possibly a cloud provider under its own account.
                </p>
              )}
              {backend?.kind === 'ollama' && (
                <div className="space-y-1 text-xs sm:col-span-2" data-hint="ollama">
                  {backend.daemon && !backend.daemon.reachable && (
                    <p className="text-destructive" data-hint="ollama-unreachable">The Ollama daemon did not answer ({backend.daemon.error}). It runs in cc's container; models are listed from cc only, and all count as cloud.</p>
                  )}
                  {form.llm.model && (!chosen || chosen.cloud) && (
                    <p className="text-destructive" role="alert" data-hint="ollama-cloud">Retained, imported and recall text is sent through cc's Ollama daemon to ollama.com under its signed-in account.</p>
                  )}
                  {chosen && !chosen.cloud && (
                    <p className="text-muted-foreground" data-hint="ollama-local">A local model: Hindsight recommends Max parallel LLM requests = 1 for Ollama.</p>
                  )}
                </div>
              )}
            </div>
          )}
          {form.llm.mode !== 'none' && (
            <Field id="llm.maxConcurrent" label="Max parallel LLM requests" error={err('llm.maxConcurrent')} hint={`Empty = Hindsight's default (32); 1 to ${view.choices.llmMaxConcurrentMax}`}>
              <Input id="llm.maxConcurrent" type="number" min={1} max={view.choices.llmMaxConcurrentMax} value={form.llm.maxConcurrent ?? ''}
                onChange={(e) => set('llm', { maxConcurrent: e.target.value.trim() === '' ? null : Number(e.target.value) })} />
            </Field>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Embeddings and reranker</CardTitle>
          <CardDescription>Changing embeddings on existing memories is refused: delete the data volume first (Images &amp; data).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field id="embeddings.provider" label="Embeddings" error={err('embeddings.provider')}>
            <NativeSelect id="embeddings.provider" value={form.embeddings.provider} onChange={(e) => set('embeddings', { provider: e.target.value })}>
              {view.choices.embeddingsProviders.map((p) => <option key={p} value={p}>{p === 'local' ? 'local (full image only)' : `${p} (remote)`}</option>)}
            </NativeSelect>
          </Field>
          <Field id="reranker.provider" label="Reranker" error={err('reranker.provider')}>
            <NativeSelect id="reranker.provider" value={form.reranker.provider} onChange={(e) => set('reranker', { provider: e.target.value })}>
              {view.choices.rerankerProviders.map((p) => <option key={p} value={p}>{p === 'local' ? 'local (full image only)' : p === 'rrf' ? 'rrf (no model)' : p}</option>)}
            </NativeSelect>
          </Field>
          {form.embeddings.provider !== 'local' && (
            <>
              <Field id="embeddings.model" label="Embeddings model" error={err('embeddings.model')}>
                <Input id="embeddings.model" value={form.embeddings.model ?? ''} onChange={(e) => set('embeddings', { model: nul(e.target.value) })} />
              </Field>
              <Field id="embeddings.baseUrl" label="Embeddings base URL" error={err('embeddings.baseUrl')} hint="Optional">
                <Input id="embeddings.baseUrl" value={form.embeddings.baseUrl ?? ''} onChange={(e) => set('embeddings', { baseUrl: nul(e.target.value) })} />
              </Field>
              <KeyField id="embeddings.key" label="Embeddings API key" error={err('embeddings.key')} isSet={view.secrets.embeddingsApiKey} value={keys.embeddingsApiKey} clear={clear.embeddingsApiKey}
                onValue={(v) => setKeys({ ...keys, embeddingsApiKey: v })} onClear={(c) => setClear({ ...clear, embeddingsApiKey: c })} />
            </>
          )}
        </CardContent>
      </Card>

      {message && <p className="text-sm" role="status">{message}</p>}
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={saving || busy} onClick={() => void save(false)}>Save</Button>
        <Button type="submit" disabled={saving || busy}>{saving && <LoaderCircleIcon className="animate-spin" />}Apply &amp; restart</Button>
      </div>
    </form>
  );
}
