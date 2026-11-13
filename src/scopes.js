// Memory scopes: which Hindsight banks a cc session recalls from and retains into. A scope pairs
// a session matcher with a bank template and the actions it grants. Memory is off until a scope
// exists. Pure matching and rendering, plus the scopes.json store.
import path from 'node:path';
import { readJsonFile, writePrivateFileAtomic } from './fsPrivate.js';

export const SCOPE_ACTIONS = Object.freeze(['recall', 'retain']);
export const SESSION_KINDS = Object.freeze(['conductor', 'worker']);
export const PLACEHOLDERS = Object.freeze(['project', 'worktree', 'kind']);
export const SCOPE_LIMITS = Object.freeze({
  maxScopes: 50, nameMax: 60, templateMax: 100, listMax: 50, globMax: 100, recallMaxBanks: 4,
});

const GLOB_RE = /^[A-Za-z0-9._*?-]+$/;
const STAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const LITERAL_RE = /^[a-z0-9._:-]*$/;
const BANK_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const MATCH_KEYS = ['projects', 'sessions', 'stages'];
const SCOPE_KEYS = ['name', 'match', 'bank', 'actions'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The template's problem, or null. */
export function templateProblem(template) {
  if (typeof template !== 'string' || !template) return 'must be a non-empty string';
  if (template.length > SCOPE_LIMITS.templateMax) return `must be at most ${SCOPE_LIMITS.templateMax} characters`;
  const rest = template.replace(/\{([^{}]*)\}/g, (m, name) => (PLACEHOLDERS.includes(name) ? '' : '\0'));
  if (rest.includes('\0')) return `unknown placeholder (use ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')})`;
  if (/[{}]/.test(rest)) return 'unbalanced { or }';
  if (!LITERAL_RE.test(rest)) return 'literal text may use only a-z 0-9 . _ : - (lowercase)';
  return null;
}

/** Normalize and validate a whole scopes list. @returns {{scopes: object[], errors: {field: string, message: string}[]}} */
export function validateScopes(input) {
  const errors = [];
  const scopes = [];
  const err = (field, message) => errors.push({ field, message });
  if (!Array.isArray(input)) return { scopes, errors: [{ field: 'scopes', message: 'must be a list' }] };
  if (input.length > SCOPE_LIMITS.maxScopes) err('scopes', `at most ${SCOPE_LIMITS.maxScopes} scopes`);
  const names = new Set();
  input.slice(0, SCOPE_LIMITS.maxScopes).forEach((raw, i) => {
    const f = (k) => `scopes[${i}].${k}`;
    if (!isObj(raw)) return err(`scopes[${i}]`, 'must be an object');
    for (const k of Object.keys(raw)) if (!SCOPE_KEYS.includes(k)) err(f(k), 'unknown field');
    const scope = { name: '', match: {}, bank: '', actions: [] };
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > SCOPE_LIMITS.nameMax) err(f('name'), `must be 1–${SCOPE_LIMITS.nameMax} characters`);
    else if (names.has(raw.name)) err(f('name'), 'duplicate name');
    else { scope.name = raw.name; names.add(raw.name); }

    const match = raw.match ?? {};
    if (!isObj(match)) err(f('match'), 'must be an object');
    else {
      for (const k of Object.keys(match)) if (!MATCH_KEYS.includes(k)) err(f(`match.${k}`), 'unknown field');
      const list = (key, ok, what) => {
        if (match[key] === undefined) return;
        const v = match[key];
        if (!Array.isArray(v) || v.length === 0) return err(f(`match.${key}`), 'must be a non-empty list (omit the key to match any)');
        if (v.length > SCOPE_LIMITS.listMax) return err(f(`match.${key}`), `at most ${SCOPE_LIMITS.listMax} entries`);
        const badAt = v.findIndex((x) => typeof x !== 'string' || !ok(x));
        if (badAt >= 0) return err(f(`match.${key}`), `${JSON.stringify(v[badAt]) ?? 'undefined'} is not ${what}`);
        if (new Set(v).size !== v.length) return err(f(`match.${key}`), 'duplicate entries');
        scope.match[key] = [...v];
      };
      list('projects', (x) => x.length <= SCOPE_LIMITS.globMax && GLOB_RE.test(x), 'a glob of letters, digits . _ - * ?');
      list('sessions', (x) => SESSION_KINDS.includes(x), `one of ${SESSION_KINDS.join(', ')}`);
      list('stages', (x) => STAGE_RE.test(x), 'a stage name');
    }

    const problem = templateProblem(raw.bank);
    if (problem) err(f('bank'), problem); else scope.bank = raw.bank;

    if (!Array.isArray(raw.actions) || raw.actions.length === 0) err(f('actions'), 'must be a non-empty list');
    else if (raw.actions.some((a) => !SCOPE_ACTIONS.includes(a))) err(f('actions'), `entries must be ${SCOPE_ACTIONS.join(' or ')}`);
    else if (new Set(raw.actions).size !== raw.actions.length) err(f('actions'), 'duplicate entries');
    else scope.actions = [...raw.actions];
    scopes.push(scope);
  });
  return { scopes: errors.length ? [] : scopes, errors };
}

