import { useEffect, useRef } from 'react';
import { cpFrameSrc, cpPathOf } from '@/lib/route';

/** The shell's own directory: the mount root (`/plugins/code-hindsight/` in cc, `/` standalone). */
const shellDir = () => location.pathname.replace(/[^/]*$/, '');

function syncTheme(frame: HTMLIFrameElement) {
  try {
    frame.contentDocument?.documentElement.classList.toggle('dark', document.documentElement.classList.contains('dark'));
  } catch { /* not loaded yet, or not same-origin */ }
}

/**
 * The Hindsight control plane in a same-origin child frame. On every load it follows cc's
 * theme, turns the CP's history pushes into replaces (so Back still leaves the plugin), and
 * reports the CP's route so the shell's URL — and cc's — can deep-link it.
 */
export function ControlPlane({ cp, onCpPath }: { cp: string | null; onCpPath: (path: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const reported = useRef<string | null>(cp);
  const initialSrc = useRef(cpFrameSrc(cp));

  // A route from outside (cc's navigate → popstate) moves the frame; our own reports do not.
  useEffect(() => {
    const frame = ref.current;
    if (frame && cp && cp !== reported.current) {
      reported.current = cp;
      frame.src = cpFrameSrc(cp);
    }
  }, [cp]);

  useEffect(() => {
    const observer = new MutationObserver(() => { if (ref.current) syncTheme(ref.current); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const onLoad = () => {
    const frame = ref.current;
    if (!frame) return;
    syncTheme(frame);
    let w: Window | null = null;
    try { w = frame.contentWindow; void w?.location.pathname; } catch { return; }
    if (!w) return;
    const win = w;
    const report = () => {
      const p = cpPathOf(win.location, shellDir());
      if (p && p !== reported.current) {
        reported.current = p;
        onCpPath(p);
      }
    };
    const h = win.history;
    const replace = h.replaceState.bind(h);
    h.replaceState = (data: unknown, unused: string, url?: string | URL | null) => { replace(data, unused, url); report(); };
    h.pushState = h.replaceState;
    win.addEventListener('popstate', report);
    report();
  };

  return (
    <iframe
      ref={ref}
      data-cp-frame=""
      title="Hindsight control plane"
      src={initialSrc.current}
      onLoad={onLoad}
      className="block h-full w-full border-0"
    />
  );
}
