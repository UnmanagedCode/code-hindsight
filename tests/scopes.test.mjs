// Scope validation, matching, precedence and bank rendering (src/scopes.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateScopes, matchScopes, renderBank, createScopesStore, SCOPE_LIMITS } from '../src/scopes.js';
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
  assert.deepEqual(matchScopes([], session()), { recall: [], retain: null, skipped: [] });
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