const sanitize = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-{2,}/g, '-').replace(/^[._-]+/, '');

/** The bank a template names for a session, or `{error}` when the result is not a valid bank id. */
export function renderBank(template, session) {
  const values = { project: session.project, worktree: session.worktree || 'main', kind: session.kind };
  const bank = template.replace(/\{(project|worktree|kind)\}/g, (_m, k) => sanitize(values[k]));
  return BANK_RE.test(bank) ? { bank } : { error: `renders to "${bank}", which is not a valid bank id` };
}

/**
 * Whether `text` matches a glob (`*` any run of characters, `?` one character, the rest literal).
 * One scan with a single backtrack point: O(glob × text) at worst, never exponential (a regular
 * expression built from many `*` can be).
 */
export function globMatches(glob, text) {
  let g = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (g < glob.length && (glob[g] === '?' || glob[g] === text[t])) { g++; t++; } else if (g < glob.length && glob[g] === '*') { star = g++; resume = t; } else if (star >= 0) { g = star + 1; t = ++resume; } else return false;
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

/** Whether a scope's matcher accepts a session. An absent key matches anything. */
export function scopeMatches(scope, session) {
  const { projects, sessions, stages } = scope.match;
  if (projects && !projects.some((g) => globMatches(g, session.project ?? ''))) return false;
  if (sessions && !sessions.includes(session.kind)) return false;
  if (stages && !(session.stage && stages.includes(session.stage))) return false;
  return true;
}

/**
 * Recall: every matching scope that grants it, in order, banks de-duplicated and capped.
 * Retain: the first matching scope that grants it; a bank that fails to render leaves the
 * session without retain rather than falling through to a later scope.
 * @returns {{recall: {scope: string, bank: string}[], retain: {scope: string, bank: string}|null, skipped: {scope: string, code: string, detail: string}[]}}
 */
export function matchScopes(scopes, session) {
  const recall = [];
  const skipped = [];
  let retain = null;
  let retainDecided = false;
  for (const scope of scopes) {
    if (!scopeMatches(scope, session)) continue;
    const rendered = renderBank(scope.bank, session);
    if (rendered.error) skipped.push({ scope: scope.name, code: 'BANK_RENDER_FAILED', detail: rendered.error });
    if (scope.actions.includes('recall') && rendered.bank && !recall.some((r) => r.bank === rendered.bank) && recall.length < SCOPE_LIMITS.recallMaxBanks) {
      recall.push({ scope: scope.name, bank: rendered.bank });
    }
    if (scope.actions.includes('retain') && !retainDecided) {
      retainDecided = true;
      if (rendered.bank) retain = { scope: scope.name, bank: rendered.bank };
    }
  }
  return { recall, retain, skipped };
}

/** scopes.json (0600) in the data dir; read once, written whole. */
export function createScopesStore(dataDir) {
  const file = path.join(dataDir, 'scopes.json');
  let cache = null;
  return {
    /** The saved scopes ([] when none). Throws when the file is not a valid scopes file. */
    get() {
      if (!cache) {
        const raw = readJsonFile(file, { scopes: [] });
        const { scopes, errors } = validateScopes(raw?.scopes);
        if (errors.length) throw new Error(`scopes.json is not valid: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
        cache = scopes;
      }
      return cache;
    },
    save(scopes) {
      writePrivateFileAtomic(file, `${JSON.stringify({ scopes }, null, 2)}\n`);
      cache = scopes;
    },
  };
}
