import { useCallback, useEffect, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NameListInput } from '@/components/NameListInput';
import { Backfill } from '@/views/Backfill';
import { api, ApiError, send } from '@/lib/api';
import type { ActivityEntry, CcProjectsView, FieldError, Scope, ScopesView, StagesView, Status } from '@/lib/types';

const ACTIVITY_POLL_MS = 5000;
const PREVIEW_DELAY_MS = 250;
const KINDS = ['conductor', 'worker'] as const;
const ACTIONS = ['recall', 'retain'] as const;

/** A scope as edited. `open` is UI-only (never sent): whether the card shows its fields. */
interface ScopeForm {
  key: number;
  open: boolean;
  name: string;
  projects: string[];
  workspaces: string[];
  sessions: Record<(typeof KINDS)[number], boolean>;
  stages: string[];
  bank: string;
  actions: Record<(typeof ACTIONS)[number], boolean>;
}

let nextKey = 1;

function toForm(s: Scope, open = false): ScopeForm {
  const kinds = s.match.sessions;
  return {
    key: nextKey++,
    open,
    name: s.name,
    projects: s.match.projects ?? [],
    workspaces: s.match.workspaces ?? [],
    sessions: { conductor: !kinds || kinds.includes('conductor'), worker: !kinds || kinds.includes('worker') },
    stages: s.match.stages ?? [],
    bank: s.bank,
    actions: { recall: s.actions.includes('recall'), retain: s.actions.includes('retain') },
  };
}

/** Both kinds ticked means "any": the key is omitted, never sent as an empty list. */
function toScope(f: ScopeForm): Scope {
  const match: Scope['match'] = {};
  if (f.projects.length) match.projects = f.projects;
  if (f.workspaces.length) match.workspaces = f.workspaces;
  const kinds = KINDS.filter((k) => f.sessions[k]);
  if (kinds.length === 1) match.sessions = [...kinds];
  if (f.stages.length) match.stages = f.stages;
  return { name: f.name, match, bank: f.bank, actions: ACTIONS.filter((a) => f.actions[a]) };
}

