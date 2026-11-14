// Scope validation, matching, precedence and bank rendering (src/scopes.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateScopes, matchScopes, needsWorkspace, renderBank, createScopesStore, globMatches, SCOPE_LIMITS } from '../src/scopes.js';
import { mkRoot } from './helpers.mjs';

const scope = (over = {}) => ({ name: 's', match: {}, bank: 'cc-{project}', actions: ['recall', 'retain'], ...over });
const session = (over = {}) => ({ project: 'proj', worktree: 'main', kind: 'worker', stage: 'implement', ...over });
const ok = (list) => { const r = validateScopes(list); assert.deepEqual(r.errors, []); return r.scopes; };
const fieldsOf = (list) => validateScopes(list).errors.map((e) => e.field);

test('validation refuses an empty match array so [] never quietly means "none"', () => {
  assert.deepEqual(fieldsOf([scope({ match: { projects: [] } })]), ['scopes[0].match.projects']);
  assert.deepEqual(fieldsOf([scope({ match: { stages: [] } })]), ['scopes[0].match.stages']);
});

test('validation refuses a bad glob character, a bad kind, an unknown key, an unknown placeholder', () => {
  assert.deepEqual(fieldsOf([scope({ match: { projects: ['a/b'] } })]), ['scopes[0].match.projects']);
  assert.deepEqual(fieldsOf([scope({ match: { sessions: ['boss'] } })]), ['scopes[0].match.sessions']);
  assert.deepEqual(fieldsOf([scope({ match: { colour: ['x'] } })]), ['scopes[0].match.colour']);
  assert.deepEqual(fieldsOf([scope({ bank: 'cc-{branch}' })]), ['scopes[0].bank']);
  assert.deepEqual(fieldsOf([scope({ bank: 'CC-{project}' })]), ['scopes[0].bank']);
});

test('validation refuses duplicate names and empty or duplicate actions; errors name the scope index', () => {
  assert.deepEqual(fieldsOf([scope(), scope()]), ['scopes[1].name']);
  assert.deepEqual(fieldsOf([scope({ actions: [] })]), ['scopes[0].actions']);
  assert.deepEqual(fieldsOf([scope({ actions: ['recall', 'recall'] })]), ['scopes[0].actions']);
  assert.deepEqual(fieldsOf([scope({ actions: ['delete'] })]), ['scopes[0].actions']);
});

test('validation refuses more scopes than the limit', () => {
  const many = Array.from({ length: SCOPE_LIMITS.maxScopes + 1 }, (_, i) => scope({ name: `s${i}` }));
  assert.ok(fieldsOf(many).includes('scopes'));
});

test('default off: no scopes match nothing', () => {
  assert.deepEqual(matchScopes([], session()), { recall: [], retain: null, retainUnresolved: false, skipped: [] });
});

test('an absent match key matches anything; stage null never matches a stages list', () => {
  const any = ok([scope()]);
  assert.equal(matchScopes(any, session({ stage: null })).recall.length, 1);
  const staged = ok([scope({ match: { stages: ['implement'] } })]);
  assert.equal(matchScopes(staged, session({ stage: null })).recall.length, 0);
  assert.equal(matchScopes(staged, session({ stage: 'review' })).recall.length, 0);
  assert.equal(matchScopes(staged, session({ stage: 'implement' })).recall.length, 1);
});

test('project globs: * spans characters (a leading dot too), ? one character, others are literal', () => {
  const m = (glob, project) => matchScopes(ok([scope({ match: { projects: [glob] } })]), session({ project })).recall.length === 1;
  assert.equal(m('code-*', 'code-hindsight'), true);
  assert.equal(m('*', '.conduct'), true);
  assert.equal(m('a?c', 'abc'), true);
  assert.equal(m('a?c', 'abbc'), false);
  assert.equal(m('a.c', 'abc'), false);
  assert.equal(m('.conduct', '.conduct'), true);
});

test('a conductor session is matched by kind', () => {
  const s = ok([scope({ match: { sessions: ['conductor'] } })]);
  assert.equal(matchScopes(s, session({ kind: 'conductor' })).recall.length, 1);
  assert.equal(matchScopes(s, session({ kind: 'worker' })).recall.length, 0);
});

test('precedence: recall merges every match in array order, de-duplicates banks and caps them', () => {
  const list = ok([
    scope({ name: 'a', bank: 'one', actions: ['recall'] }),
    scope({ name: 'b', bank: 'two', actions: ['recall'] }),
    scope({ name: 'c', bank: 'one', actions: ['recall'] }),
    scope({ name: 'd', bank: 'three', actions: ['recall'] }),
    scope({ name: 'e', bank: 'four', actions: ['recall'] }),
    scope({ name: 'f', bank: 'five', actions: ['recall'] }),
  ]);
  const { recall } = matchScopes(list, session());
  assert.deepEqual(recall.map((r) => r.bank), ['one', 'two', 'three', 'four']);
  assert.equal(recall.length, SCOPE_LIMITS.recallMaxBanks);
  assert.equal(recall[0].scope, 'a');
});

