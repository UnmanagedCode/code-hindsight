import { describe, expect, it } from 'vitest';
import { formatDuration } from './ActivityDuration';

describe('formatDuration', () => {
  it('never shows 60 seconds inside a minute count: rounding carries into the minutes', () => {
    expect(formatDuration(59_999)).toBe('1 min 0 s');
    expect(formatDuration(119_999)).toBe('2 min 0 s');
    expect(formatDuration(179_999)).toBe('3 min 0 s');
    expect(formatDuration(150_000)).toBe('2 min 30 s');
  });

  it('keeps milliseconds under a second and one decimal of seconds below a minute', () => {
    expect(formatDuration(999)).toBe('999 ms');
    expect(formatDuration(1000)).toBe('1.0 s');
    expect(formatDuration(59_949)).toBe('59.9 s');
  });
});
