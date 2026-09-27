import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { COPY_POLLING_DIAGNOSTICS_COMMAND, createLeaseDegradedNotifier } from '../lease/leaseDegradedNotice';

/**
 * §7.1's one-time degradation notice: it appears at most once per session, and
 * both of its buttons do exactly what they say — copy the diagnostics payload,
 * or turn the setting off at user scope (§11.1 stage 3's rollback path).
 *
 * The strings are asserted through the mocked `vscode.l10n.t`, which is the
 * same code path the extension host uses; the bundle keys themselves are
 * checked by `webview/__tests__/i18nParity.test.ts` (every literal `l10n.t`
 * key must exist in both shipped bundles).
 */

const logger = { info: vi.fn(), error: vi.fn() };

function showInformationMessage(): ReturnType<typeof vi.fn> {
  return vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
}

function showMessageWith(choice: string | undefined): void {
  showInformationMessage().mockResolvedValue(choice);
}

beforeEach(() => {
  vi.clearAllMocks();
  showMessageWith(undefined);
  (vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

describe('the polling lease degradation notice (§7.1)', () => {
  it('shows once per session, with the two actions and the "nothing is missing" wording', () => {
    const notifier = createLeaseDegradedNotifier({ logger });

    notifier.notify('read-unusable');
    notifier.notify('record-write-failed');
    notifier.notify('claim-unavailable');

    expect(showInformationMessage()).toHaveBeenCalledTimes(1);
    const [message, ...actions] = showInformationMessage().mock.calls[0] as [string, ...string[]];
    expect(message).toContain('The multi-window polling lease is unavailable on this machine');
    expect(message).toContain('Nothing is missing');
    expect(actions).toEqual(['Copy Diagnostics', 'Disable This Setting']);
    expect(notifier.shown).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('runs the diagnostics command from the first button', async () => {
    showMessageWith('Copy Diagnostics');
    const notifier = createLeaseDegradedNotifier({ logger });

    notifier.notify('read-unusable');

    await vi.waitFor(() => {
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(COPY_POLLING_DIAGNOSTICS_COMMAND);
    });
    expect(COPY_POLLING_DIAGNOSTICS_COMMAND).toBe('forgejoToolkit.copyPollingDiagnostics');
  });

  it('turns the setting off at user scope from the second button', async () => {
    showMessageWith('Disable This Setting');
    const update = vi.fn(async () => undefined);
    (vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn(),
      update,
    });
    const notifier = createLeaseDegradedNotifier({ logger });

    notifier.notify('read-unusable');

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith('multiWindowLease', false, vscode.ConfigurationTarget.Global);
    });
  });

  it('does nothing when the notice is dismissed', async () => {
    showMessageWith(undefined);
    const update = vi.fn(async () => undefined);
    (vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn(),
      update,
    });
    const notifier = createLeaseDegradedNotifier({ logger });

    notifier.notify('read-unusable');
    await Promise.resolve();

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports a failing button action instead of rejecting', async () => {
    showMessageWith('Copy Diagnostics');
    (vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const notifier = createLeaseDegradedNotifier({ logger });

    notifier.notify('read-unusable');

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });
    // Shown is still latched: the notice is once per session whatever happens.
    expect(notifier.shown).toBe(true);
  });
});
