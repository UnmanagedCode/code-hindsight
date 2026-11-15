import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NameListInput, type Suggestion } from './NameListInput';

const projects: Suggestion[] = [
  { name: 'code-hindsight', hint: 'CC-Dev' },
  { name: 'code-wiki', hint: 'CC-Dev' },
  { name: 'notes', hint: 'no workspace' },
  { name: 'TTrack', hint: 'HOME' },
];

/** Holds the list so the component is exercised as Memory uses it. */
function Harness({ suggestions = projects, initial = [] as string[], seen }: { suggestions?: Suggestion[] | null; initial?: string[]; seen?: (v: string[]) => void }) {
  const [values, setValues] = useState(initial);
  return (
    <NameListInput
      id="p" noun="project" values={values} suggestions={suggestions} emptyText="any project" unknownTitle="unknown" placeholder="name"
      onChange={(v) => { setValues(v); seen?.(v); }}
    />
  );
}
const input = () => screen.getByRole('combobox');
const options = () => screen.queryAllByRole('option').map((o) => o.textContent ?? '');
const chips = () => Array.from(document.querySelectorAll('[data-project]')).map((e) => e.getAttribute('data-project'));

describe('NameListInput', () => {
  // spec 2
  it('filters suggestions case-insensitively by name or hint, and never offers an added value', async () => {
    render(<Harness initial={['code-wiki']} />);
    await userEvent.type(input(), 'CODE');
    expect(options()).toEqual(['code-hindsightCC-Dev']);
    await userEvent.clear(input());
    await userEvent.type(input(), 'no workspace');
    expect(options()).toEqual(['notesno workspace']);
  });

  // spec 2
  it('Enter without an active option adds the typed glob verbatim, even when it prefixes a suggestion; arrow then Enter adds the highlighted one', async () => {
    render(<Harness />);
    await userEvent.type(input(), 'TT*{Enter}');
    expect(chips()).toEqual(['TT*']);
    await userEvent.type(input(), 'code{ArrowDown}{Enter}');
    expect(chips()).toEqual(['TT*', 'code-hindsight']);
    await userEvent.type(input(), 'code{Enter}');
    expect(chips()).toEqual(['TT*', 'code-hindsight', 'code']);
  });

  // spec 2
  it('Escape closes the list and keeps the draft; clicking an option adds it; a typed draft is added on blur', async () => {
    render(<Harness />);
    await userEvent.type(input(), 'code');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{Escape}');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect((input() as HTMLInputElement).value).toBe('code');
    await userEvent.type(input(), '-');
    await userEvent.click(screen.getByRole('option', { name: /code-wiki/ }));
    expect(chips()).toEqual(['code-wiki']);
    await userEvent.type(input(), 'glob*');
    await userEvent.tab();
    expect(chips()).toEqual(['code-wiki', 'glob*']);
  });

  // spec 2 / a11y
  it('is a combobox whose aria-activedescendant names the active option in the listbox', async () => {
    render(<Harness />);
    expect(input().getAttribute('aria-expanded')).toBe('false');
    await userEvent.type(input(), 'code');
    const list = screen.getByRole('listbox');
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    const active = document.getElementById(input().getAttribute('aria-activedescendant')!)!;
    expect(within(list).getByRole('option', { selected: true })).toBe(active);
    expect(active.textContent).toContain('code-wiki');
    expect(input().getAttribute('aria-controls')).toBe(list.id);
  });

  // spec 3
  it('removes a value with its remove button; ignores duplicates and empty values', async () => {
    const seen: string[][] = [];
    render(<Harness initial={['a']} seen={(v) => seen.push(v)} />);
    await userEvent.type(input(), 'a{Enter}');
    await userEvent.type(input(), '   {Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(seen).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove project a' }));
    expect(chips()).toEqual([]);
    expect(screen.getByText('any project')).toBeTruthy();
  });

  // spec 3
  it('with no suggestions (cc unreadable) opens no list, still adds free text, and marks nothing unknown', async () => {
    render(<Harness suggestions={null} />);
    await userEvent.type(input(), 'whatever{Enter}');
    expect(chips()).toEqual(['whatever']);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.querySelector('[data-project]')!.textContent).not.toMatch(/unknown to cc/);
  });

  it('marks a literal value cc does not list, but not a glob or a listed name', () => {
    render(<Harness initial={['gone', 'notes', 'g*']} />);
    expect(document.querySelector('[data-project="gone"]')!.textContent).toMatch(/unknown to cc/);
    expect(document.querySelector('[data-project="notes"]')!.textContent).not.toMatch(/unknown to cc/);
    expect(document.querySelector('[data-project="g*"]')!.textContent).not.toMatch(/unknown to cc/);
  });

  // spec 4: the browser draws a datalist popup outside the page, where no CSS can place it.
  it('renders no datalist and gives the input no list attribute', () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('datalist')).toBeNull();
    expect(input().hasAttribute('list')).toBe(false);
  });

  it('renders hostile cc names as text, creating no element', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    render(<Harness suggestions={[{ name: hostile, hint: hostile }]} />);
    await userEvent.click(input());
    expect(screen.getByRole('option').textContent).toContain(hostile);
    expect(document.querySelector('img')).toBeNull();
  });
});