test('precedence: retain is the first matching scope that grants it, never a later one', () => {
  const list = ok([
    scope({ name: 'recall-only', bank: 'r', actions: ['recall'] }),
    scope({ name: 'first', bank: 'first', actions: ['retain'] }),
    scope({ name: 'second', bank: 'second', actions: ['retain'] }),
  ]);
  assert.deepEqual(matchScopes(list, session()).retain, { scope: 'first', bank: 'first' });
});

test('retain does not fall through to a later scope when the first one fails to render', () => {
  const list = ok([
    scope({ name: 'broken', bank: '{project}', actions: ['retain'] }),
    scope({ name: 'later', bank: 'later', actions: ['retain'] }),
  ]);
  const r = matchScopes(list, session({ project: '...' }));
  assert.equal(r.retain, null);
  assert.deepEqual(r.skipped.map((x) => [x.scope, x.code]), [['broken', 'BANK_RENDER_FAILED']]);
});

test('rendering: .conduct → conduct, the main checkout → main, uppercase lowercased, odd characters become -', () => {
  assert.equal(renderBank('cc-{project}', session({ project: '.conduct' })).bank, 'cc-conduct');
  assert.equal(renderBank('{project}:{worktree}', session({ worktree: null })).bank, 'proj:main');
  assert.equal(renderBank('{project}', session({ project: 'My App!!v2' })).bank, 'my-app-v2');
  assert.equal(renderBank('x-{kind}', session({ kind: 'worker' })).bank, 'x-worker');
});

test('rendering fails (never throws) when the result is not a valid bank id', () => {
  assert.ok(renderBank('{project}', session({ project: '___' })).error);
  assert.ok(renderBank('p-{project}', session({ project: 'a'.repeat(200) })).error);
});

