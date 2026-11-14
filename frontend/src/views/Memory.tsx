import { useCallback, useEffect, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CcPicker } from '@/components/CcPicker';
import { Backfill } from '@/views/Backfill';
import { api, ApiError, send } from '@/lib/api';
import type { ActivityEntry, CcProjectsView, FieldError, Scope, ScopesView, StagesView, Status } from '@/lib/types';

const ACTIVITY_POLL_MS = 5000;
const PREVIEW_DELAY_MS = 250;
const KINDS = ['conductor', 'worker'] as const;
const ACTIONS = ['recall', 'retain'] as const;

/** A scope as edited: lists the user types are plain text until saved. */
interface ScopeForm {
  key: number;
  name: string;
  projects: string;
  workspaces: string[];
  sessions: Record<(typeof KINDS)[number], boolean>;
  stages: string[];
  bank: string;
  actions: Record<(typeof ACTIONS)[number], boolean>;
}

let nextKey = 1;

function toForm(s: Scope): ScopeForm {
  const kinds = s.match.sessions;
  return {
    key: nextKey++,
    name: s.name,
    projects: (s.match.projects ?? []).join('\n'),
    workspaces: s.match.workspaces ?? [],
    sessions: { conductor: !kinds || kinds.includes('conductor'), worker: !kinds || kinds.includes('worker') },
    stages: s.match.stages ?? [],
    bank: s.bank,
    actions: { recall: s.actions.includes('recall'), retain: s.actions.includes('retain') },
  };
}

/** The project lines with `name` appended as a new line, unless it is already one; typed lines are kept. */
function addProjectLine(text: string, name: string): string {
  if (text.split('\n').some((l) => l.trim() === name)) return text;
  const kept = text.replace(/\s+$/, '');
  return kept ? `${kept}\n${name}` : name;
}

/** Both kinds ticked means "any": the key is omitted, never sent as an empty list. */
function toScope(f: ScopeForm): Scope {
  const match: Scope['match'] = {};
  const projects = f.projects.split('\n').map((l) => l.trim()).filter(Boolean);
  if (projects.length) match.projects = projects;
  if (f.workspaces.length) match.workspaces = f.workspaces;
  const kinds = KINDS.filter((k) => f.sessions[k]);
  if (kinds.length === 1) match.sessions = [...kinds];
  if (f.stages.length) match.stages = f.stages;
  return { name: f.name, match, bank: f.bank, actions: ACTIONS.filter((a) => f.actions[a]) };
}

function blankScope(n: number): ScopeForm {
  return toForm({ name: `scope ${n}`, match: {}, bank: 'cc-{project}', actions: ['recall', 'retain'] });
}

function FieldMsg({ errors, field }: { errors: FieldError[]; field: string }) {
  const e = errors.find((x) => x.field === field);
  return e ? <p className="text-xs text-destructive" role="alert" data-field-error={field}>{e.message}</p> : null;
}

function BankPreview({ template }: { template: string }) {
  const [preview, setPreview] = useState<{ bank?: string; error?: string } | null>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      send<{ bank?: string; error?: string }>('-/api/memory/preview-bank', 'POST', { template, sample: { project: 'example', worktree: 'main', kind: 'worker' } }).then(setPreview, () => setPreview(null));
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(id);
  }, [template]);
  if (!preview) return null;
  return preview.error
    ? <p className="text-xs text-destructive">{preview.error}</p>
    : <p className="text-xs text-muted-foreground">Preview for project “example”, main checkout, worker: <code>{preview.bank}</code></p>;
}

