import { describe, expect, it } from 'vitest';
import { cpFrameSrc, cpPathOf, readRoute, routeSearch, safeCpPath } from './route';
import { api } from './api';

describe('route', () => {
  it('reads and writes the query route', () => {
    expect(readRoute('?view=cp&cp=%2Fbanks%2Fb')).toEqual({ view: 'cp', cp: '/banks/b' });
    expect(readRoute('?view=bogus')).toEqual({ view: null, cp: null });
    expect(routeSearch({ view: 'cp', cp: '/dashboard' })).toBe('?view=cp&cp=%2Fdashboard');
    expect(routeSearch({ view: 'status', cp: '/ignored' })).toBe('?view=status');
  });

  it('accepts only app-relative CP paths', () => {
    for (const bad of ['//evil.example', '/\\evil', '/../x', '/a/./b', 'javascript:alert(1)', 'banks', '']) expect(safeCpPath(bad)).toBeNull();
    expect(safeCpPath('/banks/a.b.c?tab=x')).toBe('/banks/a.b.c?tab=x');
    expect(cpFrameSrc('/banks/b')).toBe('./banks/b');
    expect(cpFrameSrc(null)).toBe('dashboard');
  });

  it('maps a CP document location to an app path under the shell', () => {
    expect(cpPathOf({ pathname: '/plugins/code-hindsight/banks/b', search: '?x=1' }, '/plugins/code-hindsight/')).toBe('/banks/b?x=1');
    expect(cpPathOf({ pathname: '/elsewhere', search: '' }, '/plugins/code-hindsight/')).toBeNull();
  });

  it('api() refuses a root-relative path (it would reach cc)', async () => {
    await expect(api('/api/status')).rejects.toThrow(/root-relative/);
  });
});
