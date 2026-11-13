// The page's route lives in the query string (?view=…&cp=…): the bridge demotes pushState to
// replaceState and mirrors the query into cc's URL, so a reload or a deep link lands here.

export const VIEWS = ['cp', 'status', 'memory', 'settings', 'images'] as const;
export type View = (typeof VIEWS)[number];

export interface Route { view: View | null; cp: string | null }

/** A control-plane path from the query: app-relative, `/`-led, no dot segments or scheme tricks. */
export function safeCpPath(p: string | null): string | null {
  if (!p || !p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return null;
  const pathname = p.split(/[?#]/)[0];
  if (pathname.split('/').some((s) => s === '..' || s === '.')) return null;
  return p;
}

export function readRoute(search: string = location.search): Route {
  const q = new URLSearchParams(search);
  const v = q.get('view');
  return { view: (VIEWS as readonly string[]).includes(v ?? '') ? (v as View) : null, cp: safeCpPath(q.get('cp')) };
}

export function routeSearch(r: Route): string {
  const q = new URLSearchParams();
  if (r.view) q.set('view', r.view);
  if (r.view === 'cp' && r.cp) q.set('cp', r.cp);
  const s = q.toString();
  return s ? `?${s}` : '?';
}

/** The CP frame's relative src for a CP path (the shell sits at the mount root). */
export function cpFrameSrc(cp: string | null): string {
  const p = safeCpPath(cp);
  return p ? `.${p}` : 'dashboard';
}

/** A CP document's location as an app path, given the shell's own directory. */
export function cpPathOf(frameLocation: { pathname: string; search: string }, shellDir: string): string | null {
  if (!frameLocation.pathname.startsWith(shellDir)) return null;
  return `/${frameLocation.pathname.slice(shellDir.length)}${frameLocation.search}`;
}
