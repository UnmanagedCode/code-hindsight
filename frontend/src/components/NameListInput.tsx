import { useEffect, useRef, useState } from 'react';
import { XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface Suggestion { name: string; hint: string }

/** Options rendered at once; the list scrolls and typing narrows it. */
const MAX_SUGGESTIONS = 50;

/**
 * Removable chips for a list of names, plus an entry with its own suggestion list (a combobox,
 * never a native datalist: the browser draws that popup outside the page). Suggestions only
 * help: Enter adds the typed text unless an arrow key chose an option, so a glob stays a glob.
 * `suggestions` is null while loading or when cc could not be read. Names and hints are
 * cc-supplied and rendered as text only.
 */
export function NameListInput({ id, noun, values, onChange, suggestions, emptyText, unknownTitle, placeholder }: {
  id: string; noun: string; values: string[]; onChange: (v: string[]) => void; suggestions: Suggestion[] | null; emptyText: string; unknownTitle: string; placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const q = draft.trim().toLowerCase();
  const shown = (suggestions ?? [])
    .filter((s) => !values.includes(s.name) && (!q || s.name.toLowerCase().includes(q) || s.hint.toLowerCase().includes(q)))
    .slice(0, MAX_SUGGESTIONS);
  const expanded = open && shown.length > 0;
  const listId = `${id}-listbox`;
  const optionId = (i: number) => `${id}-option-${i}`;

  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (text: string) => {
    const v = text.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
    setActive(-1);
    setOpen(false);
  };
  const move = (d: 1 | -1) => {
    if (shown.length === 0) return;
    setOpen(true);
    setActive(active < 0 ? (d === 1 ? 0 : shown.length - 1) : (active + d + shown.length) % shown.length);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter') { e.preventDefault(); add(expanded && active >= 0 ? shown[active].name : draft); }
    else if (e.key === 'Escape') { if (expanded) e.preventDefault(); setOpen(false); setActive(-1); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="space-y-1">
      <ul aria-label={`Selected ${noun}s`} className="flex flex-wrap gap-1">
        {values.map((v) => (
          <li key={v}>
            <Badge variant="secondary" className="gap-1" {...{ [`data-${noun}`]: v }}>
              {v}
              {suggestions && !/[*?]/.test(v) && !suggestions.some((s) => s.name === v) && <span className="text-warning" title={unknownTitle}>unknown to cc</span>}
              <button type="button" aria-label={`Remove ${noun} ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><XIcon className="size-3" /></button>
            </Badge>
          </li>
        ))}
        {values.length === 0 && <li className="text-xs text-muted-foreground">{emptyText}</li>}
      </ul>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            id={id} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={listId} aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
            autoComplete="off" value={draft} placeholder={placeholder}
            onChange={(e) => { setDraft(e.target.value); setActive(-1); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onBlur={(e) => {
              if (listRef.current?.contains(e.relatedTarget as Node | null)) return;
              setOpen(false);
              setActive(-1);
              if (draft.trim()) add(draft);
            }}
            onKeyDown={onKeyDown}
          />
          <ul
            ref={listRef} id={listId} role="listbox" aria-label={`${noun} suggestions`} hidden={!expanded}
            className="absolute left-0 top-full z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
          >
            {shown.map((s, i) => (
              <li
                key={s.name} id={optionId(i)} role="option" aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()} onClick={() => add(s.name)}
                className={cn('flex cursor-pointer items-baseline justify-between gap-2 px-2 py-1 text-sm', i === active && 'bg-accent text-accent-foreground')}
              >
                <span className="font-mono">{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.hint}</span>
              </li>
            ))}
          </ul>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => add(draft)}>Add {noun}</Button>
      </div>
    </div>
  );
}
