import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Status } from './Status';
import { catalogError, status } from '@/test/fixtures';

// Spec 1: each named error shows its title, its message and the one action that fixes it.
describe('Status error card', () => {
  it.each([
    ['IMAGE_MISSING', 'pull', 'Pull image'],
    ['CP_IMAGE_MISSING', 'build-cp', 'Build CP image'],
    ['DOCKER_DENIED', 'settings', 'Open Settings'],
    ['UNHEALTHY', 'restart', 'Restart Hindsight'],
    ['PORT_IN_USE', 'settings', 'Open Settings'],
  ] as const)('%s offers "%s"', async (code, action, label) => {
    const onAction = vi.fn();
    render(<Status status={status({ state: 'error', error: catalogError(code, action) })} onAction={onAction} busy={false} />);
    expect(screen.getByText(`${code} title`)).toBeTruthy();
    expect(screen.getByText(`${code} message`)).toBeTruthy();
    const card = document.querySelector<HTMLElement>(`[data-error-code="${code}"]`)!;
    await userEvent.click(within(card).getByRole('button', { name: label }));
    expect(onAction).toHaveBeenCalledWith(action);
  });

  it('an error without an action offers no button', () => {
    render(<Status status={status({ state: 'error', error: catalogError('NAME_TAKEN', null) })} onAction={() => {}} busy={false} />);
    expect(document.querySelector('[data-error-code="NAME_TAKEN"] button')).toBeNull();
  });

  // Content from Docker or Hindsight is text, never markup.
  it('renders hostile error text as text', () => {
    const evil = '<img src=x onerror="window.hacked=1"><script>window.hacked=2</script>';
    render(<Status status={status({ state: 'error', error: { ...catalogError('CRASHED', 'restart'), title: evil, message: evil } })} onAction={() => {}} busy={false} />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getAllByText(evil).length).toBe(2);
  });
});

// Decision: Hindsight lives only while the backend runs; tell the user when Auto-start is off.
describe('Auto-start hint', () => {
  it('shows when cc reports Auto-start off', () => {
    render(<Status status={status({ autoStart: false })} onAction={() => {}} busy={false} />);
    expect(document.querySelector('[data-hint="autostart"]')).not.toBeNull();
  });
  it.each([true, undefined])('is absent when Auto-start is %s', (autoStart) => {
    render(<Status status={status({ autoStart })} onAction={() => {}} busy={false} />);
    expect(document.querySelector('[data-hint="autostart"]')).toBeNull();
  });
});

describe('Status facts', () => {
  it('shows the docker mode and start/stop actions by state', async () => {
    const onAction = vi.fn();
    const { rerender } = render(<Status status={status({ state: 'stopped' })} onAction={onAction} busy={false} />);
    expect(screen.getByText(/sudo -n docker/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Start Hindsight' }));
    expect(onAction).toHaveBeenLastCalledWith('start');
    rerender(<Status status={status({ state: 'ready' })} onAction={onAction} busy={false} />);
    expect(screen.queryByRole('button', { name: 'Start Hindsight' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Stop Hindsight' }));
    expect(onAction).toHaveBeenLastCalledWith('stop');
  });

  it('offers Apply & restart when the saved settings differ from the running ones', async () => {
    const onAction = vi.fn();
    render(<Status status={status({ pendingRestart: true })} onAction={onAction} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Apply & restart' }));
    expect(onAction).toHaveBeenCalledWith('start');
  });
});

// C1: a previous backend's failed SIGTERM stop is shown, not silently dropped.
describe('Shutdown failure notice', () => {
  it('shows when the previous stop could not run', () => {
    render(<Status status={status({ lastShutdownFailure: { at: 'x', error: 'could not start sudo' } })} onAction={() => {}} busy={false} />);
    expect(document.querySelector('[data-hint="shutdown-failed"]')?.textContent).toContain('could not start sudo');
  });
});

// OL9 (UI): an Ollama link shows the daemon and relay state, its warnings, and the relay's container and log.
describe('Ollama link', () => {
  const ollama = (over: Partial<NonNullable<ReturnType<typeof status>['ollama']>> = {}) => ({
    daemonUrl: 'http://127.0.0.1:11434',
    tunnel: { state: 'connected' as const, idle: 4, error: null, address: '172.20.0.1:18434' },
    lastForward: null,
    daemon: { ok: true, version: '0.40.13', error: null, at: 'x' },
    problems: [],
    ...over,
  });
  const linked = (o: ReturnType<typeof ollama>) => status({ ollama: o, containers: { ...status().containers!, relay: { name: 'code-hindsight-relay', state: 'running' } } });

  it('shows nothing about Ollama without a link', () => {
    render(<Status status={status()} onAction={() => {}} busy={false} />);
    expect(screen.queryByText('Ollama')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Relay log' })).toBeNull();
  });

  it('shows the daemon version and URL, the relay state and the relay container', () => {
    render(<Status status={linked(ollama())} onAction={() => {}} busy={false} />);
    expect(screen.getByText(/daemon 0\.40\.13 at http:\/\/127\.0\.0\.1:11434; relay connected/)).toBeTruthy();
    expect(screen.getByText('Relay container')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Relay log' })).toBeTruthy();
  });

  it('shows a warning for each problem', () => {
    const problems = [catalogError('OLLAMA_UNREACHABLE', null), catalogError('RELAY_DISCONNECTED', 'restart')];
    render(<Status status={linked(ollama({ daemon: { ok: false, version: null, error: 'ECONNREFUSED', at: 'x' }, tunnel: { state: 'connecting', idle: 0, error: 'ECONNREFUSED', address: null }, problems }))} onAction={() => {}} busy={false} />);
    expect(document.querySelector('[data-hint="OLLAMA_UNREACHABLE"]')?.textContent).toContain('OLLAMA_UNREACHABLE message');
    expect(document.querySelector('[data-hint="RELAY_DISCONNECTED"]')?.textContent).toContain('RELAY_DISCONNECTED message');
    expect(screen.getByText(/not answering at http:\/\/127\.0\.0\.1:11434; relay connecting/)).toBeTruthy();
  });
});
