import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface PickItem { name: string; hint: string }

/**
 * A searchable list of names cc knows. Picking one hands its exact name to `onPick`; a name
 * already picked is disabled. Names and hints are cc-supplied and rendered as text only.
 */
export function CcPicker({ id, noun, items, picked, onPick }: { id: string; noun: string; items: PickItem[]; picked: string[]; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((it) => it.name.toLowerCase().includes(q) || it.hint.toLowerCase().includes(q)) : items;
  return (
    <div className="space-y-1">
      <Button type="button" size="sm" variant="outline" aria-expanded={open} aria-controls={`${id}-picker`} onClick={() => setOpen(!open)}>Pick {noun}s from cc</Button>
      {open && (
        <div id={`${id}-picker`} className="space-y-1 rounded-md border p-2">
          <Input aria-label={`Search cc ${noun}s`} placeholder={`search ${noun}s`} value={query} onChange={(e) => setQuery(e.target.value)} />
          {shown.length === 0
            ? <p className="text-xs text-muted-foreground">No match</p>
            : (
              <ul className="max-h-48 overflow-y-auto">
                {shown.map((it) => (
                  <li key={it.name}>
                    <button type="button" aria-label={`Add ${noun} ${it.name}`} disabled={picked.includes(it.name)} onClick={() => onPick(it.name)} className="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent disabled:opacity-50">
                      <span className="font-mono">{it.name}</span>
                      <span className="text-xs text-muted-foreground">{it.hint}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </div>
  );
}