test('the store round-trips scopes.json and refuses a corrupt file', (t) => {
  const r = mkRoot(t);
  const store = createScopesStore(r.dataDir);
  assert.deepEqual(store.get(), []);
  store.save(ok([scope()]));
  assert.equal(createScopesStore(r.dataDir).get()[0].name, 's');
  assert.equal(fs.statSync(path.join(r.dataDir, 'scopes.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(r.dataDir, 'scopes.json'), '{"scopes":[{"name":""}]}');
  assert.throws(() => createScopesStore(r.dataDir).get(), /scopes\.json is not valid/);
});

test('a list entry that is undefined (or any non-string) is refused, not skipped', () => {
  assert.deepEqual(fieldsOf([scope({ match: { projects: [undefined] } })]), ['scopes[0].match.projects']);
  assert.deepEqual(fieldsOf([scope({ match: { stages: ['plan', null] } })]), ['scopes[0].match.stages']);
  assert.deepEqual(fieldsOf([scope({ match: { sessions: [0] } })]), ['scopes[0].match.sessions']);
});

test('glob matching never blows up: a many-star glob against a non-matching name finishes at once', () => {
  const glob = '*a'.repeat(10) + '*b';
  const name = 'a'.repeat(41);
  const t0 = process.hrtime.bigint();
  assert.equal(globMatches(glob, name), false);
  assert.equal(matchScopes(ok([scope({ match: { projects: [glob] } })]), session({ project: name })).recall.length, 0);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 100, 'took far longer than a bounded scan would');
});

test('glob semantics: * spans any run (including none), ? exactly one, everything else literal', () => {
  const cases = [['*', ''], ['a*', 'a'], ['*b', 'ab'], ['a*c*e', 'abcde'], ['a?c', 'abc'], ['a?c', 'ac'], ['a.c', 'abc'], ['**', 'x'], ['a*b', 'acbc']];
  assert.deepEqual(cases.map(([g, n]) => globMatches(g, n)), [true, true, true, true, true, false, false, true, false]);
});

test('validation refuses an empty, badly-charactered, duplicated or over-long workspaces list, naming the field', () => {
  const field = ['scopes[0].match.workspaces'];
  assert.deepEqual(fieldsOf([scope({ match: { workspaces: [] } })]), field);
  assert.deepEqual(fieldsOf([scope({ match: { workspaces: ['a/b'] } })]), field);
  assert.deepEqual(fieldsOf([scope({ match: { workspaces: ['WS', 'WS'] } })]), field);
  assert.deepEqual(fieldsOf([scope({ match: { workspaces: Array.from({ length: SCOPE_LIMITS.listMax + 1 }, (_, i) => `w${i}`) } })]), field);
  assert.deepEqual(ok([scope({ match: { workspaces: ['CC-*', 'HOME'] } })])[0].match, { workspaces: ['CC-*', 'HOME'] });
});

test('a scope list without workspaces validates unchanged, matches as before and never needs a workspace', () => {
  const raw = [scope({ name: 'a', match: { projects: ['code-*'], sessions: ['worker'], stages: ['implement'] }, bank: 'a-{project}' }), scope({ name: 'b', bank: 'b', actions: ['recall'] })];
  const list = ok(raw);
  assert.deepEqual(list, raw);
  const s = session({ project: 'code-x' });
  assert.equal(needsWorkspace(list, s), false);
  assert.deepEqual(matchScopes(list, s), { recall: [{ scope: 'a', bank: 'a-code-x' }, { scope: 'b', bank: 'b' }], retain: { scope: 'a', bank: 'a-code-x' }, retainUnresolved: false, skipped: [] });
});

test('projects OR workspaces, ANDed with sessions and stages; workspace globs are case-sensitive and a project in no workspace never matches them', () => {
  const both = ok([scope({ match: { projects: ['code-*'], workspaces: ['WS'] } })]);
  const hit = (list, over) => matchScopes(list, session(over)).recall.length === 1;
  assert.equal(hit(both, { project: 'code-a', workspace: 'OTHER' }), true, 'a project glob alone matches');
  assert.equal(hit(both, { project: 'proj', workspace: 'WS' }), true, 'a workspace alone matches');
  assert.equal(hit(both, { project: 'proj', workspace: 'OTHER' }), false);
  assert.equal(hit(both, { project: 'proj', workspace: null }), false, 'no workspace never matches a workspaces list');
  const staged = ok([scope({ match: { workspaces: ['WS'], stages: ['plan'], sessions: ['worker'] } })]);
  assert.equal(hit(staged, { workspace: 'WS', stage: 'implement' }), false, 'the stage still has to match');
  assert.equal(hit(staged, { workspace: 'WS', stage: 'plan', kind: 'conductor' }), false, 'the kind still has to match');
  assert.equal(hit(staged, { workspace: 'WS', stage: 'plan' }), true);
  const w = (glob, workspace) => hit(ok([scope({ match: { workspaces: [glob] } })]), { workspace });
  assert.equal(w('cc-dev', 'CC-Dev'), false);
  assert.equal(w('CC-Dev', 'CC-Dev'), true);
  assert.equal(w('CC-*', 'CC-Dev'), true);
  assert.equal(w('CC-?ev', 'CC-Dev'), true);
});

test('a failed workspace lookup leaves only the scopes that depend on it undecided, and retain never falls through past one', () => {
  const failed = session({ workspaceError: 'project proj: cc did not answer in time' });
  const list = ok([
    scope({ name: 'ws', match: { workspaces: ['WS'] }, bank: 'ws', actions: ['recall', 'retain'] }),
    scope({ name: 'by-glob', match: { projects: ['pr*'], workspaces: ['WS'] }, bank: 'glob', actions: ['recall'] }),
    scope({ name: 'wrong-stage', match: { workspaces: ['WS'], stages: ['plan'] }, bank: 'staged', actions: ['recall'] }),
    scope({ name: 'catch-all', bank: 'all', actions: ['recall', 'retain'] }),
  ]);
  const m = matchScopes(list, failed);
  assert.deepEqual(m.recall.map((r) => r.bank), ['glob', 'all'], 'the undecided scope gives no bank; the others still recall');
  assert.equal(m.retain, null, 'retain does not fall through to catch-all');
  assert.equal(m.retainUnresolved, true);
  assert.deepEqual(m.skipped, [{ scope: 'ws', code: 'WORKSPACE_UNRESOLVED', detail: 'project proj: cc did not answer in time' }], 'a scope ruled out by its stage is a plain no');
  const recallOnly = ok([scope({ name: 'ws', match: { workspaces: ['WS'] }, bank: 'ws', actions: ['recall'] }), scope({ name: 'later', bank: 'later', actions: ['retain'] })]);
  assert.deepEqual(matchScopes(recallOnly, failed).retain, { scope: 'later', bank: 'later' }, 'an undecided recall-only scope does not block a later retain');
});

test('needsWorkspace is true only when a scope\'s outcome depends on the workspace', () => {
  const s = session({ project: 'proj', stage: 'implement', kind: 'worker' });
  const needs = (match) => needsWorkspace(ok([scope({ match })]), s);
  assert.equal(needs({ workspaces: ['WS'] }), true);
  assert.equal(needs({ projects: ['other'], workspaces: ['WS'] }), true);
  assert.equal(needs({ projects: ['pr*'], workspaces: ['WS'] }), false, 'a project glob already matched');
  assert.equal(needs({ workspaces: ['WS'], stages: ['plan'] }), false, 'the stage rules it out');
  assert.equal(needs({ workspaces: ['WS'], sessions: ['conductor'] }), false, 'the kind rules it out');
  assert.equal(needs({ projects: ['other'] }), false);
});