function blankScope(n: number): ScopeForm {
  return toForm({ name: `scope ${n}`, match: {}, bank: 'cc-{project}', actions: ['recall', 'retain'] }, true);
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

const SUMMARY_LIST_MAX = 2;

/** "a, b +3": the first names of a list and how many more there are. */
function briefList(list: string[]): string {
  const extra = list.length - SUMMARY_LIST_MAX;
  return list.slice(0, SUMMARY_LIST_MAX).join(', ') + (extra > 0 ? ` +${extra}` : '');
}

/** One line for a collapsed card: what the scope narrows to ("any session" when nothing), its bank and its actions. */
function summarize(f: ScopeForm): string {
  const narrowing = [
    f.projects.length ? `projects ${briefList(f.projects)}` : null,
    f.workspaces.length ? `workspaces ${briefList(f.workspaces)}` : null,
    f.stages.length ? `stages ${briefList(f.stages)}` : null,
    KINDS.every((k) => f.sessions[k]) ? null : `${KINDS.filter((k) => f.sessions[k]).join(', ')} only`,
  ].filter((p): p is string => p !== null);
  const actions = ACTIONS.filter((a) => f.actions[a]);
  return [...(narrowing.length ? narrowing : ['any session']), `bank ${f.bank}`, actions.length ? actions.join(', ') : 'no actions'].join(' · ');
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
        <CardDescription>Recent recalls, retains and past-session scans and imports, newest first. Entries name sessions, projects, stages and banks; they never hold prompt or memory text.</CardDescription>
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
    api<ScopesView>('-/api/scopes').then((v) => { setSaved(v.scopes); setForms(v.scopes.map((sc) => toForm(sc))); }, (e) => setMessage(String(e.message ?? e)));
    api<StagesView>('-/api/memory/stages').then(setStages, () => setStages({ stages: [], error: 'unreachable' }));
    api<CcProjectsView>('-/api/memory/cc-projects').then(setCcProjects, () => setCcProjects({ projects: [], workspaces: [], error: 'unreachable' }));
  }, []);

  if (saved === null) return <p className="text-sm text-muted-foreground">{message ?? 'Loading memory scopes…'}</p>;

  /** Suggestions for each list field; null while loading or when cc could not be read (names are typed then). */
  const stageItems = stages && !stages.error ? stages.stages.map((s) => ({ name: s.name, hint: s.playbooks.join(', ') })) : null;
  /** cc's projects and workspaces, or null while loading or when cc could not be read (names are typed then). */
  const cc = ccProjects && !ccProjects.error ? ccProjects : null;
  const projectItems = cc ? cc.projects.map((p) => ({ name: p.name, hint: p.workspace ?? 'no workspace' })) : null;
  const workspaceItems = cc ? cc.workspaces.map((w) => ({ name: w.name, hint: `${w.projectCount} projects` })) : null;
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
      // The saved list has the sent order and length, so each card keeps its open state.
      setForms((prev) => r.scopes.map((sc, i) => toForm(sc, prev[i]?.open ?? false)));
      setMessage(r.scopes.length ? 'Saved. Sessions started from now on use these scopes at their next prompt.' : 'Saved. Memory is off.');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SCOPES_INVALID') {
        const fields = ((e.body as { params?: { fields?: FieldError[] } })?.params?.fields) ?? [];
        setErrors(fields);
        // A refusal inside a collapsed card must not stay hidden.
        const named = new Set(fields.map((x) => /^scopes\[(\d+)\]\./.exec(x.field)?.[1]).filter((n) => n !== undefined).map(Number));
        setForms((prev) => prev.map((f, i) => (named.has(i) ? { ...f, open: true } : f)));
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
            Checked on every prompt, in this order. <strong>Recall</strong> reads every matching scope's bank (merged, at most four banks). <strong>Retain</strong> writes to the first matching scope that retains. A blank field matches anything; a conductor's project is <code>.conduct</code>. A session matches when its project matches a <strong>Projects</strong> entry <em>or</em> is in one of the <strong>Workspaces</strong>, and Sessions and Stages match too. Placeholders: <code>{'{project}'}</code> <code>{'{worktree}'}</code> <code>{'{kind}'}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {forms.map((f, i) => {
            const p = `scopes[${i}]`;
            const id = `scope-${f.key}`;
            const invalid = errors.some((x) => x.field.startsWith(`${p}.`));
            return (
              <div key={f.key} className="space-y-3 rounded-md border p-3" data-scope={i}>
                <div className="flex items-center gap-2">
                  <button type="button" aria-expanded={f.open} aria-controls={`${id}-body`} onClick={() => patch(i, { open: !f.open })} className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent">
                    {f.open ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}
                    <span className="shrink-0 text-sm font-medium">{f.name || 'unnamed scope'}</span>
                    {invalid && <Badge variant="destructive">invalid</Badge>}
                    <span className="truncate text-xs text-muted-foreground">{summarize(f)}</span>
                  </button>
                  <Button type="button" size="icon" variant="outline" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUpIcon /></Button>
                  <Button type="button" size="icon" variant="outline" aria-label={`Move ${f.name} down`} disabled={i === forms.length - 1} onClick={() => move(i, 1)}><ArrowDownIcon /></Button>
                  <Button type="button" size="icon" variant="outline" aria-label={`Delete ${f.name}`} onClick={() => setForms(forms.filter((_, j) => j !== i))}><Trash2Icon /></Button>
                </div>
                {/* Kept mounted while collapsed so drafts and the bank preview survive toggling. */}
                <div id={`${id}-body`} hidden={!f.open} className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor={`${id}-name`}>Name</Label>
                  <Input id={`${id}-name`} value={f.name} onChange={(e) => patch(i, { name: e.target.value })} />
                  <FieldMsg errors={errors} field={`${p}.name`} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-projects`}>Projects (project names or globs; * and ? allowed)</Label>
                  <NameListInput
                    id={`${id}-projects`} noun="project" values={f.projects} suggestions={projectItems}
                    emptyText="any project" unknownTitle="cc has no project with this name" placeholder="project name or glob"
                    onChange={(v) => patch(i, { projects: v })}
                  />
                  {ccProjects?.error && <p className="text-xs text-warning">cc's project and workspace lists could not be read; type the names.</p>}
                  <FieldMsg errors={errors} field={`${p}.match.projects`} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-workspace`}>Workspaces (cc workspaces; * and ? allowed)</Label>
                  <NameListInput
                    id={`${id}-workspace`} noun="workspace" values={f.workspaces} suggestions={workspaceItems}
                    emptyText="none: only the Projects entries decide" unknownTitle="cc has no workspace with this name" placeholder="workspace name or glob"
                    onChange={(w) => patch(i, { workspaces: w })}
                  />
                  <p className="text-xs text-muted-foreground">Projects in these workspaces match in addition to the Projects entries, as cc reports membership when matching. A project in no workspace matches only through Projects.</p>
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
                  <NameListInput
                    id={`${id}-stage`} noun="stage" values={f.stages} suggestions={stageItems}
                    emptyText="any stage (including sessions without one)" unknownTitle="No cc playbook has a stage with this name" placeholder="stage name"
                    onChange={(s) => patch(i, { stages: s })}
                  />
                  {stages?.error && <p className="text-xs text-warning">cc's stage names could not be read, so names are not checked.</p>}
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