/** Chips for a list of names, a free-text entry, and an "unknown to cc" marker for a literal name cc does not list. */
function NameListEditor({ id, noun, values, known, knownError, emptyText, unknownTitle, placeholder, onChange }: {
  id: string; noun: string; values: string[]; known: string[] | null; knownError: boolean; emptyText: string; unknownTitle: string; placeholder: string; onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <Badge key={v} variant="secondary" className="gap-1" {...{ [`data-${noun}`]: v }}>
            {v}
            {known && !/[*?]/.test(v) && !known.includes(v) && <span className="text-warning" title={unknownTitle}>unknown to cc</span>}
            <button type="button" aria-label={`Remove ${noun} ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><XIcon className="size-3" /></button>
          </Badge>
        ))}
        {values.length === 0 && <span className="text-xs text-muted-foreground">{emptyText}</span>}
      </div>
      <div className="flex gap-2">
        <Input id={id} list={`${id}-known`} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <datalist id={`${id}-known`}>{(known ?? []).map((k) => <option key={k} value={k} />)}</datalist>
        <Button type="button" size="sm" variant="outline" onClick={add}>Add {noun}</Button>
      </div>
      {knownError && <p className="text-xs text-warning">cc's {noun} names could not be read, so names are not checked.</p>}
    </div>
  );
}

function Activity() {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const load = useCallback(() => { api<{ entries: ActivityEntry[] }>('-/api/memory/activity').then((r) => setEntries(r.entries), () => {}); }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, ACTIVITY_POLL_MS);
    return () => clearInterval(id);
  }, [load]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Recent recalls and retains, newest first. Entries name sessions, projects, stages and banks; they never hold prompt or memory text.</CardDescription>
      </CardHeader>
      <CardContent>
        {entries === null ? <p className="text-sm text-muted-foreground">Loading…</p>
          : entries.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet.</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead><tr className="text-muted-foreground"><th className="pr-2">Time</th><th className="pr-2">Event</th><th className="pr-2">Session</th><th className="pr-2">Project · stage</th><th className="pr-2">Banks</th><th className="pr-2">#</th><th>Result</th></tr></thead>
                  <tbody>
                    {entries.map((e, i) => (
                      <tr key={`${e.at}-${i}`} data-outcome={e.outcome} className={e.outcome === 'error' ? 'text-destructive' : e.outcome === 'skipped' ? 'text-muted-foreground' : ''}>
                        <td className="pr-2 whitespace-nowrap">{e.at.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}</td>
                        <td className="pr-2">{e.event}</td>
                        <td className="pr-2">{e.sessionId ?? ''}</td>
                        <td className="pr-2">{[e.project, e.stage].filter(Boolean).join(' · ')}</td>
                        <td className="pr-2">{(e.banks ?? []).join(', ')}</td>
                        <td className="pr-2">{e.count ?? ''}</td>
                        <td>{e.outcome === 'ok' ? 'ok' : `${e.code ?? e.outcome}${e.message ? `: ${e.message}` : ''}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </CardContent>
    </Card>
  );
}

export function Memory({ status }: { status: Status }) {
  const [saved, setSaved] = useState<Scope[] | null>(null);
  const [forms, setForms] = useState<ScopeForm[]>([]);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [stages, setStages] = useState<StagesView | null>(null);
  const [ccProjects, setCcProjects] = useState<CcProjectsView | null>(null);

  useEffect(() => {
    api<ScopesView>('-/api/scopes').then((v) => { setSaved(v.scopes); setForms(v.scopes.map(toForm)); }, (e) => setMessage(String(e.message ?? e)));
    api<StagesView>('-/api/memory/stages').then(setStages, () => setStages({ stages: [], error: 'unreachable' }));
    api<CcProjectsView>('-/api/memory/cc-projects').then(setCcProjects, () => setCcProjects({ projects: [], workspaces: [], error: 'unreachable' }));
  }, []);

  if (saved === null) return <p className="text-sm text-muted-foreground">{message ?? 'Loading memory scopes…'}</p>;

  const known = stages && !stages.error ? stages.stages.map((s) => s.name) : null;
  /** cc's projects and workspaces, or null while loading or when cc could not be read (names are typed then). */
  const cc = ccProjects && !ccProjects.error ? ccProjects : null;
  const projectItems = (cc?.projects ?? []).map((p) => ({ name: p.name, hint: p.workspace ?? 'no workspace' }));
  const workspaceItems = (cc?.workspaces ?? []).map((w) => ({ name: w.name, hint: `${w.projectCount} projects` }));
  const patch = (i: number, p: Partial<ScopeForm>) => setForms(forms.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...forms];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setForms(next);
  };

  const save = async () => {
    setSaving(true);
    setErrors([]);
    setMessage(null);
    try {
      const r = await send<{ scopes: Scope[] }>('-/api/scopes', 'PUT', { scopes: forms.map(toScope) });
      setSaved(r.scopes);
      setForms(r.scopes.map(toForm));
      setMessage(r.scopes.length ? 'Saved. Sessions started from now on use these scopes at their next prompt.' : 'Saved. Memory is off.');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SCOPES_INVALID') {
        setErrors(((e.body as { params?: { fields?: FieldError[] } })?.params?.fields) ?? []);
        setMessage('Some scopes are not valid.');
      } else setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm" data-memory-header>
        {saved.length === 0
          ? <p className="font-medium">Memory is off — no scopes; every session is memoryless.</p>
          : <p>Memory is on for sessions that match a scope. A session with no matching scope is memoryless.</p>}
        {status.state !== 'ready' && <p className="text-warning">Hindsight is {status.state}: sessions are memoryless until it is ready.</p>}
        {status.llmMode === 'none' && <p className="text-muted-foreground">Hindsight's LLM mode is none: retained turns are stored as raw chunks, without fact extraction.</p>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scopes</CardTitle>
          <CardDescription>
            Checked on every prompt, in this order. <strong>Recall</strong> reads every matching scope's bank (merged, at most four banks). <strong>Retain</strong> writes to the first matching scope that retains. A blank field matches anything; a conductor's project is <code>.conduct</code>. A session matches when its project matches a <strong>Projects</strong> line <em>or</em> is in one of the <strong>Workspaces</strong>, and Sessions and Stages match too. Placeholders: <code>{'{project}'}</code> <code>{'{worktree}'}</code> <code>{'{kind}'}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {forms.map((f, i) => {
            const p = `scopes[${i}]`;
            const id = `scope-${f.key}`;
            return (
              <div key={f.key} className="space-y-3 rounded-md border p-3" data-scope={i}>
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={`${id}-name`}>Name</Label>
                    <Input id={`${id}-name`} value={f.name} onChange={(e) => patch(i, { name: e.target.value })} />
                    <FieldMsg errors={errors} field={`${p}.name`} />
                  </div>
                  <Button type="button" size="icon" variant="outline" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUpIcon /></Button>
                  <Button type="button" size="icon" variant="outline" aria-label={`Move ${f.name} down`} disabled={i === forms.length - 1} onClick={() => move(i, 1)}><ArrowDownIcon /></Button>
                  <Button type="button" size="icon" variant="outline" aria-label={`Delete ${f.name}`} onClick={() => setForms(forms.filter((_, j) => j !== i))}><Trash2Icon /></Button>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-projects`}>Projects (one glob per line; * and ? allowed)</Label>
                  <textarea id={`${id}-projects`} rows={2} className="w-full rounded-md border border-input bg-transparent px-3 py-1 font-mono text-sm" placeholder="any project" value={f.projects} onChange={(e) => patch(i, { projects: e.target.value })} />
                  {cc && <CcPicker id={`${id}-projects`} noun="project" items={projectItems} picked={f.projects.split('\n').map((l) => l.trim())} onPick={(name) => patch(i, { projects: addProjectLine(f.projects, name) })} />}
                  {ccProjects?.error && <p className="text-xs text-warning">cc's project and workspace lists could not be read; type the names.</p>}
                  <FieldMsg errors={errors} field={`${p}.match.projects`} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-workspace`}>Workspaces (cc workspaces; * and ? allowed)</Label>
                  <NameListEditor
                    id={`${id}-workspace`} noun="workspace" values={f.workspaces} known={cc ? cc.workspaces.map((w) => w.name) : null} knownError={!!ccProjects?.error}
                    emptyText="none: only the Projects lines decide" unknownTitle="cc has no workspace with this name" placeholder="workspace name or glob"
                    onChange={(w) => patch(i, { workspaces: w })}
                  />
                  {cc && <CcPicker id={`${id}-workspaces`} noun="workspace" items={workspaceItems} picked={f.workspaces} onPick={(name) => { if (!f.workspaces.includes(name)) patch(i, { workspaces: [...f.workspaces, name] }); }} />}
                  <p className="text-xs text-muted-foreground">Projects in these workspaces match in addition to the Projects lines, as cc reports membership when matching. A project in no workspace matches only through Projects.</p>
                  <FieldMsg errors={errors} field={`${p}.match.workspaces`} />
                </div>
                <fieldset className="space-y-1">
                  <legend className="text-sm font-medium">Sessions</legend>
                  {KINDS.map((k) => (
                    <label key={k} className="mr-4 inline-flex items-center gap-2 text-sm">
                      {/* The last ticked kind cannot be cleared: "none" would silently mean "any". */}
                      <input type="checkbox" checked={f.sessions[k]} disabled={f.sessions[k] && KINDS.filter((o) => f.sessions[o]).length === 1} onChange={(e) => patch(i, { sessions: { ...f.sessions, [k]: e.target.checked } })} /> {k}
                    </label>
                  ))}
                  <p className="text-xs text-muted-foreground">{KINDS.every((k) => f.sessions[k]) ? 'Both ticked: any session.' : 'Only these sessions.'} At least one stays ticked.</p>
                  <FieldMsg errors={errors} field={`${p}.match.sessions`} />
                </fieldset>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-stage`}>Stages</Label>
                  <NameListEditor
                    id={`${id}-stage`} noun="stage" values={f.stages} known={known} knownError={!!stages?.error}
                    emptyText="any stage (including sessions without one)" unknownTitle="No cc playbook has a stage with this name" placeholder="stage name"
                    onChange={(s) => patch(i, { stages: s })}
                  />
                  <FieldMsg errors={errors} field={`${p}.match.stages`} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-bank`}>Bank template</Label>
                  <Input id={`${id}-bank`} className="font-mono" value={f.bank} onChange={(e) => patch(i, { bank: e.target.value })} />
                  <BankPreview template={f.bank} />
                  <FieldMsg errors={errors} field={`${p}.bank`} />
                </div>
                <fieldset className="space-y-1">
                  <legend className="text-sm font-medium">Actions</legend>
                  {ACTIONS.map((a) => (
                    <label key={a} className="mr-4 inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={f.actions[a]} onChange={(e) => patch(i, { actions: { ...f.actions, [a]: e.target.checked } })} /> {a}
                    </label>
                  ))}
                  <FieldMsg errors={errors} field={`${p}.actions`} />
                </fieldset>
              </div>
            );
          })}
          <FieldMsg errors={errors} field="scopes" />
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setForms([...forms, blankScope(forms.length + 1)])}><PlusIcon /> Add scope</Button>
            <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>Save</Button>
            {message && <span className="text-sm" role="status">{message}</span>}
          </div>
        </CardContent>
      </Card>

      <Backfill status={status} />

      <Activity />
    </div>
  );
}
